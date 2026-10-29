const { WebSocket } = require('ws');

/**
 * Registro en memoria de las conexiones WebSocket abiertas, agrupadas por grupo.
 * Lo usan tanto el servidor WS como los controladores REST (para avisar en vivo
 * cuando alguien entra/sale del grupo o se elimina el grupo).
 *
 * groupId -> Set<WebSocket>   (cada ws tiene ws.userId, ws.groupId, ws.client)
 */
const groups = new Map();

function add(ws) {
  if (!groups.has(ws.groupId)) groups.set(ws.groupId, new Set());
  groups.get(ws.groupId).add(ws);
}

function remove(ws) {
  const set = groups.get(ws.groupId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) groups.delete(ws.groupId);
}

function sockets(groupId) {
  return [...(groups.get(groupId) || [])];
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(groupId, msg) {
  const payload = JSON.stringify(msg);
  for (const ws of sockets(groupId)) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** IDs de usuarios del grupo con al menos una conexión abierta. */
function onlineUserIds(groupId) {
  return [...new Set(sockets(groupId).map((ws) => ws.userId))];
}

function isOnline(groupId, userId) {
  return sockets(groupId).some((ws) => ws.userId === userId);
}

/** Cierra todas las conexiones de un usuario (ej: salió o lo expulsaron). */
function closeUser(groupId, userId, code, reason) {
  for (const ws of sockets(groupId)) {
    if (ws.userId === userId) {
      send(ws, { type: 'group_left', reason });
      ws.close(code, reason);
    }
  }
}

/** Cierra todas las conexiones de un grupo (ej: el admin lo eliminó). */
function closeGroup(groupId, code, reason) {
  for (const ws of sockets(groupId)) {
    send(ws, { type: 'group_deleted', reason });
    ws.close(code, reason);
  }
}

function stats() {
  let connections = 0;
  for (const set of groups.values()) connections += set.size;
  return { groupsOnline: groups.size, connections };
}

module.exports = { add, remove, send, broadcast, onlineUserIds, isOnline, closeUser, closeGroup, stats };
