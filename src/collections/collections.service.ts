import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Portfolio collections: group portfolio items by campaign/project.
 */
@Injectable()
export class CollectionsService {
  constructor(private prisma: PrismaService) {}

  async listForUser(userId: string) {
    return this.prisma.portfolioCollection.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { items: { orderBy: { createdAt: 'asc' }, select: { id: true, imageUrl: true, caption: true } } },
    });
  }

  async create(userId: string, dto: { title: string; description?: string; coverUrl?: string }) {
    return this.prisma.portfolioCollection.create({
      data: { userId, title: dto.title, description: dto.description || null, coverUrl: dto.coverUrl || null },
    });
  }

  /** Move an existing portfolio item into a collection. */
  async addItem(userId: string, collectionId: string, itemId: string) {
    await this.owner(userId, collectionId);
    const item = await this.prisma.portfolioItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Portfolio item not found');
    if (item.userId !== userId) throw new ForbiddenException('Not your portfolio item');

    return this.prisma.portfolioItem.update({
      where: { id: itemId },
      data: { collectionId },
    });
  }

  async remove(userId: string, collectionId: string) {
    await this.owner(userId, collectionId);
    // Detach items first so the collection can be deleted safely.
    await this.prisma.portfolioItem.updateMany({
      where: { collectionId },
      data: { collectionId: null },
    });
    await this.prisma.portfolioCollection.delete({ where: { id: collectionId } });
    return { success: true };
  }

  private async owner(userId: string, id: string) {
    const c = await this.prisma.portfolioCollection.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Collection not found');
    if (c.userId !== userId) throw new ForbiddenException('Not your collection');
    return c;
  }
}
