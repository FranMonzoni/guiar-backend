const express = require('express');
const cors = require('cors');
const config = require('./config');

const authRoutes = require('./routes/authRoutes');
const groupRoutes = require('./routes/groupRoutes');
const locationRoutes = require('./routes/locationRoutes');
const adminRoutes = require('./routes/adminRoutes');

const app = express();

// ── Middlewares globales ──────────────────────────────────────────────────────
app.use(cors(config.corsOrigins.length ? { origin: config.corsOrigins } : {}));
app.use(express.json({ limit: '32kb' }));

// ── Rutas ─────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta ${req.method} ${req.path} no encontrada.`, code: 'NOT_FOUND' });
});

// ── Errores (Express 5 captura también los de funciones async) ───────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido.', code: 'INVALID_JSON' });
  }
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[${req.method} ${req.path}]`, err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno del servidor.', code: err.code || 'SERVER_ERROR' });
});

module.exports = app;
