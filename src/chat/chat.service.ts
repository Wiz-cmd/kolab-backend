import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  async assertDealParticipant(dealId: string, userId: string) {
    const deal = await this.prisma.deal.findUnique({ where: { id: dealId } });
    if (!deal) throw new NotFoundException('Deal not found');
    if (deal.brandId !== userId && deal.creatorId !== userId) {
      throw new ForbiddenException('Not a participant of this deal');
    }
  }

  async saveMessage(senderId: string, content: string, dealId: string) {
    await this.assertDealParticipant(dealId, senderId);

    const message = await this.prisma.message.create({
      data: { senderId, content, dealId },
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    return message;
  }

  async getMessagesForDeal(dealId: string, requesterId: string, opts: { take?: number; before?: string } = {}) {
    await this.assertDealParticipant(dealId, requesterId);

    const where: any = { dealId };
    if (opts.before) {
      const cursor = await this.prisma.message.findUnique({ where: { id: opts.before } });
      if (cursor) where.createdAt = { lt: cursor.createdAt };
    }

    return this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: opts.take || 50,
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  /** Mark all messages in a deal as read for the given reader. */
  async markDealRead(dealId: string, readerId: string) {
    await this.assertDealParticipant(dealId, readerId);
    const res = await this.prisma.message.updateMany({
      where: { dealId, senderId: { not: readerId }, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: res.count };
  }
}
