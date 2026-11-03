const prisma = require('../prismaClient');
const config = require('../config');
const hub = require('../websocket/hub');
const devices = require('./deviceService');
const { HttpError } = require('../utils/httpError');
const { log } = require('../utils/log');

/*
 * Mensaje que manda la app (por WebSocket o POST /api/locations):
 *
 * {
 *   "type": "location",
 *   "ref": 42,                          ← opcional, vuelve en el ack
 *   "groupId": "cmh1x...",              ← obligatorio, debe ser tu grupo
 *   "email": "user@mail.com",           ← opcional; si viene, debe ser tu cuenta
 *   "groupCode": "K7P3QX9M",            ← opcional
 *   "esp": {
 *     "deviceId": "device-001",         ← OBLIGATORIO: una pulsera por usuario
 *     "latitude": -31.425,              ← alias lat (o telemetry.sensors.gps.data.lat)
 *     "longitude": -62.084,             ← alias lng / lon (o ...gps.data.lon)
 *     "timestamp": 1793656799500,       ← hora de la lectura (s, ms o ISO)
 *     "satellites": 9,                  ← alias sats (o ...gps.data.sats)
 *     "gpsHdop": 1.2,                   ← alias hdop (o ...gps.data.hdop)
 *     "heading": 87, "speed": 1.3, "altitude": 410, "accuracy": 4.5,
 *     "battery": 82, "signal": -97,
 *     "accel": { "x": 0.01, "y": -0.02, "z": 0.98 },   ← extra chico, se guarda por punto
 *     "telemetry": {                    ← estado completo de la pulsera (ver parseTelemetry)
 *       "schemaVersion": 1, "appVersion": 4, "transport": "ble", "sentAt": ...,
 *       "simulatedLocation": false,
 *       "sensors": { "identity": {...}, "imu": {...}, "gps": {...},
 *                    "magnetometer": {...}, "diagnostics": {...} }
 *     }
 *   }
 * }
 *
 * Sin coordenadas (por ejemplo, el GPS todavía no tiene fix) el mensaje se acepta
 * igual si trae telemetría: se actualiza el estado de la pulsera y no se guarda punto.
 */

const KNOWN = new Set([
  'deviceId', 'latitude', 'lat', 'longitude', 'lng', 'lon', 'altitude', 'alt', 'speed',
  'heading', 'accuracy', 'hdop', 'gpsHdop', 'satellites', 'sats', 'battery', 'signal', 'rssi',
  'timestamp', 'time', 'telemetry'
]);
const MAX_EXTRA_BYTES = 4096;
const MAX_TELEMETRY_BYTES = 12 * 1024;
const SENSOR_KEYS = ['identity', 'imu', 'gps', 'magnetometer', 'diagnostics'];

// userId → timestamp (ms) del último punto guardado en la DB
const lastPersisted = new Map();

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function num(value, { min = -Infinity, max = Infinity, field }) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `"${field}" fuera de rango o no numérico.`, 'INVALID_FIELD');
  }
  return n;
}

function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  // Acepta segundos o milisegundos epoch, o string ISO
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const str = (v, max = 64) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Valida esp.telemetry sin rechazar el mensaje: si algo no tiene la forma esperada
 * se descarta con un aviso en `warnings`. Devuelve la telemetría tal cual (para
 * mostrarla) y los datos que se usan en otras columnas.
 */
function parseTelemetry(raw, warnings) {
  const empty = { telemetry: null, gps: null, identity: null, simulated: false };
  if (raw === undefined || raw === null) return empty;
  if (!isObj(raw)) {
    warnings.push('"telemetry" descartada: no es un objeto.');
    return empty;
  }
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_TELEMETRY_BYTES) {
    warnings.push('"telemetry" descartada: ocupa más de 12 KB.');
    return empty;
  }

  const sensors = isObj(raw.sensors) ? raw.sensors : {};
  if (raw.sensors !== undefined && !isObj(raw.sensors)) warnings.push('"telemetry.sensors" no es un objeto.');
  for (const key of SENSOR_KEYS) {
    if (sensors[key] !== undefined && !isObj(sensors[key])) warnings.push(`"telemetry.sensors.${key}" no es un objeto.`);
  }
  const data = (key) => (isObj(sensors[key]) && isObj(sensors[key].data) ? sensors[key].data : null);

  return {
    telemetry: raw,
    gps: data('gps'),
    identity: data('identity'),
    simulated: raw.simulatedLocation === true
  };
}

/**
 * Valida el mensaje contra el usuario autenticado y su grupo.
 * Devuelve { deviceId, location (o null si no trae coordenadas), device, warnings }.
 */
function parseReport(msg, user, group) {
  if (!isObj(msg)) throw new HttpError(400, 'Cuerpo inválido.', 'INVALID_BODY');

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
  if (!isObj(esp)) throw new HttpError(400, 'Falta el objeto "esp".', 'MISSING_ESP');

  const deviceId = devices.normalizeDeviceId(esp.deviceId);
  const tel = parseTelemetry(esp.telemetry, warnings);
  const gps = tel.gps || {};
  if (tel.identity?.id && String(tel.identity.id) !== deviceId) {
    warnings.push(`El id de la telemetría ("${String(tel.identity.id).slice(0, 64)}") no coincide con esp.deviceId.`);
  }

  const latitude = num(esp.latitude ?? esp.lat ?? gps.lat, { min: -90, max: 90, field: 'latitude' });
  const longitude = num(esp.longitude ?? esp.lng ?? esp.lon ?? gps.lon, { min: -180, max: 180, field: 'longitude' });
  const hasCoords = latitude !== null && longitude !== null;
  if (!hasCoords && !tel.telemetry) {
    throw new HttpError(400, 'Se requieren "latitude" y "longitude" en "esp".', 'MISSING_COORDS');
  }
  if ((latitude === null) !== (longitude === null)) {
    throw new HttpError(400, 'Llegó solo una de "latitude" / "longitude".', 'MISSING_COORDS');
  }

  const satellites = num(esp.satellites ?? esp.sats ?? gps.sats, { min: 0, max: 255, field: 'satellites' });
  const hdop = num(esp.gpsHdop ?? esp.hdop ?? gps.hdop, { min: 0, max: 100, field: 'gpsHdop' });
  const gpsFix = typeof gps.fix === 'boolean' ? gps.fix : null;

  const device = {
    deviceId,
    name: str(tel.identity?.name),
    firmware: str(tel.identity?.fw, 32),
    telemetry: tel.telemetry
  };

  if (!hasCoords) {
    warnings.push('Sin coordenadas: solo se actualizó el estado de la pulsera.');
    return { deviceId, location: null, device, warnings };
  }

  const extraObj = Object.fromEntries(Object.entries(esp).filter(([k]) => !KNOWN.has(k)));
  let extra = Object.keys(extraObj).length ? JSON.stringify(extraObj) : null;
  if (extra && Buffer.byteLength(extra) > MAX_EXTRA_BYTES) {
    extra = null;
    warnings.push('Campos extra descartados (más de 4 KB).');
  }

  const location = {
    userId: user.id,
    groupId: group.id,
    deviceId,
    latitude,
    longitude,
    altitude: num(esp.altitude ?? esp.alt, { field: 'altitude' }),
    speed: num(esp.speed, { min: 0, field: 'speed' }),
    heading: num(esp.heading, { min: 0, max: 360, field: 'heading' }),
    accuracy: num(esp.accuracy, { min: 0, field: 'accuracy' }),
    hdop,
    gpsFix,
    simulated: tel.simulated,
    satellites: satellites === null ? null : Math.round(satellites),
    battery: num(esp.battery, { min: 0, max: 100, field: 'battery' }),
    signal: num(esp.signal ?? esp.rssi, { min: -200, max: 50, field: 'signal' }),
    extra,
    deviceTime: parseTime(esp.timestamp ?? esp.time)
  };

  return { deviceId, location, device, warnings };
}

/** Forma pública de un punto, igual para REST, snapshot y location_update. */
function serialize(loc, member) {
  let extra = loc.extra ?? null;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { extra = null; }
  }
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
    hdop: loc.hdop ?? null,
    gpsFix: loc.gpsFix ?? null,
    simulated: loc.simulated ?? false,
    satellites: loc.satellites,
    battery: loc.battery,
    signal: loc.signal,
    extra,
    deviceTime: loc.deviceTime,
    timestamp: loc.timestamp
  };
}

/**
 * Procesa un reporte: valida, verifica la pulsera, guarda (con límite de frecuencia)
 * y lo retransmite en vivo a todos los conectados del grupo.
 */
async function ingestReport(user, msg) {
  if (!user.groupId) throw new HttpError(400, 'No pertenecés a ningún grupo.', 'NO_GROUP');
  const group = await prisma.group.findUnique({ where: { id: user.groupId } });
  if (!group) throw new HttpError(400, 'No pertenecés a ningún grupo.', 'NO_GROUP');

  const { deviceId, location, device, warnings } = parseReport(msg, user, group);
  await devices.bindDevice(user, deviceId);

  const now = Date.now();
  await devices.touchDevice(user.id, device, now).catch((err) => log.error('[devices] touch', err));

  const liveDevice = {
    userId: user.id,
    deviceId,
    name: device.name,
    firmware: device.firmware,
    lastSeenAt: new Date(now),
    telemetry: device.telemetry
  };

  if (!location) {
    hub.broadcast(group.id, { type: 'device_update', userId: user.id, device: liveDevice });
    return { saved: false, locationId: null, deviceId, warnings };
  }

  const shouldPersist = now - (lastPersisted.get(user.id) || 0) >= config.locationMinIntervalMs;
  let point = { ...location, timestamp: new Date(now) };
  let locationId = null;
  if (shouldPersist) {
    const saved = await prisma.location.create({ data: location });
    lastPersisted.set(user.id, now);
    point = saved;
    locationId = saved.id;
  }

  hub.broadcast(group.id, { type: 'location_update', location: serialize(point, user), device: liveDevice });

  return { saved: shouldPersist, locationId, deviceId, warnings };
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
  if (count) log.info(`[locations] ${count} ubicaciones viejas eliminadas`);
}

function forgetUser(userId) {
  lastPersisted.delete(userId);
}

module.exports = { ingestReport, getLatestLocations, purgeOldLocations, parseReport, serialize, forgetUser };
