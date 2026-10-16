import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import pg from 'pg';
import { config } from './config.js';
import { PG_POOL, tx } from './db.js';
import { KafkaService } from './kafka.service.js';
import { outboxPublished } from './metrics.js';

/** Record an event in the caller's transaction. It is published only if that transaction commits. */
export async function addToOutbox(c: pg.PoolClient, topic: string, key: string, payload: object) {
  // Carry the trace context so the event continues this request's trace.
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  await c.query('INSERT INTO outbox (topic, message_key, payload, headers) VALUES ($1, $2, $3, $4)', [
    topic,
    key,
    JSON.stringify(payload),
    JSON.stringify(headers),
  ]);
}

interface Row {
  id: string;
  topic: string;
  message_key: string;
  payload: object;
  headers: Record<string, string>;
}

const RELAY_LOCK = 0x1a7e0002;

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(OutboxRelay.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(KafkaService) private readonly kafka: KafkaService,
  ) {}

  onApplicationBootstrap() {
    this.schedule();
  }

  onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private schedule() {
    this.timer = setTimeout(async () => {
      try {
        // Idle polls are not traced: five empty traces a second would bury the
        // real ones. Each published event still continues its request's trace.
        await context.with(suppressTracing(ROOT_CONTEXT), async () => {
          while ((await this.publishOnce()) > 0 && !this.stopped);
        });
      } catch (err) {
        this.log.warn(`Outbox publish failed, will retry: ${(err as Error).message}`);
      }
      if (!this.stopped) this.schedule();
    }, config.outboxPollMs);
  }

  /** Publishes up to 100 events and returns how many. Rows are marked published only after Kafka acknowledges them. */
  async publishOnce(): Promise<number> {
    await this.kafka.ready();
    return tx(this.pool, async (c) => {
      // One replica publishes at a time, which keeps each order's events in order.
      const { rows: lock } = await c.query<{ leader: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS leader', [RELAY_LOCK]);
      if (!lock[0].leader) return 0;
      const { rows } = await c.query<Row>(
        'SELECT id, topic, message_key, payload, headers FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100',
      );
      if (rows.length === 0) return 0;

      // Events for different orders go out in parallel; events for the same
      // order go out one after another, in the order they were written.
      const byKey = new Map<string, Row[]>();
      for (const row of rows) byKey.set(row.message_key, [...(byKey.get(row.message_key) ?? []), row]);
      await Promise.all(
        [...byKey.values()].map(async (chain) => {
          for (const row of chain) {
            await context.with(propagation.extract(ROOT_CONTEXT, row.headers), () =>
              this.kafka.producer.send({
                topic: row.topic,
                acks: -1,
                messages: [{ key: row.message_key, value: JSON.stringify(row.payload), headers: { ...row.headers } }],
              }),
            );
          }
        }),
      );
      await c.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      outboxPublished.inc(rows.length);
      return rows.length;
    });
  }
}
