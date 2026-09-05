import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  async create(input: CreateNotificationInput) {
    try {
      const notification = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          entityType: input.entityType,
          entityId: input.entityId,
          data: (input.data as any) ?? undefined,
        },
      });

      // Fire-and-forget mobile push (never blocks or fails the in-app record).
      await this.pushToUser(input.userId, {
        title: input.title,
        body: input.body,
        data: input.data ? (input.data as Record<string, string>) : undefined,
      }).catch((e) => this.logger.warn(`Push skipped: ${e.message}`));

      return notification;
    } catch {
      // Notifications are best-effort; never fail the primary operation.
      return null;
    }
  }

  private async pushToUser(
    userId: string,
    payload: { title: string; body?: string; data?: Record<string, string> },
  ) {
    if (!this.push.enabled) return;
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    await this.push.sendToUser(
      userId,
      tokens.map((t) => t.token),
      payload,
    );
  }

  async listForUser(userId: string, opts: { skip?: number; take?: number } = {}) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: opts.skip || 0,
      take: opts.take || 30,
    });
  }

  async countUnread(userId: string) {
    return this.prisma.notification.count({
      where: { userId, readAt: null },
    });
  }

  async markRead(userId: string, notificationId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
  }
}
