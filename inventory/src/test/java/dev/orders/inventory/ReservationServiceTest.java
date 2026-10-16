package dev.orders.inventory;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import dev.orders.inventory.Events.Line;
import dev.orders.inventory.Events.OrderEvent;
import dev.orders.inventory.ReservationService.Outcome;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;

import static org.assertj.core.api.Assertions.assertThat;

class ReservationServiceTest extends IntegrationTest {

	@Autowired
	ReservationService service;

	@Test
	void reservesStockAndRecordsAnEvent() {
		assertThat(this.service.handle(placed(UUID.randomUUID(), new Line("KB-001", 2)))).isEqualTo(Outcome.RESERVED);
		assertThat(available("KB-001")).isEqualTo(23);
		assertThat(outboxTypes()).containsExactly(Events.STOCK_RESERVED);
	}

	@Test
	void rejectsWhenStockIsShortAndReservesNothing() {
		UUID order = UUID.randomUUID();
		assertThat(this.service.handle(placed(order, new Line("KB-001", 1), new Line("MN-003", 11))))
			.isEqualTo(Outcome.REJECTED);
		assertThat(available("KB-001")).isEqualTo(25);
		assertThat(available("MN-003")).isEqualTo(10);
		String reason = this.db.sql("SELECT payload->>'reason' FROM outbox").query(String.class).single();
		assertThat(reason).isEqualTo("Only 10 of MN-003 available, 11 requested");
	}

	@Test
	void rejectsUnknownProducts() {
		assertThat(this.service.handle(placed(UUID.randomUUID(), new Line("NOPE-1", 1)))).isEqualTo(Outcome.REJECTED);
	}

	@Test
	void mergesRepeatedLinesForTheSameProduct() {
		this.service.handle(placed(UUID.randomUUID(), new Line("MS-002", 3), new Line("MS-002", 4)));
		assertThat(available("MS-002")).isEqualTo(33);
	}

	@Test
	void appliesARedeliveredEventOnce() {
		OrderEvent event = placed(UUID.randomUUID(), new Line("KB-001", 2));
		assertThat(this.service.handle(event)).isEqualTo(Outcome.RESERVED);
		assertThat(this.service.handle(event)).isEqualTo(Outcome.DUPLICATE);
		assertThat(available("KB-001")).isEqualTo(23);
		assertThat(outboxTypes()).hasSize(1);
	}

	@Test
	void cancellingReleasesStockOnce() {
		UUID order = UUID.randomUUID();
		this.service.handle(placed(order, new Line("HD-004", 5)));
		assertThat(this.service.handle(cancelled(order))).isEqualTo(Outcome.RELEASED);
		assertThat(this.service.handle(cancelled(order))).isEqualTo(Outcome.NOTHING_TO_RELEASE);
		assertThat(available("HD-004")).isEqualTo(15);
		assertThat(outboxTypes()).containsExactly(Events.STOCK_RESERVED, Events.STOCK_RELEASED);
	}

	@Test
	void concurrentOrdersNeverOversell() throws Exception {
		// 40 orders race for 10 monitors.
		ExecutorService pool = Executors.newFixedThreadPool(16);
		List<Callable<Outcome>> orders = new ArrayList<>();
		for (int i = 0; i < 40; i++) {
			orders.add(() -> this.service.handle(placed(UUID.randomUUID(), new Line("MN-003", 1))));
		}
		List<Outcome> outcomes = new ArrayList<>();
		for (Future<Outcome> f : pool.invokeAll(orders)) {
			outcomes.add(f.get());
		}
		pool.shutdown();
		assertThat(outcomes).filteredOn(o -> o == Outcome.RESERVED).hasSize(10);
		assertThat(outcomes).filteredOn(o -> o == Outcome.REJECTED).hasSize(30);
		assertThat(available("MN-003")).isZero();
	}

}
