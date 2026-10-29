const prisma = require('../prismaClient');
const { randomBytes } = require('crypto');

function generateJoinKey() {
  return randomBytes(4).toString('hex').toUpperCase(); // Ej: "A3F2B9C1"
}

/**
 * Obtiene el usuario de la DB a partir del firebaseUid del token verificado.
 */
async function getDbUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

/**
 * Crea un nuevo grupo. El usuario se convierte en dueño y primer miembro.
 * POST /api/groups
 * Body: { name }
 */
async function createGroup(req, res) {
  const { name } = req.body;
  const dbUser = await getDbUser(req.firebaseUser.uid);

  if (!dbUser) return res.status(404).json({ error: 'Usuario no encontrado. Iniciá sesión nuevamente.' });
  if (!name || name.trim().length === 0) return res.status(400).json({ error: 'El nombre del grupo es requerido.' });
  if (dbUser.groupId) return res.status(409).json({ error: 'Ya pertenecés a un grupo. Salí primero para crear uno nuevo.' });

  try {
    const joinKey = generateJoinKey();

    const group = await prisma.group.create({
      data: {
        name: name.trim(),
        joinKey,
        ownerId: dbUser.id,
        members: { connect: { id: dbUser.id } }
      },
      include: {
        members: { select: { id: true, displayName: true, email: true, role: true } },
        owner:   { select: { id: true, displayName: true } }
      }
    });

    await prisma.user.update({ where: { id: dbUser.id }, data: { groupId: group.id } });

    return res.status(201).json({ group });
  } catch (err) {
    console.error('[createGroup]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

/**
 * Une al usuario a un grupo existente usando la joinKey.
 * POST /api/groups/join
 * Body: { joinKey }
 */
async function joinGroup(req, res) {
  const { joinKey } = req.body;
  const dbUser = await getDbUser(req.firebaseUser.uid);

  if (!dbUser) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (!joinKey) return res.status(400).json({ error: 'La clave del grupo es requerida.' });
  if (dbUser.groupId) return res.status(409).json({ error: 'Ya pertenecés a un grupo.' });

  try {
    const group = await prisma.group.findUnique({ where: { joinKey } });
    if (!group) return res.status(404).json({ error: 'Clave de grupo inválida.' });

    await prisma.user.update({
      where: { id: dbUser.id },
      data: { groupId: group.id, group: { connect: { id: group.id } } }
    });

    const updatedGroup = await prisma.group.findUnique({
      where: { id: group.id },
      include: {
        members: { select: { id: true, displayName: true, email: true, role: true } },
        owner:   { select: { id: true, displayName: true } }
      }
    });

    return res.json({ group: updatedGroup });
  } catch (err) {
    console.error('[joinGroup]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

/**
 * Devuelve el grupo actual del usuario con sus miembros.
 * GET /api/groups/me
 */
async function getMyGroup(req, res) {
  const dbUser = await getDbUser(req.firebaseUser.uid);

  if (!dbUser) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (!dbUser.groupId) return res.status(404).json({ error: 'No pertenecés a ningún grupo.' });

  try {
    const group = await prisma.group.findUnique({
      where: { id: dbUser.groupId },
      include: {
        members: { select: { id: true, displayName: true, email: true, role: true } },
        owner:   { select: { id: true, displayName: true } },
        _count:  { select: { members: true } }
      }
    });

    return res.json({ group });
  } catch (err) {
    console.error('[getMyGroup]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

/**
 * Lista todos los grupos. Solo para admin.
 * GET /api/groups
 */
async function getAllGroups(req, res) {
  try {
    const groups = await prisma.group.findMany({
      include: {
        owner:  { select: { id: true, displayName: true, email: true } },
        _count: { select: { members: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ groups });
  } catch (err) {
    console.error('[getAllGroups]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

/**
 * Elimina un grupo por ID. Solo para admin.
 * DELETE /api/groups/:id
 */
async function deleteGroup(req, res) {
  const { id } = req.params;

  try {
    await prisma.user.updateMany({ where: { groupId: id }, data: { groupId: null } });
    await prisma.location.deleteMany({ where: { groupId: id } });
    await prisma.group.delete({ where: { id } });

    return res.json({ ok: true, message: 'Grupo eliminado.' });
  } catch (err) {
    console.error('[deleteGroup]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

module.exports = { createGroup, joinGroup, getMyGroup, getAllGroups, deleteGroup };
