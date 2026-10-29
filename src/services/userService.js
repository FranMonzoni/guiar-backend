const prisma = require('../prismaClient');
const config = require('../config');
const { isUniqueViolation } = require('../utils/httpError');

/** Campos del usuario que se devuelven a la propia persona. */
const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  groupId: true,
  createdAt: true,
  group: { select: { id: true, name: true } }
};

function defaultName(email) {
  return email ? email.split('@')[0] : 'Usuario';
}

/**
 * Crea o actualiza el usuario local a partir de los datos de Firebase.
 * Usa upsert para que dos llamadas simultáneas (web abre 2 pestañas, la app
 * se reconecta, etc.) no choquen con la restricción unique de firebaseUid.
 */
async function upsertFromFirebase({ uid, email, name }) {
  const normalizedEmail = email ? email.toLowerCase() : null;
  const isAdminEmail = normalizedEmail && config.adminEmails.includes(normalizedEmail);

  try {
    return await upsertByUid(uid, normalizedEmail, name, isAdminEmail);
  } catch (err) {
    // El email ya existe con otro UID: la cuenta se borró y se volvió a crear en
    // Firebase con el mismo email. Re-vinculamos la fila local al UID nuevo.
    if (normalizedEmail && isUniqueViolation(err, 'email')) {
      await prisma.user.update({ where: { email: normalizedEmail }, data: { firebaseUid: uid } });
      return upsertByUid(uid, normalizedEmail, name, isAdminEmail);
    }
    // Dos requests simultáneas del mismo usuario nuevo: la otra ya lo creó.
    if (isUniqueViolation(err, 'firebaseUid')) return upsertByUid(uid, normalizedEmail, name, isAdminEmail);
    throw err;
  }
}

function upsertByUid(uid, normalizedEmail, name, isAdminEmail) {
  return prisma.user.upsert({
    where: { firebaseUid: uid },
    create: {
      firebaseUid: uid,
      email: normalizedEmail,
      displayName: (name || defaultName(normalizedEmail)).slice(0, 60),
      role: isAdminEmail ? 'ADMIN' : 'USER'
    },
    update: {
      // El email puede cambiar en Firebase; lo mantenemos sincronizado.
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
      ...(isAdminEmail ? { role: 'ADMIN' } : {})
    }
  });
}

async function getPublicUser(id) {
  return prisma.user.findUnique({ where: { id }, select: USER_SELECT });
}

module.exports = { upsertFromFirebase, getPublicUser, USER_SELECT };
