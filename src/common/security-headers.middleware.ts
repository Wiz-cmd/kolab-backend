import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';

/**
 * Lightweight security headers (a minimal helmet stand-in tuned for an API).
 * Locked-origin CORS is enforced separately in main.ts / through the
 * `CorsMiddleware`-style configuration; here we set the response headers that
 * prevent common web attacks against browser clients that call this API.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  constructor(private config: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Download-Options', 'noopen');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    // HSTS only makes sense over a TLS-terminating proxy; enable explicitly so
    // plain-HTTP local/dev setups don't log a bogus header.
    if (this.config.get('ENABLE_HSTS') === 'true') {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }
    // Default: no caching of API responses (they may be personalized or carry
    // account data). Static assets (/uploads/*) override this with max-age.
    res.setHeader('Cache-Control', 'no-store');
    next();
  }
}
