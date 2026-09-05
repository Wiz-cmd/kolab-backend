import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';

/**
 * In-process background jobs. Uses @nestjs/schedule cron for recurring tasks and
 * a tiny in-memory queue for fire-and-forget side effects (email retries, etc.).
 *
 * In this build the queue is intentionally lightweight and for demonstration; a
 * production deploy should move to a durable queue (BullMQ/Redis). Everything is
 * guarded so an un-provisioned feature degrades instead of crashing.
 */
@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly queue: Array<() => Promise<void>> = [];
  private running = false;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private notifications: NotificationsService,
    private mail: MailService,
  ) {}

  /** Enqueue a fire-and-forget async task. */
  enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    this.drain().catch((e) => this.logger.warn(`Job queue error: ${e.message}`));
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const task = this.queue.shift()!;
        try {
          await task();
        } catch (e: any) {
          this.logger.warn(`Queued task failed: ${e.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy() {
    this.queue.length = 0;
  }

  /**
   * Hourly: recompute creator rankings and province leaderboard so the leaderboard
   * reflects recent engagement without hammering the DB on every view.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async recomputeLeaderboard() {
    if (this.config.get('JOBS_LIVE') !== 'true') return; // opt-in
    this.logger.log('Recomputing leaderboard…');

    const targetMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const provinces = await this.prisma.hotspot.groupBy({
      by: ['province'],
      _count: { _all: true },
      _sum: {},
    });

    // Leaderboard is best-effort; failures are logged, never thrown.
    for (const p of provinces) {
      const score = p._count?._all ?? 0;
      try {
        await this.prisma.provinceStats.upsert({
          where: { province_month: { province: p.province, month: targetMonth } },
          create: { province: p.province, month: targetMonth, checkIns: score, score },
          update: { checkIns: score, score },
        });
      } catch (e: any) {
        this.logger.warn(`leaderboard update failed for ${p.province}: ${e.message}`);
      }
    }
  }

  /**
   * FIFO simulations for widgets/in-app mail when a real SMTP driver is not set.
   * In production this is where failed emails would be retried with backoff.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async retryPendingOutbox() {
    // Placeholder: real implementation reads a durable outbox and retries with
    // exponential backoff. No-op here to keep the deploy safe.
  }
}
