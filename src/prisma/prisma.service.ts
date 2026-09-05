import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

function prismaLogOptions(): Prisma.PrismaClientOptions {
  return process.env.PRISMA_LOG_QUERIES === 'true'
    ? { log: [{ emit: 'event', level: 'query' }] }
    : { log: [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }] };
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Optional query logging for ops/performance work: PRISMA_LOG_QUERIES=true.
    // Off by default — paranoia about writing request data to logs in prod.
    super(prismaLogOptions());
    if (process.env.PRISMA_LOG_QUERIES === 'true') {
      (this.$on as any)('query', (e: any) => this.logger.log(`${e.query}  [${e.duration}ms]`));
    }
    (this.$on as any)('warn', (e: any) => this.logger.warn(e.message));
    (this.$on as any)('error', (e: any) => this.logger.error(e.message));
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}