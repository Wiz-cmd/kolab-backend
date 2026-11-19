import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type Challenge = {
  tag: string;
  title: string;
  city: string;
  brief: string;
};

const THEMES: Challenge[] = [
  { tag: 'golden-hour-joburg', title: 'Golden Hour Joburg', city: 'Johannesburg', brief: 'Catch the city in warm evening light.' },
  { tag: 'street-style-cpt', title: 'Street Style CPT', city: 'Cape Town', brief: 'Real style on the Mother City streets.' },
  { tag: 'natural-light-product', title: 'Product in Natural Light', city: 'Anywhere', brief: 'No studio flash — let the daylight do the work.' },
  { tag: 'creative-workspace', title: 'Behind the Scenes', city: 'Anywhere', brief: 'Show us where the magic happens.' },
];

@Injectable()
export class ChallengesService {
  constructor(private prisma: PrismaService) {}

  /** Deterministic weekly challenge — same for everyone, rotates every ISO week. */
  current() {
    const now = new Date();
    const week = this.isoWeek(now);
    const challenge = THEMES[week % THEMES.length];
    const endsAt = new Date(now);
    endsAt.setUTCDate(endsAt.getUTCDate() + (7 - (now.getUTCDay() || 7)));
    endsAt.setUTCHours(23, 59, 59, 999);
    return {
      ...challenge,
      week,
      endsAt: endsAt.toISOString(),
      year: now.getUTCFullYear(),
    };
  }

  async leaderboard(limit = 20) {
    const { tag } = this.current();
    const posts = await this.prisma.post.findMany({
      where: { tags: { has: tag } },
      take: limit,
      orderBy: [{ likesCount: 'desc' }, { createdAt: 'desc' }],
      include: {
        author: { select: { id: true, name: true, avatarUrl: true, role: true, location: true } },
        _count: { select: { comments: true } },
      },
    });
    return posts.map((post: any) => {
      const { _count, ...rest } = post;
      return { ...rest, commentsCount: _count?.comments || 0 };
    });
  }

  private isoWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }
}
