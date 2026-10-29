const prisma = require('../prismaClient');
const firebaseAuth = require('../firebase/firebaseAdmin');
const firebaseRest = require('../services/firebaseRest');
const { upsertFromFirebase, getPublicUser } = require('../services/userService');
const { HttpError } = require('../utils/httpError');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readCredentials(body) {
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email inválido.', 'INVALID_EMAIL');
  if (password.length < 6) throw new HttpError(400, 'La contraseña debe tener al menos 6 caracteres.', 'WEAK_PASSWORD');
  return { email, password };
}

function cleanName(name) {
  const n = String(name || '').trim();
  return n ? n.slice(0, 60) : null;
}

/**
 * POST /api/auth/register  { email, password, displayName? }
 * Crea la cuenta en Firebase y en la base local. Devuelve la sesión.
 */
async function register(req, res) {
  const { email, password } = readCredentials(req.body);
  const displayName = cleanName(req.body.displayName);

  const session = await firebaseRest.signUp(email, password);
  if (displayName) {
    await firebaseAuth.updateUser(session.uid, { displayName }).catch(() => {});
  }
  const dbUser = await upsertFromFirebase({ uid: session.uid, email, name: displayName });

  res.status(201).json({ ...session, user: await getPublicUser(dbUser.id) });
}

/**
 * POST /api/auth/login  { email, password }
 * Pensado para la app móvil. Devuelve idToken (1 h) + refreshToken.
 */
async function login(req, res) {
  const { email, password } = readCredentials(req.body);
  const session = await firebaseRest.signIn(email, password);
  const dbUser = await upsertFromFirebase({ uid: session.uid, email: session.email });

  res.json({ ...session, user: await getPublicUser(dbUser.id) });
}

/**
 * POST /api/auth/refresh  { refreshToken }
 * Renueva el idToken vencido sin volver a pedir la contraseña.
 */
async function refresh(req, res) {
  const refreshToken = String(req.body?.refreshToken || '');
  if (!refreshToken) throw new HttpError(400, 'refreshToken es requerido.', 'MISSING_REFRESH_TOKEN');
  res.json(await firebaseRest.refresh(refreshToken));
}

/**
 * POST /api/auth/password-reset  { email }
 * Siempre responde ok (no revela si el email existe).
 */
async function passwordReset(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Email inválido.', 'INVALID_EMAIL');
  await firebaseRest.sendPasswordReset(email).catch(() => {});
  res.json({ ok: true });
}

/**
 * GET|POST /api/auth/me (alias: /api/auth/sync)
 * Devuelve el usuario actual. authMiddleware ya lo creó si no existía.
 */
async function me(req, res) {
  res.json({ user: await getPublicUser(req.user.id) });
}

/**
 * PATCH /api/auth/me  { displayName }
 */
async function updateMe(req, res) {
  const displayName = cleanName(req.body?.displayName);
  if (!displayName) throw new HttpError(400, 'El nombre no puede estar vacío.', 'INVALID_NAME');

  await prisma.user.update({ where: { id: req.user.id }, data: { displayName } });
  await firebaseAuth.updateUser(req.user.firebaseUid, { displayName }).catch(() => {});
  res.json({ user: await getPublicUser(req.user.id) });
}

module.exports = { register, login, refresh, passwordReset, me, updateMe };
