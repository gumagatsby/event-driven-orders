import { resolve } from 'node:path';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://orders:orders@localhost:5433/orders'),
  kafkaBrokers: env('KAFKA_BROKERS', 'localhost:9094').split(','),
  inventoryGrpc: env('INVENTORY_GRPC', 'localhost:9090'),
  protoDir: env('PROTO_DIR', resolve(process.cwd(), '../proto')),
  inventoryDeadlineMs: Number(env('INVENTORY_DEADLINE_MS', '300')),
  outboxPollMs: Number(env('OUTBOX_POLL_MS', '200')),
  kafkaPartitions: Number(env('KAFKA_PARTITIONS', '3')),
};
