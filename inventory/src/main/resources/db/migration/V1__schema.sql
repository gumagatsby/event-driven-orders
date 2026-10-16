-- Stock is never negative and never over-reserved; the database enforces it,
-- not only the code.
CREATE TABLE products (
    sku          text PRIMARY KEY,
    name         text NOT NULL,
    price_minor  bigint NOT NULL CHECK (price_minor > 0),
    on_hand      integer NOT NULL CHECK (on_hand >= 0),
    reserved     integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    CHECK (reserved <= on_hand)
);

CREATE TABLE reservations (
    order_id    uuid PRIMARY KEY,
    status      text NOT NULL CHECK (status IN ('RESERVED', 'RELEASED')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reservation_lines (
    order_id  uuid NOT NULL REFERENCES reservations (order_id),
    sku       text NOT NULL REFERENCES products (sku),
    quantity  integer NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, sku)
);

-- Kafka delivers at least once. Recording each event id in the same
-- transaction as its effect makes processing exactly-once.
CREATE TABLE processed_events (
    event_id      uuid PRIMARY KEY,
    processed_at  timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: events are written with the change that caused them
-- and published by a relay, so a crash cannot lose or invent an event.
CREATE TABLE outbox (
    id            bigserial PRIMARY KEY,
    topic         text NOT NULL,
    message_key   text NOT NULL,
    payload       jsonb NOT NULL,
    headers       jsonb NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    published_at  timestamptz
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
