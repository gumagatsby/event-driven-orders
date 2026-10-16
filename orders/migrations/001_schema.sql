CREATE TABLE orders (
    id               uuid PRIMARY KEY,
    customer_id      text NOT NULL,
    status           text NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED')),
    reason           text,
    idempotency_key  text NOT NULL UNIQUE,
    request_hash     text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
    order_id  uuid NOT NULL REFERENCES orders (id),
    sku       text NOT NULL,
    quantity  integer NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (order_id, sku)
);

CREATE TABLE processed_events (
    event_id      uuid PRIMARY KEY,
    processed_at  timestamptz NOT NULL DEFAULT now()
);

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
