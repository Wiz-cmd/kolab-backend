import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PayoutService } from '../payouts/payouts.service';

/**
 * Payout orchestration.
 *
 * Withdrawal lifecycle:
 *   1. Creator requests a withdrawal -> funds are RESERVED (debited from
 *      balance) and the request becomes PENDING.
 *   2. Admin approves -> a real provider payout is dispatched via PayoutService
 *      (Ozow/PayFast/EFT) and status moves to PROCESSING.
 *   3. On success the provider callback marks it PAID; on failure it is
 *      FAILED and the reserved funds are released back to the balance.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private notifications: NotificationsService,
    private payouts: PayoutService,
  ) {}

  async request(userId: string, amount: number, method: string, details: Record<string, any>) {
    if (!amount || amount <= 0) throw new BadRequestException('Amount must be positive');
    if (!['bank', 'payfast', 'paypal', 'eft'].includes(method)) {
      throw new BadRequestException('Unsupported payout method');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const fee = this.withdrawalFee(amount);
    const netAmount = +(amount - fee).toFixed(2);

    if (user.balance < amount) {
      throw new BadRequestException('Insufficient balance');
    }

    // Reserve funds atomically so we never over-draw.
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.user.findUnique({ where: { id: userId } });
      if (!locked || locked.balance < amount) {
        throw new BadRequestException('Insufficient balance');
      }
      await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: amount } },
      });
    });

    const withdrawal = await this.prisma.withdrawal.create({
      data: { userId, amount, fee, netAmount, method, details: details as any },
    });

    await this.notifications.create({
      userId,
      type: 'system',
      title: 'Withdrawal requested',
      body: `R${amount.toFixed(2)} withdrawal is being processed.`,
      entityType: 'withdrawal',
      entityId: withdrawal.id,
    });

    return withdrawal;
  }

  /** Admin approves and dispatches the (provider) payout. */
  async approve(withdrawalId: string, adminId: string, note?: string) {
    const w = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!w) throw new NotFoundException('Withdrawal not found');
    if (w.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException('Withdrawal is not pending');
    }

    // Dispatch the real provider payout (Ozow/PayFast/EFT or mock in sandbox).
    const result = await this.payouts.dispatch({
      withdrawalId,
      userId: w.userId,
      amount: w.amount,
      netAmount: w.netAmount,
      method: w.method,
      bankAccount: (w.details as any)?.bank || undefined,
    });

    if (!result.success) {
      // Provider rejected the payout: fail the request and refund reserved funds.
      await this.fail(withdrawalId, 'Provider rejected the payout');
      throw new BadRequestException('Payout could not be dispatched to the provider');
    }

    const payoutRef = result.reference || this.buildPayoutRef(w.id);

    await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.PROCESSING,
        payoutRef,
        adminNote: note || null,
        processedAt: new Date(),
      },
    });

    await this.notifications.create({
      userId: w.userId,
      type: 'system',
      title: 'Withdrawal approved',
      body: `R${w.netAmount.toFixed(2)} is on its way (ref ${payoutRef}).`,
      entityType: 'withdrawal',
      entityId: withdrawalId,
    });

    return { success: true, payoutRef };
  }

  /** Provider callback / admin confirmation that funds were sent. */
  async markPaid(withdrawalId: string) {
    const w = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!w) throw new NotFoundException('Withdrawal not found');
    if (w.status !== WithdrawalStatus.PROCESSING) {
      throw new BadRequestException('Withdrawal is not processing');
    }
    return this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: WithdrawalStatus.PAID },
    });
  }

  /** Provider failure / admin rejection -> refund reserved funds. */
  async fail(withdrawalId: string, reason: string) {
    const w = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!w) throw new NotFoundException('Withdrawal not found');
    if (
      !(
        [WithdrawalStatus.PENDING, WithdrawalStatus.PROCESSING] as WithdrawalStatus[]
      ).includes(w.status)
    ) {
      throw new BadRequestException('Withdrawal cannot be failed in its current state');
    }

    await this.prisma.$transaction([
      this.prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.FAILED, adminNote: reason },
      }),
      this.prisma.user.update({
        where: { id: w.userId },
        data: { balance: { increment: w.amount } },
      }),
    ]);

    await this.notifications.create({
      userId: w.userId,
      type: 'system',
      title: 'Withdrawal failed',
      body: `R${w.amount.toFixed(2)} has been returned to your balance: ${reason}`,
      entityType: 'withdrawal',
      entityId: withdrawalId,
    });

    return { success: true };
  }

  async listForUser(userId: string) {
    return this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAll(status?: WithdrawalStatus) {
    return this.prisma.withdrawal.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  }

  /** Withdrawal fee (e.g. flat R10). */
  private withdrawalFee(amount: number): number {
    const fee = Number(this.config.get('WITHDRAWAL_FEE') || 10);
    return Math.min(fee, amount);
  }

  private buildPayoutRef(id: string): string {
    // Sandbox note: replace with the actual provider's batch/payout reference.
    return `PF-${Date.now().toString(36).toUpperCase()}-${id.slice(-6).toUpperCase()}`;
  }
}
