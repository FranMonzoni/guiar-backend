/**
 * Login por REST contra Firebase Auth (Identity Toolkit).
 *
 * Permite que la app móvil (o cualquier cliente sin el SDK de Firebase) se
 * autentique solo con HTTP: el backend le pide el token a Firebase y se lo
 * devuelve. El resto de la API se usa igual que desde la web:
 *   Authorization: Bearer <idToken>
 *
 * Docs: https://firebase.google.com/docs/reference/rest/auth
 */
const config = require('../config');
const { HttpError } = require('../utils/httpError');

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token';

// Códigos de error de Firebase → [status HTTP, mensaje]
const ERRORS = {
  EMAIL_EXISTS:               [409, 'Ese email ya está registrado.'],
  EMAIL_NOT_FOUND:            [401, 'Email o contraseña incorrectos.'],
  INVALID_PASSWORD:           [401, 'Email o contraseña incorrectos.'],
  INVALID_LOGIN_CREDENTIALS:  [401, 'Email o contraseña incorrectos.'],
  INVALID_EMAIL:              [400, 'El formato del email no es válido.'],
  WEAK_PASSWORD:              [400, 'La contraseña debe tener al menos 6 caracteres.'],
  MISSING_PASSWORD:           [400, 'La contraseña es requerida.'],
  USER_DISABLED:              [403, 'La cuenta está deshabilitada.'],
  TOO_MANY_ATTEMPTS_TRY_LATER:[429, 'Demasiados intentos. Probá más tarde.'],
  TOKEN_EXPIRED:              [401, 'La sesión expiró. Iniciá sesión de nuevo.'],
  INVALID_REFRESH_TOKEN:      [401, 'Refresh token inválido. Iniciá sesión de nuevo.'],
  USER_NOT_FOUND:             [401, 'La cuenta ya no existe.']
};

function requireApiKey() {
  if (!config.firebaseWebApiKey) {
    throw new HttpError(500, 'Falta FIREBASE_WEB_API_KEY en el .env del backend.', 'CONFIG');
  }
  return config.firebaseWebApiKey;
}

async function call(url, body, { form = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body)
    });
  } catch (err) {
    throw new HttpError(502, 'No se pudo contactar a Firebase.', 'FIREBASE_UNREACHABLE');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // "WEAK_PASSWORD : Password should be at least 6 characters" → "WEAK_PASSWORD"
    const fbCode = String(data?.error?.message || 'UNKNOWN').split(' ')[0];
    const [status, message] = ERRORS[fbCode] || [400, 'No se pudo autenticar.'];
    throw new HttpError(status, message, fbCode);
  }
  return data;
}

/** Normaliza la respuesta para que login/register/refresh devuelvan lo mismo. */
function session({ idToken, refreshToken, expiresIn, uid, email }) {
  return {
    idToken,
    refreshToken,
    expiresIn: Number(expiresIn), // segundos (Firebase: 3600)
    uid,
    email
  };
}

async function signUp(email, password) {
  const key = requireApiKey();
  const d = await call(`${IDENTITY}:signUp?key=${key}`, { email, password, returnSecureToken: true });
  return session({ idToken: d.idToken, refreshToken: d.refreshToken, expiresIn: d.expiresIn, uid: d.localId, email: d.email });
}

async function signIn(email, password) {
  const key = requireApiKey();
  const d = await call(`${IDENTITY}:signInWithPassword?key=${key}`, { email, password, returnSecureToken: true });
  return session({ idToken: d.idToken, refreshToken: d.refreshToken, expiresIn: d.expiresIn, uid: d.localId, email: d.email });
}

async function refresh(refreshToken) {
  const key = requireApiKey();
  const d = await call(`${SECURE_TOKEN}?key=${key}`, { grant_type: 'refresh_token', refresh_token: refreshToken }, { form: true });
  return session({ idToken: d.id_token, refreshToken: d.refresh_token, expiresIn: d.expires_in, uid: d.user_id });
}

async function sendPasswordReset(email) {
  const key = requireApiKey();
  await call(`${IDENTITY}:sendOobCode?key=${key}`, { requestType: 'PASSWORD_RESET', email });
}

module.exports = { signUp, signIn, refresh, sendPasswordReset };
