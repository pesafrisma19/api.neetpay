export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'NeetPay REST API',
    version: '1.0.0',
    description: `## Non-Custodial QRIS Payment Gateway for Indonesian Merchants

NeetPay provides an automated, non-custodial QRIS payment infrastructure. Funds go directly from customer e-wallets / mobile banking apps straight into the merchant's GoBiz / GoPay Merchant settlement account without intermediary platform custody or hold.

---

### Core Architecture & Operating Principles
* **Non-Custodial**: NeetPay never holds customer funds. Settlement is processed directly by the payment provider (GoBiz).
* **Deterministic Dynamic QRIS**: Every payment generates an official EMVCo QR code string with an exact **5-minute (300 seconds)** validity window.
* **Auto-Increment Unique Code Mechanism**: Transactions automatically assign a unique payment code starting from \`+1\` (e.g. Rp 25.001 for a base Rp 25.000 order). If the calculated \`totalAmount\` collides with an active \`PENDING\` transaction on the same GoBiz Payment Account, it incrementally tests \`+2\`, \`+3\`, up to \`+999\`. This unique code is calculated and assigned automatically by the platform; merchants cannot manually set it.
* **Payment Channels**: Merchants can query available payment accounts via \`GET /v1/payment-channels\` to present selectable payment channels to their end users. The returned \`id\` can be passed as \`paymentAccountId\` in \`POST /v1/transactions\`.
* **Real-time Webhook Notifications**: When a payment mutation is detected by the NeetPay worker, an HTTP POST notification is dispatched to your configured endpoint with timing-safe HMAC-SHA256 signature verification.

---

### Transaction Lifecycle Statuses (Public V1)
In the public merchant API, transactions move through the following states:
* **\`PENDING\`**: Transaction created, awaiting customer payment within the 5-minute validity window.
* **\`PAID\`**: Payment successfully detected and verified via GoBiz journal mutation matching.
* **\`EXPIRED\`**: The 5-minute payment window elapsed without any matching mutation detected.

---

### Subscription Plans & Quotas
* **FREE Plan**:
  * **30 created transactions / month**
  * **1 Payment Account** (GoBiz outlet)
  * Real-time polling & Webhook delivery
* **PRO Plan**:
  * **Unlimited business transactions / month**
  * **Up to 3 Payment Accounts** (GoBiz outlets)
  * Priority webhook retry & dedicated worker journal polling

---

### Authentication
All merchant transaction endpoints require an API Key supplied in the HTTP \`Authorization\` header:

\`\`\`http
Authorization: Bearer np_live_...
\`\`\`

> **Note**: Secret API Keys begin with the prefix \`np_live_\` and can be generated or rotated in your [NeetPay Dashboard](https://neetpay.web.id/dashboard/api-key).
`,
    contact: {
      name: 'NeetPay Developer Support',
      url: 'https://neetpay.web.id',
    },
  },
  servers: [
    {
      url: 'https://api.neetpay.web.id',
      description: 'Production Gateway',
    },
    {
      url: 'http://localhost:4000',
      description: 'Local Development Server',
    },
  ],
  paths: {
    '/v1/payment-channels': {
      get: {
        summary: 'List Active Payment Channels',
        description: `Retrieves the list of active payment channels configured for the authenticated merchant account.

* The \`name\` field is the merchant-customizable display label (e.g. *"QRIS Utama"*, *"QRIS Toko 2"*).
* The \`id\` field is the technical PaymentAccount ID (e.g. \`"cuid_example"\`) that should be provided as \`paymentAccountId\` when creating transactions via \`POST /v1/transactions\`.`,
        operationId: 'listPaymentChannels',
        tags: ['Payment Channels'],
        security: [
          {
            BearerAuth: [],
          },
        ],
        responses: {
          '200': {
            description: 'Active payment channels retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/PaymentChannelsResponse',
                },
                example: {
                  success: true,
                  message: 'Payment channels retrieved successfully',
                  data: [
                    {
                      id: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
                      name: 'QRIS Utama',
                      method: 'QRIS',
                      provider: 'GOBIZ',
                    },
                  ],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized - Invalid or missing API key',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
        },
      },
    },
    '/v1/transactions': {
      post: {
        summary: 'Create Dynamic QRIS Transaction',
        description: 'Creates a new dynamic QRIS payment transaction with an exact 5-minute expiry window. Calculates fee markup, assigns an auto-increment unique code (+1, +2, etc. when unique codes are enabled on the Payment Account) to prevent payment collision, and generates the EMVCo dynamic QR string.',
        operationId: 'createTransaction',
        tags: ['Transactions'],
        security: [
          {
            BearerAuth: [],
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateTransactionRequest',
              },
              example: {
                orderId: 'INV-2026-001',
                amount: 25000,
                paymentAccountId: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
                customerName: 'John Doe',
                customerEmail: 'customer@example.com',
                metadata: {
                  userId: 'usr_9921',
                  itemsCount: 2,
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Transaction created successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/TransactionResponse',
                },
                example: {
                  success: true,
                  message: 'Transaction created successfully',
                  data: {
                    id: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
                    reference: 'INV-2026-001',
                    external_ref_no: 'NP-20260818-A1B2C3',
                    status: 'PENDING',
                    amount: 25000,
                    fee_amount: 0,
                    unique_code: 1,
                    total_amount: 25001,
                    qr_string: '00020101021226590014ID.GO-PAY.WWW01189360091438999999990208123456785204581253033605405250015802ID5914Merchant Store6007Jakarta61051234062070703A016304ABCD',
                    customer_name: 'John Doe',
                    customer_email: 'customer@example.com',
                    metadata: {
                      userId: 'usr_9921',
                      itemsCount: 2,
                    },
                    expires_at: '2026-08-18T10:05:00.000Z',
                    created_at: '2026-08-18T10:00:00.000Z',
                  },
                },
              },
            },
          },
          '400': {
            description: 'Validation failed or no active payment account configured',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
                examples: {
                  ValidationError: {
                    summary: 'Validation Error',
                    value: {
                      success: false,
                      message: 'Input validation failed',
                      error: {
                        code: 'VALIDATION_ERROR',
                        details: {
                          fieldErrors: {
                            amount: ['Minimum amount is Rp 1.000'],
                          },
                        },
                      },
                    },
                  },
                  NoActiveAccount: {
                    summary: 'No Connected GoBiz Account',
                    value: {
                      success: false,
                      message: 'No active payment account found. Please connect your GoBiz account in the NeetPay dashboard.',
                      error: {
                        code: 'NO_ACTIVE_PAYMENT_ACCOUNT',
                      },
                    },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized - Invalid or missing API key',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
                example: {
                  success: false,
                  message: 'API Key required. Provide your API Key in Authorization header: Bearer np_live_...',
                  error: {
                    code: 'UNAUTHORIZED',
                  },
                },
              },
            },
          },
          '403': {
            description: 'Forbidden - Monthly transaction limit exceeded for current plan',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
                example: {
                  success: false,
                  message: 'You have reached your monthly transaction limit for your current subscription plan. Please upgrade to Pro for unlimited transactions.',
                  error: {
                    code: 'MONTHLY_LIMIT_EXCEEDED',
                  },
                },
              },
            },
          },
          '409': {
            description: 'Conflict - Duplicate active pending order ID or pending payment amount collision when unique code is disabled on the Payment Account',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
                examples: {
                  duplicatePendingAmount: {
                    summary: 'Pending Amount Collision (Unique Code OFF on Payment Account)',
                    value: {
                      success: false,
                      message: 'An active pending transaction with the same payment amount already exists for this payment account. Please retry after payment is completed or expired, or enable unique codes on the Payment Account.',
                      error: {
                        code: 'DUPLICATE_PENDING_AMOUNT',
                      },
                    },
                  },
                  duplicatePendingOrder: {
                    summary: 'Duplicate Order ID',
                    value: {
                      success: false,
                      message: 'An active pending transaction already exists with orderId "INV-2026-001".',
                      error: {
                        code: 'DUPLICATE_PENDING_ORDER',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/v1/transactions/{id}': {
      get: {
        summary: 'Get Transaction Status & Details',
        description: 'Retrieves complete transaction details, payment verification timestamp, and current status. The `{id}` parameter supports:\n1. Internal NeetPay Transaction ID (e.g. `cuid_...`)\n2. External Reference Number (`external_ref_no`, e.g. `NP-20260818-A1B2C3`)\n3. Merchant Order ID / Reference (`reference` / `merchantTradeNo`, e.g. `INV-2026-001`)',
        operationId: 'getTransaction',
        tags: ['Transactions'],
        security: [
          {
            BearerAuth: [],
          },
        ],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'NeetPay transaction ID (cuid), external reference number (`NP-20260818-A1B2C3`), or merchant order ID (`INV-2026-001`)',
            schema: {
              type: 'string',
            },
            example: 'NP-20260818-A1B2C3',
          },
        ],
        responses: {
          '200': {
            description: 'Transaction details retrieved successfully',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/TransactionDetailResponse',
                },
                example: {
                  success: true,
                  message: 'Transaction details retrieved',
                  data: {
                    id: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
                    reference: 'INV-2026-001',
                    external_ref_no: 'NP-20260818-A1B2C3',
                    status: 'PAID',
                    payment_method: 'QRIS',
                    account_name: 'Warung Kopi Sejahtera (GoBiz)',
                    amount: 25000,
                    fee_amount: 0,
                    unique_code: 1,
                    total_amount: 25001,
                    qr_string: '00020101021226590014ID.GO-PAY.WWW01189360091438999999990208123456785204581253033605405250015802ID5914Merchant Store6007Jakarta61051234062070703A016304ABCD',
                    customer_name: 'John Doe',
                    customer_email: 'customer@example.com',
                    metadata: {
                      userId: 'usr_9921',
                    },
                    paid_at: '2026-08-18T10:02:15.000Z',
                    expires_at: '2026-08-18T10:05:00.000Z',
                    created_at: '2026-08-18T10:00:00.000Z',
                  },
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
          '404': {
            description: 'Transaction not found',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
                example: {
                  success: false,
                  message: 'Transaction not found with the provided identifier.',
                  error: {
                    code: 'TRANSACTION_NOT_FOUND',
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        summary: 'API Health Check',
        description: 'Returns health status and timestamp of the NeetPay API Gateway service.',
        operationId: 'healthCheck',
        tags: ['System'],
        responses: {
          '200': {
            description: 'Service is operational',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    success: { type: 'boolean', example: true },
                    data: {
                      type: 'object',
                      properties: {
                        service: { type: 'string', example: 'neetpay-api' },
                        version: { type: 'string', example: '1.0.0' },
                        status: { type: 'string', example: 'UP' },
                        timestamp: { type: 'string', format: 'date-time', example: '2026-08-18T10:00:00.000Z' },
                      },
                    },
                    message: { type: 'string', example: 'NeetPay API Gateway is operational' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  webhooks: {
    transactionPaid: {
      post: {
        summary: 'Payment Detected (transaction.paid)',
        description: `Dispatched automatically when the NeetPay Payment Worker matches an inbound credit mutation in your GoBiz transaction journal.

### HMAC Signature Verification
Every webhook request contains signature headers:
* \`X-NeetPay-Signature\`: \`HMAC_SHA256(webhookSecret, "\${timestamp}.\${rawBody}")\`
* \`X-NeetPay-Timestamp\`: Unix epoch timestamp in seconds
* \`X-NeetPay-Event\`: \`transaction.paid\`
* \`X-NeetPay-Delivery-Id\`: Unique delivery identifier for idempotent deduplication

#### Verification Example (Node.js):
\`\`\`javascript
const crypto = require('crypto');

function verifyWebhook(rawBody, signature, timestamp, secret) {
  const payloadToSign = \`\${timestamp}.\${rawBody}\`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payloadToSign)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'utf8'),
    Buffer.from(expectedSignature, 'utf8')
  );
}
\`\`\`
`,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/WebhookPaidEventPayload',
              },
              example: {
                event: 'transaction.paid',
                created_at: '2026-08-18T10:02:15.000Z',
                data: {
                  id: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
                  reference: 'INV-2026-001',
                  status: 'PAID',
                  amount: 25000,
                  fee_amount: 0,
                  unique_code: 1,
                  total_amount: 25001,
                  paid_at: '2026-08-18T10:02:15.000Z',
                  created_at: '2026-08-18T10:00:00.000Z',
                  expires_at: '2026-08-18T10:05:00.000Z',
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Merchant acknowledged webhook delivery with HTTP 200/204 status',
          },
        },
      },
    },
    transactionExpired: {
      post: {
        summary: 'Payment Expired (transaction.expired)',
        description: 'Dispatched when a 5-minute transaction payment window elapses without any matching mutation detected.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/WebhookExpiredEventPayload',
              },
              example: {
                event: 'transaction.expired',
                created_at: '2026-08-18T10:05:01.000Z',
                data: {
                  id: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
                  reference: 'INV-2026-001',
                  status: 'EXPIRED',
                  amount: 25000,
                  fee_amount: 0,
                  unique_code: 1,
                  total_amount: 25001,
                  paid_at: null,
                  created_at: '2026-08-18T10:00:00.000Z',
                  expires_at: '2026-08-18T10:05:00.000Z',
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Merchant acknowledged webhook delivery',
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'np_live_...',
        description: 'Merchant Secret API Key. Must begin with prefix `np_live_`. Generated from NeetPay Dashboard.',
      },
    },
    schemas: {
      PaymentChannelsResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Payment channels retrieved successfully' },
          data: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/PaymentChannelItem',
            },
          },
        },
      },
      PaymentChannelItem: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'PaymentAccount technical ID. Pass this value as `paymentAccountId` in `POST /v1/transactions`.',
            example: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
          },
          name: {
            type: 'string',
            description: 'Merchant-customized display name for UI display to customers (e.g. "QRIS Utama").',
            example: 'QRIS Utama',
          },
          method: {
            type: 'string',
            description: 'Payment method type.',
            example: 'QRIS',
          },
          provider: {
            type: 'string',
            description: 'Underlying payment provider.',
            example: 'GOBIZ',
          },
        },
      },
      CreateTransactionRequest: {
        type: 'object',
        required: ['orderId', 'amount'],
        properties: {
          orderId: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Unique order identifier from your merchant e-commerce system (e.g. INV-2026-001)',
            example: 'INV-2026-001',
          },
          amount: {
            type: 'integer',
            minimum: 1000,
            description: 'Base order amount in Rupiah (IDR). Minimum is Rp 1.000.',
            example: 25000,
          },
          paymentAccountId: {
            type: 'string',
            description: 'Optional PaymentAccount ID obtained from `GET /v1/payment-channels`. If omitted, NeetPay automatically routes to your active default GoBiz account. Unique-code behavior is configured on the selected Payment Account.',
            example: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j',
          },
          customerName: {
            type: 'string',
            maxLength: 100,
            description: 'Optional customer name for transaction records',
            example: 'John Doe',
          },
          customerEmail: {
            type: 'string',
            format: 'email',
            description: 'Optional customer email address',
            example: 'customer@example.com',
          },
          customerPhone: {
            type: 'string',
            maxLength: 25,
            description: 'Optional customer phone / WhatsApp number',
            example: '6281234567890',
          },
          metadata: {
            type: 'object',
            description: 'Optional custom JSON metadata object to attach to the transaction',
            example: {
              userId: 'usr_9921',
              invoiceRef: 'INV/2026/08/99',
            },
          },
        },
      },
      TransactionResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Transaction created successfully' },
          data: {
            $ref: '#/components/schemas/TransactionData',
          },
        },
      },
      TransactionDetailResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Transaction details retrieved' },
          data: {
            $ref: '#/components/schemas/TransactionDetailData',
          },
        },
      },
      TransactionData: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Internal NeetPay transaction CUID', example: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j' },
          reference: { type: 'string', description: 'Merchant orderId provided during creation', example: 'INV-2026-001' },
          external_ref_no: { type: 'string', description: 'Public unique transaction reference number', example: 'NP-20260818-A1B2C3' },
          status: {
            type: 'string',
            enum: ['PENDING', 'PAID', 'EXPIRED'],
            description: 'Current transaction status (PENDING, PAID, or EXPIRED)',
            example: 'PENDING',
          },
          amount: { type: 'number', description: 'Base amount in IDR', example: 25000 },
          fee_amount: { type: 'number', description: 'Merchant-configured fee markup', example: 0 },
          unique_code: { type: 'integer', description: 'Auto-increment unique payment matching code (starts at 1)', example: 1 },
          total_amount: { type: 'number', description: 'Total payable amount (amount + fee_amount + unique_code)', example: 25001 },
          qr_string: { type: 'string', nullable: true, description: 'EMVCo Dynamic QRIS payload string', example: '00020101021226590014ID.GO-PAY.WWW01189360091438999999990208123456785204581253033605405250015802ID5914Merchant Store6007Jakarta61051234062070703A016304ABCD' },
          qris_url: { type: 'string', nullable: true, description: 'NEETpay-hosted QR image URL', example: 'https://api.neetpay.web.id/v1/transactions/INV-2026-001/qr.png' },
          checkout_url: { type: 'string', nullable: true, description: 'NEETpay-hosted payment page URL', example: 'https://neetpay.web.id/pay/INV-2026-001' },
          customer_name: { type: 'string', nullable: true, example: 'John Doe' },
          customer_email: { type: 'string', nullable: true, example: 'customer@example.com' },
          customer_phone: { type: 'string', nullable: true, description: 'Optional customer phone / WhatsApp number', example: '6281234567890' },
          metadata: { type: 'object', nullable: true },
          expires_at: { type: 'string', format: 'date-time', description: 'ISO 8601 expiry timestamp', example: '2026-08-18T10:05:00.000Z' },
          created_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:00:00.000Z' },
        },
      },
      TransactionDetailData: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j' },
          reference: { type: 'string', example: 'INV-2026-001' },
          external_ref_no: { type: 'string', example: 'NP-20260818-A1B2C3' },
          status: {
            type: 'string',
            enum: ['PENDING', 'PAID', 'EXPIRED'],
            example: 'PAID',
          },
          payment_method: { type: 'string', example: 'QRIS' },
          account_name: { type: 'string', example: 'Warung Kopi Sejahtera (GoBiz)' },
          amount: { type: 'number', example: 25000 },
          fee_amount: { type: 'number', example: 0 },
          unique_code: { type: 'integer', example: 1 },
          total_amount: { type: 'number', example: 25001 },
          qr_string: { type: 'string', nullable: true, example: '000201010212...' },
          qris_url: { type: 'string', nullable: true, description: 'NEETpay-hosted QR image URL', example: 'https://api.neetpay.web.id/v1/transactions/INV-2026-001/qr.png' },
          checkout_url: { type: 'string', nullable: true, description: 'NEETpay-hosted payment page URL', example: 'https://neetpay.web.id/pay/INV-2026-001' },
          customer_name: { type: 'string', nullable: true, example: 'John Doe' },
          customer_email: { type: 'string', nullable: true, example: 'customer@example.com' },
          customer_phone: { type: 'string', nullable: true, description: 'Optional customer phone / WhatsApp number', example: '6281234567890' },
          metadata: { type: 'object', nullable: true },
          paid_at: { type: 'string', format: 'date-time', nullable: true, example: '2026-08-18T10:02:15.000Z' },
          expires_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:05:00.000Z' },
          created_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:00:00.000Z' },
        },
      },
      WebhookPaidEventPayload: {
        type: 'object',
        properties: {
          event: { type: 'string', example: 'transaction.paid' },
          created_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:02:15.000Z' },
          data: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j' },
              reference: { type: 'string', example: 'INV-2026-001' },
              status: { type: 'string', example: 'PAID' },
              amount: { type: 'number', example: 25000 },
              fee_amount: { type: 'number', example: 0 },
              unique_code: { type: 'integer', example: 1 },
              total_amount: { type: 'number', example: 25001 },
              paid_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:02:15.000Z' },
              created_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:00:00.000Z' },
              expires_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:05:00.000Z' },
            },
          },
        },
      },
      WebhookExpiredEventPayload: {
        type: 'object',
        properties: {
          event: { type: 'string', example: 'transaction.expired' },
          created_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:05:01.000Z' },
          data: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'cuid_cm6u8a1b2c3d4e5f6g7h8i9j' },
              reference: { type: 'string', example: 'INV-2026-001' },
              status: { type: 'string', example: 'EXPIRED' },
              amount: { type: 'number', example: 25000 },
              fee_amount: { type: 'number', example: 0 },
              unique_code: { type: 'integer', example: 1 },
              total_amount: { type: 'number', example: 25001 },
              paid_at: { type: 'string', nullable: true, example: null },
              created_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:00:00.000Z' },
              expires_at: { type: 'string', format: 'date-time', example: '2026-08-18T10:05:00.000Z' },
            },
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Error description' },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'ERROR_CODE' },
              details: { type: 'object' },
            },
          },
        },
      },
    },
  },
};
