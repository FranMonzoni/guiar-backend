const { randomBytes, randomInt } = require('crypto');
const prisma = require('../prismaClient');
const hub = require('../websocket/hub');
const { HttpError, isUniqueViolation } = require('../utils/httpError');

// Sin 0/O, 1/I/L para que el código se pueda dictar o tipear sin errores.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

// Códigos de cierre del WebSocket (rango 4000-4999 = propios de la app)
const WS_CLOSE = {
  UNAUTHORIZED: 4001,
  NO_GROUP: 4003,
  LEFT_GROUP: 4004,
  GROUP_DELETED: 4005
};

function generateInviteCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** 32 bytes aleatorios = clave AES-256. Se guarda en hex y se entrega en base64. */
function generateEncryptionKey() {
  return randomBytes(32).toString('hex');
}

/**
 * Bloque de cifrado que reciben los miembros (GET /api/groups/me).
 * La app lo pasa a la pulsera por BLE; `keyVersion` permite saber si la pulsera
 * tiene la clave vigente.
 */
function encryptionFor(group) {
  return {
    algorithm: 'AES-256',
    key: Buffer.from(group.encryptionKey, 'hex').toString('base64'),
    encoding: 'base64',
    keyVersion: group.keyVersion ?? 1,
    rotatedAt: group.keyRotatedAt ?? null
  };
}

/** Datos para renovar la clave dentro de un update de Prisma. */
function rotatedKeyData() {
  return { encryptionKey: generateEncryptionKey(), keyVersion: { increment: 1 }, keyRotatedAt: new Date() };
}

/** "k7p3-qx9m " → "K7P3QX9M" */
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Reintenta si el código aleatorio choca con uno existente (muy improbable). */
async function withUniqueCode(fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn(generateInviteCode());
    } catch (err) {
      if (!isUniqueViolation(err, 'inviteCode')) throw err;
    }
  }
  throw new HttpError(500, 'No se pudo generar un código único. Intentá de nuevo.');
}

const MEMBER_SELECT = { id: true, displayName: true, email: true, joinedAt: true };

/**
 * Grupo completo para un MIEMBRO (incluye la clave de cifrado en `encryption`).
 * Nunca usar en respuestas del panel de administración.
 */
async function getGroupForMember(groupId) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      members: { select: MEMBER_SELECT, orderBy: { joinedAt: 'asc' } },
      owner: { select: { id: true, displayName: true } }
    }
  });
  if (!group) return null;

  const online = new Set(hub.onlineUserIds(groupId));
  return {
    id: group.id,
    name: group.name,
    inviteCode: group.inviteCode,
    encryption: encryptionFor(group),
    ownerId: group.ownerId,
    owner: group.owner,
    createdAt: group.createdAt,
    memberCount: group.members.length,
    members: group.members.map((m) => ({
      ...m,
      isOwner: m.id === group.ownerId,
      online: online.has(m.id)
    }))
  };
}

function cleanGroupName(name) {
  const n = String(name || '').trim();
  if (!n) throw new HttpError(400, 'El nombre del grupo es requerido.', 'INVALID_NAME');
  return n.slice(0, 60);
}

async function createGroup(user, name) {
  const groupName = cleanGroupName(name);

  const groupId = await withUniqueCode((inviteCode) =>
    prisma.$transaction(async (tx) => {
      const group = await tx.group.create({
        data: {
          name: groupName,
          inviteCode,
          encryptionKey: generateEncryptionKey(),
          ownerId: user.id
        }
      });
      // Igual que en joinGroup: solo asigna si el usuario sigue sin grupo. Si otra
      // request lo metió en un grupo mientras tanto, la transacción se deshace entera.
      const { count } = await tx.user.updateMany({
        where: { id: user.id, groupId: null },
        data: { groupId: group.id, joinedAt: new Date() }
      });
      if (count === 0) {
        throw new HttpError(409, 'Ya pertenecés a un grupo. Salí primero para crear otro.', 'ALREADY_IN_GROUP');
      }
      return group.id;
    })
  );

  return getGroupForMember(groupId);
}

async function joinGroup(user, rawCode) {
  const inviteCode = normalizeCode(rawCode);
  if (!inviteCode) throw new HttpError(400, 'El código del grupo es requerido.', 'MISSING_CODE');

  const group = await prisma.group.findUnique({ where: { inviteCode } });
  if (!group) throw new HttpError(404, 'Código de grupo inválido.', 'INVALID_CODE');

  // updateMany con groupId: null es atómico: si dos requests llegan juntas,
  // solo una puede asignar el grupo. Así se garantiza "un grupo por persona".
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, groupId: null },
    data: { groupId: group.id, joinedAt: new Date() }
  });
  if (count === 0) {
    throw new HttpError(409, 'Ya pertenecés a un grupo. Salí primero para unirte a otro.', 'ALREADY_IN_GROUP');
  }

  hub.broadcast(group.id, {
    type: 'member_joined',
    member: { id: user.id, displayName: user.displayName, email: user.email, isOwner: false, online: false }
  });

  return getGroupForMember(group.id);
}

/**
 * Saca a un usuario de su grupo. Borra sus ubicaciones en ese grupo.
 * Si era el owner, el miembro más antiguo pasa a ser owner.
 * Si era el último miembro, el grupo se elimina.
 * Si el grupo sigue, la clave de cifrado se RENUEVA (keyVersion + 1): quien salió
 * conocía la anterior. A los que quedan les llega `key_rotated` por WebSocket.
 */
async function removeFromGroup(userId, { reason = 'Saliste del grupo.' } = {}) {
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user?.groupId) throw new HttpError(404, 'No pertenecés a ningún grupo.', 'NO_GROUP');

    const groupId = user.groupId;
    const group = await tx.group.findUnique({ where: { id: groupId } });

    await tx.location.deleteMany({ where: { userId, groupId } });
    await tx.user.update({ where: { id: userId }, data: { groupId: null, joinedAt: null } });

    const next = await tx.user.findFirst({ where: { groupId }, orderBy: { joinedAt: 'asc' } });
    if (!next) {
      await tx.group.delete({ where: { id: groupId } });
      return { groupId, groupDeleted: true, newOwnerId: null };
    }
    const newOwnerId = group.ownerId === userId ? next.id : null;
    const updated = await tx.group.update({
      where: { id: groupId },
      data: { ...rotatedKeyData(), ...(newOwnerId ? { ownerId: newOwnerId } : {}) }
    });
    return { groupId, groupDeleted: false, newOwnerId, keyVersion: updated.keyVersion };
  });

  hub.closeUser(result.groupId, userId, WS_CLOSE.LEFT_GROUP, reason);
  if (!result.groupDeleted) {
    hub.broadcast(result.groupId, { type: 'member_left', userId, newOwnerId: result.newOwnerId });
    hub.broadcast(result.groupId, { type: 'key_rotated', keyVersion: result.keyVersion, reason: 'member_left' });
  }
  return result;
}

async function assertOwner(user) {
  if (!user.groupId) throw new HttpError(404, 'No pertenecés a ningún grupo.', 'NO_GROUP');
  const group = await prisma.group.findUnique({ where: { id: user.groupId } });
  if (group.ownerId !== user.id) {
    throw new HttpError(403, 'Solo el creador del grupo puede hacer esto.', 'NOT_OWNER');
  }
  return group;
}

async function kickMember(owner, memberId) {
  const group = await assertOwner(owner);
  if (memberId === owner.id) throw new HttpError(400, 'No podés expulsarte a vos mismo. Usá "Salir del grupo".', 'CANNOT_KICK_SELF');

  const member = await prisma.user.findUnique({ where: { id: memberId } });
  if (!member || member.groupId !== group.id) throw new HttpError(404, 'Ese usuario no es miembro del grupo.', 'NOT_A_MEMBER');

  await removeFromGroup(memberId, { reason: 'Te quitaron del grupo.' });
  return getGroupForMember(group.id);
}

async function regenerateInviteCode(owner) {
  const group = await assertOwner(owner);
  await withUniqueCode((inviteCode) => prisma.group.update({ where: { id: group.id }, data: { inviteCode } }));
  return getGroupForMember(group.id);
}

/** El creador renueva la clave a mano (por ejemplo, si cree que se filtró). */
async function rotateKey(owner) {
  const group = await assertOwner(owner);
  const updated = await prisma.group.update({ where: { id: group.id }, data: rotatedKeyData() });
  hub.broadcast(group.id, { type: 'key_rotated', keyVersion: updated.keyVersion, reason: 'manual' });
  return getGroupForMember(group.id);
}

async function renameGroup(owner, name) {
  const group = await assertOwner(owner);
  const updated = await prisma.group.update({ where: { id: group.id }, data: { name: cleanGroupName(name) } });
  hub.broadcast(group.id, { type: 'group_renamed', name: updated.name });
  return getGroupForMember(group.id);
}

/** Admin: elimina un grupo completo (miembros quedan sin grupo, ubicaciones se borran). */
async function deleteGroup(groupId) {
  const exists = await prisma.group.findUnique({ where: { id: groupId } });
  if (!exists) throw new HttpError(404, 'Grupo no encontrado.', 'GROUP_NOT_FOUND');

  await prisma.$transaction([
    prisma.user.updateMany({ where: { groupId }, data: { groupId: null, joinedAt: null } }),
    prisma.group.delete({ where: { id: groupId } }) // Location → onDelete: Cascade
  ]);
  hub.closeGroup(groupId, WS_CLOSE.GROUP_DELETED, 'Un administrador eliminó el grupo.');
}

module.exports = {
  WS_CLOSE,
  normalizeCode,
  getGroupForMember,
  createGroup,
  joinGroup,
  removeFromGroup,
  kickMember,
  regenerateInviteCode,
  rotateKey,
  renameGroup,
  deleteGroup
};
