const express = require('express');
const router = express.Router();
const { syncUser } = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

// POST /api/auth/sync — Sincroniza el usuario Firebase con SQLite (crear si no existe)
// Llamado desde el frontend justo después del login con Firebase
router.post('/sync', authMiddleware, syncUser);

// GET /api/auth/sync — Alias GET para obtener el perfil actual
router.get('/sync', authMiddleware, syncUser);

module.exports = router;
