# NeetPay V1 - Database Schema Specification

This document details the final 18 core models for NeetPay V1 following all Owner decisions.

---

## 1. Authentication & Users (Non-Custodial)
1. **`User`**
   - Stores merchant/admin master records, login credentials, role, status. Non-custodial (NO balance/wallet).
2. **`AuthSession`**
   - Tracks web/dashboard sessions with revocable `tokenHash`, expiry, IP address, and User-Agent.
3. **`ApiCredential`**
   - Exactly 1 API key per user (`1 User = 1 ApiCredential`). Stores `keyPrefix` for dashboard display and `keyHash` (SHA-256).
4. **`WebhookConfig`**
   - Merchant webhook endpoints, dedicated signing secret (`secretKey`), and subscribed event types.

---

## 2. Billing & Subscriptions (SaaS Quota Only)
5. **`Plan`**
   - SaaS subscription tiers:
     - `priceMonthly` (e.g. 0 IDR for Free, 20,000 IDR for Pro)
     - `monthlyTransactionLimit` (e.g. 30 for Free, null for Pro/unlimited)
     - `paymentAccountLimit` (e.g. 1 for Free, 3 for Pro)
     - *(NO merchant payment fees stored in Plan)*.
6. **`Subscription`**
   - Active subscription linking a user to a `Plan` with cycle dates and auto-renewal flag.
7. **`MonthlyUsage`**
   - Aggregated monthly transaction volume, transaction counts, and API call counters for tier enforcement.

---

## 3. Providers & Payment Accounts
8. **`PaymentProvider`**
   - Master provider records (e.g. `GOBIZ`) with status and configuration schemas.
9. **`PaymentMethod`**
   - Master payment methods (e.g. `QRIS`, `VIRTUAL_ACCOUNT`, `EWALLET`).
10. **`ProviderPaymentMethod`**
    - Junction between providers and methods, setting provider fee structures, min/max limits, and method codes.
11. **`PaymentAccount`**
    - Generic merchant account container (`userId`, `providerId`, `name`, `status`, `isActive`, `lastSyncedAt`). No provider-specific tokens.
12. **`GoBizAccount`**
    - GoBiz-specific extension (`paymentAccountId`, `merchantId`, `outletId`, `merchantName`, `outletName`, `loginIdentifier`, `credentialEncrypted`, `credentialExpiresAt`, `qrString`, `qrUpdatedAt`, `lastConnectionCheckAt`).
13. **`PaymentFeeRule`**
    - Merchant custom fee markup (`type: NONE | FLAT | PERCENT`, `value: Int` in IDR or basis points for percent).

---

## 4. Transactions & Events
14. **`Transaction`**
    - Core payment record storing full snapshot calculations: `amount`, `feeType`, `feeValue`, `feeAmount`, `uniqueCode`, `totalAmount`, `status`, `qrisPayload`, `qrisUrl`, `paidAt`, `expiredAt`.
15. **`TransactionEvent`**
    - Immutable audit trail of status transitions (`TRANSACTION_CREATED`, `QR_GENERATED`, `PAYMENT_DETECTED`, `STATUS_CHANGED`, `WEBHOOK_QUEUED`, `EXPIRED`, `CANCELLED`).
16. **`ProviderEvent`**
    - Raw event/history records ingested from providers during polling or callbacks for idempotency and debugging.

---

## 5. Webhooks & Retry Log
17. **`WebhookDelivery`**
    - Top-level delivery task for an outgoing merchant notification with `status`, `attemptsCount`, and `nextRetryAt`.
18. **`WebhookAttempt`**
    - Granular log of each HTTP delivery attempt (`httpStatus`, `responseBody`, `error`, `durationMs`, `createdAt`).
