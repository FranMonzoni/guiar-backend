const express = require('express');
const router = express.Router();
const admin = require('../controllers/adminController');
const authMiddleware = require('../middlewares/authMiddleware');
const adminMiddleware = require('../middlewares/adminMiddleware');

router.use(authMiddleware, adminMiddleware);

router.get('/stats', admin.stats);

router.get('/groups', admin.listGroups);
router.get('/groups/:id', admin.getGroup);
router.delete('/groups/:id', admin.deleteGroup);

router.get('/users', admin.listUsers);
router.patch('/users/:id', admin.updateUser);
router.delete('/users/:id', admin.deleteUser);

module.exports = router;
