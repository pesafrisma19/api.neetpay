import bcrypt from 'bcryptjs';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { env } from '../config/env.js';

export async function runAdminSeed() {
  const email = env.ADMIN_EMAIL.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  const name = env.ADMIN_NAME;

  logger.info({ email, name }, '🌱 Checking / seeding root Administrator...');

  const passwordHash = await bcrypt.hash(password, 10);

  const adminUser = await prisma.user.upsert({
    where: { email },
    update: {
      name,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    create: {
      email,
      name,
      passwordHash,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });

  logger.info(
    { userId: adminUser.id, email: adminUser.email, role: adminUser.role },
    '✓ Administrator account verified / created successfully (password securely stored)'
  );
}

// Execute directly if run via CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runAdminSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Failed to run admin seed');
      process.exit(1);
    });
}
