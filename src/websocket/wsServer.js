const { WebSocketServer } = require('ws');
const firebaseAuth = require('../firebase/firebaseAdmin');
const prisma = require('../prismaClient');
const config = require('../config');
const hub = require('./hub');
const { upsertFromFirebase } = require('../services/userService');
const { ingestReport, getLatestLocations, forgetUser } = require('../services/locationService');
const { getGroupForMember, WS_CLOSE } = require('../services/groupService');

/*
 * Conexión:
 *   ws://HOST/ws?token=<idToken>
 *   ws://HOST/ws/<groupId>?token=<idToken>     ← opcional: valida que sea tu grupo
 *
 * El token también puede ir en el header "Authorization: Bearer <idToken>"
 * (apps nativas) o como primer mensaje: { "type": "auth", "token": "<idToken>" }.
 *
 * Mensajes que recibe el servidor:
 *   { type: "location", groupId, email, groupCode, esp: {...} }   → ver locationService.js
 *   { type: "ping" }                                                → responde { type: "pong" }
 *
 * Mensajes que envía el servidor:
 *   connected, snapshot, location_update, presence, member_joined, member_left,
 *   group_renamed, group_deleted, group_left, ack, error, pong
 */

const AUTH_TIMEOUT_MS = 10_000;

function parseUpgradeUrl(req) {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/ws(?:\/([A-Za-z0-9_-]+))?\/?$/);
  if (!match) return null;
  return {
    groupId: match[1] || url.searchParams.get('groupId') || null,
    token: url.searchParams.get('token')
  };
}

function headerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function authenticate(token) {
  if (!token) return null;
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    return upsertFromFirebase(decoded);
  } catch {
    return null;
  }
}

function sendError(ws, error, code, extra = {}) {
  hub.send(ws, { type: 'error', error, code, ...extra });
}

/** Una vez autenticado: registra la conexión y manda el estado inicial. */
async function attach(ws, user, requestedGroupId) {
  if (!user) return ws.close(WS_CLOSE.UNAUTHORIZED, 'Token invalido o ausente');
  if (!user.groupId) return ws.close(WS_CLOSE.NO_GROUP, 'El usuario no pertenece a ningun grupo');
  if (requestedGroupId && requestedGroupId !== user.groupId) {
    return ws.close(WS_CLOSE.NO_GROUP, 'groupId no coincide con tu grupo');
  }

  ws.userId = user.id;
  ws.groupId = user.groupId;
  const wasOnline = hub.isOnline(ws.groupId, ws.userId);
  hub.add(ws);

  const [group, locations] = await Promise.all([
    getGroupForMember(ws.groupId),
    getLatestLocations(ws.groupId)
  ]);

  hub.send(ws, {
    type: 'connected',
    groupId: ws.groupId,
    userId: user.id,
    displayName: user.displayName
  });
  hub.send(ws, {
    type: 'snapshot',
    group: { id: group.id, name: group.name, ownerId: group.ownerId, members: group.members },
    locations
  });

  if (!wasOnline) hub.broadcast(ws.groupId, { type: 'presence', userId: user.id, online: true });
  console.log(`[WS] ${user.displayName} conectado al grupo ${ws.groupId}`);
}

async function handleMessage(ws, msg) {
  if (msg.type === 'ping') return hub.send(ws, { type: 'pong', t: Date.now() });

  if (msg.type === 'location') {
    // Releer el usuario: puede haber salido del grupo desde otra sesión.
    const user = await prisma.user.findUnique({ where: { id: ws.userId } });
    if (!user || user.groupId !== ws.groupId) {
      return ws.close(WS_CLOSE.LEFT_GROUP, 'Ya no perteneces a este grupo');
    }
    try {
      const result = await ingestReport(user, msg);
      return hub.send(ws, { type: 'ack', ...result, ref: msg.ref ?? null });
    } catch (err) {
      return sendError(ws, err.status ? err.message : 'Error al procesar la ubicación.', err.code || 'SERVER_ERROR', {
        ref: msg.ref ?? null
      });
    }
  }

  sendError(ws, `Tipo de mensaje desconocido: ${msg.type}`, 'UNKNOWN_TYPE');
}

function initWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const target = parseUpgradeUrl(req);
    if (!target) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, target));
  });

  wss.on('connection', async (ws, req, target) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const initialToken = target.token || headerToken(req);
    let authTimer = null;
    // Si el token vino en la URL/header, los mensajes que lleguen mientras se
    // verifica esperan a que termine (la app puede mandar apenas abre).
    const ready = initialToken
      ? authenticate(initialToken).then((user) => attach(ws, user, target.groupId)).catch((err) => {
          console.error('[WS] Error autenticando:', err);
          ws.close(1011, 'Error interno');
        })
      : null;

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return sendError(ws, 'JSON inválido', 'INVALID_JSON');
      }

      if (ready) await ready;

      // Autenticación por primer mensaje (si no vino el token en la URL/header)
      if (!ws.userId) {
        if (initialToken || msg.type !== 'auth') return sendError(ws, 'Todavía no autenticado.', 'NOT_AUTHENTICATED');
        clearTimeout(authTimer);
        return attach(ws, await authenticate(msg.token), target.groupId);
      }

      try {
        await handleMessage(ws, msg);
      } catch (err) {
        console.error('[WS] Error procesando mensaje:', err);
        sendError(ws, 'Error interno.', 'SERVER_ERROR');
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!ws.userId) return;
      hub.remove(ws);
      if (!hub.isOnline(ws.groupId, ws.userId)) {
        forgetUser(ws.userId);
        hub.broadcast(ws.groupId, { type: 'presence', userId: ws.userId, online: false });
      }
    });

    ws.on('error', (err) => console.error('[WS] error:', err.message));

    if (!initialToken) {
      authTimer = setTimeout(() => ws.close(WS_CLOSE.UNAUTHORIZED, 'Timeout de autenticacion'), AUTH_TIMEOUT_MS);
    }
  });

  // Heartbeat: corta conexiones muertas (celular sin señal, app cerrada a la fuerza…)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.wsHeartbeatMs);
  wss.on('close', () => clearInterval(heartbeat));

  console.log('[WS] Servidor WebSocket listo en /ws');
  return wss;
}

module.exports = { initWebSocketServer };
