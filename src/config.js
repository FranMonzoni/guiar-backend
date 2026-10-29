require('dotenv').config({ quiet: true });

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  port: Number(process.env.PORT) || 3001,
  corsOrigins: list(process.env.CORS_ORIGINS),
  firebaseWebApiKey: process.env.FIREBASE_WEB_API_KEY || '',
  adminEmails: list(process.env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  locationRetentionHours: Number(process.env.LOCATION_RETENTION_HOURS) || 48,
  locationMinIntervalMs: Number(process.env.LOCATION_MIN_INTERVAL_MS ?? 2000),
  // Un miembro se considera "desconectado" del mapa si no reporta en este tiempo.
  wsHeartbeatMs: 30_000
};

module.exports = config;
