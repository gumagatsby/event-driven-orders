package dev.orders.inventory;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import org.apache.kafka.clients.producer.ProducerRecord;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Publishes outbox rows to Kafka, oldest first. Rows are marked published only
 * after Kafka acknowledges them, so delivery is at least once and consumers
 * de-duplicate by event id.
 */
@Component
public class OutboxRelay {

	// Only one replica publishes at a time, which keeps per-order event order.
	private static final long RELAY_LOCK = 0x1A7E_0001L;

	private static final TextMapGetter<Map<String, String>> GETTER = new TextMapGetter<>() {
		@Override
		public Iterable<String> keys(Map<String, String> carrier) {
			return carrier.keySet();
		}

		@Override
		public String get(Map<String, String> carrier, String key) {
			return carrier == null ? null : carrier.get(key);
		}
	};

	private record Row(long id, String topic, String key, String payload, String headers) {
	}

	private final JdbcClient db;

	private final KafkaTemplate<String, String> kafka;

	private final JsonMapper json;

	private final int batchSize;

	private final Counter published;

	public OutboxRelay(JdbcClient db, KafkaTemplate<String, String> kafka, JsonMapper json, MeterRegistry meters,
			@Value("${inventory.outbox.batch-size}") int batchSize) {
		this.db = db;
		this.kafka = kafka;
		this.json = json;
		this.batchSize = batchSize;
		this.published = Counter.builder("outbox_published").description("Events published to Kafka").register(meters);
	}

	@Scheduled(fixedDelayString = "${inventory.outbox.poll-ms}")
	@Transactional
	public void publish() throws Exception {
		Boolean leader = this.db.sql("SELECT pg_try_advisory_xact_lock(?)").param(RELAY_LOCK).query(Boolean.class).single();
		if (!leader) {
			return;
		}
		List<Row> rows = this.db
			.sql("SELECT id, topic, message_key, payload::text, headers::text FROM outbox "
					+ "WHERE published_at IS NULL ORDER BY id LIMIT ?")
			.param(this.batchSize)
			.query((rs, n) -> new Row(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)))
			.list();
		if (rows.isEmpty()) {
			return;
		}
		List<CompletableFuture<SendResult<String, String>>> sends = new ArrayList<>();
		for (Row row : rows) {
			Map<String, String> headers = this.json.readValue(row.headers(), new TypeReference<Map<String, String>>() {
			});
			ProducerRecord<String, String> record = new ProducerRecord<>(row.topic(), row.key(), row.payload());
			headers.forEach((k, v) -> record.headers().add(k, v.getBytes(StandardCharsets.UTF_8)));
			Context parent = GlobalOpenTelemetry.getPropagators()
				.getTextMapPropagator()
				.extract(Context.root(), headers, GETTER);
			try (Scope ignored = parent.makeCurrent()) {
				sends.add(this.kafka.send(record));
			}
		}
		// The idempotent producer keeps order within a partition, so sending the
		// batch then waiting is as safe as sending one at a time, and faster.
		CompletableFuture.allOf(sends.toArray(CompletableFuture[]::new)).get(30, TimeUnit.SECONDS);
		this.db.sql("UPDATE outbox SET published_at = now() WHERE id = ANY(?)")
			.param(rows.stream().map(Row::id).toArray(Long[]::new))
			.update();
		this.published.increment(rows.size());
	}

}
