# NeetPay V1 - Database, Seeding & Runtime Test Guide

## 1. Development Database Configuration

NeetPay uses **PostgreSQL 16+** hosted on Supabase DEV.

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

## 2. Prisma Database Workflow

### Schema Synchronization
```bash
# Push schema updates directly to development database
npx prisma db push

# Generate fresh Prisma Client
npx prisma generate

# Validate schema integrity
npx prisma validate
```

### Migration History
Initial V1 baseline migration script is tracked under:
`backend/prisma/migrations/20260816_init_v1/migration.sql`

---

## 3. Seed Execution

### 3.1 Base Data Seeding (`npm run seed`)
Executes [**`backend/src/lib/seed.ts`**](file:///D:/project%20web/NEETpay/backend/src/lib/seed.ts):
* **Plan FREE**: `code: "FREE"`, `priceMonthly: 0`, `monthlyTransactionLimit: 30`, `paymentAccountLimit: 1`
* **Plan PRO**: `code: "PRO"`, `priceMonthly: 20000`, `monthlyTransactionLimit: null`, `paymentAccountLimit: 3`
* **PaymentProvider**: `code: "GOBIZ"`, `name: "GoBiz"`, `isEnabled: true`
* **PaymentMethod**: `code: "QRIS"`, `type: QRIS`, `isEnabled: true`
* **ProviderPaymentMethod**: `GOBIZ` $\leftrightarrow$ `QRIS` (`minAmount: 1000`, `maxAmount: 10000000`)

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

### Verification Checklist (20 Tests)
1. Base seed executed successfully
2. Plan FREE exists with exact V1 quota
3. Plan PRO exists with exact V1 quota
4. Payment Provider GOBIZ exists
5. Payment Method QRIS exists
6. ProviderPaymentMethod GOBIZ $\leftrightarrow$ QRIS mapping exists
7. Register USER via `POST /api/auth/register` succeeded
8. Duplicate email registration rejected with `409 Conflict`
9. Public registration cannot escalate role to ADMIN (role is strictly USER)
10. Login with correct password succeeded and returned session
11. Login with incorrect password rejected with `401 Unauthorized`
12. `GET /api/me` with session returned user profile and FREE subscription
13. `GET /api/me` without session rejected with `401 Unauthorized`
14. `POST /api/auth/logout` successfully revoked the session
15. Admin seed created/verified ADMIN account with bcrypt hash
16. `POST /api/api-key/generate` generated `np_live_...` API key
17. Raw API key is NOT stored in database (stored as SHA-256 hash only)
18. Second API key generation rejected with `409 Conflict` (1 User = 1 Key)
19. `POST /api/api-key/rotate` rotated key and returned new raw key once
20. `requireApiKey` rejects rotated old key and authorizes new key
