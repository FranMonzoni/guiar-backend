const express = require('express');
const router = express.Router();
const {
  createGroup,
  joinGroup,
  getMyGroup,
  getAllGroups,
  deleteGroup
} = require('../controllers/groupController');
const {
  getGroupLocations,
  getGroupLocationsByAdmin
} = require('../controllers/locationController');
const authMiddleware = require('../middlewares/authMiddleware');
const adminMiddleware = require('../middlewares/adminMiddleware');

// POST /api/groups — Crear grupo (usuario autenticado)
router.post('/', authMiddleware, createGroup);

// POST /api/groups/join — Unirse a grupo con joinKey
router.post('/join', authMiddleware, joinGroup);

// GET /api/groups/me — Ver mi grupo y sus miembros
router.get('/me', authMiddleware, getMyGroup);

// GET /api/groups/me/locations — Ubicaciones del grupo para el mapa
router.get('/me/locations', authMiddleware, getGroupLocations);

// GET /api/groups — Lista todos los grupos (solo admin)
router.get('/', authMiddleware, adminMiddleware, getAllGroups);

// GET /api/groups/:id/locations — Ubicaciones de un grupo específico (solo admin)
router.get('/:id/locations', authMiddleware, adminMiddleware, getGroupLocationsByAdmin);

// DELETE /api/groups/:id — Eliminar grupo (solo admin)
router.delete('/:id', authMiddleware, adminMiddleware, deleteGroup);

module.exports = router;
