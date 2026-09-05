import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { WebhookEventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DealsService } from '../deals/deals.service';

interface PayFastPayload {
  signature?: string;
  m_payment_id?: string;
  pf_payment_id?: string;
  payment_status?: string;
  amount_gross?: string;
  [key: string]: string | number | undefined;
}

interface OzowPayload {
  Status?: string;
  TransactionReference?: string;
  Amount?: string | number;
  CurrencyCode?: string;
  Hash?: string;
  [key: string]: string | number | undefined;
}

/**
 * PayFast ITN (Instant Transaction Notification) handling.
 *
 * PayFast retries webhooks aggressively (up to days). We therefore make
 * handling idempotent by recording the event (keyed on provider + event id)
 * BEFORE doing work, and skipping anything already processed. Signature
 * verification prevents forged webhook calls from releasing escrow.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private deals: DealsService,
  ) {}

  /**
   * Verifies the PayFast signature. All POST fields except `signature` are
   * sorted alphabetically and joined as `key=value`, the passphrase is
   * appended, and the result is MD5-hashed.
   */
  verifyPayFastSignature(payload: PayFastPayload): boolean {
    const passphrase = this.config.get('PAYFAST_PASSPHRASE');
    if (!passphrase) {
      this.logger.warn('PAYFAST_PASSPHRASE not configured; cannot verify signature');
      return false;
    }

    const { signature, ...rest } = payload;

    const signString = Object.keys(rest)
      .sort()
      .map((key) => `${key}=${rest[key]}`)
      .join('&');

    const expected = createHash('md5')
      .update(signString + passphrase)
      .digest('hex');

    return expected === signature;
  }

  /**
   * Entry point for the PayFast ITN endpoint. Returns a boolean so the
   * controller can respond with the plain "OK" that PayFast expects.
   */
  async handlePayFastWebhook(payload: PayFastPayload): Promise<boolean> {
    if (!this.verifyPayFastSignature(payload)) {
      throw new BadRequestException('Invalid signature');
    }

    const eventId = payload.pf_payment_id || payload.m_payment_id || 'unknown';
    const status = payload.payment_status || 'unknown';
    const dedupeId = `payfast:${eventId}:${status}`;

    const existing = await this.prisma.webhookEvent.findUnique({
      where: { eventId: dedupeId },
    });
    if (existing) {
      if (existing.status === WebhookEventStatus.PROCESSED) {
        return true; // already handled; tell provider to stop retrying
      }
      // A retry that previously failed -> attempt again.
      await this.prisma.webhookEvent.update({
        where: { id: existing.id },
        data: { attempts: { increment: 1 } },
      });
      try {
        return await this.processPayFastEvent(payload, existing.id);
      } catch (e: any) {
        await this.recordFailure(existing.id, e);
        throw e;
      }
    }

    const created = await this.prisma.webhookEvent.create({
      data: {
        provider: 'payfast',
        eventId: dedupeId,
        payload: payload as any,
      },
    });

    try {
      return await this.processPayFastEvent(payload, created.id);
    } catch (e: any) {
      await this.recordFailure(created.id, e);
      throw e;
    }
  }

  private async processPayFastEvent(
    payload: PayFastPayload,
    eventDbId: string,
  ): Promise<boolean> {
    const status = payload.payment_status || '';
    const dealId = payload.m_payment_id;

    if (!dealId) {
      this.logger.warn(`PayFast event ${eventDbId} has no m_payment_id`);
      await this.markProcessed(eventDbId);
      return true;
    }

    // Only COMPLETE clears funds into escrow.
    if (status !== 'COMPLETE') {
      this.logger.log(`PayFast event ${eventDbId} status=${status}; ignored`);
      await this.markProcessed(eventDbId);
      return true;
    }

    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) throw new NotFoundException(`Deal ${dealId} not found`);

    if (deal.paymentStatus === 'HELD_IN_ESCROW' || deal.paymentStatus === 'RELEASED') {
      // Already funded -> nothing to do.
      await this.markProcessed(eventDbId);
      return true;
    }

    // Optionally cross-check the gross amount against the expected total.
    const expectedTotal = +deal.amount.toFixed(2);
    const received = payload.amount_gross ? +payload.amount_gross : NaN;
    if (!isNaN(received) && Math.abs(received - expectedTotal) > 0.01) {
      this.logger.error(
        `Amount mismatch for deal ${dealId}: expected ${expectedTotal}, got ${received}`,
      );
      throw new BadRequestException('Payment amount mismatch');
    }

    await this.deals.markPaidInEscrow(dealId, payload.pf_payment_id);
    await this.markProcessed(eventDbId);

    this.logger.log(
      `PayFast event ${eventDbId}: deal ${dealId} now HELD_IN_ESCROW`,
    );
    return true;
  }

  /** Create a deal checkout reference for the Android client to call PayFast. */
  async buildPayFastRedirect(dealId: string, requesterId: string) {
    const deal = await this.deals.findById(dealId, requesterId);
    if (deal.brandId !== requesterId) {
      throw new BadRequestException('Only the brand can fund a deal');
    }
    if (deal.paymentStatus !== 'PENDING') {
      throw new BadRequestException('Deal payment is not pending');
    }

    const merchantId = this.config.get('PAYFAST_MERCHANT_ID');
    const merchantKey = this.config.get('PAYFAST_MERCHANT_KEY');
    const base = this.config.get('PAYFAST_BASE_URL') || 'https://www.payfast.co.za/eng/process';
    if (!merchantId || !merchantKey) {
      throw new BadRequestException('PayFast is not configured');
    }

    const params: Record<string, string | number> = {
      merchant_id: merchantId,
      merchant_key: merchantKey,
      return_url: `${this.config.get('APP_BASE_URL')}/payments/return?deal=${dealId}`,
      cancel_url: `${this.config.get('APP_BASE_URL')}/payments/cancel?deal=${dealId}`,
      notify_url: `${this.config.get('APP_BASE_URL')}/payments/webhook/payfast`,
      m_payment_id: deal.id,
      amount: deal.amount.toFixed(2),
      item_name: deal.title,
      item_description: deal.description || deal.title,
    };

    const query = Object.keys(params)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(params[k])}`)
      .join('&');

    return { url: `${base}?${query}`, provider: 'payfast' };
  }

  // ─────────────────────────── OZOW RAIL ──────────────────────────

  /**
   * Build an Ozow checkout URL. Ozow signs the POSTed fields by joining
   * merchantCode + siteCode + countryCode + currencyCode + amount +
   * transactionReference + bankReference + cancelUrl + errorUrl + successUrl +
   * notifyUrl + privateKey, then MD5-hashing.
   */
  async buildOzowRedirect(dealId: string, requesterId: string) {
    const deal = await this.deals.findById(dealId, requesterId);
    if (deal.brandId !== requesterId) {
      throw new BadRequestException('Only the brand can fund a deal');
    }
    if (deal.paymentStatus !== 'PENDING') {
      throw new BadRequestException('Deal payment is not pending');
    }

    const siteCode = this.config.get('OZOW_SITE_CODE');
    const merchantCode = this.config.get('OZOW_MERCHANT_CODE');
    const privateKey = this.config.get('OZOW_PRIVATE_KEY');
    const base = this.config.get('OZOW_API_URL') || 'https://pay.ozow.com';
    if (!siteCode || !merchantCode || !privateKey) {
      throw new BadRequestException('Ozow is not configured');
    }

    const txnRef = `KOLAB-${dealId}`;
    const amount = deal.amount.toFixed(2);
    const bankRef = txnRef;
    const cancelUrl = `${this.config.get('APP_BASE_URL')}/payments/cancel?deal=${dealId}`;
    const errorUrl = `${this.config.get('APP_BASE_URL')}/payments/error?deal=${dealId}`;
    const successUrl = `${this.config.get('APP_BASE_URL')}/payments/return?deal=${dealId}`;
    const notifyUrl = `${this.config.get('APP_BASE_URL')}/payments/webhook/ozow`;

    // Ozow signature: MD5 of the concatenated params + private key.
    const signature = createHash('md5')
      .update(
        merchantCode +
          siteCode +
          'ZAR' + // countryCode
          'ZAR' + // currencyCode
          amount +
          txnRef +
          bankRef +
          cancelUrl +
          errorUrl +
          successUrl +
          notifyUrl +
          privateKey,
      )
      .digest('hex');

    const params: Record<string, string> = {
      MerchantCode: merchantCode,
      SiteCode: siteCode,
      CountryCode: 'ZAR',
      CurrencyCode: 'ZAR',
      Amount: amount,
      TransactionReference: txnRef,
      BankReference: bankRef,
      CancelUrl: cancelUrl,
      ErrorUrl: errorUrl,
      SuccessUrl: successUrl,
      NotifyUrl: notifyUrl,
      IsTest: this.config.get('OZOW_TEST') === 'true' ? 'true' : 'false',
      hash: signature,
    };

    return { url: base, params, provider: 'ozow' };
  }

  /**
   * Verify the Ozow callback hash:
   * MD5(Status + TransactionReference + Amount + CurrencyCode + SiteCode + PrivateKey)
   */
  verifyOzowSignature(payload: OzowPayload): boolean {
    const siteCode = this.config.get('OZOW_SITE_CODE');
    const privateKey = this.config.get('OZOW_PRIVATE_KEY');
    if (!siteCode || !privateKey) return false;

    const expected = createHash('md5')
      .update(
        `${payload.Status}${payload.TransactionReference}${payload.Amount}${payload.CurrencyCode}${siteCode}${privateKey}`,
      )
      .digest('hex');
    return expected.toLowerCase() === ((payload.Hash || '') as string).toLowerCase();
  }

  /**
   * Handle the Ozow payment notification. Idempotent via webhook_events.
   * Ozow sends Status="Complete" when funds arrive and expects an "OK" reply.
   */
  async handleOzowWebhook(payload: OzowPayload): Promise<boolean> {
    if (!this.verifyOzowSignature(payload)) {
      throw new BadRequestException('Invalid Ozow signature');
    }

    const status = String(payload.Status || '').toLowerCase();
    const txnRef = String(payload.TransactionReference || '');
    const dealId = txnRef.replace(/^KOLAB-/, '');
    const dedupeId = `ozow:${txnRef || 'unknown'}:${status}`;

    // Only "Complete" clears funds into escrow.
    if (status !== 'complete') {
      this.logger.log(`Ozow event ${dedupeId}: status=${status}; ignored`);
      await this.recordEvent(dedupeId, { payload, provider: 'ozow', processed: true });
      return true;
    }

    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventId: dedupeId } });
    if (existing?.status === WebhookEventStatus.PROCESSED) return true;

    const deal = dealId ? await this.prisma.deal.findUnique({ where: { id: dealId } }) : null;
    if (!deal) throw new NotFoundException(`Deal ${dealId} not found`);

    if (deal.paymentStatus === 'HELD_IN_ESCROW' || deal.paymentStatus === 'RELEASED') {
      await this.recordEvent(dedupeId, { payload, provider: 'ozow', processed: true });
      return true;
    }

    const expectedTotal = +deal.amount.toFixed(2);
    const received = payload.Amount ? +payload.Amount : NaN;
    if (!isNaN(received) && Math.abs(received - expectedTotal) > 0.01) {
      throw new BadRequestException('Ozow amount mismatch');
    }

    await this.deals.markPaidInEscrow(dealId, String(txnRef));
    await this.recordEvent(dedupeId, { payload, provider: 'ozow', processed: true });
    this.logger.log(`Ozow event ${dedupeId}: deal ${dealId} now HELD_IN_ESCROW`);
    return true;
  }

  /** Idempotency helper that upserts a webhook event record. */
  private async recordEvent(
    dedupeId: string,
    data: { payload: unknown; provider: string; processed: boolean },
  ) {
    await this.prisma.webhookEvent.upsert({
      where: { eventId: dedupeId },
      create: {
        provider: data.provider,
        eventId: dedupeId,
        payload: data.payload as any,
        status: data.processed
          ? WebhookEventStatus.PROCESSED
          : WebhookEventStatus.RECEIVED,
        processedAt: data.processed ? new Date() : null,
      },
      update: data.processed
        ? { status: WebhookEventStatus.PROCESSED, processedAt: new Date() }
        : {},
    });
  }


  private async markProcessed(id: string) {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date() },
    });
  }

  private async recordFailure(id: string, error: Error) {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: {
        status: WebhookEventStatus.FAILED,
        lastError: error.message,
        attempts: { increment: 1 },
      },
    });
  }
}
