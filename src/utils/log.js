/**
 * Logs sin secretos.
 *
 * Los errores de Prisma pueden incluir los valores de la consulta en su mensaje
 * (por ejemplo, la clave de cifrado al crear un grupo). Todo lo que se loguea
 * pasa por acá: se tapan las claves en hex (64 caracteres), en base64 (32 bytes)
 * y los tokens JWT, y no se imprimen objetos de error completos.
 */
const PATTERNS = [
  /\b[0-9a-f]{64}\b/gi, // clave AES-256 en hex (como se guarda)
  /[A-Za-z0-9+/]{43}=/g, // clave AES-256 en base64 (como se entrega)
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g // idToken de Firebase
];

function redact(text) {
  let out = String(text);
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Texto seguro para loguear a partir de un error (código + mensaje + stack, redactados). */
function describe(err) {
  if (!err) return '';
  if (typeof err !== 'object') return redact(err);
  const head = [err.name, err.code].filter(Boolean).join(' ');
  return redact(`${head}: ${err.message || ''}${err.stack ? `\n${err.stack.split('\n').slice(1, 6).join('\n')}` : ''}`);
}

const log = {
  info: (...parts) => console.log(redact(parts.join(' '))),
  warn: (...parts) => console.warn(redact(parts.join(' '))),
  error: (context, err) => console.error(`${context} ${describe(err)}`)
};

module.exports = { log, redact, describe };
