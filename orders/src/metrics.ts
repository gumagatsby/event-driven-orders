import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route template',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});
export const ordersPlaced = new client.Counter({
  name: 'orders_placed_total',
  help: 'Order placement attempts by result',
  labelNames: ['result'],
  registers: [registry],
});
export const statusChanges = new client.Counter({
  name: 'order_status_changes_total',
  help: 'Order status transitions',
  labelNames: ['to'],
  registers: [registry],
});
export const inventoryChecks = new client.Counter({
  name: 'inventory_checks_total',
  help: 'gRPC availability checks by result',
  labelNames: ['result'],
  registers: [registry],
});
export const outboxPublished = new client.Counter({
  name: 'outbox_published_total',
  help: 'Events published to Kafka',
  registers: [registry],
});
export const deadLettered = new client.Counter({
  name: 'events_dead_lettered_total',
  help: 'Unprocessable events sent to the dead-letter topic',
  registers: [registry],
});
