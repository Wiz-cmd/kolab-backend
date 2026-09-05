import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DealStatus, PaymentStatus, ReportStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async banUser(adminId: string, userId: string, reason: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === 'ADMIN' && user.id !== adminId) {
      throw new BadRequestException('Admins cannot ban other admins');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { isBanned: true, bannedAt: new Date(), banReason: reason || null },
    });
    // Revoke all sessions.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async unbanUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.user.update({
      where: { id: userId },
      data: { isBanned: false, bannedAt: null, banReason: null },
    });
    return { success: true };
  }

  async deletePost(postId: string, moderationNote?: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    await this.prisma.post.delete({ where: { id: postId } });
    await this.notifications.create({
      userId: post.authorId,
      type: 'system',
      title: 'Post removed',
      body: moderationNote || 'Your post was removed for a policy violation.',
      entityType: 'post',
      entityId: postId,
    });
    return { success: true };
  }

  async adjustBalance(userId: string, amount: number, reason?: string) {
    if (!amount || isNaN(amount)) throw new BadRequestException('Amount required');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.user.update({
      where: { id: userId },
      data: { balance: { increment: amount } },
    });
    await this.notifications.create({
      userId,
      type: 'system',
      title: amount >= 0 ? 'Balance adjusted' : 'Balance correction',
      body: reason || `Your balance was adjusted by R${amount.toFixed(2)}.`,
      entityType: 'balance',
    });
    return { success: true };
  }

  async resolveReport(reportId: string, resolution: string, action?: 'dismiss' | 'warn' | 'ban') {
    const report = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    const status = action === 'dismiss' ? ReportStatus.DISMISSED : ReportStatus.RESOLVED;

    if (action === 'ban' && report.reportedUserId) {
      const target = await this.prisma.user.findUnique({ where: { id: report.reportedUserId } });
      if (target && target.role !== 'ADMIN') {
        await this.prisma.user.update({
          where: { id: target.id },
          data: { isBanned: true, bannedAt: new Date(), banReason: resolution },
        });
        await this.prisma.refreshToken.updateMany({
          where: { userId: target.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }

    await this.prisma.report.update({
      where: { id: reportId },
      data: { status, resolution, resolvedAt: new Date() },
    });

    return { success: true };
  }

  async listDisputes(opts: { take?: number; skip?: number } = {}) {
    return this.prisma.deal.findMany({
      where: {
        OR: [
          { status: DealStatus.DISPUTED },
          { paymentStatus: PaymentStatus.HELD_IN_ESCROW },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      skip: opts.skip || 0,
      take: opts.take || 50,
      include: {
        brand: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });
  }
}
