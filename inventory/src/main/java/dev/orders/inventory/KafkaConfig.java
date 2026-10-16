package dev.orders.inventory;

import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.common.TopicPartition;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.util.backoff.ExponentialBackOff;

@Configuration(proxyBeanMethods = false)
class KafkaConfig {

	// Created if missing; both services declare the topics they use, so start
	// order does not matter.
	@Bean
	KafkaAdmin.NewTopics topics(@Value("${inventory.kafka.partitions:3}") int partitions,
			@Value("${inventory.kafka.replicas:1}") short replicas) {
		return new KafkaAdmin.NewTopics(topic(Events.ORDERS, partitions, replicas),
				topic(Events.ORDERS + ".DLT", partitions, replicas), topic(Events.INVENTORY, partitions, replicas),
				topic(Events.INVENTORY + ".DLT", partitions, replicas));
	}

	private static NewTopic topic(String name, int partitions, short replicas) {
		return TopicBuilder.name(name).partitions(partitions).replicas(replicas).build();
	}

	/**
	 * A malformed message goes straight to the dead-letter topic. Anything else,
	 * such as the database being down, is retried with backoff for as long as it
	 * takes: skipping it would lose a reservation, and moving past it would break
	 * per-order ordering.
	 */
	@Bean
	DefaultErrorHandler errorHandler(KafkaTemplate<String, String> template) {
		DeadLetterPublishingRecoverer dlt = new DeadLetterPublishingRecoverer(template,
				(record, ex) -> new TopicPartition(record.topic() + ".DLT", -1));
		ExponentialBackOff backOff = new ExponentialBackOff(500, 2.0);
		backOff.setMaxInterval(30_000);
		DefaultErrorHandler handler = new DefaultErrorHandler(dlt, backOff);
		handler.addNotRetryableExceptions(InvalidEventException.class);
		return handler;
	}

}
