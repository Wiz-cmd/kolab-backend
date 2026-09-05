import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Assigns a request ID (honouring an inbound one), timestamps the request and
 * logs method/path/status/duration. Every response carries `X-Request-Id`
 * which pairs client-side traces with server logs.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction) {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    // Skip per-file access logs for static uploads (high volume, low value).
    if ((req.originalUrl || req.url || '/').startsWith('/uploads/')) {
      next();
      return;
    }

    const started = Date.now();
    // Use the raw URL with the query string stripped (never `req.path`, which
    // is unreliable under Nest's global prefix). Query strings can carry
    // verification/reset tokens and must never reach application logs.
    const rawUrl = req.originalUrl || req.url || '/';
    const path = rawUrl.split('?')[0];
    const { method } = req;

    res.on('finish', () => {
      const duration = Date.now() - started;
      const statusCode = res.statusCode;
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log';
      this.logger[level](
        `${method} ${path} ${statusCode} ${duration}ms [${requestId}]`,
      );
    });

    next();
  }
}
