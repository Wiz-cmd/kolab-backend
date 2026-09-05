import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { WithdrawalStatus } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PayoutService } from '../payouts/payouts.service';

const configMock = { get: jest.fn((k: string) => (k === 'WITHDRAWAL_FEE' ? '10' : undefined)) };

describe('WithdrawalsService', () => {
  let service: WithdrawalsService;
  let prisma: any;
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  const payouts = { dispatch: jest.fn() };

  beforeEach(async () => {
    payouts.dispatch.mockResolvedValue({ success: true, reference: 'PY-TEST' });
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      withdrawal: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((input: any) =>
        typeof input === 'function'
          ? input(prisma) // tx callback
          : (async () => {
              for (const op of input) await op;
              return input;
            })(),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        WithdrawalsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: configMock },
        { provide: NotificationsService, useValue: notifications },
        { provide: PayoutService, useValue: payouts },
      ],
    }).compile();

    service = module.get(WithdrawalsService);
  });

  it('rejects a non-positive or unsupported-method request', async () => {
    await expect(
      service.request('u1', 0, 'bank', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.request('u1', 100, 'crypto', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a withdrawal when balance is insufficient', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', balance: 50 });
    await expect(service.request('u1', 100, 'bank', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('reserves funds and creates a withdrawal on success', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', balance: 1000 });
    prisma.user.update.mockResolvedValue({ id: 'u1', balance: 890 });
    prisma.withdrawal.create.mockResolvedValue({
      id: 'w1',
      userId: 'u1',
      amount: 100,
      fee: 10,
      netAmount: 90,
    });

    const result = await service.request('u1', 100, 'bank', { account: 'x' });

    expect(result.id).toBe('w1');
    // Atomic reservation transaction invoked (tx callback form)
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(notifications.create).toHaveBeenCalled();
  });

  it('approves only a PENDING withdrawal and dispatches the payout', async () => {
    prisma.withdrawal.findUnique.mockResolvedValue({
      id: 'w1',
      userId: 'u1',
      amount: 100,
      netAmount: 90,
      details: {},
      status: WithdrawalStatus.PENDING,
    });
    prisma.withdrawal.update.mockResolvedValue({});

    const result = await service.approve('w1', 'admin1');
    expect(result.success).toBe(true);
    expect(payouts.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ withdrawalId: 'w1', netAmount: 90 }),
    );
    expect(result.payoutRef).toContain('PY-');
  });

  it('fails the withdrawal when the provider rejects the payout', async () => {
    payouts.dispatch.mockResolvedValue({ success: false, raw: { error: 'bank rejected' } });
    prisma.withdrawal.findUnique.mockResolvedValue({
      id: 'w1',
      userId: 'u1',
      amount: 100,
      netAmount: 90,
      details: {},
      status: WithdrawalStatus.PENDING,
    });
    // fail() re-reads then updates + refunds
    prisma.withdrawal.update.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});

    await expect(service.approve('w1', 'admin1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Approval calls fail(), which increments the balance back.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ balance: { increment: 100 } }) }),
    );
  });

  it('refuses to approve a non-pending withdrawal', async () => {
    prisma.withdrawal.findUnique.mockResolvedValue({
      id: 'w1',
      status: WithdrawalStatus.PAID,
    });
    await expect(service.approve('w1', 'admin1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('marks a PROCESSING withdrawal as paid', async () => {
    prisma.withdrawal.findUnique.mockResolvedValue({
      id: 'w1',
      status: WithdrawalStatus.PROCESSING,
    });
    prisma.withdrawal.update.mockResolvedValue({ id: 'w1', status: WithdrawalStatus.PAID });

    const result = await service.markPaid('w1');
    expect(result.status).toBe(WithdrawalStatus.PAID);
  });

  it('refunds reserved funds when a payout fails', async () => {
    prisma.withdrawal.findUnique.mockResolvedValue({
      id: 'w1',
      userId: 'u1',
      amount: 100,
      status: WithdrawalStatus.PROCESSING,
    });
    prisma.withdrawal.update.mockResolvedValue({});

    const result = await service.fail('w1', 'provider rejected');
    expect(result.success).toBe(true);
    // Refund increments the balance back
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ balance: { increment: 100 } }) }),
    );
  });
});
