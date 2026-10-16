import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Consumer, KafkaMessage } from 'kafkajs';
import { INVENTORY_DLT, INVENTORY_TOPIC, InventoryEvent } from './events.js';
import { KafkaService } from './kafka.service.js';
import { deadLettered } from './metrics.js';
import { OrdersService } from './orders.service.js';

@Injectable()
export class InventoryEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(InventoryEventsConsumer.name);
  private consumer?: Consumer;
  private stopped = false;

  constructor(
    @Inject(KafkaService) private readonly kafka: KafkaService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  onApplicationBootstrap() {
    void this.start();
  }

  private async start() {
    while (!this.stopped) {
      try {
        await this.kafka.ready();
        this.consumer = this.kafka.kafka.consumer({ groupId: 'orders' });
        await this.consumer.connect();
        await this.consumer.subscribe({ topic: INVENTORY_TOPIC, fromBeginning: true });
        // Offsets are committed only after handle() returns. If it throws (say
        // the database is down), kafkajs retries the same message.
        await this.consumer.run({ eachMessage: ({ message }) => this.handle(message) });
        return;
      } catch (err) {
        this.log.warn(`Consumer not started, retrying: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  async handle(message: KafkaMessage) {
    const raw = message.value?.toString() ?? '';
    let event: InventoryEvent;
    try {
      event = InventoryEvent.parse(JSON.parse(raw));
    } catch (err) {
      // It will never parse, so retrying would block the partition forever.
      await this.kafka.producer.send({
        topic: INVENTORY_DLT,
        messages: [{ key: message.key, value: message.value, headers: { ...message.headers, error: (err as Error).message.slice(0, 500) } }],
      });
      deadLettered.inc();
      this.log.warn('Unparseable inventory event sent to the dead-letter topic');
      return;
    }
    await this.orders.applyInventoryEvent(event);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    await this.consumer?.disconnect();
  }
}
