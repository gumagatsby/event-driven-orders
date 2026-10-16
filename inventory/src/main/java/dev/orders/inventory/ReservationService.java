package dev.orders.inventory;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

import dev.orders.inventory.Events.InventoryEvent;
import dev.orders.inventory.Events.Line;
import dev.orders.inventory.Events.OrderEvent;
import io.micrometer.core.instrument.MeterRegistry;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Reserves and releases stock. Each event is applied exactly once, in one transaction. */
@Service
public class ReservationService {

	public enum Outcome {
		RESERVED, REJECTED, RELEASED, NOTHING_TO_RELEASE, DUPLICATE
	}

	private record Stock(String sku, int available) {
	}

	private final JdbcClient db;

	private final Outbox outbox;

	private final MeterRegistry meters;

	public ReservationService(JdbcClient db, Outbox outbox, MeterRegistry meters) {
		this.db = db;
		this.outbox = outbox;
		this.meters = meters;
	}

	@Transactional
	public Outcome handle(OrderEvent event) {
		Outcome outcome;
		int inserted = this.db.sql("INSERT INTO processed_events (event_id) VALUES (?) ON CONFLICT DO NOTHING")
			.param(event.eventId())
			.update();
		if (inserted == 0) {
			outcome = Outcome.DUPLICATE;
		}
		else if (Events.ORDER_PLACED.equals(event.type())) {
			outcome = reserve(event.orderId(), event.lines());
		}
		else {
			outcome = release(event.orderId());
		}
		this.meters.counter("inventory_events_processed", "outcome", outcome.name().toLowerCase()).increment();
		return outcome;
	}

	private Outcome reserve(UUID orderId, List<Line> lines) {
		boolean seen = this.db.sql("SELECT EXISTS (SELECT 1 FROM reservations WHERE order_id = ?)")
			.param(orderId)
			.query(Boolean.class)
			.single();
		if (seen) {
			return Outcome.DUPLICATE;
		}
		// Merge repeated SKUs, and sort them: every transaction locks rows in the
		// same order, so two orders for the same products cannot deadlock.
		Map<String, Integer> wanted = new TreeMap<>();
		lines.forEach(l -> wanted.merge(l.sku(), l.quantity(), Integer::sum));
		Map<String, Integer> available = new TreeMap<>();
		this.db
			.sql("SELECT sku, on_hand - reserved FROM products WHERE sku = ANY(?) ORDER BY sku FOR UPDATE")
			.param(wanted.keySet().toArray(String[]::new))
			.query((rs, n) -> new Stock(rs.getString(1), rs.getInt(2)))
			.list()
			.forEach(s -> available.put(s.sku(), s.available()));

		for (Map.Entry<String, Integer> line : wanted.entrySet()) {
			Integer have = available.get(line.getKey());
			String reason = null;
			if (have == null) {
				reason = "Unknown product " + line.getKey();
			}
			else if (have < line.getValue()) {
				reason = "Only " + have + " of " + line.getKey() + " available, " + line.getValue() + " requested";
			}
			if (reason != null) {
				emit(InventoryEvent.of(Events.STOCK_REJECTED, orderId, reason));
				return Outcome.REJECTED;
			}
		}

		this.db.sql("INSERT INTO reservations (order_id, status) VALUES (?, 'RESERVED')").param(orderId).update();
		wanted.forEach((sku, qty) -> {
			this.db.sql("UPDATE products SET reserved = reserved + ? WHERE sku = ?").params(qty, sku).update();
			this.db.sql("INSERT INTO reservation_lines (order_id, sku, quantity) VALUES (?, ?, ?)")
				.params(orderId, sku, qty)
				.update();
		});
		emit(InventoryEvent.of(Events.STOCK_RESERVED, orderId, null));
		return Outcome.RESERVED;
	}

	private Outcome release(UUID orderId) {
		String status = this.db.sql("SELECT status FROM reservations WHERE order_id = ? FOR UPDATE")
			.param(orderId)
			.query(String.class)
			.optional()
			.orElse(null);
		if (!"RESERVED".equals(status)) {
			// Rejected orders reserved nothing, and a repeat cancel has nothing left.
			return Outcome.NOTHING_TO_RELEASE;
		}
		this.db.sql("SELECT sku, quantity FROM reservation_lines WHERE order_id = ? ORDER BY sku")
			.param(orderId)
			.query((rs, n) -> new Line(rs.getString(1), rs.getInt(2)))
			.list()
			.forEach(l -> this.db.sql("UPDATE products SET reserved = reserved - ? WHERE sku = ?")
				.params(l.quantity(), l.sku())
				.update());
		this.db.sql("UPDATE reservations SET status = 'RELEASED', updated_at = now() WHERE order_id = ?")
			.param(orderId)
			.update();
		emit(InventoryEvent.of(Events.STOCK_RELEASED, orderId, null));
		return Outcome.RELEASED;
	}

	private void emit(InventoryEvent event) {
		this.outbox.add(Events.INVENTORY, event.orderId().toString(), event);
	}

}
