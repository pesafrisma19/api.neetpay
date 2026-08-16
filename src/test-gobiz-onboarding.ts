import crypto from 'crypto';
import { prisma } from './lib/prisma.js';
import { runBaseSeed } from './lib/seed.js';
import { encryptAES, decryptAES } from './lib/encryption.js';
import { PaymentAccountService } from './modules/payment-accounts/payment-accounts.service.js';
import { app } from './app.js';

async function testGoBizOnboardingSuite() {
  console.log('\n======================================================');
  console.log('🧪 NEETPAY V1 GOBIZ ONBOARDING & ENCRYPTION TEST SUITE');
  console.log('======================================================\n');

  await runBaseSeed();

  const testSuffix = crypto.randomBytes(4).toString('hex');
  const testEmail = `merchant_gobiz_${testSuffix}@example.com`;
  const testPassword = 'Password123!';

  // 1. Register User
  const regRes = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'GoBiz Tester', email: testEmail, password: testPassword }),
  });
  console.log('1. User Registration:', regRes.status === 201 ? '✅ PASS' : '❌ FAIL');

  // 2. Login User to get Session Cookie
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const cookie = loginRes.headers.get('set-cookie')?.match(/neetpay_session=([^;]+)/)?.[1];
  console.log('2. User Login & Session Cookie:', !!cookie ? '✅ PASS' : '❌ FAIL');

  // 3. Test AES-256-GCM Encryption & Decryption
  const testPayload = JSON.stringify({
    accessToken: 'test_access_token_1234567890abcdef',
    refreshToken: 'test_refresh_token_0987654321fedcba',
  });
  const encrypted = encryptAES(testPayload);
  const isGcmFormat = encrypted.split(':').length === 3;
  const decrypted = decryptAES(encrypted);
  const isDecryptedEqual = decrypted === testPayload;
  console.log('3. AES-256-GCM Token Encryption/Decryption:', isGcmFormat && isDecryptedEqual ? '✅ PASS' : '❌ FAIL');

  // 4. Test Connecting PaymentAccount + GoBizAccount in Database
  const user = await prisma.user.findUnique({ where: { email: testEmail } });
  const provider = await prisma.paymentProvider.findUnique({ where: { code: 'GOBIZ' } });

  const account = await prisma.$transaction(async (tx) => {
    const acc = await tx.paymentAccount.create({
      data: {
        userId: user!.id,
        providerId: provider!.id,
        name: 'NEETshop GoBiz Outlet',
        customMinAmount: 5000,
        customMaxAmount: 5000000,
        status: 'ACTIVE',
        isActive: true,
      },
    });
    await tx.goBizAccount.create({
      data: {
        paymentAccountId: acc.id,
        merchantId: 'G754583723',
        outletId: 'G754583723',
        merchantName: 'NEETshop',
        outletName: 'NEETshop',
        loginIdentifier: '+6285220581369',
        credentialEncrypted: encrypted,
        lastConnectionCheckAt: new Date(),
      },
    });
    return acc;
  });
  console.log('4. PaymentAccount + GoBizAccount Creation:', !!account.id ? '✅ PASS' : '❌ FAIL');

  // 5. List Connected Accounts API
  const listRes = await app.request('/api/payment-accounts', {
    method: 'GET',
    headers: { 'Cookie': `neetpay_session=${cookie}` },
  });
  const listData = (await listRes.json()) as any;
  const isListed = listRes.status === 200 && listData.data.length === 1 && listData.data[0].goBiz?.merchantId === 'G754583723';
  console.log('5. GET /api/payment-accounts (List Active Accounts):', isListed ? '✅ PASS' : '❌ FAIL');

  // 6. Plan Quota Limit Enforcement (Free Plan limit = 1 account)
  let quotaRejected = false;
  try {
    await PaymentAccountService.requestOtp(user!.id, '08123456789');
  } catch (e: any) {
    quotaRejected = e.message === 'ACCOUNT_LIMIT_EXCEEDED';
  }
  console.log('6. Plan Quota Limit Enforcement (Free limit = 1 account max):', quotaRejected ? '✅ PASS' : '❌ FAIL');

  // 7. Disconnect Account
  const discRes = await app.request(`/api/payment-accounts/${account.id}`, {
    method: 'DELETE',
    headers: { 'Cookie': `neetpay_session=${cookie}` },
  });
  const afterDiscList = await prisma.paymentAccount.findMany({
    where: { userId: user!.id, isActive: true },
  });
  console.log('7. DELETE /api/payment-accounts/:id (Disconnect):', discRes.status === 200 && afterDiscList.length === 0 ? '✅ PASS' : '❌ FAIL');

  // Cleanup
  if (user) await prisma.user.delete({ where: { id: user.id } });
  console.log(`\n🧹 Cleaned up temporary test user (${testEmail})\n`);
}

testGoBizOnboardingSuite()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch((e) => {
    console.error(e);
    prisma.$disconnect().then(() => process.exit(1));
  });
