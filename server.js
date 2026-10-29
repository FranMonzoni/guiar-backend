require('dotenv').config();

const http = require('http');
const app = require('./src/app');
const { initWebSocketServer } = require('./src/websocket/wsServer');

const PORT = process.env.PORT || 3001;

// Crear servidor HTTP base (necesario para adjuntarle WebSocket)
const server = http.createServer(app);

// Inicializar WebSocket sobre el mismo servidor HTTP
initWebSocketServer(server);

server.listen(PORT, () => {
  console.log(`\n✅ GuiAR Backend corriendo en http://localhost:${PORT}`);
  console.log(`   REST API:      http://localhost:${PORT}/api/health`);
  console.log(`   WebSocket:     ws://localhost:${PORT}/ws?token=<jwt>\n`);
});
