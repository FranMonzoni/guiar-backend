const path = require('path');
const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

/**
 * Carga las credenciales del Admin SDK:
 *  1. FIREBASE_SERVICE_ACCOUNT_JSON (JSON en una línea, para deploy)
 *  2. FIREBASE_SERVICE_ACCOUNT_PATH (ruta al archivo)
 *  3. ./serviceAccountKey.json en la raíz del backend
 */
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
  return require(path.resolve(__dirname, '../..', file));
}

const app = getApps().length
  ? getApps()[0]
  : initializeApp({ credential: cert(loadServiceAccount()) });

/** Instancia de firebase-admin/auth (verifyIdToken, updateUser, deleteUser…) */
module.exports = getAuth(app);
