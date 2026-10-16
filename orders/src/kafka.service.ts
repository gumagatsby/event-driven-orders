import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Kafka, logLevel, Partitioners, Producer } from 'kafkajs';
import { config } from './config.js';
import { INVENTORY_DLT, INVENTORY_TOPIC, ORDERS_TOPIC } from './events.js';

/**
 * Kafka is not needed to accept an order: orders go to the outbox first. So
 * startup does not wait for Kafka; the producer connects in the background and
 * the relay simply retries until it can publish.
 */
@Injectable()
export class KafkaService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(KafkaService.name);
  readonly kafka = new Kafka({
    clientId: 'orders',
    brokers: config.kafkaBrokers,
    logLevel: logLevel.WARN,
    retry: { retries: 5, initialRetryTime: 300 },
  });
  // One request in flight per broker keeps messages in order within a partition.
  // The default partitioner hashes keys the same way as the Java client.
  readonly producer: Producer = this.kafka.producer({
    maxInFlightRequests: 1,
    allowAutoTopicCreation: false,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
  private connected: Promise<void> | null = null;

  onModuleInit() {
    void this.ready().catch(() => undefined);
  }

  /** Resolves once the producer is connected and the topics exist. Retries on later calls if it failed. */
  ready(): Promise<void> {
    this.connected ??= (async () => {
      const admin = this.kafka.admin();
      await admin.connect();
      try {
        await admin.createTopics({
          waitForLeaders: true,
          topics: [ORDERS_TOPIC, `${ORDERS_TOPIC}.DLT`, INVENTORY_TOPIC, INVENTORY_DLT].map((topic) => ({
            topic,
            numPartitions: config.kafkaPartitions,
          })),
        });
      } finally {
        await admin.disconnect();
      }
      await this.producer.connect();
      this.log.log('Connected to Kafka');
    })().catch((err: Error) => {
      this.connected = null;
      this.log.warn(`Kafka not ready: ${err.message}`);
      throw err;
    });
    return this.connected;
  }

  async onApplicationShutdown() {
    await this.producer.disconnect();
  }
}
