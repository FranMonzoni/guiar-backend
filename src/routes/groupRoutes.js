const express = require('express');
const router = express.Router();
const g = require('../controllers/groupController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

// Varias respuestas llevan la clave de cifrado: que ningún proxy ni el celular las guarde.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
});

router.post('/', g.createGroup);                         // crear grupo
router.post('/join', g.joinGroup);                       // unirse con código

router.get('/me', g.getMyGroup);                         // mi grupo + miembros + clave
router.patch('/me', g.renameGroup);                      // renombrar (owner)
router.post('/me/leave', g.leaveGroup);                  // salir del grupo
router.post('/me/invite-code', g.regenerateCode);        // nuevo código (owner)
router.post('/me/encryption/rotate', g.rotateKey);       // nueva clave de cifrado (owner)
router.delete('/me/members/:userId', g.kickMember);      // expulsar (owner)
router.get('/me/locations', g.getMyLocations);           // últimas ubicaciones para el mapa

module.exports = router;
