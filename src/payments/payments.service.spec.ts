import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { WebhookEventStatus } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { DealsService } from '../deals/deals.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PaymentsService (PayFast webhook)', () => {
  let service: PaymentsService;
  let prisma: any;
  let deals: any;

  const passphrase = 'test-passphrase';
  const configMock = {
    get: jest.fn((key: string) => {
      if (key === 'PAYFAST_PASSPHRASE') return passphrase;
      if (key === 'PAYFAST_MERCHANT_ID') return '10024101';
      if (key === 'PAYFAST_MERCHANT_KEY') return 'merchant-key';
      if (key === 'APP_BASE_URL') return 'http://localhost:3000';
      return undefined;
    }),
  };

  /** Build a valid PayFast ITN payload with a correct MD5 signature. */
  function signedPayload(overrides: Record<string, string> = {}) {
    const payload: Record<string, string> = {
      m_payment_id: 'deal_123',
      pf_payment_id: 'pf_456',
      payment_status: 'COMPLETE',
      amount_gross: '500.00',
      item_name: 'Test Deal',
      ...overrides,
    };
    const { signature: _omit, ...rest } = payload;
    const signString = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${rest[k]}`)
      .join('&');
    payload.signature = createHash('md5')
      .update(signString + passphrase)
      .digest('hex');
    return payload;
  }

  beforeEach(async () => {
    prisma = {
      webhookEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      deal: { findUnique: jest.fn() },
    };
    deals = {
      findById: jest.fn(),
      markPaidInEscrow: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: ConfigService, useValue: configMock },
        { provide: PrismaService, useValue: prisma },
        { provide: DealsService, useValue: deals },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  it('rejects a payload with an invalid signature', async () => {
    const payload = signedPayload();
    payload.signature = 'forged-signature';

    await expect(service.handlePayFastWebhook(payload)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a duplicate event idempotently (already processed)', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue({
      status: WebhookEventStatus.PROCESSED,
    });
    const result = await service.handlePayFastWebhook(signedPayload());
    expect(result).toBe(true);
    expect(deals.markPaidInEscrow).not.toHaveBeenCalled();
  });

  it('moves the deal to escrow on first COMPLETE event', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.webhookEvent.create.mockResolvedValue({ id: 'event_1' });
    prisma.deal.findUnique.mockResolvedValue({
      id: 'deal_123',
      amount: 500,
      paymentStatus: 'PENDING',
    });
    deals.markPaidInEscrow.mockResolvedValue({});

    const result = await service.handlePayFastWebhook(signedPayload());

    expect(result).toBe(true);
    expect(deals.markPaidInEscrow).toHaveBeenCalledWith('deal_123', 'pf_456');
    expect(prisma.webhookEvent.update).toHaveBeenCalledWith({
      where: { id: 'event_1' },
      data: expect.objectContaining({
        status: WebhookEventStatus.PROCESSED,
      }),
    });
  });

  it('rejects a payment whose amount does not match the deal', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.webhookEvent.create.mockResolvedValue({ id: 'event_2' });
    prisma.deal.findUnique.mockResolvedValue({
      id: 'deal_123',
      amount: 999,
      paymentStatus: 'PENDING',
    });

    // amount_gross of 500 != deal.amount of 999
    await expect(service.handlePayFastWebhook(signedPayload())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(deals.markPaidInEscrow).not.toHaveBeenCalled();
  });

  it('ignores non-COMPLETE payment statuses without touching escrow', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.webhookEvent.create.mockResolvedValue({ id: 'event_3' });

    const result = await service.handlePayFastWebhook(
      signedPayload({ payment_status: 'PENDING' }),
    );

    expect(result).toBe(true);
    expect(deals.markPaidInEscrow).not.toHaveBeenCalled();
  });

  it('does not double-credit a deal that is already in escrow', async () => {
    prisma.webhookEvent.findUnique.mockResolvedValue(null);
    prisma.webhookEvent.create.mockResolvedValue({ id: 'event_4' });
    prisma.deal.findUnique.mockResolvedValue({
      id: 'deal_123',
      amount: 500,
      paymentStatus: 'HELD_IN_ESCROW',
    });

    const result = await service.handlePayFastWebhook(signedPayload());

    expect(result).toBe(true);
    expect(deals.markPaidInEscrow).not.toHaveBeenCalled();
  });
});
