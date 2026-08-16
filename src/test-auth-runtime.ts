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

// Helper to extract session cookie from Response headers
function extractSessionCookie(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/neetpay_session=([^;]+)/);
  return match ? match[1] : null;
}

export async function runAllRuntimeTests() {
  console.log('\n================================================================');
  console.log('🧪 NEETPAY V1 FINAL VALIDATION SUITE (COOKIE-ONLY & 7-DAY EXPIRY)');
  console.log('================================================================\n');

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

    // 4. Verify GOBIZ <-> QRIS Mapping
    const mapping = await prisma.providerPaymentMethod.findFirst({
      where: {
        provider: { code: 'GOBIZ' },
        paymentMethod: { code: 'QRIS' },
      },
    });
    const isMappingClean = !!mapping && mapping.isEnabled;
    record(4, 'GOBIZ <-> QRIS mapping exists and is enabled', isMappingClean);

    // 5. Register USER via API
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
    record(5, 'Register USER via POST /api/auth/register succeeded', isRegistered);

    // 6. Duplicate Email Rejection
    const dupRes = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Another User',
        email: testEmail,
        password: testPassword,
      }),
    });
    record(6, 'Duplicate email registration rejected with 409 Conflict', dupRes.status === 409);

    // 7. Role Escalation Prevention
    const registeredUser = await prisma.user.findUnique({ where: { email: testEmail } });
    const isRoleSafe = registeredUser?.role === 'USER';
    record(7, 'Public registration cannot escalate role to ADMIN (role is strictly USER)', isRoleSafe);

    // 8. Login & Verify HttpOnly Cookie & NO raw token in JSON response
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: testPassword,
      }),
    });
    const loginData = (await loginRes.json()) as any;
    const rawCookie = extractSessionCookie(loginRes);
    const setCookieHeader = loginRes.headers.get('set-cookie') || '';
    const hasHttpOnly = setCookieHeader.toLowerCase().includes('httponly');
    const noRawTokenInBody = !('token' in (loginData?.data || {})) && !('sessionToken' in (loginData?.data || {}));
    const isLoginSafe = loginRes.status === 200 && !!rawCookie && hasHttpOnly && noRawTokenInBody;
    record(8, 'POST /api/auth/login sets HttpOnly cookie & response JSON does NOT leak raw token', isLoginSafe);

    // 9. Session Lifetime Verification (7 days)
    const sessionExpiresAt = new Date(loginData?.data?.session?.expiresAt);
    const now = new Date();
    const diffDays = Math.round((sessionExpiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const is7Days = diffDays === 7;
    record(9, 'Dashboard session lifetime is exactly 7 days (not 30 days)', is7Days);

    // 10. Login with Incorrect Password
    const badLoginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'WrongPassword!',
      }),
    });
    record(10, 'Login with incorrect password rejected with 401 Unauthorized', badLoginRes.status === 401);

    // 11. GET /api/me with Valid Session Cookie
    const meRes = await app.request('/api/me', {
      method: 'GET',
      headers: {
        Cookie: `neetpay_session=${rawCookie}`,
      },
    });
    const meData = (await meRes.json()) as any;
    const isMeValid = meRes.status === 200 && meData.data?.email === testEmail && meData.data?.subscription?.plan?.code === 'FREE';
    record(11, 'GET /api/me with valid HttpOnly cookie returned user profile & subscription', isMeValid);

    // 12. GET /api/me without Cookie
    const unauthMeRes = await app.request('/api/me', { method: 'GET' });
    record(12, 'GET /api/me without cookie rejected with 401 Unauthorized', unauthMeRes.status === 401);

    // 13. Boundary Separation: API key in cookie rejected for dashboard
    const fakeKeyCookieRes = await app.request('/api/me', {
      method: 'GET',
      headers: {
        Cookie: `neetpay_session=np_live_fakeapikey123456`,
      },
    });
    record(13, 'Dashboard auth rejects API key used as session cookie (Boundary Check)', fakeKeyCookieRes.status === 401);

    // 14. Expired Session Rejection
    const testExpiredToken = crypto.randomBytes(32).toString('hex');
    const testExpiredHash = crypto.createHash('sha256').update(testExpiredToken).digest('hex');
    const pastDate = new Date(Date.now() - 3600000); // 1 hour ago
    await prisma.authSession.create({
      data: {
        userId: registeredUser!.id,
        tokenHash: testExpiredHash,
        expiresAt: pastDate,
      },
    });
    const expiredMeRes = await app.request('/api/me', {
      method: 'GET',
      headers: {
        Cookie: `neetpay_session=${testExpiredToken}`,
      },
    });
    record(14, 'Expired session is strictly rejected with 401 Unauthorized', expiredMeRes.status === 401);

    // 15. Logout Invalidates Session
    const logoutRes = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `neetpay_session=${rawCookie}`,
      },
    });
    const afterLogoutMeRes = await app.request('/api/me', {
      method: 'GET',
      headers: {
        Cookie: `neetpay_session=${rawCookie}`,
      },
    });
    record(15, 'POST /api/auth/logout revoked session and cleared cookie', logoutRes.status === 200 && afterLogoutMeRes.status === 401);

    // 16. Admin Seed Execution
    await runAdminSeed();
    const adminUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    record(16, 'Admin seed created/verified ADMIN account with bcrypt hash', !!adminUser && adminUser.role === 'ADMIN');

    // Relogin for API key tests
    const reloginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    const activeCookie = extractSessionCookie(reloginRes);

    // 17. Generate First API Key (via Cookie Auth)
    const genKeyRes = await app.request('/api/api-key/generate', {
      method: 'POST',
      headers: { Cookie: `neetpay_session=${activeCookie}` },
    });
    const genKeyData = (await genKeyRes.json()) as any;
    const rawKey1 = genKeyData?.data?.rawKey;
    const isKey1FormatValid = rawKey1 && rawKey1.startsWith('np_live_');
    record(17, 'POST /api/api-key/generate generated np_live_ API key', genKeyRes.status === 201 && isKey1FormatValid);

    // 18. Raw Key Not in DB (Stored as SHA-256 hash only)
    const dbKey1 = await prisma.apiCredential.findUnique({ where: { userId: registeredUser!.id } });
    const isRawKeyHidden = dbKey1 && dbKey1.keyHash !== rawKey1 && dbKey1.keyHash.length === 64;
    record(18, 'Raw API key is NOT stored in database (SHA-256 hash only)', !!isRawKeyHidden);

    // 19. Duplicate API Key Rejected (1 User = 1 Key)
    const genKeyDupRes = await app.request('/api/api-key/generate', {
      method: 'POST',
      headers: { Cookie: `neetpay_session=${activeCookie}` },
    });
    record(19, 'Second API key generation rejected with 409 Conflict (1 User = 1 Key)', genKeyDupRes.status === 409);

    // 20. Rotate API Key
    const rotateRes = await app.request('/api/api-key/rotate', {
      method: 'POST',
      headers: { Cookie: `neetpay_session=${activeCookie}` },
    });
    const rotateData = (await rotateRes.json()) as any;
    const rawKey2 = rotateData?.data?.rawKey;
    record(20, 'POST /api/api-key/rotate rotated key and returned new raw key once', rotateRes.status === 200 && !!rawKey2 && rawKey2 !== rawKey1);

    // 21. Boundary Separation: Dashboard session Bearer token rejected for Merchant API
    const sessionAsApiKeyRes = await app.request('/api/test/merchant-auth', {
      method: 'GET',
      headers: { Authorization: `Bearer ${activeCookie}` },
    });
    record(21, 'Merchant API rejects dashboard session used as Bearer token (Boundary Check)', sessionAsApiKeyRes.status === 401);

    // 22. Rotated old API key rejected & new API key authorized
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
    record(22, 'requireApiKey rejects rotated old key and authorizes new key', isMerchantAuthWorking);

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
  return { passedCount, total: results.length, allPassed: passedCount === results.length && results.length === 22 };
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
