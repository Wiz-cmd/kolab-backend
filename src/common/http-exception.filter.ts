import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SentryService } from './sentry.service';

/**
 * Normalizes every error into a consistent shape so the Android client and
 * monitoring can rely on a single contract:
 *
 * {
 *   statusCode: number,
 *   message: string | string[],
 *   error: string,   // machine-readable label
 *   requestId: string,
 *   path: string,
 *   timestamp: string
 * }
 *
 * Unknown errors are logged with full detail and masked to a generic 500 so we
 * never leak internals to clients, while keeping the real cause in the logs.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly sentry: SentryService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId =
      (request as any).requestId ||
      (request.headers['x-request-id'] as string) ||
      'unknown';

    const body = this.buildBody(exception, request, requestId);

    // Report real server errors to Sentry (if configured).
    if (body.statusCode >= 500) {
      this.sentry.captureException(exception, {
        method: request.method,
        path: request.path,
        requestId,
      });
    }

    response.status(body.statusCode).json(body);
  }

  private buildBody(
    exception: unknown,
    request: Request,
    requestId: string,
  ) {
    const path = request.path;
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      let message: string | string[];
      let error = HttpStatus[status] || 'Error';

      if (typeof res === 'string') {
        message = res;
      } else {
        const obj = res as Record<string, any>;
        message = obj.message ?? exception.message;
        error = obj.error ?? error;
      }

      return {
        statusCode: status,
        message,
        error,
        requestId,
        path,
        timestamp,
      };
    }

    // Body-parser / raw-body errors carry a 4xx status (413 too large,
    // 415 unsupported type) on the raw error object rather than an
    // HttpException — pass them through instead of collapsing to a 500.
    const parserStatus = this.parserErrorStatus(exception);
    if (parserStatus !== null) {
      const err = exception as any;
      return {
        statusCode: parserStatus,
        message: err.message || 'Request body could not be read',
        error: HttpStatus[parserStatus] || 'BadRequest',
        requestId,
        path,
        timestamp,
      };
    }

    // Prisma known error codes -> friendlier messages (still 500, client-safe)
    if (this.isPrismaError(exception)) {
      const p = exception as any;
      if (p.code === 'P2002') {
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'A record with the same unique value already exists.',
          error: 'UniqueConstraint',
          requestId,
          path,
          timestamp,
        };
      }
      if (p.code === 'P2025') {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'The requested record does not exist.',
          error: 'NotFound',
          requestId,
          path,
          timestamp,
        };
      }
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'InternalServerError',
      requestId,
      path,
      timestamp,
    };
  }

  private isPrismaError(exception: unknown): boolean {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      typeof (exception as any).code === 'string' &&
      (exception as any).code.startsWith('P')
    );
  }

  /** Map a raw (non-HttpException) client error to a 4xx status, else null. */
  private parserErrorStatus(exception: unknown): number | null {
    if (typeof exception !== 'object' || exception === null) {
      return null;
    }
    const status = Number((exception as any).status ?? (exception as any).statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return status;
    }
    return null;
  }
}
