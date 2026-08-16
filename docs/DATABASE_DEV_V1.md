# NeetPay V1 - Database, Seeding & Runtime Test Guide

## 1. Development Database Configuration

NeetPay V1 uses **PostgreSQL 16+** hosted on Supabase DEV.

### Environment Variable (`backend/.env`)
```env
PORT=4000
NODE_ENV=development
DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require"
JWT_SECRET="development_secret_key_neetpay_v1_1234567890abcdef"
ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
CORS_ORIGIN="http://localhost:5173"
ADMIN_EMAIL="admin@neetpay.web.id"
ADMIN_PASSWORD="AdminSecurePassword2026!"
ADMIN_NAME="NeetPay Root Admin"
```

---

## 2. Prisma Migration Workflow

### Development Workflow
```bash
# In Development: create and apply migrations
npx prisma migrate dev --name <migration_name>

# Check migration status
npx prisma migrate status

# Generate fresh Prisma Client
npx prisma generate

# Validate schema integrity
npx prisma validate
```

### Production Workflow
```bash
# In Production VPS (NO db push, NO interactive migrate dev)
npx prisma migrate deploy
```

### Migration History
Baseline V1 migration script is tracked under:
`backend/prisma/migrations/20260816_init_v1/migration.sql`

---

## 3. Seed Execution

### 3.1 Base Data Seeding (`npm run seed`)
Executes [**`backend/src/lib/seed.ts`**](file:///D:/project%20web/NEETpay/backend/src/lib/seed.ts):
* **Plan FREE**: `code: "FREE"`, `priceMonthly: 0`, `monthlyTransactionLimit: 30`, `paymentAccountLimit: 1`
* **Plan PRO**: `code: "PRO"`, `priceMonthly: 20000`, `monthlyTransactionLimit: null`, `paymentAccountLimit: 3`
* **PaymentProvider**: `code: "GOBIZ"`, `name: "GoBiz"`, `isEnabled: true`
* **PaymentMethod**: `code: "QRIS"`, `type: QRIS`, `isEnabled: true`
* **ProviderPaymentMethod**: `GOBIZ` $\leftrightarrow$ `QRIS` (`minAmount: null`, `maxAmount: null` - batasan transaksi dapat dikonfigurasi per user / belum diasumsikan paten).

### 3.2 Root Admin Seeding (`npm run seed:admin`)
Executes [**`backend/src/lib/seed-admin.ts`**](file:///D:/project%20web/NEETpay/backend/src/lib/seed-admin.ts):
* Reads credentials from `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`.
* Hashes password via bcrypt (10 rounds).
* Upserts user with role `ADMIN`.
* Password is never printed or leaked in output logs.

---

## 4. Automated Runtime Test Suite

Run the full end-to-end runtime test suite:
```bash
npm run test:auth
```

### Verification Checklist (22 Tests)
1. Base seed executed successfully
2. Plan FREE exists with exact V1 quota
3. Plan PRO exists with exact V1 quota
4. GOBIZ $\leftrightarrow$ QRIS mapping exists with unassumed limits (min/max null)
5. Register USER via `POST /api/auth/register` succeeded
6. Duplicate email registration rejected with `409 Conflict`
7. Public registration cannot escalate role to ADMIN (role is strictly USER)
8. `POST /api/auth/login` sets HttpOnly cookie & response JSON does NOT leak raw token
9. Dashboard session lifetime is exactly 7 days
10. Login with incorrect password rejected with `401 Unauthorized`
11. `GET /api/me` with valid HttpOnly cookie returned user profile & subscription
12. `GET /api/me` without cookie rejected with `401 Unauthorized`
13. Dashboard auth rejects API key used as session cookie (Boundary Check)
14. Expired session is strictly rejected with `401 Unauthorized`
15. `POST /api/auth/logout` revoked session and cleared cookie
16. Admin seed created/verified ADMIN account with bcrypt hash
17. `POST /api/api-key/generate` generated `np_live_...` API key
18. Raw API key is NOT stored in database (SHA-256 hash only)
19. Second API key generation rejected with `409 Conflict` (1 User = 1 Key)
20. `POST /api/api-key/rotate` rotated key and returned new raw key once
21. Merchant API rejects dashboard session used as Bearer token (Boundary Check)
22. `requireApiKey` rejects rotated old key and authorizes new key
