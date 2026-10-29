const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

// ── Públicas (para la app móvil / clientes sin SDK de Firebase) ──────────────
router.post('/register', auth.register);
router.post('/login', auth.login);
router.post('/refresh', auth.refresh);
router.post('/password-reset', auth.passwordReset);

// ── Requieren Authorization: Bearer <idToken> ────────────────────────────────
router.get('/me', authMiddleware, auth.me);
router.patch('/me', authMiddleware, auth.updateMe);

// Compatibilidad con la versión anterior de la web
router.get('/sync', authMiddleware, auth.me);
router.post('/sync', authMiddleware, auth.me);

module.exports = router;
