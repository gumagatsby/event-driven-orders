import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'node:path';
import { config } from './config.js';
import type { Line } from './events.js';

export interface Product {
  sku: string;
  name: string;
  priceMinor: number;
  available: number;
}
export interface Availability {
  allAvailable: boolean;
  lines: { sku: string; known: boolean; available: number; sufficient: boolean }[];
}

type Unary<Req, Res> = (req: Req, opts: grpc.CallOptions, cb: (err: grpc.ServiceError | null, res: Res) => void) => void;
interface InventoryStub extends grpc.Client {
  listProducts: Unary<object, { products: Product[] }>;
  checkAvailability: Unary<{ lines: Line[] }, Availability>;
}

/** gRPC client for the inventory service, loaded from the shared .proto at runtime. */
@Injectable()
export class InventoryClient implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(InventoryClient.name);
  private readonly stub: InventoryStub;

  constructor() {
    const definition = protoLoader.loadSync(join(config.protoDir, 'inventory/v1/inventory.proto'), {
      longs: Number,
      defaults: true,
    });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      inventory: { v1: { InventoryService: new (addr: string, creds: grpc.ChannelCredentials, options: grpc.ChannelOptions) => InventoryStub } };
    };
    // Balance calls across every address DNS returns (one per inventory pod),
    // rather than pinning all traffic to the first connection.
    this.stub = new pkg.inventory.v1.InventoryService(config.inventoryGrpc, grpc.credentials.createInsecure(), {
      'grpc.service_config': JSON.stringify({ loadBalancingConfig: [{ round_robin: {} }] }),
    });
  }

  /**
   * Connect at start-up rather than on the first request. A cold connection
   * takes longer than the 300 ms call deadline, so otherwise the first calls
   * after a deploy would fail.
   */
  onModuleInit() {
    this.stub.waitForReady(Date.now() + 30_000, (err) =>
      err ? this.log.warn(`Inventory not reachable yet: ${err.message}`) : this.log.log('Connected to inventory'),
    );
  }

  private call<Req, Res>(method: Unary<Req, Res>, req: Req): Promise<Res> {
    // Every call has a deadline, so a slow inventory service cannot hold up orders.
    const deadline = Date.now() + config.inventoryDeadlineMs;
    return new Promise((resolve, reject) =>
      method.call(this.stub, req, { deadline }, (err, res) => (err ? reject(err) : resolve(res))),
    );
  }

  listProducts(): Promise<Product[]> {
    return this.call(this.stub.listProducts, {}).then((r) => r.products);
  }

  checkAvailability(lines: Line[]): Promise<Availability> {
    return this.call(this.stub.checkAvailability, { lines });
  }

  onApplicationShutdown() {
    this.stub.close();
  }
}
