import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DealStatus, PaymentStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateDealDto } from './dto/deals.dto';

const PLATFORM_FEE_PERCENT = 20;

// Non-admin state machine: only these forward/backward transitions are allowed.
const ALLOWED_TRANSITIONS: Record<DealStatus, DealStatus[]> = {
  [DealStatus.PENDING]: [DealStatus.ACCEPTED, DealStatus.CANCELLED],
  [DealStatus.ACCEPTED]: [DealStatus.IN_PROGRESS, DealStatus.CANCELLED],
  [DealStatus.IN_PROGRESS]: [DealStatus.DELIVERED, DealStatus.DISPUTED, DealStatus.CANCELLED],
  [DealStatus.DELIVERED]: [DealStatus.DISPUTED],
  [DealStatus.COMPLETED]: [],
  [DealStatus.DISPUTED]: [DealStatus.DELIVERED, DealStatus.CANCELLED],
  [DealStatus.CANCELLED]: [],
};

@Injectable()
export class DealsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async create(userId: string, dto: CreateDealDto) {
    if (dto.creatorId === userId) {
      throw new BadRequestException('Cannot create a deal with yourself');
    }

    const creator = await this.prisma.user.findUnique({
      where: { id: dto.creatorId },
      select: { id: true },
    });
    if (!creator) throw new NotFoundException('Creator not found');

    const platformFee = DealsService.platformFeeFor(dto.amount);
    const creatorAmount = +(dto.amount - platformFee).toFixed(2);

    return this.prisma.deal.create({
      data: {
        brandId: userId,
        creatorId: dto.creatorId,
        title: dto.title,
        description: dto.description,
        deliverables: dto.deliverables,
        deadline: dto.deadline ? new Date(dto.deadline) : null,
        amount: dto.amount,
        platformFee,
        creatorAmount,
        status: DealStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
      },
      include: {
        brand: { select: { id: true, name: true, avatarUrl: true } },
        creator: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async findForUser(userId: string, opts: { take?: number; skip?: number } = {}) {
    return this.prisma.deal.findMany({
      where: {
        OR: [{ brandId: userId }, { creatorId: userId }],
      },
      orderBy: { createdAt: 'desc' },
      skip: opts.skip || 0,
      take: opts.take || 20,
      include: {
        brand: { select: { id: true, name: true, avatarUrl: true } },
        creator: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  async findById(id: string, userId: string) {
    const deal = await this.prisma.deal.findUnique({
      where: { id },
      include: {
        brand: { select: { id: true, name: true, avatarUrl: true } },
        creator: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    if (!deal) throw new NotFoundException('Deal not found');
    if (deal.brandId !== userId && deal.creatorId !== userId) {
      throw new ForbiddenException('Not your deal');
    }
    return deal;
  }

  /** Either party (or admin) advances the deal through its state machine. */
  async updateStatus(
    dealId: string,
    userId: string,
    role: Role,
    status: DealStatus,
    reason?: string,
  ) {
    const deal = await this.ensureParticipant(dealId, userId, role);
    if (deal.status === status) {
      throw new BadRequestException('Deal is already in that state');
    }
    if (status === DealStatus.COMPLETED) {
      throw new BadRequestException('Release via the escrow release endpoint');
    }
    const from = deal.status;
    const allowed = ALLOWED_TRANSITIONS[from] || [];
    if (role !== Role.ADMIN && !allowed.includes(status)) {
      throw new BadRequestException('Invalid status transition');
    }
    if (status === DealStatus.CANCELLED && !reason) {
      throw new BadRequestException('A reason is required to cancel a deal');
    }

    const updated = await this.prisma.deal.update({
      where: { id: dealId },
      data: {
        status,
        ...(status === DealStatus.CANCELLED ? { deniedReason: reason } : {}),
      },
    });

    const otherParty = updated.brandId === userId ? updated.creatorId : updated.brandId;
    await this.notifications.create({
      userId: otherParty,
      type: 'deal',
      title: `Deal ${status.toLowerCase()}`,
      body: reason || `Deal "${updated.title}" moved to ${status.toLowerCase()}`,
      entityType: 'deal',
      entityId: dealId,
    });

    return updated;
  }

  async raiseDispute(dealId: string, userId: string) {
    const deal = await this.ensureParticipant(dealId, userId);
    if (
      !(
        [DealStatus.IN_PROGRESS, DealStatus.DELIVERED] as DealStatus[]
      ).includes(deal.status)
    ) {
      throw new BadRequestException('Deal is not disputeable in its current state');
    }
    const updated = await this.prisma.deal.update({
      where: { id: dealId },
      data: { status: DealStatus.DISPUTED },
    });
    await this.notifications.create({
      userId: updated.brandId === userId ? updated.creatorId : updated.brandId,
      type: 'deal',
      title: 'Deal disputed',
      body: `Deal "${updated.title}" was flagged for dispute`,
      entityType: 'deal',
      entityId: dealId,
    });

    return updated;
  }

  /** Called by the payment webhook once funds are confirmed held in escrow. */
  async markPaidInEscrow(dealId: string, gatewayRef?: string) {
    return this.prisma.deal.update({
      where: { id: dealId },
      data: {
        paymentStatus: PaymentStatus.HELD_IN_ESCROW,
        status: DealStatus.IN_PROGRESS,
        gatewayRef,
      },
    });
  }

  /** Brand (or admin) releases escrowed funds to the creator. */
  async releaseFunds(dealId: string, brandId: string, role: Role) {
    const deal = await this.ensureParticipant(dealId, brandId, role);
    if (deal.brandId !== brandId && role !== Role.ADMIN) {
      throw new ForbiddenException('Only brand can release');
    }
    if (deal.paymentStatus !== PaymentStatus.HELD_IN_ESCROW) {
      throw new BadRequestException('Funds not in escrow');
    }
    if (deal.status !== DealStatus.DELIVERED && deal.status !== DealStatus.IN_PROGRESS) {
      throw new BadRequestException('Deal must be delivered before release');
    }

    await this.prisma.$transaction([
      this.prisma.deal.update({
        where: { id: dealId },
        data: {
          paymentStatus: PaymentStatus.RELEASED,
          status: DealStatus.COMPLETED,
          completedAt: new Date(),
          amountPaid: deal.amount,
        },
      }),
      this.prisma.user.update({
        where: { id: deal.creatorId },
        data: { balance: { increment: deal.creatorAmount } },
      }),
    ]);

    await this.notifications.create({
      userId: deal.creatorId,
      type: 'deal',
      title: 'Payment released',
      body: `R${deal.creatorAmount} was released for "${deal.title}"`,
      entityType: 'deal',
      entityId: dealId,
    });

    return { success: true, released: deal.creatorAmount };
  }

  /** Admin refunds escrowed funds back to the brand. */
  async refundDeal(dealId: string, adminId: string, reason?: string) {
    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) throw new NotFoundException('Deal not found');
    if (deal.paymentStatus !== PaymentStatus.HELD_IN_ESCROW) {
      throw new BadRequestException('Only funds still held in escrow can be refunded');
    }

    await this.prisma.$transaction([
      this.prisma.deal.update({
        where: { id: dealId },
        data: {
          paymentStatus: PaymentStatus.REFUNDED,
          status: DealStatus.CANCELLED,
          deniedReason: reason || 'Refunded by admin',
          completedAt: new Date(),
        },
      }),
      this.prisma.user.update({
        where: { id: deal.brandId },
        data: { balance: { increment: deal.amount } },
      }),
    ]);

    await this.notifications.create({
      userId: deal.brandId,
      type: 'deal',
      title: 'Escrow refunded',
      body: `R${deal.amount} was refunded for "${deal.title}"`,
      entityType: 'deal',
      entityId: dealId,
    });

    return { success: true, refunded: deal.amount };
  }

  private async ensureParticipant(
    dealId: string,
    userId: string,
    role?: Role,
  ) {
    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) throw new NotFoundException('Deal not found');
    if (role !== Role.ADMIN && deal.brandId !== userId && deal.creatorId !== userId) {
      throw new ForbiddenException('Not your deal');
    }
    return deal;
  }

  static platformFeeFor(amount: number) {
    return +((amount * (PLATFORM_FEE_PERCENT / 100)).toFixed(2));
  }
}