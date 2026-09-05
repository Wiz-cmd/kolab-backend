import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface SearchAlert {
  userId: string;
  filters: {
    location?: string;
    province?: string;
    city?: string;
    category?: string;
    tags?: string[];
  };
}

/**
 * Saved searches / alerts ("notify me when a model in CPT posts"). Users save a
 * set of filters; whenever a matching profile posts, the interested users get a
 * push/in-app notification.
 */
@Injectable()
export class AlertsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async create(userId: string, dto: { label?: string; filters: Record<string, any> }) {
    const search = await this.prisma.savedSearch.create({
      data: { userId, label: dto.label || null, filters: dto.filters as any },
    });
    return search;
  }

  async listForUser(userId: string) {
    return this.prisma.savedSearch.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  async setActive(userId: string, id: string, active: boolean) {
    const s = await this.owner(userId, id);
    return this.prisma.savedSearch.update({ where: { id: s.id }, data: { active } });
  }

  async remove(userId: string, id: string) {
    await this.owner(userId, id);
    await this.prisma.savedSearch.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Run on new post: find active saved searches that match the poster + post,
   * and notify each interested user (excluding the author).
   */
  async matchAndNotify(author: { id: string; location?: string | null; bio?: string | null }, post: { id: string; category?: string; tags?: string[] }) {
    const searches = await this.prisma.savedSearch.findMany({
      where: { active: true, userId: { not: author.id } },
    });

    for (const s of searches) {
      const f = (s.filters as any) || {};
      const locationMatch =
        !f.location || !author.location || author.location.toLowerCase().includes(String(f.location).toLowerCase());
      const categoryMatch =
        !f.category || post.category === f.category;
      const provinceMatch = !f.province; // province is derived from author location in practice
      const tagMatch = !f.tags?.length || (f.tags as string[]).some((t: string) => (post.tags || []).includes(t));

      if (locationMatch && categoryMatch && provinceMatch && tagMatch) {
        await this.prisma.savedSearch.update({
          where: { id: s.id },
          data: { lastRunAt: new Date() },
        });
        await this.notifications.create({
          userId: s.userId,
          type: 'system',
          title: 'New post matches your search',
          body: `${author.location ? author.location + ' · ' : ''}${post.category || 'New'} content just dropped.`,
          entityType: 'post',
          entityId: post.id,
          data: { savedSearchId: s.id, filters: f },
        });
      }
    }
  }

  private async owner(userId: string, id: string) {
    const s = await this.prisma.savedSearch.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Saved search not found');
    if (s.userId !== userId) throw new ForbiddenException('Not your saved search');
    return s;
  }
}
