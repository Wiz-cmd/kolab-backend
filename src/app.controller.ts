import { Controller, Get, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {}

  @Get()
  root() {
    return {
      name: 'Kolab API',
      version: '1.2.0',
      status: 'ok',
      prefix: '/api',
    };
  }

  /**
   * Liveness probe: the process is up. Deliberately does NOT touch the DB so
   * an orchestrator can distinguish "app crashed" from "database unavailable".
   */
  @Get('health/live')
  live() {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  /**
   * Readiness probe used by Render. Returns 503 when the database is
   * unreachable so the platform does not mark a broken instance as healthy.
   */
  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    let db = 'down';
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }

    const healthy = db === 'up';
    res.status(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      db,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
