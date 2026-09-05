import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory sliding-window rate limiter. Good enough for a single-node
 * rollout; swap for @nestjs/throttler + Redis when you scale horizontally.
 *
 * Keys off the request IP. Applied to sensitive routes (auth, uploads) where
 * brute-force and abuse are a real risk.
 */
@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private buckets = new Map<string, Bucket>();

  constructor(private config: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const path = req.originalUrl || req.url;
    // Stricter per-IP limits on credential endpoints to blunt brute force
    // and lockout-abuse (account DoS).
    const isAuth = path.startsWith('/api/auth/');
    const windowMs = Number(
      this.config.get(isAuth ? 'AUTH_RATE_LIMIT_WINDOW_MS' : 'RATE_LIMIT_WINDOW_MS') ||
        (isAuth ? 60_000 : 60_000),
    );
    const max = Number(
      this.config.get(isAuth ? 'AUTH_RATE_LIMIT_MAX' : 'RATE_LIMIT_MAX') ||
        (isAuth ? 20 : 100),
    );

    // Limit based on IP. `req.ip` resolves the real client address once
    // `app.set('trust proxy', ...)` is configured in main.ts.
    const key =
      req.ip || (req.connection && (req.connection as any).remoteAddress) ||
      'unknown';

    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({
        statusCode: 429,
        message: 'Too many requests, please try again later.',
        error: 'TooManyRequests',
        requestId: (req as any).requestId,
        path: req.originalUrl || req.url,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Cheap bounded cleanup so the map doesn't grow forever.
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (now >= b.resetAt) this.buckets.delete(k);
      }
    }

    next();
  }
}
