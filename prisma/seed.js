const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed...');

  // Crear usuario admin
  const adminHash = await bcrypt.hash('admin1234', 10);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: adminHash,
      role: 'ADMIN'
    }
  });
  console.log(`✅ Admin creado: ${admin.username}`);

  // Crear usuario de prueba
  const userHash = await bcrypt.hash('user1234', 10);
  const user = await prisma.user.upsert({
    where: { username: 'testuser' },
    update: {},
    create: {
      username: 'testuser',
      passwordHash: userHash,
      role: 'USER'
    }
  });
  console.log(`✅ Usuario de prueba creado: ${user.username}`);

  // Crear grupo de prueba
  const group = await prisma.group.upsert({
    where: { joinKey: 'TEST01' },
    update: {},
    create: {
      name: 'Grupo de prueba',
      joinKey: 'TEST01',
      ownerId: user.id,
      members: { connect: { id: user.id } }
    }
  });

  // Vincular al usuario con el grupo
  await prisma.user.update({
    where: { id: user.id },
    data: { groupId: group.id }
  });

  console.log(`✅ Grupo de prueba creado: "${group.name}" (joinKey: ${group.joinKey})`);
  console.log('\n📌 Credenciales de prueba:');
  console.log('   Admin:    admin / admin1234');
  console.log('   Usuario:  testuser / user1234');
  console.log(`   Grupo:    "${group.name}" | Clave: ${group.joinKey}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
