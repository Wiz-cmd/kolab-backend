import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

/**
 * Minimal Prometheus-style metrics endpoint. Exposes process/heartbeat metrics
 * without a heavy dependency so ops can scrape this in a pinch. Extend with real
 * counters per-route once a metrics library is adopted.
 */
@ApiTags('ops')
@Controller('metrics')
export class MetricsController {
  private readonly startedAt = Date.now();

  constructor(private config: ConfigService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics() {
    const upSeconds = Math.round((Date.now() - this.startedAt) / 1000);
    const mem = process.memoryUsage();
    const lines = [
      '# HELP kolab_up Whether the process is running.',
      '# TYPE kolab_up gauge',
      `kolab_up 1`,
      '',
      '# HELP kolab_uptime_seconds Process uptime in seconds.',
      '# TYPE kolab_uptime_seconds gauge',
      `kolab_uptime_seconds ${upSeconds}`,
      '',
      '# HELP kolab_nodejs_heap_bytes Active heap usage.',
      '# TYPE kolab_nodejs_heap_bytes gauge',
      `kolab_nodejs_heap_bytes ${Math.round(mem.heapUsed)}`,
      '',
      '# HELP kolab_nodejs_rss_bytes Resident set size.',
      '# TYPE kolab_nodejs_rss_bytes gauge',
      `kolab_nodejs_rss_bytes ${Math.round(mem.rss)}`,
      `kolab_environment "${this.config.get('NODE_ENV') || 'development'}"`,
      '',
      '# HELP kolab_total_memory_ratio Rough fraction of heap used.',
      '# TYPE kolab_total_memory_ratio gauge',
      `kolab_total_memory_ratio ${mem.heapUsed && mem.heapTotal ? (mem.heapUsed / mem.heapTotal).toFixed(3) : 0}`,
    ];
    return lines.join('\n') + '\n';
  }
}
