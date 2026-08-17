# NeetPay V1 — Merchant Webhook Specification

Dokumentasi resmi arsitektur, format payload, security signing, dan retry policy untuk sistem Webhook Merchant NeetPay V1.

---

## 1. Daftar Event Webhook (Event List)

NeetPay V1 mendukung 2 event transaksi utama dan 1 event diagnostik:

| Event Name | Deskripsi | Kapan Ditembakkan |
| :--- | :--- | :--- |
| **`transaction.paid`** | Pembayaran QRIS berhasil diverifikasi lunas | Saat mutasi GoBiz berhasil dicocokkan dengan transaksi `PENDING` $\rightarrow$ `PAID` |
| **`transaction.expired`** | Transaksi kedaluwarsa tanpa pembayaran | Saat waktu `expiredAt` + 60s reconciliation grace habis tanpa mutasi |
| **`webhook.test`** | Event pengujian endpoint merchant | Saat merchant menekan tombol "Test Webhook" di dashboard (`POST /api/webhook/test`) |

> **Catatan Penting**: Status `PENDING` **tidak** dikirimkan via webhook karena merchant sudah mendapatkan status dan `qr_string` secara langsung pada response `POST /v1/transactions`.

---

## 2. Struktur Payload Webhook (JSON)

### A. `transaction.paid`
```json
{
  "event": "transaction.paid",
  "created_at": "2026-08-17T06:32:57.687Z",
  "data": {
    "id": "cmswuvrtm0001u6x8fz12b5q0",
    "reference": "ORDER-1786948300582",
    "status": "PAID",
    "amount": 1000,
    "fee_amount": 0,
    "unique_code": 1,
    "total_amount": 1001,
    "paid_at": "2026-08-17T06:32:52.000Z",
    "created_at": "2026-08-17T06:31:40.000Z",
    "expires_at": "2026-08-17T06:36:40.000Z"
  }
}
```

### B. `transaction.expired`
```json
{
  "event": "transaction.expired",
  "created_at": "2026-08-17T06:40:00.000Z",
  "data": {
    "id": "cmswuvrtm0001u6x8fz12b5q0",
    "reference": "ORDER-1786948300582",
    "status": "EXPIRED",
    "amount": 1000,
    "fee_amount": 0,
    "unique_code": 1,
    "total_amount": 1001,
    "paid_at": null,
    "created_at": "2026-08-17T06:31:40.000Z",
    "expires_at": "2026-08-17T06:36:40.000Z"
  }
}
```

### C. `webhook.test`
```json
{
  "event": "webhook.test",
  "created_at": "2026-08-17T06:45:00.000Z",
  "data": {
    "message": "NeetPay webhook test"
  }
}
```

---

## 3. HTTP Request Headers

Setiap webhook request dari NeetPay dikirimkan dengan header berikut:

```http
POST /your-webhook-endpoint HTTP/1.1
Host: api.yourdomain.com
Content-Type: application/json; charset=utf-8
User-Agent: NeetPay-Webhook/1.0
X-NeetPay-Signature: 6f8b9e... (64-char hex HMAC-SHA256)
X-NeetPay-Timestamp: 1786948377 (Unix Timestamp Seconds)
X-NeetPay-Event: transaction.paid
X-NeetPay-Delivery-Id: cmswvx91k0001u6cc4p0z83qm
```

---

## 4. Verifikasi Tanda Tangan (HMAC-SHA256 Signature Verification)

Untuk mencegah request forgery dan replay attacks, NeetPay menandatangani setiap payload menggunakan secret key merchant (`whsec_...`).

### Formula Perhitungan Signature:
$$\text{Signature} = \text{HMAC\_SHA256}\left(\text{webhookSecret}, \text{timestamp} + \text{"."} + \text{rawBody}\right)$$

### Contoh Verifikasi di Node.js (Express / Fastify):

```javascript
import crypto from 'crypto';

function verifyNeetPayWebhook(rawBody, signature, timestamp, webhookSecret) {
  // 1. Replay attack protection (toleransi maksimum 5 menit / 300 detik)
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parseInt(timestamp, 10)) > 300) {
    return false; // Timestamp terlalu lama / replay attack
  }

  // 2. Hitung HMAC-SHA256 dari timestamp + "." + rawBody
  const payloadToSign = `${timestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(payloadToSign)
    .digest('hex');

  // 3. Bandingkan secara timing-safe
  if (expectedSignature.length !== signature.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'utf8'),
    Buffer.from(signature, 'utf8')
  );
}

// Contoh Express Endpoint
app.post('/api/webhook/neetpay', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf8');
  const signature = req.headers['x-neetpay-signature'];
  const timestamp = req.headers['x-neetpay-timestamp'];
  const webhookSecret = process.env.NEETPAY_WEBHOOK_SECRET; // whsec_...

  if (!verifyNeetPayWebhook(rawBody, signature, timestamp, webhookSecret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(rawBody);
  console.log(`Received event: ${payload.event} for order ${payload.data.reference}`);

  // Selalu balas HTTP 200 OK
  return res.status(200).json({ received: true });
});
```

---

## 5. Kebijakan Percobaan Ulang (Retry Policy)

Jika server merchant membalas dengan status non-2xx (misal `500 Internal Server Error`, `404 Not Found`) atau request mengalami *timeout* (10 detik):

| Percobaan (Attempt) | Waktu Penundaan (Delay) | Keterangan |
| :---: | :---: | :--- |
| **Attempt 1** | Langsung (0s) | Ditembakkan segera saat status transaksi final |
| **Attempt 2** | +30 Detik | Percobaan ulang pertama |
| **Attempt 3** | +2 Menit (120s) | Percobaan ulang kedua |
| **Attempt 4** | +10 Menit (600s) | Percobaan ulang ketiga |
| **Attempt 5** | +30 Menit (1800s) | Percobaan ulang terakhir |

Setelah 5 percobaan gagal, pengiriman ditandai sebagai **`FAILED`** dan tidak di-retry lagi.

---

## 6. Dashboard & Security Endpoints

* **`GET /api/webhook`**: Melihat status webhook URL dan masked secret (`whsec_••••••••1234`).
* **`PUT /api/webhook`**: Mengubah URL webhook (`url`) dan status aktif (`isEnabled`).
* **`POST /api/webhook/rotate-secret`**: Merotasi secret signing baru (raw secret hanya ditampilkan 1 kali).
* **`POST /api/webhook/test`**: Mengirimkan event `webhook.test` untuk memverifikasi kesiapan URL merchant.

### Proteksi Keamanan:
1. **SSRF Protection**: URL tujuan webhook divalidasi dan menolak `localhost`, `127.0.0.1`, `::1`, jaringan privat RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), dan Cloud Metadata (`169.254.169.254`).
2. **Non-Blocking Settlement**: Kegagalan webhook di sisi merchant **TIDAK AKAN** me-rollback status transaksi `PAID` / `EXPIRED`.
3. **Database Idempotency**: Setiap status transaksi hanya menghasilkan tepat 1 baris `WebhookDelivery` (dilindungi *unique constraint* `@@unique([transactionId, event])`).
