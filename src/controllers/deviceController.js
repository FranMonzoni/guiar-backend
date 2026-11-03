const devices = require('../services/deviceService');

/** GET /api/devices/me — la pulsera vinculada a mi cuenta, o { device: null }. */
async function getMine(req, res) {
  res.json({ device: await devices.getMyDevice(req.user.id) });
}

/**
 * DELETE /api/devices/me — desvincula la pulsera para poder usar otra.
 * La próxima pulsera que mande datos desde esta cuenta queda vinculada.
 */
async function unlinkMine(req, res) {
  await devices.unlinkDevice(req.user);
  res.json({ ok: true });
}

module.exports = { getMine, unlinkMine };
