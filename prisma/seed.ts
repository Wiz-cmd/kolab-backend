import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const PROVINCES = [
  'Gauteng',
  'Western Cape',
  'KwaZulu-Natal',
  'Eastern Cape',
  'Free State',
  'Limpopo',
  'Mpumalanga',
  'North West',
  'Northern Cape',
];

const HOTSPOTS = [
  { name: 'Maboneng Precinct', category: 'urban', province: 'Gauteng', city: 'Johannesburg', latitude: -26.2057, longitude: 28.0495 },
  { name: 'Kruger National Park', category: 'nature', province: 'Mpumalanga', city: 'Skukuza', latitude: -24.9951, longitude: 31.5862 },
  { name: 'Table Mountain', category: 'nature', province: 'Western Cape', city: 'Cape Town', latitude: -33.9648, longitude: 18.4098 },
  { name: 'The Neighbourgoods Market', category: 'lifestyle', province: 'Gauteng', city: 'Johannesburg', latitude: -26.2041, longitude: 28.0473 },
  { name: 'Umhlanga Beach', category: 'beach', province: 'KwaZulu-Natal', city: 'Durban', latitude: -29.7255, longitude: 31.0845 },
  { name: 'V&A Waterfront', category: 'urban', province: 'Western Cape', city: 'Cape Town', latitude: -33.9040, longitude: 18.4189 },
];

async function main() {
  const month = new Date().toISOString().slice(0, 7);

  console.log('Seeding provinces...');
  for (const province of PROVINCES) {
    await prisma.provinceStats.upsert({
      where: { province_month: { province, month } },
      create: { province, month, checkIns: 0, postsCount: 0, dealsCount: 0, score: 0 },
      update: {},
    });
  }

  console.log('Seeding hotspots...');
  for (const h of HOTSPOTS) {
    await prisma.hotspot.upsert({
      where: { id: `seed-${h.name.replace(/\s+/g, '-').toLowerCase()}` },
      create: { id: `seed-${h.name.replace(/\s+/g, '-').toLowerCase()}`, ...h },
      update: {},
    });
  }

  console.log('Seeding demo users...');
  const passwordHash = await bcrypt.hash('Password123!', 12);
  const demoUsers = [
    { email: 'brand@kolab.co.za', name: 'Demo Brand', role: Role.BRAND as Role, location: 'Johannesburg' },
    { email: 'model@kolab.co.za', name: 'Demo Model', role: Role.MODEL as Role, location: 'Cape Town' },
    { email: 'admin@kolab.co.za', name: 'Demo Admin', role: Role.ADMIN as Role, location: 'Johannesburg' },
  ];
  for (const u of demoUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      create: { ...u, passwordHash, isEmailVerified: true },
      update: {},
    });
  }

  console.log('Seed complete 🎉');
  console.log('Demo logins (password: Password123!):');
  for (const u of demoUsers) console.log(`  ${u.email}  (${u.role})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
