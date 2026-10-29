const admin = require('../firebase/firebaseAdmin');

/**
 * Middleware de autenticación con Firebase.
 * Verifica el ID Token enviado en Authorization: Bearer <token>
 * Si es válido, agrega req.firebaseUser con el decoded token de Firebase.
 */
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticación requerido.' });
  }

  const idToken = authHeader.split(' ')[1];

  try {
    const decoded = await admin.verifyIdToken(idToken);
    req.firebaseUser = decoded; // { uid, email, name, ... }
    next();
  } catch (err) {
    console.error('[authMiddleware]', err.code);
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}

module.exports = authMiddleware;
