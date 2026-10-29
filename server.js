const http = require('http');
const config = require('./src/config');
const app = require('./src/app');
const { initWebSocketServer } = require('./src/websocket/wsServer');
const { purgeOldLocations } = require('./src/services/locationService');

// Servidor HTTP compartido por la API REST y el WebSocket
const server = http.createServer(app);
initWebSocketServer(server);

// Limpieza del historial de ubicaciones (al arrancar y cada hora)
const runPurge = () => purgeOldLocations().catch((err) => console.error('[purge]', err.message));
runPurge();
setInterval(runPurge, 60 * 60 * 1000).unref();

server.listen(config.port, () => {
  console.log(`\n✅ GuiAR Backend en http://localhost:${config.port}`);
  console.log(`   REST:      http://localhost:${config.port}/api/health`);
  console.log(`   WebSocket: ws://localhost:${config.port}/ws?token=<idToken>\n`);
  if (!config.firebaseWebApiKey) {
    console.warn('⚠️  Falta FIREBASE_WEB_API_KEY: /api/auth/login y /register no van a funcionar.\n');
  }
});
