import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';

@Injectable()
export class HotspotsService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  async findAll(filters: {
    province?: string;
    category?: string;
    city?: string;
    skip?: number;
    take?: number;
  }) {
    const where: any = {};
    if (filters.province) where.province = filters.province;
    if (filters.category) where.category = filters.category;
    if (filters.city) where.city = { contains: filters.city, mode: 'insensitive' };

    const key = [
      'hotspots:list:',
      filters.province || '',
      filters.category || '',
      (filters.city || '').toLowerCase(),
      filters.skip || 0,
      filters.take || 100,
    ].join('|');

    return this.cache.wrap(key, 30_000, () =>
      this.prisma.hotspot.findMany({
        where,
        orderBy: { checkInsCount: 'desc' },
        skip: filters.skip || 0,
        take: filters.take || 100,
      }),
    );
  }

  async create(userId: string, data: any) {
    const created = await this.prisma.hotspot.create({
      data: {
        ...data,
        createdById: userId,
      },
    });
    this.cache.delPrefix('hotspots:list:');
    this.cache.delPrefix('hotspots:lb:');
    return created;
  }

  async checkIn(userId: string, hotspotId: string) {
    const existing = await this.prisma.hotspotCheckIn.findUnique({
      where: { userId_hotspotId: { userId, hotspotId } },
    });

    if (existing) {
      await this.prisma.hotspotCheckIn.delete({ where: { id: existing.id } });
      await this.prisma.hotspot.update({
        where: { id: hotspotId },
        data: { checkInsCount: { decrement: 1 } },
      });
      this.cache.delPrefix('hotspots:list:');
      this.cache.delPrefix('hotspots:lb:');
      return { checkedIn: false };
    }

    await this.prisma.hotspotCheckIn.create({ data: { userId, hotspotId } });
    await this.prisma.hotspot.update({
      where: { id: hotspotId },
      data: { checkInsCount: { increment: 1 } },
    });
    this.cache.delPrefix('hotspots:list:');
    this.cache.delPrefix('hotspots:lb:');
    return { checkedIn: true };
  }

  async getLeaderboard(month?: string) {
    const currentMonth = month || new Date().toISOString().slice(0, 7);
    return this.cache.wrap(`hotspots:lb:${currentMonth}`, 300_000, () =>
      this.prisma.provinceStats.findMany({
        where: { month: currentMonth },
        orderBy: { score: 'desc' },
      }),
    );
  }
}
