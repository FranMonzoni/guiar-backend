const express = require('express');
const router = express.Router();
const { reportLocation } = require('../controllers/locationController');
const authMiddleware = require('../middlewares/authMiddleware');

// POST /api/locations — reportar datos de la ESP (mismo JSON que el WebSocket)
router.post('/', authMiddleware, reportLocation);

module.exports = router;
