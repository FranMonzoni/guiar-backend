const express = require('express');
const router = express.Router();
const { reportLocation } = require('../controllers/locationController');
const authMiddleware = require('../middlewares/authMiddleware');

// POST /api/locations — Reportar ubicación GPS (usado por la app móvil)
router.post('/', authMiddleware, reportLocation);

module.exports = router;
