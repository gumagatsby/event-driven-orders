import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { resolve } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createPool, migrate, PG_POOL } from '../src/db.js';
import { InventoryEventsConsumer } from '../src/inventory-events.consumer.js';
import { Availability, InventoryClient } from '../src/inventory.client.js';
import { KafkaService } from '../src/kafka.service.js';
import { OrdersService } from '../src/orders.service.js';
import { OutboxRelay } from '../src/outbox.js';

// Real PostgreSQL; Kafka and the inventory gRPC service are replaced with fakes.
const url = process.env.TEST_DATABASE_URL ?? 'postgres://orders:orders@localhost:5433/orders_test';

const sent: { topic: string; key: string; value: string }[] = [];
const fakeKafka = {
  ready: async () => undefined,
  producer: {
    send: async ({ topic, messages }: { topic: string; messages: { key: string; value: string }[] }) => {
      for (const m of messages) sent.push({ topic, key: String(m.key), value: String(m.value) });
    },
  },
};
let availability: () => Promise<Availability>;
const fakeInventory = {
  checkAvailability: () => availability(),
  listProducts: async () => [],
};

let app: INestApplication;
let pool: pg.Pool;
let orders: OrdersService;
let relay: OutboxRelay;
let consumer: InventoryEventsConsumer;

const order = { customerId: 'cust-1', lines: [{ sku: 'KB-001', quantity: 1 }] };
const place = (key: string, body: object = order) =>
  request(app.getHttpServer()).post('/orders').set('Idempotency-Key', key).send(body);
const outbox = async () =>
  (await pool.query("SELECT payload FROM outbox ORDER BY id")).rows.map((r) => r.payload);

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'orders_test'");
  if (!rowCount) await admin.query('CREATE DATABASE orders_test');
  await admin.end();

  pool = createPool(url);
  await migrate(pool, resolve(import.meta.dirname, '../migrations'));
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(createPool(url))
    .overrideProvider(KafkaService).useValue(fakeKafka)
    .overrideProvider(InventoryClient).useValue(fakeInventory)
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0);
  // The relay runs on a timer in production; the tests drive it directly.
  relay = app.get(OutboxRelay);
  relay.onApplicationShutdown();
  consumer = app.get(InventoryEventsConsumer);
  await consumer.onApplicationShutdown();
  orders = app.get(OrdersService);
});

beforeEach(async () => {
  await pool.query('TRUNCATE order_lines, orders, processed_events, outbox');
  sent.length = 0;
  availability = async () => ({ allAvailable: true, lines: [] });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('placing an order', () => {
  it('accepts it as PENDING and records an OrderPlaced event in the same transaction', async () => {
    const res = await place('k1', { customerId: 'c', lines: [{ sku: 'B', quantity: 1 }, { sku: 'A', quantity: 1 }, { sku: 'B', quantity: 2 }] });
    expect(res.status).toBe(202);
    expect(res.headers.location).toBe(`/orders/${res.body.id}`);
    expect(res.body.status).toBe('PENDING');
    const [event] = await outbox();
    expect(event).toMatchObject({ type: 'OrderPlaced', orderId: res.body.id, lines: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 3 }] });
  });

  it('requires an Idempotency-Key and a valid body', async () => {
    expect((await request(app.getHttpServer()).post('/orders').send(order)).status).toBe(400);
    const bad = await place('k2', { customerId: 'c', lines: [{ sku: 'A', quantity: -1 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0]).toMatch(/^lines\.0\.quantity/);
  });

  it('replays a retry with the same key and refuses the key for a different order', async () => {
    const first = await place('k3');
    const retry = await place('k3');
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect((await place('k3', { ...order, customerId: 'someone-else' })).status).toBe(409);
    expect(await outbox()).toHaveLength(1);
  });

  it('creates one order when 20 identical requests race', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => place('k4')));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(1);
  });

  it('refuses an order inventory says it cannot meet, without creating it', async () => {
    availability = async () => ({ allAvailable: false, lines: [{ sku: 'KB-001', known: true, available: 0, sufficient: false }] });
    const res = await place('k5');
    expect(res.status).toBe(422);
    expect(res.body.lines[0].sku).toBe('KB-001');
    expect(await outbox()).toHaveLength(0);
  });

  it('still accepts the order when inventory is unreachable', async () => {
    availability = async () => {
      throw new Error('14 UNAVAILABLE: connection refused');
    };
    expect((await place('k6')).status).toBe(202);
    expect(await outbox()).toHaveLength(1);
  });
});

describe('inventory results', () => {
  const result = (type: string, orderId: string, eventId = crypto.randomUUID()) => ({
    eventId,
    type: type as 'StockReserved',
    orderId,
    occurredAt: new Date().toISOString(),
  });

  it('confirms a pending order exactly once', async () => {
    const { body } = await place('k7');
    const event = result('StockReserved', body.id);
    expect(await orders.applyInventoryEvent(event)).toBe('applied');
    expect(await orders.applyInventoryEvent(event)).toBe('duplicate');
    expect((await orders.get(body.id))!.status).toBe('CONFIRMED');
  });

  it('records the reason when stock is rejected', async () => {
    const { body } = await place('k8');
    await orders.applyInventoryEvent({ ...result('StockRejected', body.id), type: 'StockRejected', reason: 'Only 0 of KB-001 available, 1 requested' });
    const o = (await request(app.getHttpServer()).get(`/orders/${body.id}`)).body;
    expect(o).toMatchObject({ status: 'REJECTED', reason: 'Only 0 of KB-001 available, 1 requested' });
  });

  it('keeps an order cancelled even if the reservation arrives afterwards', async () => {
    const { body } = await place('k9');
    expect((await request(app.getHttpServer()).post(`/orders/${body.id}/cancel`)).body.status).toBe('CANCELLED');
    expect(await orders.applyInventoryEvent(result('StockReserved', body.id))).toBe('ignored');
    expect((await orders.get(body.id))!.status).toBe('CANCELLED');
    expect((await outbox()).map((e) => e.type)).toEqual(['OrderPlaced', 'OrderCancelled']);
  });

  it('dead-letters a message that can never be parsed', async () => {
    await consumer.handle({ key: Buffer.from('x'), value: Buffer.from('not json'), headers: {} } as never);
    expect(sent).toEqual([expect.objectContaining({ topic: 'inventory.events.DLT', value: 'not json' })]);
  });
});

describe('cancelling', () => {
  it('cancels once and refuses to cancel a rejected order', async () => {
    const { body } = await place('k10');
    await request(app.getHttpServer()).post(`/orders/${body.id}/cancel`);
    await request(app.getHttpServer()).post(`/orders/${body.id}/cancel`);
    expect((await outbox()).filter((e) => e.type === 'OrderCancelled')).toHaveLength(1);

    const other = (await place('k11')).body;
    await orders.applyInventoryEvent({ eventId: crypto.randomUUID(), type: 'StockRejected', orderId: other.id, occurredAt: '' });
    expect((await request(app.getHttpServer()).post(`/orders/${other.id}/cancel`)).status).toBe(409);
  });

  it('returns 404 for an unknown order and 400 for a malformed id', async () => {
    expect((await request(app.getHttpServer()).get(`/orders/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/orders/not-a-uuid')).status).toBe(400);
  });
});

describe('outbox relay', () => {
  it('publishes each order\'s events in order and marks them published', async () => {
    const a = (await place('k12')).body.id;
    const b = (await place('k13')).body.id;
    await request(app.getHttpServer()).post(`/orders/${a}/cancel`);
    expect(await relay.publishOnce()).toBe(3);
    const forA = sent.filter((m) => m.key === a).map((m) => JSON.parse(m.value).type);
    expect(forA).toEqual(['OrderPlaced', 'OrderCancelled']);
    expect(sent.filter((m) => m.key === b)).toHaveLength(1);
    expect(await relay.publishOnce()).toBe(0);
  });
});
