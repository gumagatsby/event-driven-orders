import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { config } from './config.js';
import { createPool, PG_POOL } from './db.js';
import { HealthController } from './health.controller.js';
import { InventoryEventsConsumer } from './inventory-events.consumer.js';
import { InventoryClient } from './inventory.client.js';
import { KafkaService } from './kafka.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OutboxRelay } from './outbox.js';

@Module({
  controllers: [OrdersController, HealthController],
  providers: [
    { provide: PG_POOL, useFactory: () => createPool(config.databaseUrl) },
    KafkaService,
    InventoryClient,
    OrdersService,
    OutboxRelay,
    InventoryEventsConsumer,
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
