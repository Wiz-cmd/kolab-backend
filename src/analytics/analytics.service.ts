import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type AnalyticsType = 'profile_visit' | 'post_view' | 'collab_tap' | 'impression';

/**
 * Basic creator analytics. Records raw events and aggregates them into a compact
 * daily summary the creator can read from the dashboard.
 */
@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async record(userId: string, dto: { type: AnalyticsType; postId?: string; viewerId?: string }) {
    await this.prisma.analyticsEvent.create({
      data: {
        userId,
        type: dto.type,
        postId: dto.postId || null,
        viewerId: dto.viewerId || null,
      },
    });

    // For post views, mirror onto Post.viewsCount for cheap list reads.
    if (dto.type === 'post_view' && dto.postId) {
      await this.prisma.post
        .update({ where: { id: dto.postId }, data: { viewsCount: { increment: 1 } } })
        .catch(() => null);
    }
    return { success: true };
  }

  /** Aggregate totals for a creator over a date range. */
  async summary(userId: string, requesterId: string, days = 30) {
    if (requesterId !== userId) throw new ForbiddenException('Not your analytics');
    const since = new Date(Date.now() - days * 86400000);

    const [profileVisits, postViews, collabTaps, impressions, topPost] = await Promise.all([
      this.prisma.analyticsEvent.count({ where: { userId, type: 'profile_visit', createdAt: { gte: since } } }),
      this.prisma.analyticsEvent.count({ where: { userId, type: 'post_view', createdAt: { gte: since } } }),
      this.prisma.analyticsEvent.count({ where: { userId, type: 'collab_tap', createdAt: { gte: since } } }),
      this.prisma.analyticsEvent.count({ where: { userId, type: 'impression', createdAt: { gte: since } } }),
      this.prisma.post.findMany({
        where: { authorId: userId },
        orderBy: { viewsCount: 'desc' },
        take: 1,
        select: { id: true, description: true, viewsCount: true },
      }),
    ]);

    const engagementRate =
      impressions > 0 ? +(postViews / impressions).toFixed(3) : 0;
    const collabConversion =
      postViews > 0 ? +(collabTaps / postViews).toFixed(3) : 0;

    return {
      range: { days, since },
      totals: { profileVisits, postViews, collabTaps, impressions },
      rates: { engagementRate, collabConversion },
      topPost: topPost[0] || null,
    };
  }
}
