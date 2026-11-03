/**
 * Pulseras vinculadas.
 *
 * Regla: cada usuario tiene como máximo UNA pulsera y cada pulsera pertenece a UN usuario.
 * La pulsera se vincula sola la primera vez que la app manda datos con su deviceId.
 * Si después llega otro deviceId desde la misma cuenta, se rechaza (DEVICE_MISMATCH);
 * para cambiar de pulsera hay que desvincular la actual (DELETE /api/devices/me).
 */
const prisma = require('../prismaClient');
const hub = require('../websocket/hub');
const { HttpError, isUniqueViolation } = require('../utils/httpError');
const { log } = require('../utils/log');

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const TOUCH_INTERVAL_MS = 5000; // como máximo una escritura del estado de la pulsera cada 5 s

// userId → deviceId ya verificado (evita consultar la base en cada mensaje)
const bound = new Map();
// userId → último momento en que se escribió el estado en la base
const lastTouch = new Map();
// userId → { state, timer }: el estado más nuevo que todavía no se escribió
const pending = new Map();

function normalizeDeviceId(value) {
  const id = String(value ?? '').trim();
  if (!id) throw new HttpError(400, 'Falta "esp.deviceId".', 'MISSING_DEVICE_ID');
  if (!DEVICE_ID_RE.test(id)) {
    throw new HttpError(400, '"esp.deviceId" solo admite letras, números y . _ : - (máx. 64).', 'INVALID_DEVICE_ID');
  }
  return id;
}

/**
 * Comprueba que `deviceId` sea la pulsera del usuario y la vincula si no tiene ninguna.
 * Lanza 409 si el usuario ya tiene otra pulsera o si la pulsera es de otra cuenta.
 */
async function bindDevice(user, deviceId) {
  if (bound.get(user.id) === deviceId) return;

  const [mine, owner] = await Promise.all([
    prisma.device.findUnique({ where: { userId: user.id } }),
    prisma.device.findUnique({ where: { deviceId } })
  ]);

  if (mine && mine.deviceId !== deviceId) {
    throw new HttpError(
      409,
      `Tu cuenta ya tiene vinculada la pulsera "${mine.deviceId}". Desvinculala desde la web para usar otra.`,
      'DEVICE_MISMATCH'
    );
  }
  if (owner && owner.userId !== user.id) {
    throw new HttpError(409, `La pulsera "${deviceId}" está vinculada a otra cuenta.`, 'DEVICE_IN_USE');
  }

  if (!mine) {
    try {
      await prisma.device.create({ data: { deviceId, userId: user.id } });
    } catch (err) {
      // Dos mensajes simultáneos: el otro la creó primero. Se vuelve a validar.
      if (isUniqueViolation(err, 'deviceId') || isUniqueViolation(err, 'userId')) {
        bound.delete(user.id);
        return bindDevice(user, deviceId);
      }
      throw err;
    }
  }
  bound.set(user.id, deviceId);
}

async function writeDevice(userId, { name, firmware, telemetry, at }) {
  lastTouch.set(userId, at);
  await prisma.device.updateMany({
    where: { userId },
    data: {
      lastSeenAt: new Date(at),
      ...(name ? { name } : {}),
      ...(firmware ? { firmware } : {}),
      ...(telemetry ? { telemetry: JSON.stringify(telemetry) } : {})
    }
  });
}

/**
 * Guarda nombre, firmware, última conexión y telemetría, como máximo una vez cada 5 s.
 * Lo que llega dentro de esa ventana no se pierde: el estado más nuevo se escribe
 * al terminar la ventana.
 */
async function touchDevice(userId, state, now = Date.now()) {
  const entry = { ...state, at: now };
  const wait = TOUCH_INTERVAL_MS - (now - (lastTouch.get(userId) || 0));
  if (wait <= 0) {
    const p = pending.get(userId);
    if (p) { clearTimeout(p.timer); pending.delete(userId); }
    return writeDevice(userId, entry);
  }
  const p = pending.get(userId);
  if (p) {
    // Mantiene nombre/firmware/telemetría anteriores si el mensaje nuevo no los trae.
    p.state = { ...p.state, ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v != null)) };
    return;
  }
  const slot = { state: entry };
  slot.timer = setTimeout(() => {
    pending.delete(userId);
    writeDevice(userId, slot.state).catch((err) => log.error('[devices] write', err));
  }, wait);
  slot.timer.unref?.();
  pending.set(userId, slot);
}

/** Suma lo que todavía está en memoria sin escribir, así las lecturas nunca quedan atrasadas. */
function withPending(d) {
  const p = d && pending.get(d.userId);
  if (!p) return d;
  const { name, firmware, telemetry, at } = p.state;
  return {
    ...d,
    name: name ?? d.name,
    firmware: firmware ?? d.firmware,
    telemetry: telemetry ?? d.telemetry,
    lastSeenAt: new Date(at)
  };
}

function serializeDevice(raw) {
  const d = withPending(raw);
  if (!d) return null;
  let telemetry = null;
  if (typeof d.telemetry === 'string') {
    try { telemetry = JSON.parse(d.telemetry); } catch { telemetry = null; }
  } else if (d.telemetry) {
    telemetry = d.telemetry;
  }
  return {
    deviceId: d.deviceId,
    name: d.name ?? null,
    firmware: d.firmware ?? null,
    lastSeenAt: d.lastSeenAt ?? null,
    telemetry
  };
}

async function getMyDevice(userId) {
  return serializeDevice(await prisma.device.findUnique({ where: { userId } }));
}

/** Pulseras de los miembros del grupo: [{ userId, ...device }]. */
async function getGroupDevices(groupId) {
  const devices = await prisma.device.findMany({ where: { user: { groupId } } });
  return devices.map((d) => ({ userId: d.userId, ...serializeDevice(d) }));
}

async function unlinkDevice(user) {
  const { count } = await prisma.device.deleteMany({ where: { userId: user.id } });
  forgetDevice(user.id);
  if (!count) throw new HttpError(404, 'No tenés ninguna pulsera vinculada.', 'NO_DEVICE');
  if (user.groupId) hub.broadcast(user.groupId, { type: 'device_update', userId: user.id, device: null });
}

function forgetDevice(userId) {
  bound.delete(userId);
  lastTouch.delete(userId);
  const p = pending.get(userId);
  if (p) { clearTimeout(p.timer); pending.delete(userId); }
}

module.exports = {
  normalizeDeviceId,
  bindDevice,
  touchDevice,
  serializeDevice,
  getMyDevice,
  getGroupDevices,
  unlinkDevice,
  forgetDevice
};
