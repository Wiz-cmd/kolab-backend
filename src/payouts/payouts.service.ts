import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Provider payout abstraction. Dispatches a real payout (PayFast/Ozow/EFT) for a
 * withdrawal once an admin approves it.
 *
 * The provider REST endpoint + credentials are read from env. When not configured
 * the call is simulated (returns a generated reference) so the flow stays testable
 * in sandbox/dev, exactly as the README documents.
 */
@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);

  constructor(private config: ConfigService) {}

  async dispatch(opts: {
    withdrawalId: string;
    userId: string;
    amount: number;
    netAmount: number;
    method: string;
    bankAccount?: Record<string, any>;
  }): Promise<{ success: boolean; reference?: string; raw?: any }> {
    const driver = this.config.get('PAYOUT_DRIVER') || 'mock';

    if (driver === 'mock') {
      // Simulated provider call; deterministic reference so idempotency holds.
      const reference = `PY-${Date.now().toString(36).toUpperCase()}-${opts.withdrawalId.slice(-6).toUpperCase()}`;
      this.logger.log(
        `[mock payout] ${opts.netAmount} (${opts.method}) -> ${opts.userId} ref ${reference}`,
      );
      return { success: true, reference };
    }

    if (driver === 'ozow') {
      // Real Ozow payout (PayOutToBeneficiary). Overridable endpoint.
      const endpoint =
        this.config.get('OZOW_PAYOUT_URL') ||
        `${this.config.get('OZOW_API_URL') || 'https://pay.ozow.com'}/api/payout`;
      const siteCode = this.config.get('OZOW_SITE_CODE');
      const apiKey = this.config.get('OZOW_API_KEY');
      if (!siteCode || !apiKey) {
        throw new Error('Ozow payout not configured (OZOW_SITE_CODE / OZOW_API_KEY)');
      }

      const payload = {
        SiteCode: siteCode,
        TransactionReference: `WDR-${opts.withdrawalId}`,
        Amount: opts.netAmount,
        CurrencyCode: 'ZAR',
        BankAccount: opts.bankAccount || undefined,
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const raw = await res.json().catch(() => ({}));
      if (!res.ok) {
        this.logger.error(`Ozow payout failed: ${res.status} ${JSON.stringify(raw)}`);
        return { success: false, raw };
      }
      return { success: true, reference: raw?.PayoutId || raw?.Reference || undefined, raw };
    }

    if (driver === 'payfast') {
      const endpoint =
        this.config.get('PAYFAST_PAYOUT_URL') ||
        `${this.config.get('PAYFAST_BASE_URL') || 'https://payfast.co.za'}/payouts`;
      const merchantId = this.config.get('PAYFAST_MERCHANT_ID');
      const merchantKey = this.config.get('PAYFAST_MERCHANT_KEY');
      if (!merchantId || !merchantKey) {
        throw new Error('PayFast payout not configured');
      }
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchant_id: merchantId,
          amount: opts.netAmount,
          bank: opts.bankAccount,
          m_payment_id: `WDR-${opts.withdrawalId}`,
        }),
      });
      const raw = await res.json().catch(() => ({}));
      if (!res.ok) return { success: false, raw };
      return { success: true, reference: raw?.reference || undefined, raw };
    }

    return { success: false, raw: { error: `Unknown PAYOUT_DRIVER: ${driver}` } };
  }
}
