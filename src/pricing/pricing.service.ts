import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Structured pricing: rate cards & packages per creator. Complements the
 * free-text `User.rate` field and lets brands filter by price.
 */
@Injectable()
export class PricingService {
  constructor(private prisma: PrismaService) {}

  async listForUser(userId: string, activeOnly = false) {
    return this.prisma.rateCard.findMany({
      where: activeOnly ? { userId, active: true } : { userId },
      orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }],
    });
  }

  async create(userId: string, dto: { title: string; price: number; unit?: string; includes?: string }) {
    return this.prisma.rateCard.create({
      data: {
        userId,
        title: dto.title,
        price: dto.price,
        unit: dto.unit || 'per_booking',
        includes: dto.includes || null,
      },
    });
  }

  async update(userId: string, id: string, data: Partial<{ title: string; price: number; unit: string; includes: string; active: boolean; sortOrder: number }>) {
    await this.owner(userId, id);
    return this.prisma.rateCard.update({ where: { id }, data });
  }

  async remove(userId: string, id: string) {
    await this.owner(userId, id);
    await this.prisma.rateCard.delete({ where: { id } });
    return { success: true };
  }

  private async owner(userId: string, id: string) {
    const rc = await this.prisma.rateCard.findUnique({ where: { id } });
    if (!rc) throw new NotFoundException('Rate card not found');
    if (rc.userId !== userId) throw new ForbiddenException('Not your rate card');
    return rc;
  }
}
