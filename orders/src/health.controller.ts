import { Controller, Get, Header, Inject, ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from './db.js';
import { registry } from './metrics.js';

@Controller()
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Liveness: the process is serving requests. */
  @Get('healthz')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the database is reachable. Kafka is not required to accept orders. */
  @Get('readyz')
  async ready() {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }

  @Get('metrics')
  @Header('Content-Type', registry.contentType)
  metrics() {
    return registry.metrics();
  }
}
