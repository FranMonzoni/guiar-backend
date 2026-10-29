const { PrismaClient } = require('@prisma/client');

/**
 * Instancia única de Prisma Client compartida en toda la aplicación.
 * Evita múltiples conexiones innecesarias durante el desarrollo con hot-reload.
 */
const prisma = new PrismaClient();

module.exports = prisma;
