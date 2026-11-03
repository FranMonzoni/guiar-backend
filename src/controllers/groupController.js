const groups = require('../services/groupService');
const { getLatestLocations } = require('../services/locationService');
const { getGroupDevices } = require('../services/deviceService');
const { HttpError } = require('../utils/httpError');

function requireGroup(user) {
  if (!user.groupId) throw new HttpError(404, 'No pertenecés a ningún grupo.', 'NO_GROUP');
  return user.groupId;
}

/** POST /api/groups  { name } — crea un grupo; el usuario queda como owner y primer miembro. */
async function createGroup(req, res) {
  res.status(201).json({ group: await groups.createGroup(req.user, req.body?.name) });
}

/** POST /api/groups/join  { code }  (acepta también { joinKey } por compatibilidad) */
async function joinGroup(req, res) {
  const code = req.body?.code ?? req.body?.inviteCode ?? req.body?.joinKey;
  res.json({ group: await groups.joinGroup(req.user, code) });
}

/**
 * GET /api/groups/me — mi grupo para la app y la web.
 * Respuesta PLANA (sin envolver en "group"):
 *   { id, name, encryption: { algorithm, key, encoding, keyVersion, rotatedAt },
 *     inviteCode, ownerId, owner, createdAt, memberCount, members }
 * El usuario sale del token; solo se entrega la clave si es miembro.
 * Sin grupo → 404 { code: "NO_GROUP" }.
 */
async function getMyGroup(req, res) {
  const groupId = requireGroup(req.user);
  const group = await groups.getGroupForMember(groupId);
  if (!group) throw new HttpError(404, 'No pertenecés a ningún grupo.', 'NO_GROUP');
  res.json(group);
}

/** POST /api/groups/me/encryption/rotate — renueva la clave a mano. Solo owner. */
async function rotateKey(req, res) {
  res.json({ group: await groups.rotateKey(req.user) });
}

/** PATCH /api/groups/me  { name } — solo owner */
async function renameGroup(req, res) {
  res.json({ group: await groups.renameGroup(req.user, req.body?.name) });
}

/** POST /api/groups/me/leave */
async function leaveGroup(req, res) {
  const result = await groups.removeFromGroup(req.user.id);
  res.json({ ok: true, groupDeleted: result.groupDeleted });
}

/** POST /api/groups/me/invite-code — genera un código nuevo (el anterior deja de servir). Solo owner. */
async function regenerateCode(req, res) {
  res.json({ group: await groups.regenerateInviteCode(req.user) });
}

/** DELETE /api/groups/me/members/:userId — expulsa a un miembro. Solo owner. */
async function kickMember(req, res) {
  res.json({ group: await groups.kickMember(req.user, req.params.userId) });
}

/** GET /api/groups/me/locations — última ubicación de cada miembro (para el mapa). */
async function getMyLocations(req, res) {
  const groupId = requireGroup(req.user);
  const [locations, devices] = await Promise.all([getLatestLocations(groupId), getGroupDevices(groupId)]);
  res.json({ groupId, locations, devices });
}

module.exports = {
  createGroup,
  joinGroup,
  getMyGroup,
  renameGroup,
  leaveGroup,
  regenerateCode,
  rotateKey,
  kickMember,
  getMyLocations
};
