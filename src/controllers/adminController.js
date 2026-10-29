/**
 * Panel de administración.
 * IMPORTANTE: ningún endpoint de este archivo devuelve coordenadas ni la clave
 * de cifrado de los grupos. El admin ve QUÉ grupos existen y QUIÉN está en
 * cada uno, pero nunca DÓNDE están.
 */
const prisma = require('../prismaClient');
const firebaseAuth = require('../firebase/firebaseAdmin');
const hub = require('../websocket/hub');
const groups = require('../services/groupService');
const { HttpError } = require('../utils/httpError');

async function lastActivityByGroup() {
  const rows = await prisma.location.groupBy({ by: ['groupId'], _max: { timestamp: true } });
  return new Map(rows.map((r) => [r.groupId, r._max.timestamp]));
}

/** GET /api/admin/stats */
async function stats(req, res) {
  const [users, groupsCount, usersWithoutGroup, admins] = await Promise.all([
    prisma.user.count(),
    prisma.group.count(),
    prisma.user.count({ where: { groupId: null } }),
    prisma.user.count({ where: { role: 'ADMIN' } })
  ]);
  res.json({ users, groups: groupsCount, usersWithoutGroup, admins, ...hub.stats() });
}

/** GET /api/admin/groups?search=texto */
async function listGroups(req, res) {
  const search = String(req.query.search || '').trim();
  const where = search
    ? { OR: [{ name: { contains: search } }, { id: { contains: search } }, { owner: { email: { contains: search.toLowerCase() } } }] }
    : {};

  const [list, activity] = await Promise.all([
    prisma.group.findMany({
      where,
      select: {
        id: true,
        name: true,
        createdAt: true,
        owner: { select: { id: true, displayName: true, email: true } },
        _count: { select: { members: true } }
      },
      orderBy: { createdAt: 'desc' }
    }),
    lastActivityByGroup()
  ]);

  res.json({
    groups: list.map((g) => ({
      id: g.id,
      name: g.name,
      createdAt: g.createdAt,
      owner: g.owner,
      memberCount: g._count.members,
      onlineCount: hub.onlineUserIds(g.id).length,
      lastActivityAt: activity.get(g.id) ?? null
    }))
  });
}

/** GET /api/admin/groups/:id — detalle con miembros (sin ubicaciones). */
async function getGroup(req, res) {
  const g = await prisma.group.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      ownerId: true,
      members: { select: { id: true, displayName: true, email: true, joinedAt: true }, orderBy: { joinedAt: 'asc' } }
    }
  });
  if (!g) throw new HttpError(404, 'Grupo no encontrado.');

  const online = new Set(hub.onlineUserIds(g.id));
  const activity = await prisma.location.aggregate({ where: { groupId: g.id }, _max: { timestamp: true } });

  res.json({
    group: {
      ...g,
      lastActivityAt: activity._max.timestamp,
      members: g.members.map((m) => ({ ...m, isOwner: m.id === g.ownerId, online: online.has(m.id) }))
    }
  });
}

/** DELETE /api/admin/groups/:id */
async function deleteGroup(req, res) {
  await groups.deleteGroup(req.params.id);
  res.json({ ok: true });
}

/** GET /api/admin/users?search=texto */
async function listUsers(req, res) {
  const search = String(req.query.search || '').trim();
  const where = search
    ? { OR: [{ displayName: { contains: search } }, { email: { contains: search.toLowerCase() } }] }
    : {};

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      createdAt: true,
      group: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json({ users });
}

/** PATCH /api/admin/users/:id  { role: "ADMIN" | "USER" } */
async function updateUser(req, res) {
  const { role } = req.body || {};
  if (!['ADMIN', 'USER'].includes(role)) throw new HttpError(400, 'role debe ser "ADMIN" o "USER".');
  if (req.params.id === req.user.id && role !== 'ADMIN') {
    throw new HttpError(400, 'No podés quitarte el rol de admin a vos mismo.');
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { role },
    select: { id: true, email: true, displayName: true, role: true }
  }).catch(() => { throw new HttpError(404, 'Usuario no encontrado.'); });

  res.json({ user });
}

/**
 * DELETE /api/admin/users/:id
 * Saca al usuario de su grupo (transfiriendo el owner si hace falta),
 * borra sus datos locales y su cuenta de Firebase.
 */
async function deleteUser(req, res) {
  if (req.params.id === req.user.id) throw new HttpError(400, 'No podés eliminar tu propia cuenta desde el panel.');

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) throw new HttpError(404, 'Usuario no encontrado.');

  if (user.groupId) await groups.removeFromGroup(user.id, { reason: 'Tu cuenta fue eliminada.' });
  await prisma.user.delete({ where: { id: user.id } }); // Location → onDelete: Cascade

  let firebaseDeleted = true;
  await firebaseAuth.deleteUser(user.firebaseUid).catch(() => { firebaseDeleted = false; });

  res.json({ ok: true, firebaseDeleted });
}

module.exports = { stats, listGroups, getGroup, deleteGroup, listUsers, updateUser, deleteUser };
