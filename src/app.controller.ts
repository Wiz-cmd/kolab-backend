import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
      version: '1.0.0',
      status: 'ok',
      prefix: '/api',
    };
  }

  @Get('health')
  async health() {
    let db = 'down';
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }

    const healthy = db === 'up';
    return {
      status: healthy ? 'ok' : 'degraded',
      db,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
