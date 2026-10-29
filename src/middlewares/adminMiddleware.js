/**
 * Middleware de autorización para rutas exclusivas de administradores.
 * Debe usarse DESPUÉS de authMiddleware.
 */
function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Acceso restringido a administradores.' });
  }
  next();
}

module.exports = adminMiddleware;
