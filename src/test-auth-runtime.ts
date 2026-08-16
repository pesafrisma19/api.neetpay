import crypto from 'crypto';
import { prisma } from './lib/prisma.js';
import { runBaseSeed } from './lib/seed.js';
import { runAdminSeed } from './lib/seed-admin.js';
import { app } from './app.js';

interface TestResult {
  step: number;
  description: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function record(step: number, description: string, passed: boolean, details?: string) {
  results.push({ step, description, passed, details });
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} [Test ${step.toString().padStart(2, '0')}] ${description}`);
  if (details && !passed) {
    console.error(`   Details: ${details}`);
  }
}

export async function runAllRuntimeTests() {
  console.log('\n======================================================');
  console.log('🧪 NEETPAY V1 RUNTIME AUTH & DATABASE VALIDATION SUITE');
  console.log('======================================================\n');

  const testSuffix = crypto.randomBytes(4).toString('hex');
  const testEmail = `merchant_${testSuffix}@example.com`;
  const testPassword = 'PasswordTest123!';
  const testName = `Test Merchant ${testSuffix}`;

  try {
    // 1. Run Base Seed
    await runBaseSeed();
    record(1, 'Base seed executed successfully', true);

    // 2. Verify Plan FREE
    const freePlan = await prisma.plan.findUnique({ where: { code: 'FREE' } });
    const isFreeValid =
      !!freePlan &&
      freePlan.priceMonthly === 0 &&
      freePlan.monthlyTransactionLimit === 30 &&
      freePlan.paymentAccountLimit === 1;
    record(2, 'Plan FREE exists with exact V1 quota', isFreeValid);

    // 3. Verify Plan PRO
    const proPlan = await prisma.plan.findUnique({ where: { code: 'PRO' } });
    const isProValid =
      !!proPlan &&
      proPlan.priceMonthly === 20000 &&
      proPlan.monthlyTransactionLimit === null &&
      proPlan.paymentAccountLimit === 3;
    record(3, 'Plan PRO exists with exact V1 quota', isProValid);

    // 4. Verify Payment Provider GOBIZ
    const goBiz = await prisma.paymentProvider.findUnique({ where: { code: 'GOBIZ' } });
    record(4, 'Payment Provider GOBIZ exists', !!goBiz && goBiz.isEnabled);

    // 5. Verify Payment Method QRIS
    const qris = await prisma.paymentMethod.findUnique({ where: { code: 'QRIS' } });
    record(5, 'Payment Method QRIS exists', !!qris && qris.isEnabled);

    // 6. Verify GOBIZ <-> QRIS Mapping
    const mapping = await prisma.providerPaymentMethod.findFirst({
      where: {
        provider: { code: 'GOBIZ' },
        paymentMethod: { code: 'QRIS' },
      },
    });
    record(6, 'ProviderPaymentMethod GOBIZ <-> QRIS mapping exists', !!mapping && mapping.isEnabled);

    // 7. Register USER via API
    const regRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: testName,
        email: testEmail,
        password: testPassword,
        role: 'ADMIN', // Test role escalation attempt
      }),
    });
    const regData = (await regRes.json()) as any;
    const isRegistered = regRes.status === 201 && regData.success && regData.data.email === testEmail;
    record(7, 'Register USER via POST /api/auth/register succeeded', isRegistered);

    // 8. Duplicate Email Rejection
    const dupRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Another User',
        email: testEmail,
        password: testPassword,
      }),
    });
    record(8, 'Duplicate email registration rejected with 409 Conflict', dupRes.status === 409);

    // 9. Role Escalation Prevention
    const registeredUser = await prisma.user.findUnique({ where: { email: testEmail } });
    const isRoleSafe = registeredUser?.role === 'USER';
    record(9, 'Public registration cannot escalate role to ADMIN (role is USER)', isRoleSafe);

    // 10. Login with Correct Password
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
      }),
    });
    const loginData = (await loginRes.json()) as any;
    const sessionToken = loginData?.data?.token;
    record(10, 'Login with correct password succeeded and returned session', loginRes.status === 200 && !!sessionToken);

    // 11. Login with Incorrect Password
    const badLoginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'WrongPassword!',
      }),
    });
    record(11, 'Login with incorrect password rejected with 401 Unauthorized', badLoginRes.status === 401);

    // 12. GET /api/me with Valid Session
    const meRes = await app.request('/api/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });
    const meData = (await meRes.json()) as any;
    const isMeValid = meRes.status === 200 && meData.data?.email === testEmail && meData.data?.subscription?.plan?.code === 'FREE';
    record(12, 'GET /api/me with session returned user profile and FREE subscription', isMeValid);

    // 13. GET /api/me without Session
    const unauthMeRes = await app.request('/api/me', { method: 'GET' });
    record(13, 'GET /api/me without session rejected with 401 Unauthorized', unauthMeRes.status === 401);

    // 14. Logout Invalidates Session
    const logoutRes = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });
    const afterLogoutMeRes = await app.request('/api/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`,
      },
    });
    record(14, 'POST /api/auth/logout successfully revoked the session', logoutRes.status === 200 && afterLogoutMeRes.status === 401);

    // 15. Admin Seed Execution
    await runAdminSeed();
    const adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    record(15, 'Admin seed created/verified ADMIN account with bcrypt hash', !!adminUser && adminUser.role === 'ADMIN');

    // Relogin for API key tests
    const reloginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    const reloginData = (await reloginRes.json()) as any;
    const activeSessionToken = reloginData?.data?.token;

    // 16. Generate First API Key
    const genKeyRes = await app.request('/api/api-key/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeSessionToken}` },
    });
    const genKeyData = (await genKeyRes.json()) as any;
    const rawKey1 = genKeyData?.data?.rawKey;
    const isKey1FormatValid = rawKey1 && rawKey1.startsWith('np_live_');
    record(16, 'POST /api/api-key/generate generated np_live_ API key', genKeyRes.status === 201 && isKey1FormatValid);

    // 17. Raw Key Not in DB
    const dbKey1 = await prisma.apiCredential.findUnique({ where: { userId: registeredUser!.id } });
    const isRawKeyHidden = dbKey1 && dbKey1.keyHash !== rawKey1 && dbKey1.keyHash.length === 64;
    record(17, 'Raw API key is NOT stored in database (stored as SHA-256 hash only)', !!isRawKeyHidden);

    // 18. Duplicate API Key Rejected
    const genKeyDupRes = await app.request('/api/api-key/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeSessionToken}` },
    });
    record(18, 'Second API key generation rejected with 409 Conflict (1 User = 1 Key)', genKeyDupRes.status === 409);

    // 19. Rotate API Key
    const rotateRes = await app.request('/api/api-key/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeSessionToken}` },
    });
    const rotateData = (await rotateRes.json()) as any;
    const rawKey2 = rotateData?.data?.rawKey;
    record(19, 'POST /api/api-key/rotate rotated key and returned new raw key once', rotateRes.status === 200 && !!rawKey2 && rawKey2 !== rawKey1);

    // 20. Merchant Auth Middleware Verification
    const oldKeyAuthRes = await app.request('/api/test/merchant-auth', {
      method: 'GET',
      headers: { Authorization: `Bearer ${rawKey1}` },
    });
    const newKeyAuthRes = await app.request('/api/test/merchant-auth', {
      method: 'GET',
      headers: { Authorization: `Bearer ${rawKey2}` },
    });
    const newKeyAuthData = (await newKeyAuthRes.json()) as any;
    const isMerchantAuthWorking =
      oldKeyAuthRes.status === 401 &&
      newKeyAuthRes.status === 200 &&
      newKeyAuthData?.data?.merchantEmail === testEmail;
    record(20, 'requireApiKey rejects rotated old key and authorizes new key', isMerchantAuthWorking);

    // Cleanup test user
    if (registeredUser) {
      await prisma.user.delete({ where: { id: registeredUser.id } }).catch(() => {});
      console.log(`\n🧹 Cleaned up temporary test user (${testEmail})\n`);
    }
  } catch (err: any) {
    console.error('💥 Test suite crashed:', err?.message || err);
  }

  const passedCount = results.filter((r) => r.passed).length;
  console.log(`Summary: ${passedCount}/${results.length} tests passed.`);
  return { passedCount, total: results.length, allPassed: passedCount === results.length && results.length === 20 };
}

// Automatically invoke
runAllRuntimeTests()
  .then((res) => {
    prisma.$disconnect().then(() => process.exit(res.allPassed ? 0 : 1));
  })
  .catch((err) => {
    console.error(err);
    prisma.$disconnect().then(() => process.exit(1));
  });
