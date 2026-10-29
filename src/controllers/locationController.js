const { ingestReport } = require('../services/locationService');

/**
 * POST /api/locations
 * Alternativa REST al WebSocket (mismo formato de mensaje). Útil si la app
 * pierde la conexión WS o para probar con curl/Postman.
 */
async function reportLocation(req, res) {
  const result = await ingestReport(req.user, req.body);
  res.status(result.saved ? 201 : 202).json({ ok: true, ...result });
}

module.exports = { reportLocation };
