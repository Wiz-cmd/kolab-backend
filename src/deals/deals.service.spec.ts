import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DealStatus, PaymentStatus, Role } from '@prisma/client';
import { DealsService } from './deals.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('DealsService (escrow release)', () => {
  let service: DealsService;
  let prisma: any;
  let notifications: any;

  const brandId = 'brand_1';
  const creatorId = 'creator_1';

  const escrowDeal = {
    id: 'deal_1',
    brandId,
    creatorId,
    title: 'Campaign',
    amount: 500,
    creatorAmount: 400, // 500 - 20% fee
    status: DealStatus.DELIVERED,
    paymentStatus: PaymentStatus.HELD_IN_ESCROW,
  };

  beforeEach(async () => {
    prisma = {
      deal: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      user: { update: jest.fn() },
      $transaction: jest.fn(async (ops: any[]) => {
        for (const op of ops) await op;
        return ops;
      }),
    };
    notifications = { create: jest.fn().mockResolvedValue(null) };

    const module = await Test.createTestingModule({
      providers: [
        DealsService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(DealsService);
  });

  it('releases escrow to the creator and credits their balance', async () => {
    prisma.deal.findUnique.mockResolvedValue(escrowDeal);

    const result = await service.releaseFunds(dealId(), brandId, Role.BRAND);

    expect(result).toEqual({ success: true, released: 400 });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: creatorId },
      data: { balance: { increment: 400 } },
    });
    expect(prisma.deal.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'deal_1' },
        data: expect.objectContaining({ paymentStatus: PaymentStatus.RELEASED }),
      }),
    );
  });

  it('forbids a non-brand user from releasing', async () => {
    prisma.deal.findUnique.mockResolvedValue(escrowDeal);

    await expect(
      service.releaseFunds(dealId(), creatorId, Role.MODEL),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an ADMIN to release a deal they are not a party to', async () => {
    prisma.deal.findUnique.mockResolvedValue(escrowDeal);

    // Admin is not brandId, but role ADMIN bypasses the ownership check.
    const result = await service.releaseFunds('deal_1', 'admin_1', Role.ADMIN);
    expect(result.success).toBe(true);
  });

  it('rejects release when funds are not in escrow', async () => {
    prisma.deal.findUnique.mockResolvedValue({
      ...escrowDeal,
      paymentStatus: PaymentStatus.PENDING,
    });

    await expect(
      service.releaseFunds(dealId(), brandId, Role.BRAND),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects release before the deal is delivered', async () => {
    prisma.deal.findUnique.mockResolvedValue({
      ...escrowDeal,
      status: DealStatus.ACCEPTED,
    });

    await expect(
      service.releaseFunds(dealId(), brandId, Role.BRAND),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws NotFound for a missing deal', async () => {
    prisma.deal.findUnique.mockResolvedValue(null);
    await expect(
      service.releaseFunds(dealId(), brandId, Role.BRAND),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  function dealId() {
    return 'deal_1';
  }
});
