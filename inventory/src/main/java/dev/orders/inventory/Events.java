package dev.orders.inventory;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Event contracts shared with the orders service. Both topics are keyed by order id. */
public final class Events {

	public static final String ORDERS = "orders.events";
	public static final String INVENTORY = "inventory.events";

	public static final String ORDER_PLACED = "OrderPlaced";
	public static final String ORDER_CANCELLED = "OrderCancelled";
	public static final String STOCK_RESERVED = "StockReserved";
	public static final String STOCK_REJECTED = "StockRejected";
	public static final String STOCK_RELEASED = "StockReleased";

	public record Line(String sku, int quantity) {
	}

	public record OrderEvent(UUID eventId, String type, UUID orderId, Instant occurredAt, List<Line> lines) {
	}

	public record InventoryEvent(UUID eventId, String type, UUID orderId, Instant occurredAt, String reason) {

		static InventoryEvent of(String type, UUID orderId, String reason) {
			return new InventoryEvent(UUID.randomUUID(), type, orderId, Instant.now(), reason);
		}

	}

	private Events() {
	}

}
