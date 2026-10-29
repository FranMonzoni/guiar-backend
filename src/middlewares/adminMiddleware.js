/**
 * Autorización para rutas exclusivas de administradores.
 * Debe usarse DESPUÉS de authMiddleware (que carga req.user).
 */
function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Acceso restringido a administradores.', code: 'FORBIDDEN' });
  }
  next();
}

module.exports = adminMiddleware;
