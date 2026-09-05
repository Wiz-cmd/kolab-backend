import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Optional Sentry error reporting. When `SENTRY_DSN` is set (and @sentry/node is
 * installed) it initialises the SDK and exposes `captureException`. Otherwise it
 * is a safe no-op so the app runs without Sentry credentials.
 */
@Injectable()
export class SentryService {
  private readonly logger = new Logger(SentryService.name);
  private sentry: any = null;
  private enabled = false;

  constructor(private config: ConfigService) {
    const dsn = this.config.get('SENTRY_DSN');
    if (dsn) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Sentry = require('@sentry/node');
        Sentry.init({
          dsn,
          environment: this.config.get('NODE_ENV') || 'development',
          release: this.config.get('SENTRY_RELEASE') || undefined,
          tracesSampleRate: Number(this.config.get('SENTRY_TRACES_SAMPLE_RATE') || 0.1),
        });
        this.sentry = Sentry;
        this.enabled = true;
        this.logger.log('Sentry initialised.');
      } catch (e: any) {
        this.logger.warn('Sentry disabled (not installed / bad DSN): ' + e.message);
      }
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  captureException(error: unknown, context?: Record<string, unknown>) {
    if (!this.enabled || !this.sentry) return;
    try {
      this.sentry.captureException(error, {
        extra: context || {},
      });
    } catch (_) {
      /* swallow */
    }
  }
}
