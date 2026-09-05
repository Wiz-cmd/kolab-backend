import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationStatus } from '@prisma/client';

/**
 * Content moderation queue. New posts are auto-scored against simple heuristics
 * (offensive terms, links, etc.). Flagged/uncertain content is queued for admin
 * review before it appears prominently.
 */
@Injectable()
export class ModerationService {
  constructor(private prisma: PrismaService) {}

  // A minimal keyword list to demonstrate auto-flagging. Expand via config in prod.
  private get blockedTerms(): string[] {
    return ['nude-onlyfans', 'fake-account', 'bots', 'buy-followers'];
  }

  /** Auto-score content 0..1. Higher = riskier. */
  scoreContent(text: string): { score: number; reasons: string[] } {
    const lower = (text || '').toLowerCase();
    const reasons: string[] = [];
    let score = 0;

    const hits = this.blockedTerms.filter((t) => lower.includes(t));
    if (hits.length) {
      score += 0.8 * hits.length;
      reasons.push(`contains blocked terms: ${hits.join(', ')}`);
    }
    if (/(https?:\/\/|www\.)/i.test(text)) {
      score += 0.3;
      reasons.push('contains links');
    }

    return { score: Math.min(1, score), reasons };
  }

  /** Run on post create: score it and enqueue for moderation. */
  async reviewNewPost(postId: string, text: string, category?: string) {
    const { score, reasons } = this.scoreContent(text);
    const status =
      score >= 0.5
        ? ModerationStatus.FLAGGED
        : score >= 0.15
          ? ModerationStatus.IN_REVIEW
          : ModerationStatus.APPROVED;

    await this.prisma.publication.create({
      data: {
        postId,
        status,
        reason: reasons.join('; ') || null,
        autoScore: score,
      },
    });
    return { status, score };
  }

  /** Admin: list the moderation queue. */
  async listQueue(status?: ModerationStatus) {
    return this.prisma.publication.findMany({
      where: status ? { status } : {},
      orderBy: { flaggedAt: 'desc' },
      include: {
        post: {
          include: {
            author: { select: { id: true, name: true } },
          },
        },
      },
      take: 100,
    });
  }

  /** Admin: approve (allow), mark removed (hide). */
  async review(id: string, admnId: string, action: 'approve' | 'remove', note?: string) {
    const p = await this.prisma.publication.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Submission not found');

    const status = action === 'approve' ? ModerationStatus.APPROVED : ModerationStatus.REMOVED;

    await this.prisma.publication.update({
      where: { id },
      data: { status, reviewedBy: admnId, reviewedAt: new Date(), note: note || null },
    });

    // Feed queries filter on post -> publication status to hide REMOVED content.
    return { success: true, status };
  }
}
