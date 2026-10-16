package dev.orders.inventory;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import dev.orders.inventory.Events.Line;
import dev.orders.inventory.Events.OrderEvent;
import org.junit.jupiter.api.BeforeEach;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.simple.JdbcClient;

@SpringBootTest
@Import(TestcontainersConfiguration.class)
abstract class IntegrationTest {

	@Autowired
	JdbcClient db;

	@BeforeEach
	void resetStock() {
		this.db.sql("TRUNCATE reservation_lines, reservations, processed_events, outbox").update();
		this.db.sql("UPDATE products SET reserved = 0").update();
	}

	static OrderEvent placed(UUID orderId, Line... lines) {
		return new OrderEvent(UUID.randomUUID(), Events.ORDER_PLACED, orderId, Instant.now(), List.of(lines));
	}

	static OrderEvent cancelled(UUID orderId) {
		return new OrderEvent(UUID.randomUUID(), Events.ORDER_CANCELLED, orderId, Instant.now(), null);
	}

	int available(String sku) {
		return this.db.sql("SELECT on_hand - reserved FROM products WHERE sku = ?").param(sku).query(Integer.class).single();
	}

	List<String> outboxTypes() {
		return this.db.sql("SELECT payload->>'type' FROM outbox ORDER BY id").query(String.class).list();
	}

}
