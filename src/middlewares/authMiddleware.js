const firebaseAuth = require('../firebase/firebaseAdmin');
const { upsertFromFirebase } = require('../services/userService');

/**
 * Extrae el token de "Authorization: Bearer <token>".
 */
function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * Verifica el ID Token de Firebase (web o mobile) y deja disponibles:
 *   req.firebaseUser → token decodificado { uid, email, name, ... }
 *   req.user         → usuario de la base local (se crea si no existe)
 */
async function authMiddleware(req, res, next) {
  const token = bearer(req);
  if (!token) {
    return res.status(401).json({ error: 'Token de autenticación requerido.', code: 'NO_TOKEN' });
  }

  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(token);
  } catch (err) {
    const expired = err.code === 'auth/id-token-expired';
    return res.status(401).json({
      error: expired ? 'El token expiró. Renovalo con /api/auth/refresh.' : 'Token inválido.',
      code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'
    });
  }

  req.firebaseUser = decoded;
  req.user = await upsertFromFirebase(decoded);
  next();
}

module.exports = authMiddleware;
module.exports.bearer = bearer;
