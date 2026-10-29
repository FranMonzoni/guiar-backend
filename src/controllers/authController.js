const prisma = require('../prismaClient');

/**
 * Sincroniza el usuario de Firebase con la base de datos local (SQLite).
 * Si no existe, lo crea. Si existe, devuelve sus datos actualizados.
 * POST /api/auth/sync
 * Headers: Authorization: Bearer <firebase_id_token>
 */
async function syncUser(req, res) {
  const { uid, email, name } = req.firebaseUser;

  try {
    // Buscar o crear el usuario por su Firebase UID
    let user = await prisma.user.findUnique({ where: { firebaseUid: uid } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          firebaseUid: uid,
          email: email || null,
          displayName: name || (email ? email.split('@')[0] : 'Usuario')
        }
      });
    }

    // Devolver usuario con datos del grupo si tiene
    const userWithGroup = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        firebaseUid: true,
        email: true,
        displayName: true,
        role: true,
        groupId: true,
        createdAt: true,
        group: { select: { id: true, name: true, joinKey: true } }
      }
    });

    return res.json({ user: userWithGroup });
  } catch (err) {
    console.error('[syncUser]', err);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
}

module.exports = { syncUser };
