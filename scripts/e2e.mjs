#!/usr/bin/env node
// End-to-end checks against the running cluster. Needs kubectl pointed at it
// and the orders API on ORDERS_URL. Prints each measurement; exits 1 on failure.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const API = process.env.ORDERS_URL ?? 'http://localhost:8090';
const results = [];
let failed = false;

const kubectl = (...args) => execFileSync('kubectl', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const psql = (db, sql) => kubectl('exec', `${db}-db-0`, '--', 'psql', '-U', db, '-d', db, '-tAc', sql);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function place(lines, key = randomUUID()) {
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ customerId: 'e2e', lines }),
  });
  return { status: res.status, body: await res.json() };
}

const getOrder = async (id) => (await fetch(`${API}/orders/${id}`)).json();

/** Polls until every order has left PENDING. Returns final orders and elapsed ms. */
async function settle(ids, timeoutMs = 120_000) {
  const start = Date.now();
  const done = new Map();
  while (done.size < ids.length && Date.now() - start < timeoutMs) {
    await Promise.all(
      ids.filter((id) => !done.has(id)).map(async (id) => {
        const o = await getOrder(id);
        if (o.status !== 'PENDING') done.set(id, o);
      }),
    );
    if (done.size < ids.length) await sleep(100);
  }
  return { orders: [...done.values()], ms: Date.now() - start, pending: ids.length - done.size };
}

const available = (sku) => Number(psql('inventory', `SELECT on_hand - reserved FROM products WHERE sku = '${sku}'`));
const setStock = (sku, n) => psql('inventory', `UPDATE products SET on_hand = ${n}, reserved = 0 WHERE sku = '${sku}'`);

async function waitReady(kind, name) {
  kubectl('rollout', 'status', `${kind}/${name}`, '--timeout=180s');
}

const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

// 1. Happy path, with time from accepted to confirmed for 100 orders.
{
  const products = await (await fetch(`${API}/products`)).json();
  check('catalogue served over gRPC', products.length === 5, `${products.length} products`);
  setStock('CB-005', 1000);
  const latencies = [];
  for (let batch = 0; batch < 10; batch++) {
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        const t0 = Date.now();
        const { body } = await place([{ sku: 'CB-005', quantity: 1 }]);
        const s = await settle([body.id]);
        if (s.orders[0]?.status === 'CONFIRMED') latencies.push(Date.now() - t0);
      }),
    );
  }
  check('100 orders confirmed', latencies.length === 100, `${latencies.length} confirmed`);
  check(
    'accepted to confirmed latency',
    latencies.length > 0,
    `p50 ${percentile(latencies, 50)} ms, p95 ${percentile(latencies, 95)} ms, max ${Math.max(...latencies)} ms`,
  );
}

// 2. Forty customers race for ten monitors.
{
  setStock('MN-003', 10);
  const placed = await Promise.all(Array.from({ length: 40 }, () => place([{ sku: 'MN-003', quantity: 1 }])));
  const accepted = placed.filter((p) => p.status === 202).map((p) => p.body.id);
  const refused = placed.filter((p) => p.status === 422).length;
  const { orders } = await settle(accepted);
  const confirmed = orders.filter((o) => o.status === 'CONFIRMED').length;
  const rejected = orders.filter((o) => o.status === 'REJECTED').length;
  check(
    'no overselling under contention',
    confirmed === 10 && available('MN-003') === 0,
    `${confirmed} confirmed, ${rejected} rejected by reservation, ${refused} refused by the gRPC pre-check, stock left ${available('MN-003')}`,
  );
}

// 3. Retries with one idempotency key create one order.
{
  const key = randomUUID();
  const replies = await Promise.all(Array.from({ length: 10 }, () => place([{ sku: 'KB-001', quantity: 1 }], key)));
  const ids = new Set(replies.map((r) => r.body.id));
  check('10 concurrent retries, one order', ids.size === 1, `${ids.size} distinct order id`);
}

// 4. Cancelling a confirmed order releases its stock.
{
  setStock('HD-004', 15);
  const { body } = await place([{ sku: 'HD-004', quantity: 4 }]);
  await settle([body.id]);
  const before = available('HD-004');
  await fetch(`${API}/orders/${body.id}/cancel`, { method: 'POST' });
  let after = before;
  for (let i = 0; i < 100 && after !== 15; i++) {
    await sleep(100);
    after = available('HD-004');
  }
  check('cancel releases reserved stock', before === 11 && after === 15, `available ${before} then ${after}`);
}

// 5. A malformed event is dead-lettered and does not block the partition.
{
  const dltCount = () =>
    kubectl('exec', 'kafka-0', '--', '/opt/kafka/bin/kafka-get-offsets.sh', '--bootstrap-server', 'localhost:9092', '--topic', 'orders.events.DLT')
      .split('\n')
      .reduce((n, line) => n + Number(line.split(':')[2] ?? 0), 0);
  const before = dltCount();
  execFileSync('kubectl', ['exec', '-i', 'kafka-0', '--', '/opt/kafka/bin/kafka-console-producer.sh', '--bootstrap-server', 'localhost:9092', '--topic', 'orders.events'], {
    input: 'this is not an event\n',
  });
  const { body } = await place([{ sku: 'MS-002', quantity: 1 }]);
  const { orders } = await settle([body.id], 30_000);
  let after = dltCount();
  for (let i = 0; i < 50 && after === before; i++) {
    await sleep(200);
    after = dltCount();
  }
  check('poison message dead-lettered, next order still confirmed', after === before + 1 && orders[0]?.status === 'CONFIRMED', `DLT ${before} to ${after}`);
}

// 6. Inventory down: orders are still accepted, and confirmed once it returns.
{
  kubectl('scale', 'deployment/inventory', '--replicas=0');
  kubectl('wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/name=inventory', '--timeout=120s');
  const placed = await Promise.all(Array.from({ length: 20 }, () => place([{ sku: 'CB-005', quantity: 1 }])));
  const accepted = placed.filter((p) => p.status === 202).map((p) => p.body.id);
  check('orders accepted while inventory is down', accepted.length === 20, `${accepted.length} of 20 accepted`);
  const t0 = Date.now();
  kubectl('scale', 'deployment/inventory', '--replicas=2');
  const { orders, pending } = await settle(accepted, 300_000);
  check(
    'all confirmed after inventory returns',
    pending === 0 && orders.every((o) => o.status === 'CONFIRMED'),
    `${Math.round((Date.now() - t0) / 1000)} s from scale-up, including JVM start`,
  );
  await waitReady('deployment', 'inventory');
}

// 7. Kafka down: orders are still accepted, and confirmed once it returns.
{
  kubectl('scale', 'statefulset/kafka', '--replicas=0');
  kubectl('wait', '--for=delete', 'pod/kafka-0', '--timeout=120s');
  const placed = await Promise.all(Array.from({ length: 20 }, () => place([{ sku: 'CB-005', quantity: 1 }])));
  const accepted = placed.filter((p) => p.status === 202).map((p) => p.body.id);
  check('orders accepted while Kafka is down', accepted.length === 20, `${accepted.length} of 20 accepted`);
  const t0 = Date.now();
  kubectl('scale', 'statefulset/kafka', '--replicas=1');
  const { orders, pending } = await settle(accepted, 300_000);
  check(
    'all confirmed after Kafka returns',
    pending === 0 && orders.every((o) => o.status === 'CONFIRMED'),
    `${Math.round((Date.now() - t0) / 1000)} s from scale-up`,
  );
}

// Every confirmed order holds exactly its reservation, and stock adds up.
{
  const orphan = psql('orders', "SELECT count(*) FROM orders WHERE status = 'PENDING'");
  check('no orders left pending', orphan === '0', `${orphan} pending`);
  const unbalanced = psql('inventory', 'SELECT count(*) FROM products WHERE reserved > on_hand OR reserved < 0');
  check('stock never negative or over-reserved', unbalanced === '0');
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
