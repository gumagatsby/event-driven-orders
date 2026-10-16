package dev.orders.inventory;

import java.util.HashMap;
import java.util.Map;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.context.Context;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/** Writes events in the caller's transaction. {@link OutboxRelay} publishes them. */
@Component
public class Outbox {

	private final JdbcClient db;

	private final JsonMapper json;

	public Outbox(JdbcClient db, JsonMapper json) {
		this.db = db;
		this.json = json;
	}

	public void add(String topic, String key, Object payload) {
		// Keep the current trace context so the relay can continue the same trace
		// when it publishes, even though that happens later on another thread.
		Map<String, String> headers = new HashMap<>();
		GlobalOpenTelemetry.getPropagators().getTextMapPropagator().inject(Context.current(), headers, Map::put);
		this.db.sql("INSERT INTO outbox (topic, message_key, payload, headers) VALUES (?, ?, ?::jsonb, ?::jsonb)")
			.params(topic, key, this.json.writeValueAsString(payload), this.json.writeValueAsString(headers))
			.update();
	}

}
