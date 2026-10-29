const prisma = require('../prismaClient');

/**
 * Lista todos los usuarios. Solo admin.
 * GET /api/users
 */
async function getAllUsers(req, res) {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        displayName: true,
        role: true,
        groupId: true,
        createdAt: true,
        group: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ users });
  } catch (err) {
    console.error('[getAllUsers]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

/**
 * Elimina un usuario por ID. Solo admin.
 * DELETE /api/users/:id
 */
async function deleteUser(req, res) {
  const { id } = req.params;

  try {
    await prisma.location.deleteMany({ where: { userId: id } });
    await prisma.user.delete({ where: { id } });
    return res.json({ ok: true, message: 'Usuario eliminado.' });
  } catch (err) {
    console.error('[deleteUser]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

module.exports = { getAllUsers, deleteUser };
