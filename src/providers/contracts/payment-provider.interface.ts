export interface GenerateQrInput {
  externalRefNo: string;
  amount: number;
  customerName?: string;
  customerEmail?: string;
  paymentAccountConfig: Record<string, unknown>;
}

export interface GenerateQrResult {
  qrisPayload: string;
  qrisUrl?: string;
  providerRefId?: string;
  rawResponse: Record<string, unknown>;
}

export interface CheckTransactionInput {
  externalRefNo: string;
  providerRefId?: string;
  paymentAccountConfig: Record<string, unknown>;
}

export interface CheckTransactionResult {
  isPaid: boolean;
  paidAmount?: number;
  paidAt?: Date;
  providerRefId?: string;
  rawResponse: Record<string, unknown>;
}

export interface IPaymentProvider {
  readonly providerCode: string;

  /**
   * Generate QRIS / dynamic payment for an order
   */
  generateQr(input: GenerateQrInput): Promise<GenerateQrResult>;

  /**
   * Check status of a single transaction directly from provider
   */
  checkTransaction(input: CheckTransactionInput): Promise<CheckTransactionResult>;

  /**
   * Poll latest history/settlement entries from provider for an account
   */
  pollHistory(paymentAccountConfig: Record<string, unknown>): Promise<Array<{
    providerRefId: string;
    amount: number;
    paidAt: Date;
    rawPayload: Record<string, unknown>;
  }>>;
}
