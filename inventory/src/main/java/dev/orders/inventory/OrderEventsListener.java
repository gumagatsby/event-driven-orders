package dev.orders.inventory;

import java.util.List;

import dev.orders.inventory.Events.Line;
import dev.orders.inventory.Events.OrderEvent;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderEventsListener {

	private final ReservationService reservations;

	private final JsonMapper json;

	public OrderEventsListener(ReservationService reservations, JsonMapper json) {
		this.reservations = reservations;
		this.json = json;
	}

	// One consumer thread per partition. Records with the same key (order id)
	// share a partition, so each order's events are handled in order.
	@KafkaListener(topics = Events.ORDERS, concurrency = "3")
	public void on(ConsumerRecord<String, String> record) {
		this.reservations.handle(parse(record.value()));
	}

	OrderEvent parse(String value) {
		OrderEvent event;
		try {
			event = this.json.readValue(value, OrderEvent.class);
		}
		catch (JacksonException ex) {
			throw new InvalidEventException("Not a valid order event", ex);
		}
		if (event == null || event.eventId() == null || event.orderId() == null || event.type() == null) {
			throw new InvalidEventException("Missing eventId, orderId or type");
		}
		if (!Events.ORDER_PLACED.equals(event.type()) && !Events.ORDER_CANCELLED.equals(event.type())) {
			throw new InvalidEventException("Unknown event type " + event.type());
		}
		if (Events.ORDER_PLACED.equals(event.type())) {
			List<Line> lines = event.lines();
			if (lines == null || lines.isEmpty() || lines.size() > 100) {
				throw new InvalidEventException("An order needs 1 to 100 lines");
			}
			for (Line line : lines) {
				if (line.sku() == null || line.sku().isBlank() || line.quantity() < 1 || line.quantity() > 1000) {
					throw new InvalidEventException("Invalid line " + line);
				}
			}
		}
		return event;
	}

}
