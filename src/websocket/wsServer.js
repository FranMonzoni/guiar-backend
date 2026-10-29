const { WebSocketServer, WebSocket } = require('ws');
const admin = require('../firebase/firebaseAdmin');
const prisma = require('../prismaClient');

/**
 * groupId -> Set<WebSocket>
 */
const groupConnections = new Map();

function addToGroup(groupId, ws) {
  if (!groupConnections.has(groupId)) groupConnections.set(groupId, new Set());
  groupConnections.get(groupId).add(ws);
}

function removeFromGroup(groupId, ws) {
  const group = groupConnections.get(groupId);
  if (group) {
    group.delete(ws);
    if (group.size === 0) groupConnections.delete(groupId);
  }
}

function broadcastToGroup(groupId, data) {
  const group = groupConnections.get(groupId);
  if (!group) return;
  const payload = JSON.stringify(data);
  group.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

/**
 * Extrae y verifica el Firebase ID Token del query string.
 * ws://host/ws?token=<firebase_id_token>
 */
async function verifyFirebaseToken(req) {
  try {
    const url = new URL(req.url, 'ws://localhost');
    const token = url.searchParams.get('token');
    if (!token) return null;
    return await admin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

/**
 * Inicializa el servidor WebSocket sobre el servidor HTTP.
 * @param {import('http').Server} server
 */
function initWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // 1. Verificar token Firebase
    const firebaseUser = await verifyFirebaseToken(req);
    if (!firebaseUser) {
      ws.close(4001, 'Token Firebase inválido o ausente');
      return;
    }

    // 2. Buscar usuario en SQLite
    const dbUser = await prisma.user.findUnique({ where: { firebaseUid: firebaseUser.uid } });
    if (!dbUser) {
      ws.close(4002, 'Usuario no registrado. Iniciá sesión en la web primero.');
      return;
    }

    if (!dbUser.groupId) {
      ws.close(4003, 'El usuario no pertenece a ningún grupo.');
      return;
    }

    const groupId = dbUser.groupId;
    ws.userId      = dbUser.id;
    ws.displayName = dbUser.displayName;
    ws.groupId     = groupId;

    addToGroup(groupId, ws);
    console.log(`[WS] ${dbUser.displayName} conectado al grupo ${groupId}`);

    ws.send(JSON.stringify({
      type:        'connected',
      message:     `Conectado al grupo ${groupId}`,
      groupId,
      displayName: dbUser.displayName
    }));

    // 3. Mensajes entrantes desde la app móvil
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'JSON inválido' }));
        return;
      }

      /**
       * Formato esperado del mensaje (enviado por la app móvil):
       * {
       *   type:      "location",
       *   groupId:   "abc123",       <- debe coincidir con el grupo del usuario
       *   email:     "user@x.com",   <- email del usuario (informativo)
       *   groupCode: "A3F2B9C1",     <- joinKey del grupo (usado para cifrado en la ESP)
       *   esp: {
       *     latitude:  -34.6037,
       *     longitude: -58.3816,
       *     deviceId:  "ESP32_001",
       *     battery:   85,           <- opcional
       *     signal:    -70           <- opcional (dBm)
       *   }
       * }
       */
      if (msg.type === 'location') {
        if (msg.groupId !== groupId) {
          ws.send(JSON.stringify({ type: 'error', error: 'groupId no coincide con tu grupo.' }));
          return;
        }

        const { esp } = msg;
        if (!esp || esp.latitude === undefined || esp.longitude === undefined) {
          ws.send(JSON.stringify({ type: 'error', error: 'Datos ESP inválidos: se requieren latitude y longitude.' }));
          return;
        }

        try {
          const location = await prisma.location.create({
            data: {
              userId:    dbUser.id,
              groupId,
              latitude:  esp.latitude,
              longitude: esp.longitude,
              deviceId:  esp.deviceId || 'unknown'
            }
          });

          const broadcastPayload = {
            type:        'location_update',
            userId:      dbUser.id,
            displayName: dbUser.displayName,
            latitude:    esp.latitude,
            longitude:   esp.longitude,
            deviceId:    esp.deviceId || 'unknown',
            battery:     esp.battery ?? null,
            signal:      esp.signal  ?? null,
            timestamp:   location.timestamp
          };

          // Enviar a todos los miembros del grupo (incluyendo al emisor)
          broadcastToGroup(groupId, broadcastPayload);
          ws.send(JSON.stringify({ type: 'ack', locationId: location.id }));
        } catch (err) {
          console.error('[WS] Error guardando location:', err);
          ws.send(JSON.stringify({ type: 'error', error: 'Error al guardar la ubicación.' }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'error', error: `Tipo de mensaje desconocido: ${msg.type}` }));
      }
    });

    ws.on('close', () => {
      console.log(`[WS] ${dbUser.displayName} desconectado`);
      removeFromGroup(groupId, ws);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Error en ${dbUser.displayName}:`, err.message);
      removeFromGroup(groupId, ws);
    });
  });

  console.log('[WS] Servidor WebSocket listo en /ws');
  return wss;
}

module.exports = { initWebSocketServer, broadcastToGroup };
