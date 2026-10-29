const express = require('express');
const router = express.Router();
const { getAllUsers, deleteUser } = require('../controllers/userController');
const authMiddleware = require('../middlewares/authMiddleware');
const adminMiddleware = require('../middlewares/adminMiddleware');

// GET /api/users — Lista todos los usuarios (solo admin)
router.get('/', authMiddleware, adminMiddleware, getAllUsers);

// DELETE /api/users/:id — Eliminar usuario (solo admin)
router.delete('/:id', authMiddleware, adminMiddleware, deleteUser);

module.exports = router;
