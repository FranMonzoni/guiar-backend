const prisma = require('../prismaClient');

async function getDbUser(firebaseUid) {
  return prisma.user.findUnique({ where: { firebaseUid } });
}

/**
 * Registra una ubicación GPS enviada por la app móvil.
 * POST /api/locations
 * Body: { latitude, longitude, deviceId? }
 */
async function reportLocation(req, res) {
  const { latitude, longitude, deviceId } = req.body;
  const dbUser = await getDbUser(req.firebaseUser.uid);

  if (!dbUser) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (latitude === undefined || longitude === undefined)
    return res.status(400).json({ error: 'latitude y longitude son requeridos.' });
  if (typeof latitude !== 'number' || typeof longitude !== 'number')
    return res.status(400).json({ error: 'latitude y longitude deben ser números.' });
  if (!dbUser.groupId)
    return res.status(400).json({ error: 'El usuario no pertenece a ningún grupo.' });

  try {
    const location = await prisma.location.create({
      data: {
        userId:    dbUser.id,
        groupId:   dbUser.groupId,
        latitude,
        longitude,
        deviceId:  deviceId || 'unknown'
      }
    });

    return res.status(201).json({ location });
  } catch (err) {
    console.error('[reportLocation]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

/**
 * Devuelve la última ubicación de cada miembro del grupo del usuario.
 * GET /api/groups/me/locations
 */
async function getGroupLocations(req, res) {
  const dbUser = await getDbUser(req.firebaseUser.uid);

  if (!dbUser) return res.status(404).json({ error: 'Usuario no encontrado.' });
  if (!dbUser.groupId) return res.status(404).json({ error: 'No pertenecés a ningún grupo.' });

  try {
    const group = await prisma.group.findUnique({
      where: { id: dbUser.groupId },
      include: { members: { select: { id: true, displayName: true, email: true } } }
    });

    const locationsPromises = group.members.map(async (member) => {
      const last = await prisma.location.findFirst({
        where: { userId: member.id, groupId: dbUser.groupId },
        orderBy: { timestamp: 'desc' }
      });

      return {
        userId:      member.id,
        displayName: member.displayName,
        email:       member.email,
        latitude:    last?.latitude ?? null,
        longitude:   last?.longitude ?? null,
        deviceId:    last?.deviceId ?? null,
        timestamp:   last?.timestamp ?? null
      };
    });

    const locations = await Promise.all(locationsPromises);
    return res.json({ groupId: dbUser.groupId, locations });
  } catch (err) {
    console.error('[getGroupLocations]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

/**
 * Ubicaciones de un grupo específico. Solo admin.
 * GET /api/groups/:id/locations
 */
async function getGroupLocationsByAdmin(req, res) {
  const { id } = req.params;

  try {
    const locations = await prisma.location.findMany({
      where: { groupId: id },
      include: { user: { select: { id: true, displayName: true, email: true } } },
      orderBy: { timestamp: 'desc' },
      take: 200
    });

    return res.json({ locations });
  } catch (err) {
    console.error('[getGroupLocationsByAdmin]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

module.exports = { reportLocation, getGroupLocations, getGroupLocationsByAdmin };
