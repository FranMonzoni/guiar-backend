const prisma = require('../prismaClient');
const config = require('../config');
const hub = require('../websocket/hub');
const { HttpError } = require('../utils/httpError');

/*
 * Formato del mensaje que manda la app móvil (por WebSocket o POST /api/locations):
 *
 * {
 *   "type":      "location",
 *   "groupId":   "cmh1x...",          ← ID del grupo (obligatorio, debe ser el tuyo)
 *   "email":     "user@mail.com",     ← opcional; si viene, debe coincidir con tu cuenta
 *   "groupCode": "K7P3QX9M",          ← opcional; código de invitación vigente
 *   "esp": {
 *     "deviceId":   "GUIAR-01",
 *     "latitude":   -31.4201,          ← obligatorio (alias: lat)
 *     "longitude":  -64.1888,          ← obligatorio (alias: lng, lon)
 *     "altitude":   410.2,             ← m
 *     "speed":      1.3,               ← m/s
 *     "heading":    87,                ← grados 0-360 (magnetómetro)
 *     "accuracy":   4.5,               ← m
 *     "satellites": 9,
 *     "battery":    82,                ← %
 *     "signal":     -97,               ← RSSI LoRa dBm
 *     "timestamp":  1761751200000,     ← hora de la ESP (ms epoch o ISO)
 *     "accel": { "x": 0.01, "y": -0.02, "z": 0.98 }   ← cualquier campo extra se guarda en "extra"
 *   }
 * }
 */

const KNOWN = new Set([
  'deviceId', 'latitude', 'lat', 'longitude', 'lng', 'lon', 'altitude', 'alt', 'speed',
  'heading', 'accuracy', 'hdop', 'satellites', 'sats', 'battery', 'signal', 'rssi', 'timestamp', 'time'
]);
const MAX_EXTRA_BYTES = 4096;

// userId → timestamp (ms) del último punto guardado en la DB
const lastPersisted = new Map();

function num(value, { min = -Infinity, max = Infinity, field }) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `"${field}" fuera de rango o no numérico.`, 'INVALID_FIELD');
  }
  return n;
}

function parseDeviceTime(value) {
  if (value === undefined || value === null) return null;
  // Acepta segundos o milisegundos epoch, o string ISO
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Valida el mensaje contra el usuario autenticado y su grupo.
 * Devuelve { data, warnings } listo para guardar.
 */
function parseReport(msg, user, group) {
  if (!msg || typeof msg !== 'object') throw new HttpError(400, 'Cuerpo inválido.', 'INVALID_BODY');

  if (!msg.groupId) throw new HttpError(400, 'Falta "groupId".', 'MISSING_GROUP_ID');
  if (msg.groupId !== group.id) {
    throw new HttpError(403, '"groupId" no coincide con tu grupo.', 'GROUP_MISMATCH');
  }
  if (msg.email && user.email && String(msg.email).toLowerCase() !== user.email) {
    throw new HttpError(403, '"email" no coincide con la cuenta autenticada.', 'EMAIL_MISMATCH');
  }

  const warnings = [];
  if (msg.groupCode && String(msg.groupCode).toUpperCase().replace(/[^A-Z0-9]/g, '') !== group.inviteCode) {
    warnings.push('groupCode desactualizado: el código de invitación del grupo cambió.');
  }

  const esp = msg.esp;
  if (!esp || typeof esp !== 'object') throw new HttpError(400, 'Falta el objeto "esp".', 'MISSING_ESP');

  const latitude = num(esp.latitude ?? esp.lat, { min: -90, max: 90, field: 'latitude' });
  const longitude = num(esp.longitude ?? esp.lng ?? esp.lon, { min: -180, max: 180, field: 'longitude' });
  if (latitude === null || longitude === null) {
    throw new HttpError(400, 'Se requieren "latitude" y "longitude" en "esp".', 'MISSING_COORDS');
  }

  const extraObj = Object.fromEntries(Object.entries(esp).filter(([k]) => !KNOWN.has(k)));
  let extra = Object.keys(extraObj).length ? JSON.stringify(extraObj) : null;
  if (extra && Buffer.byteLength(extra) > MAX_EXTRA_BYTES) {
    extra = null;
    warnings.push('Campos extra descartados (más de 4 KB).');
  }

  const data = {
    userId: user.id,
    groupId: group.id,
    deviceId: String(esp.deviceId || 'unknown').slice(0, 64),
    latitude,
    longitude,
    altitude: num(esp.altitude ?? esp.alt, { field: 'altitude' }),
    speed: num(esp.speed, { min: 0, field: 'speed' }),
    heading: num(esp.heading, { min: 0, max: 360, field: 'heading' }),
    accuracy: num(esp.accuracy ?? esp.hdop, { min: 0, field: 'accuracy' }),
    satellites: num(esp.satellites ?? esp.sats, { min: 0, max: 255, field: 'satellites' }),
    battery: num(esp.battery, { min: 0, max: 100, field: 'battery' }),
    signal: num(esp.signal ?? esp.rssi, { min: -200, max: 50, field: 'signal' }),
    extra,
    deviceTime: parseDeviceTime(esp.timestamp ?? esp.time)
  };
  if (data.satellites !== null) data.satellites = Math.round(data.satellites);

  return { data, warnings };
}

/** Forma pública de un punto, igual para REST, snapshot y location_update. */
function serialize(loc, member) {
  return {
    userId: member.id,
    displayName: member.displayName,
    email: member.email,
    deviceId: loc.deviceId,
    latitude: loc.latitude,
    longitude: loc.longitude,
    altitude: loc.altitude,
    speed: loc.speed,
    heading: loc.heading,
    accuracy: loc.accuracy,
    satellites: loc.satellites,
    battery: loc.battery,
    signal: loc.signal,
    extra: typeof loc.extra === 'string' ? JSON.parse(loc.extra) : loc.extra ?? null,
    deviceTime: loc.deviceTime,
    timestamp: loc.timestamp
  };
}

/**
 * Procesa un reporte: valida, guarda (con límite de frecuencia) y lo
 * retransmite en vivo a todos los conectados del grupo.
 */
async function ingestReport(user, msg) {
  if (!user.groupId) throw new HttpError(400, 'No pertenecés a ningún grupo.', 'NO_GROUP');
  const group = await prisma.group.findUnique({ where: { id: user.groupId } });
  if (!group) throw new HttpError(400, 'No pertenecés a ningún grupo.', 'NO_GROUP');

  const { data, warnings } = parseReport(msg, user, group);

  const now = Date.now();
  const shouldPersist = now - (lastPersisted.get(user.id) || 0) >= config.locationMinIntervalMs;

  let point = { ...data, timestamp: new Date(now) };
  let locationId = null;
  if (shouldPersist) {
    const saved = await prisma.location.create({ data });
    lastPersisted.set(user.id, now);
    point = saved;
    locationId = saved.id;
  }

  hub.broadcast(group.id, { type: 'location_update', location: serialize(point, user) });

  return { saved: shouldPersist, locationId, warnings };
}

/** Última ubicación conocida de cada miembro del grupo (+ si está en línea). */
async function getLatestLocations(groupId) {
  const [members, latest] = await Promise.all([
    prisma.user.findMany({
      where: { groupId },
      select: { id: true, displayName: true, email: true },
      orderBy: { joinedAt: 'asc' }
    }),
    prisma.location.findMany({
      where: { groupId },
      orderBy: { timestamp: 'desc' },
      distinct: ['userId']
    })
  ]);

  const byUser = new Map(latest.map((l) => [l.userId, l]));
  const online = new Set(hub.onlineUserIds(groupId));

  return members
    .filter((m) => byUser.has(m.id))
    .map((m) => ({ ...serialize(byUser.get(m.id), m), online: online.has(m.id) }));
}

/** Borra ubicaciones más viejas que LOCATION_RETENTION_HOURS. */
async function purgeOldLocations() {
  const cutoff = new Date(Date.now() - config.locationRetentionHours * 3600_000);
  const { count } = await prisma.location.deleteMany({ where: { timestamp: { lt: cutoff } } });
  if (count) console.log(`[locations] ${count} ubicaciones viejas eliminadas`);
}

function forgetUser(userId) {
  lastPersisted.delete(userId);
}

module.exports = { ingestReport, getLatestLocations, purgeOldLocations, parseReport, serialize, forgetUser };
