# NEETPAY V1 - PUBLIC TRANSACTIONS & DYNAMIC QRIS API SPECIFICATION

**Version:** 1.0.0  
**Status:** IMPLEMENTED & VERIFIED (100% Runtime Pass)  
**Public API URL:** `https://api.neetpay.web.id/v1/transactions`  
**Authentication:** Merchant API Key via `Authorization: Bearer np_live_...`  

---

## 1. Overview & Core Principles

The Public Merchant API allows merchants to programmatically generate dynamic, amount-specified QRIS codes tied to their connected GoBiz account.

### Key Capabilities:
1. **Dynamic EMVCo QRIS (`qr_string`)**:
   - Converts GoBiz Base Static QRIS into standard Dynamic QRIS (`Tag 01: 12`).
   - Injects `Tag 54` with exact payable amount (`baseAmount + feeAmount + uniqueCode`).
   - Generates valid CRC16-CCITT checksum (`Tag 63`).
   - **No Heavy Base64 Images Generated**: Clean and fast payload containing only `qr_string` so merchant frontends can render SVG/Canvas QR codes natively.
2. **PostgreSQL Database Row Locking (Multi-Process Concurrency Guard)**:
   - Uses `SELECT ... FOR UPDATE` row-level locks on `subscriptions` and `payment_accounts`.
   - **Quota Guard**: Guarantees parallel requests from API and background worker cannot exceed the 30 transactions/month limit.
   - **Collision-Free Unique Codes**: Serializes parallel transaction creations for the same GoBiz account so concurrent transactions never receive conflicting amounts or unique codes.
3. **Explicit Fee Calculation & Rounding Rule**:
   - `FLAT`: Fixed IDR fee added directly.
   - `PERCENT`: Formula $\text{feeAmount} = \lceil \frac{\text{baseAmount} \times \text{feeValue}}{10000} \rceil$ (`Math.ceil`) where `feeValue` is in basis points ($100 = 1.00\%$, $250 = 2.50\%$).
   - *Example:* Rp 10.000 @ 2.5% = Rp 250; Rp 10.001 @ 2.5% = Rp 251.

---

## 2. API Endpoints

### 1. Create Dynamic QRIS Transaction
* **Endpoint**: `POST /v1/transactions`
* **Headers**:
  * `Authorization: Bearer np_live_<hex_key>`
  * `Content-Type: application/json`

#### Request Body:
```json
{
  "orderId": "ORDER-12345",
  "amount": 50000,
  "paymentAccountId": "clyacc01...",
  "customerName": "Ahmad",
  "customerEmail": "ahmad@example.com",
  "metadata": {
    "productId": "topup_100",
    "userId": "usr_99"
  },
  "expiresInMinutes": 15
}
```

#### Response Body (HTTP 201 Created):
```json
{
  "success": true,
  "data": {
    "id": "clytrx12345...",
    "reference": "ORDER-12345",
    "external_ref_no": "NP-20260816-9F8E2A",
    "status": "PENDING",
    "amount": 50000,
    "fee_amount": 0,
    "unique_code": 37,
    "total_amount": 50037,
    "qr_string": "00020101021226610014COM.GO-JEK.WWW01189360091437545837230210G7545837230303UMI51440014ID.CO.QRIS.WWW0215ID10264750436040303UMI5204899953033605405500375802ID5925NEETshop, Digital & Kreat6007CIANJUR61054329162070703A016304XXXX",
    "customer_name": "Ahmad",
    "customer_email": "ahmad@example.com",
    "metadata": {
      "productId": "topup_100",
      "userId": "usr_99"
    },
    "expires_at": "2026-08-16T17:15:00.000Z",
    "created_at": "2026-08-16T17:00:00.000Z"
  },
  "message": "Transaction created successfully"
}
```

---

### 2. Get Transaction Details & Status
* **Endpoint**: `GET /v1/transactions/:id` (Accepts transaction ID, `external_ref_no`, or merchant `reference` / `orderId`)
* **Headers**: `Authorization: Bearer np_live_<hex_key>`

#### Response Body (HTTP 200 OK):
```json
{
  "success": true,
  "data": {
    "id": "clytrx12345...",
    "reference": "ORDER-12345",
    "external_ref_no": "NP-20260816-9F8E2A",
    "status": "PENDING",
    "payment_method": "QRIS",
    "account_name": "NEETshop Main QRIS Account",
    "amount": 50000,
    "fee_amount": 0,
    "unique_code": 37,
    "total_amount": 50037,
    "qr_string": "000201010212...",
    "customer_name": "Ahmad",
    "customer_email": "ahmad@example.com",
    "metadata": {
      "productId": "topup_100"
    },
    "paid_at": null,
    "expires_at": "2026-08-16T17:15:00.000Z",
    "created_at": "2026-08-16T17:00:00.000Z"
  },
  "message": "Transaction details retrieved"
}
```

---

## 3. Error Responses

| Error Code | HTTP Status | Description |
| :--- | :---: | :--- |
| `UNAUTHORIZED` | 401 | Invalid or missing `Authorization: Bearer np_live_...` API key |
| `MONTHLY_LIMIT_EXCEEDED` | 403 | Plan monthly transaction limit reached (Free: 30) |
| `NO_ACTIVE_PAYMENT_ACCOUNT` | 400 | No active connected GoBiz account found |
| `BASE_QRIS_NOT_FOUND` | 400 | Connected GoBiz account lacks base QRIS string |
| `AMOUNT_OUT_OF_RANGE` | 400 | Nominal violates account or provider min/max limits |
| `DUPLICATE_PENDING_ORDER` | 409 | A pending transaction with the same `orderId` is already active |
| `TRANSACTION_NOT_FOUND` | 404 | Transaction not found or does not belong to merchant |
