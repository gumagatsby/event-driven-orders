import { ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { PG_POOL, tx } from './db.js';
import { InventoryEvent, Line, ORDERS_TOPIC, orderEvent } from './events.js';
import { InventoryClient } from './inventory.client.js';
import { inventoryChecks, ordersPlaced, statusChanges } from './metrics.js';
import { addToOutbox } from './outbox.js';

export const PlaceOrder = z.object({
  customerId: z.string().min(1).max(100),
  lines: z
    .array(z.object({ sku: z.string().min(1).max(50), quantity: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(100),
});
export type PlaceOrder = z.infer<typeof PlaceOrder>;

export type Status = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED';
export interface Order {
  id: string;
  customerId: string;
  status: Status;
  reason: string | null;
  lines: Line[];
  createdAt: string;
  updatedAt: string;
}

/** Repeated SKUs become one line, sorted, so equal orders hash and store identically. */
export const mergeLines = (lines: Line[]): Line[] => {
  const merged = new Map<string, number>();
  for (const l of lines) merged.set(l.sku, (merged.get(l.sku) ?? 0) + l.quantity);
  return [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([sku, quantity]) => ({ sku, quantity }));
};

export const requestHash = (o: PlaceOrder) =>
  createHash('sha256').update(JSON.stringify({ customerId: o.customerId, lines: mergeLines(o.lines) })).digest('hex');

@Injectable()
export class OrdersService {
  private readonly log = new Logger(OrdersService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(InventoryClient) private readonly inventory: InventoryClient,
  ) {}

  /**
   * Accepts an order. The reply is 202: stock is reserved asynchronously by
   * the inventory service, and the order moves to CONFIRMED or REJECTED.
   */
  async place(idempotencyKey: string, input: PlaceOrder): Promise<{ order: Order; replayed: boolean }> {
    const hash = requestHash(input);
    const existing = await this.findByKey(idempotencyKey, hash);
    if (existing) return { order: existing, replayed: true };

    const lines = mergeLines(input.lines);
    await this.precheck(lines);

    const id = randomUUID();
    const created = await tx(this.pool, async (c) => {
      const inserted = await c.query(
        `INSERT INTO orders (id, customer_id, status, idempotency_key, request_hash)
         VALUES ($1, $2, 'PENDING', $3, $4) ON CONFLICT (idempotency_key) DO NOTHING`,
        [id, input.customerId, idempotencyKey, hash],
      );
      if (inserted.rowCount === 0) return false; // a concurrent request with this key won
      for (const l of lines) {
        await c.query('INSERT INTO order_lines (order_id, sku, quantity) VALUES ($1, $2, $3)', [id, l.sku, l.quantity]);
      }
      await addToOutbox(c, ORDERS_TOPIC, id, orderEvent('OrderPlaced', id, lines));
      return true;
    });
    if (!created) {
      const winner = await this.findByKey(idempotencyKey, hash);
      return { order: winner!, replayed: true };
    }
    ordersPlaced.inc({ result: 'accepted' });
    return { order: (await this.get(id))!, replayed: false };
  }

  /**
   * Asks inventory whether the order could be met, so an impossible order is
   * refused immediately. If inventory is unreachable the order is still
   * accepted: the reservation over Kafka is the decision that counts.
   */
  private async precheck(lines: Line[]) {
    let result;
    try {
      result = await this.inventory.checkAvailability(lines);
    } catch (err) {
      inventoryChecks.inc({ result: 'unavailable' });
      this.log.warn(`Availability check skipped: ${(err as Error).message}`);
      return;
    }
    if (!result.allAvailable) {
      inventoryChecks.inc({ result: 'short' });
      ordersPlaced.inc({ result: 'refused' });
      throw new UnprocessableEntityException({
        message: 'Not enough stock',
        lines: result.lines.filter((l) => !l.sufficient),
      });
    }
    inventoryChecks.inc({ result: 'ok' });
  }

  private async findByKey(key: string, hash: string): Promise<Order | null> {
    const { rows } = await this.pool.query<{ id: string; request_hash: string }>(
      'SELECT id, request_hash FROM orders WHERE idempotency_key = $1',
      [key],
    );
    if (rows.length === 0) return null;
    if (rows[0].request_hash !== hash) {
      throw new ConflictException('This Idempotency-Key was already used for a different order');
    }
    return this.get(rows[0].id);
  }

  async get(id: string, client: pg.Pool | pg.PoolClient = this.pool): Promise<Order | null> {
    const { rows } = await client.query(
      `SELECT o.id, o.customer_id, o.status, o.reason, o.created_at, o.updated_at,
              COALESCE(json_agg(json_build_object('sku', l.sku, 'quantity', l.quantity) ORDER BY l.sku)
                       FILTER (WHERE l.sku IS NOT NULL), '[]') AS lines
         FROM orders o LEFT JOIN order_lines l ON l.order_id = o.id
        WHERE o.id = $1 GROUP BY o.id`,
      [id],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      customerId: r.customer_id,
      status: r.status,
      reason: r.reason,
      lines: r.lines,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  /** Cancels a pending or confirmed order. Inventory releases any stock it reserved. */
  async cancel(id: string): Promise<Order> {
    return tx(this.pool, async (c) => {
      const { rows } = await c.query<{ status: Status }>('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (rows.length === 0) throw new NotFoundException('Order not found');
      const status = rows[0].status;
      if (status === 'REJECTED') throw new ConflictException('A rejected order cannot be cancelled');
      if (status !== 'CANCELLED') {
        await c.query("UPDATE orders SET status = 'CANCELLED', updated_at = now() WHERE id = $1", [id]);
        await addToOutbox(c, ORDERS_TOPIC, id, orderEvent('OrderCancelled', id));
        statusChanges.inc({ to: 'CANCELLED' });
      }
      return (await this.get(id, c))!;
    });
  }

  /**
   * Applies an inventory result once. A PENDING order moves on; any other
   * status (for example cancelled while inventory was deciding) is kept.
   */
  async applyInventoryEvent(event: InventoryEvent): Promise<'applied' | 'duplicate' | 'ignored'> {
    return tx(this.pool, async (c) => {
      const fresh = await c.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [event.eventId]);
      if (fresh.rowCount === 0) return 'duplicate';
      if (event.type === 'StockReleased') return 'ignored';
      const to: Status = event.type === 'StockReserved' ? 'CONFIRMED' : 'REJECTED';
      const updated = await c.query(
        "UPDATE orders SET status = $2, reason = $3, updated_at = now() WHERE id = $1 AND status = 'PENDING'",
        [event.orderId, to, event.reason ?? null],
      );
      if (updated.rowCount === 0) return 'ignored';
      statusChanges.inc({ to });
      return 'applied';
    });
  }
}
