# NeetPay V1 - Authentication & API Key Specification

## 1. Overview & Security Architecture

NeetPay V1 implements strict separation between **Dashboard Authentication** and **Merchant Public API Authentication**:

1. **Dashboard & Web Session Auth (`requireAuth`)**:
   - Strictly uses **HttpOnly Session Cookie** (`neetpay_session`).
   - Session maximum lifetime: **7 hari** (bukan 30 hari).
   - Response JSON saat login **TIDAK** mengekspos `sessionToken` / `token` ke response body.
   - Database hanya menyimpan **`tokenHash` (SHA-256)** di model `AuthSession`.
   - API key `np_live_...` **TIDAK** diterima sebagai session cookie dashboard.

2. **Merchant Public API Auth (`requireApiKey`)**:
   - Single API key per user (`1 User = 1 ApiCredential`).
   - Format: `np_live_<crypto_hex>`.
   - Dikirimkan via header: `Authorization: Bearer np_live_...`.
   - Database hanya menyimpan `keyPrefix` dan `keyHash` (SHA-256).
   - Dashboard session cookie/token **TIDAK** diterima sebagai Merchant API key.

---

## 2. Standard API Response Envelope

All NeetPay API endpoints adhere to a unified JSON response envelope:

### Success Response (`2xx`)
```json
{
  "success": true,
  "data": { ... },
  "message": "Human readable success message"
}
```

### Error Response (`4xx`, `5xx`)
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE_STRING",
    "message": "Human readable error description",
    "details": { ... }
  }
}
```

---

## 3. Authentication Endpoints

### 3.1 Public User Registration
* **Endpoint**: `POST /api/auth/register`
* **Access**: Public
* **Description**: Registers a new merchant account and automatically assigns an active **FREE Plan** subscription.

#### Request Body
```json
{
  "name": "Merchant Name",
  "email": "merchant@example.com",
  "password": "SecurePassword123!"
}
```

#### Validation Rules
* `name`: String, 2 to 100 characters.
* `email`: Valid email format (automatically normalized to lowercase).
* `password`: Minimum 8 characters (hashed via bcrypt with cost factor 10).
* `role`: Forced to `USER` (public registration cannot escalate to `ADMIN`).

#### Response (`201 Created`)
```json
{
  "success": true,
  "data": {
    "id": "usr_cly1234567890abcdef",
    "email": "merchant@example.com",
    "name": "Merchant Name",
    "role": "USER",
    "status": "ACTIVE",
    "createdAt": "2026-08-16T12:00:00.000Z"
  },
  "message": "Account registered successfully. You can now log in."
}
```

---

### 3.2 User Login (Cookie ONLY)
* **Endpoint**: `POST /api/auth/login`
* **Access**: Public
* **Description**: Authenticates user credentials, creates a 7-day session in database, and sets an `HttpOnly` cookie (`neetpay_session`).

#### Request Body
```json
{
  "email": "merchant@example.com",
  "password": "SecurePassword123!"
}
```

#### Response Headers
```http
Set-Cookie: neetpay_session=0123456789abcdef...; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Expires=Sun, 23 Aug 2026 12:00:00 GMT
```

#### Response Body (`200 OK`)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr_cly1234567890abcdef",
      "email": "merchant@example.com",
      "name": "Merchant Name",
      "role": "USER",
      "status": "ACTIVE",
      "createdAt": "2026-08-16T12:00:00.000Z"
    },
    "session": {
      "expiresAt": "2026-08-23T12:00:00.000Z"
    }
  },
  "message": "Logged in successfully"
}
```
*(Catatan: Raw token credential tidak pernah diekspos di response JSON).*

---

### 3.3 User Logout
* **Endpoint**: `POST /api/auth/logout`
* **Access**: Authenticated Session (Cookie)
* **Description**: Revokes and deletes the current `AuthSession` record from PostgreSQL and clears the session cookie.

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "loggedOut": true
  },
  "message": "Logged out successfully"
}
```

---

### 3.4 Get Current Profile (`/api/me`)
* **Endpoint**: `GET /api/me`
* **Access**: Authenticated (`requireAuth` via HttpOnly cookie `neetpay_session`)

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "id": "usr_cly1234567890abcdef",
    "email": "merchant@example.com",
    "name": "Merchant Name",
    "role": "USER",
    "status": "ACTIVE",
    "createdAt": "2026-08-16T12:00:00.000Z",
    "subscription": {
      "status": "ACTIVE",
      "currentPeriodEnd": "2036-08-16T12:00:00.000Z",
      "plan": {
        "code": "FREE",
        "name": "Free",
        "monthlyTransactionLimit": 30,
        "paymentAccountLimit": 1
      }
    },
    "apiKey": {
      "exists": true,
      "keyPrefix": "np_live_a1b2c3...",
      "createdAt": "2026-08-16T12:30:00.000Z",
      "rotatedAt": null,
      "lastUsedAt": "2026-08-16T13:00:00.000Z"
    }
  },
  "message": "User profile retrieved"
}
```

---

## 4. API Key Endpoints

### 4.1 Get API Key Metadata
* **Endpoint**: `GET /api/api-key`
* **Access**: Authenticated (`requireAuth` via Cookie)
* **Description**: Returns safe metadata for the authenticated user's API Key (never exposes raw keys or hashes).

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "exists": true,
    "keyPrefix": "np_live_a1b2c3...",
    "createdAt": "2026-08-16T12:30:00.000Z",
    "rotatedAt": null,
    "lastUsedAt": "2026-08-16T13:00:00.000Z"
  },
  "message": "API Key metadata retrieved"
}
```

---

### 4.2 Generate API Key
* **Endpoint**: `POST /api/api-key/generate`
* **Access**: Authenticated (`requireAuth` via Cookie)
* **Description**: Generates the user's initial API key. Returns raw key **ONCE**. Rejects with `409 Conflict` if an API key already exists.

#### Response (`201 Created`)
```json
{
  "success": true,
  "data": {
    "rawKey": "np_live_a1b2c3d4e5f67890abcdef1234567890abcdef1234567890",
    "keyPrefix": "np_live_a1b2c3...",
    "createdAt": "2026-08-16T12:30:00.000Z",
    "message": "Save this API Key now. It will not be shown again."
  },
  "message": "API Key generated successfully"
}
```

---

### 4.3 Rotate API Key
* **Endpoint**: `POST /api/api-key/rotate`
* **Access**: Authenticated (`requireAuth` via Cookie)
* **Description**: Generates a new API key, updates the stored SHA-256 hash, and marks `rotatedAt`. The old API key is immediately and permanently invalidated. Returns new raw key **ONCE**.

#### Response (`200 OK`)
```json
{
  "success": true,
  "data": {
    "rawKey": "np_live_9876543210fedcba9876543210fedcba9876543210fedcba",
    "keyPrefix": "np_live_987654...",
    "rotatedAt": "2026-08-16T14:00:00.000Z",
    "message": "Your API Key has been rotated. Previous API key is now permanently invalid."
  },
  "message": "API Key rotated successfully"
}
```

---

## 5. Merchant Public API Authentication Middleware (`requireApiKey`)

Public merchant endpoints (e.g. creating transactions, checking transaction status) authenticate using the API key:

### Authorization Header Format
```http
Authorization: Bearer np_live_a1b2c3d4e5f67890abcdef1234567890abcdef1234567890
```

### Security Flow
1. Middleware extracts `rawKey` from `Authorization: Bearer ...`.
2. Asserts prefix starts with `np_live_`. (Rejects session cookies).
3. Computes `SHA-256(rawKey)`.
4. Queries `ApiCredential` by `keyHash`.
5. Verifies associated merchant user is `ACTIVE`.
6. Updates `lastUsedAt` timestamp.
7. Binds `merchantUser` and `apiCredential` to Hono context.
