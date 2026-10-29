/**
 * Cambia el rol de un usuario por email.
 *   npm run admin:grant -- tu@email.com
 *   npm run admin:revoke -- tu@email.com
 *
 * El usuario tiene que haber iniciado sesión al menos una vez (para existir en la DB).
 * Alternativa: agregar el email a ADMIN_EMAILS en el .env.
 */
require('../src/config');
const prisma = require('../src/prismaClient');

async function main() {
  const [role, email] = process.argv.slice(2);
  if (!['ADMIN', 'USER'].includes(role) || !email) {
    console.error('Uso: node scripts/setRole.js <ADMIN|USER> <email>');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    console.error(`❌ No existe un usuario con email ${email}. Iniciá sesión en la web primero.`);
    process.exit(1);
  }
  await prisma.user.update({ where: { id: user.id }, data: { role } });
  console.log(`✅ ${email} ahora es ${role}`);
}

main().finally(() => prisma.$disconnect());
