import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { HttpExceptionFilter } from './http-exception.filter';
import { RolesGuard } from './roles.guard';
import { AppLogger } from './logger.service';
import { MetricsController } from './metrics.controller';
import { SentryService } from './sentry.service';
import { CacheService } from './cache.service';

/**
 * Global cross-cutting infrastructure:
 * - a single normalized error shape (HttpExceptionFilter)
 * - role-based authorization guard (RolesGuard; no-op when no @Roles set)
 * - structured JSON logging (AppLogger)
 * - optional Sentry error capture (SentryService)
 * - a lightweight /metrics endpoint for ops
 * - a process-local TTL cache for hot read paths (CacheService)
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: RolesGuard },
    AppLogger,
    SentryService,
    CacheService,
  ],
  exports: [AppLogger, SentryService, CacheService],
})
export class CommonModule {}
