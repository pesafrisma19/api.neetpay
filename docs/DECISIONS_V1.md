# NeetPay V1 - Architecture & Decision Record

## 1. Overview & Non-Custodial Model
NeetPay V1 is a lightweight, high-performance, non-custodial payment gateway orchestration platform.

### Non-Custodial Architecture
- NeetPay **DOES NOT** hold, escrow, or store user balances or merchant funds (`User` has NO balance/saldo/wallet).
- Transaction flow:
  $$\text{Customer} \xrightarrow{\text{QRIS Payment}} \text{User's GoBiz Account (Direct)}$$
- All payments settle directly into the merchant's own payment provider account.
- NeetPay solely orchestrates payment creation, provider polling, status synchronization, and webhook dispatching.

---

## 2. Production Deployment & Domains

| Layer | Production Domain | Platform / Host | Managed Process |
| :--- | :--- | :--- | :--- |
| **Frontend** | `https://neetpay.web.id` | Vercel (Static CDN) | React 19 + Vite 8 SPA |
| **Backend API** | `https://api.neetpay.web.id` | Ubuntu VPS (Node 24 LTS) | PM2: `neetpay-api` (Port 4000) |
| **Background Worker** | Internal / Shared VPS | Ubuntu VPS | PM2: `neetpay-worker` (PostgreSQL Polling) |
| **Database** | Internal Network | PostgreSQL 16+ | Direct connection / connection pooler |

### Initial Scope
- **Initial Payment Provider**: `GOBIZ`
- **Initial Public Payment Method**: `QRIS`

---

## 3. Technology Stack

### Backend
- **Runtime**: Node.js 24 LTS
- **Framework**: Hono (`@hono/node-server`)
- **Validation**: Zod + `@hono/zod-openapi`
- **ORM**: Prisma ORM with PostgreSQL
- **Logging**: Pino (`pino-pretty`)
- **Process Manager**: PM2 (`neetpay-api` & `neetpay-worker`)

### Frontend
- **Framework**: React 19 (`19.2.x`) + TypeScript
- **Tooling / Bundler**: Vite 8 (`8.2.x`) with `@vitejs/plugin-react` (v6)
- **Styling**: Tailwind CSS v4 (`4.3.x`) with `@tailwindcss/vite` (Zero legacy config)
- **Component Primitives**: Base UI (`@base-ui/react`) + shadcn/ui design tokens
- **State Management**: TanStack Query (React Query v5)
- **Routing**: React Router (v7)
- **Forms & Validation**: React Hook Form + Zod resolvers
- **Icons & Toasts**: Lucide React + Sonner

---

## 4. Key Architectural Decisions (Owner Confirmed)

### Decision 1: Non-Custodial (No User Balance / Wallet)
- `User` model does not contain `balance` or wallet fields.
- Platform does not intermediate or hold funds.

### Decision 2: Plan Manages SaaS Subscriptions Only
- `Plan` controls account limits and monthly transaction volume:
  - **FREE**: `priceMonthly = 0`, `monthlyTransactionLimit = 30`, `paymentAccountLimit = 1`
  - **PRO**: `priceMonthly = 20000`, `monthlyTransactionLimit = null (unlimited)`, `paymentAccountLimit = 3`
- `Plan` **DOES NOT** store merchant payment markup or transaction fees.
- Merchant markup fees are configured exclusively per-user in `PaymentFeeRule` (`NONE`, `FLAT`, `PERCENT`).

### Decision 3: Single API Key Per User
- 1 User = 1 API Key credential (format: `np_live_xxxxxxxxx`).
- Merchant sends: `Authorization: Bearer np_live_xxxxxxxxx`.
- Database stores `keyPrefix` for safe display and `keyHash` (SHA-256). Raw keys are never stored in the database.
- Webhook signature uses a distinct `secretKey` stored in `WebhookConfig`.

### Decision 4: Generic PaymentAccount vs Provider-Specific Isolation
- `PaymentAccount` contains generic metadata (`userId`, `providerId`, `name`, `status`, `isActive`, `lastSyncedAt`).
- All GoBiz-specific tokens, credentials, merchant IDs, and outlet IDs reside exclusively in `GoBizAccount`.
- Encrypted credentials in `GoBizAccount` use AES-256-GCM encryption.
- This design permits seamless future addition of other providers without schema refactoring.

### Decision 5: Integer-Safe Fee Rule & Transaction Snapshot
- `PaymentFeeRule.value` uses integer representation (IDR for FLAT, basis points for PERCENT, e.g. 100 = 1.00%) to eliminate floating-point precision loss.
- `Transaction` preserves snapshot calculations (`amount`, `feeType`, `feeValue`, `feeAmount`, `uniqueCode`, `totalAmount`).

### Decision 6: Dual-Process Architecture (No-Redis V1)
- Eliminates Redis/BullMQ infrastructure overhead for V1.
- PostgreSQL indexed queue with optimistic locking and retry timestamps (`nextRetryAt`) handles worker polling and webhook dispatching.
