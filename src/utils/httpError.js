/**
 * Error con código HTTP. Los controladores lo lanzan y el handler global
 * de app.js lo convierte en { error, code } con el status correspondiente.
 */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { HttpError };

/**
 * ¿El error de Prisma es una violación de unique sobre `field`?
 * (El formato de err.meta cambia según el motor de Prisma, por eso se busca en todo el objeto.)
 */
function isUniqueViolation(err, field) {
  return err?.code === 'P2002' && JSON.stringify(err.meta ?? {}).includes(field);
}

module.exports.isUniqueViolation = isUniqueViolation;
