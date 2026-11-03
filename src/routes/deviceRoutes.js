const express = require('express');
const router = express.Router();
const d = require('../controllers/deviceController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/me', d.getMine);        // mi pulsera
router.delete('/me', d.unlinkMine);  // desvincular para usar otra

module.exports = router;
