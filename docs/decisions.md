# Design decisions and trade-offs

## 1. Two services, two languages, one contract

The orders service is TypeScript (NestJS); the inventory service is Java 21 (Spring Boot). They share nothing but contracts: a gRPC `.proto` file in [`proto/`](../proto) that both build from, and the JSON event shapes on two Kafka topics. Each has its own PostgreSQL database, and a network policy stops either service connecting to the other's. A team could change, deploy or rewrite one service without touching the other, which is the point of splitting them.

## 2. Synchronous for questions, asynchronous for decisions

The orders service asks inventory "could this order be met?" over gRPC, with a 300 ms deadline, so an obviously impossible order gets a 422 straight away. That answer is advisory. The reservation itself happens when inventory consumes the `OrderPlaced` event. If inventory is slow or down, the deadline expires, orders skips the check, and the order is accepted anyway: the event will be processed when inventory returns. The end-to-end run scaled inventory to zero, placed 20 orders, and all 20 were confirmed after it came back.

**Alternative considered:** reserve stock synchronously over gRPC. Simpler to follow, but then every order depends on inventory being up at that moment, and a reservation can be made with no record that the order exists, or the reverse.

## 3. Transactional outbox on both sides

Neither service writes to Kafka directly from a request. It writes the event to an `outbox` table **in the same transaction** as the change it describes, and a relay publishes outbox rows to Kafka, marking them published only after Kafka acknowledges. So a crash can never leave an order without its event, or an event about an order that was rolled back. Kafka can be down: orders are still accepted, and the relay catches up. The run scaled Kafka to zero and back with no orders lost.

The relay takes a PostgreSQL advisory lock, so only one replica publishes at a time. That keeps each order's events in the order they were written. Within a batch, events for different orders are sent in parallel and events for the same order one after another.

**Trade-off:** latency. Each relay polls every 200 ms, which is most of the 231 ms median from accepted to confirmed. LISTEN/NOTIFY or change data capture (Debezium) would cut that; polling is simpler and was fast enough here.

## 4. At-least-once delivery, exactly-once effect

Kafka can deliver a message twice: after a consumer crash, a rebalance, or a relay that published but died before marking the row. Each consumer records the event id in a `processed_events` table in the same transaction as the event's effect, and skips ids it has seen. Inventory also refuses a second reservation for the same order. The tests deliver the same event twice and check stock moves once.

## 5. Ordering by key

Both topics are keyed by order id, so all events for one order land on one partition and are consumed in order. That matters for "placed, then cancelled": inventory must reserve before it releases. Inventory's listener runs one thread per partition. A cancellation that overtakes the reservation result is handled too: orders only moves an order out of `PENDING`, so a late `StockReserved` cannot un-cancel it.

## 6. Overselling is impossible, not just unlikely

Inventory locks the product rows it needs with `SELECT ... FOR UPDATE`, always in SKU order so two orders for the same products cannot deadlock, checks availability, then reserves. `CHECK (reserved <= on_hand)` and `CHECK (reserved >= 0)` are the last line of defence. Forty concurrent orders for ten monitors produced exactly ten reservations, in the Java tests and again on the cluster.

## 7. Poison messages go to a dead-letter topic

A message that can never be parsed would otherwise be retried forever and block every later message on its partition. Inventory's error handler sends unparseable or invalid events straight to `orders.events.DLT`. Anything else, such as the database being down, is retried with exponential backoff for as long as it takes, because skipping it would lose a reservation and moving past it would break ordering. The orders consumer does the same with `inventory.events.DLT`.

## 8. gRPC load balancing in Kubernetes

gRPC holds one long-lived HTTP/2 connection. Through a normal Kubernetes Service, every call from one orders pod would go to whichever inventory pod that connection reached. The service chart adds a headless Service for gRPC, which returns every pod's address, and the client balances calls across them (round robin). In one run the two inventory pods handled 70 and 82 availability checks.

## 9. One Helm chart for every service

`charts/service` is a generic chart: Deployment, Service, PodDisruptionBudget, NetworkPolicy and ServiceAccount, configured per service by a values file. Every pod runs as non-root with a read-only root filesystem, no Linux capabilities and no service-account token. Replicas spread across nodes, rolling updates never drop below the current count, and a startup probe gives the JVM time to start. `charts/platform` holds the infrastructure. Database passwords are generated by Helm on first install, stored as Secrets and kept on upgrade; none are in the repository.

## 10. Tracing across the whole flow

Both services export OpenTelemetry traces to Jaeger: the Java service through the OpenTelemetry agent (no code changes), the Node service through the SDK. The outbox stores the W3C trace context with each event, and the relay restores it when publishing, so one order is one trace across both services, through Kafka in both directions. The idle polls of the Node relay are not traced; the Java agent still traces them, which a sampler would drop in production.

## 11. Testing against real infrastructure

The Java tests use Testcontainers to start real Kafka and PostgreSQL, because locking, constraints, consumer groups and dead-lettering are what is being tested. The TypeScript tests use a real PostgreSQL and replace only Kafka and gRPC. Then CI builds both images, creates a three-node kind cluster, installs the charts and runs [`scripts/e2e.mjs`](../scripts/e2e.mjs), which includes the outage drills.

## 12. What production would add

- Three or more Kafka brokers with replication factor 3 and `min.insync.replicas` 2, or a managed service (Amazon MSK, Confluent Cloud).
- A schema registry (Avro or Protobuf) for events, so producers cannot break consumers.
- Managed PostgreSQL with backups, and connection pooling (PgBouncer).
- Mutual TLS between services (a service mesh, or gRPC TLS with cert-manager).
- Tail-based trace sampling, Prometheus and alerting on consumer lag and outbox depth.
- `kafkajs` has had no release since February 2023 and prints a timeout warning on Node 24. The Confluent JavaScript client, released as recently as October 2026, is the maintained alternative.
