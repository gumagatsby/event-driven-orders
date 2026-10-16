package dev.orders.inventory;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import org.apache.kafka.clients.consumer.Consumer;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.kafka.core.ConsumerFactory;
import org.springframework.kafka.core.KafkaTemplate;

import static org.assertj.core.api.Assertions.assertThat;

/** End to end through Kafka: the listener, the outbox relay and the dead-letter topic. */
class KafkaFlowTest extends IntegrationTest {

	@Autowired
	KafkaTemplate<String, String> kafka;

	@Autowired
	ConsumerFactory<String, String> consumers;

	@Test
	void anOrderPlacedEventProducesAStockReservedEvent() throws Exception {
		try (Consumer<String, String> results = consumer(Events.INVENTORY)) {
			UUID order = UUID.randomUUID();
			this.kafka.send(Events.ORDERS, order.toString(), """
					{"eventId":"%s","type":"OrderPlaced","orderId":"%s","occurredAt":"2026-10-16T12:00:00Z",
					 "lines":[{"sku":"CB-005","quantity":3}]}""".formatted(UUID.randomUUID(), order)).get();

			ConsumerRecord<String, String> reply = await(results, r -> r.key().equals(order.toString()));
			assertThat(reply.value()).contains("\"StockReserved\"");
			assertThat(available("CB-005")).isEqualTo(197);
		}
	}

	@Test
	void aMalformedMessageIsDeadLetteredAndDoesNotBlockTheNextOne() throws Exception {
		try (Consumer<String, String> dlt = consumer(Events.ORDERS + ".DLT");
				Consumer<String, String> results = consumer(Events.INVENTORY)) {
			String key = UUID.randomUUID().toString();
			this.kafka.send(Events.ORDERS, key, "this is not json").get();
			this.kafka.send(Events.ORDERS, key, """
					{"eventId":"%s","type":"OrderPlaced","orderId":"%s","occurredAt":"2026-10-16T12:00:00Z",
					 "lines":[{"sku":"MS-002","quantity":1}]}""".formatted(UUID.randomUUID(), key)).get();

			assertThat(await(dlt, r -> r.key().equals(key)).value()).isEqualTo("this is not json");
			assertThat(await(results, r -> r.key().equals(key)).value()).contains("StockReserved");
		}
	}

	private Consumer<String, String> consumer(String topic) {
		Consumer<String, String> c = this.consumers.createConsumer("test-" + UUID.randomUUID(), null);
		c.subscribe(List.of(topic));
		return c;
	}

	private static ConsumerRecord<String, String> await(Consumer<String, String> c,
			java.util.function.Predicate<ConsumerRecord<String, String>> match) {
		long deadline = System.currentTimeMillis() + 30_000;
		List<String> seen = new ArrayList<>();
		while (System.currentTimeMillis() < deadline) {
			for (ConsumerRecord<String, String> r : c.poll(Duration.ofMillis(250))) {
				if (r.key() != null && match.test(r)) {
					return r;
				}
				seen.add(r.key());
			}
		}
		throw new AssertionError("No matching record within 30 s; saw keys " + seen);
	}

}
