import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Contracts shared with the inventory service. Both topics are keyed by order
// id, so every event about one order lands on one partition, in order.
export const ORDERS_TOPIC = 'orders.events';
export const INVENTORY_TOPIC = 'inventory.events';
export const INVENTORY_DLT = `${INVENTORY_TOPIC}.DLT`;

export interface Line {
  sku: string;
  quantity: number;
}

export interface OrderEvent {
  eventId: string;
  type: 'OrderPlaced' | 'OrderCancelled';
  orderId: string;
  occurredAt: string;
  lines?: Line[];
}

export const orderEvent = (type: OrderEvent['type'], orderId: string, lines?: Line[]): OrderEvent => ({
  eventId: randomUUID(),
  type,
  orderId,
  occurredAt: new Date().toISOString(),
  ...(lines ? { lines } : {}),
});

export const InventoryEvent = z.object({
  eventId: z.uuid(),
  type: z.enum(['StockReserved', 'StockRejected', 'StockReleased']),
  orderId: z.uuid(),
  occurredAt: z.string(),
  reason: z.string().nullish(),
});
export type InventoryEvent = z.infer<typeof InventoryEvent>;
