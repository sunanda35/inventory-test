# Inventory Reservation System

A full-stack inventory reservation application. Customers reserve available inventory and manage their own reservations. Administrators manage stock and review all reservations.

## Stack

- React and TypeScript frontend, powered by Vite
- Fastify and TypeScript API
- PostgreSQL 16 in Docker
- JWT authentication with customer and administrator roles

## Run locally

For Docker environment:

```bash
docker compose up --build
```

Open `http://localhost:5173`.

Compose starts PostgreSQL, runs the API migration and seed process, starts the API at `http://localhost:3001`, and serves the frontend at `http://localhost:5173`.

For a local, non-Docker development server:

```bash
cp .env.example apps/api/.env
npm install
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run dev
```

Seed accounts:

- Customer: `customer@example.com` / `Password123!`
- Customer: `customer.two@example.com` / `Password123!`
- Customer: `customer.three@example.com` / `Password123!`
- Admin: `admin@example.com` / `Password123!`

Run quality checks with `npm run lint`, `npm run format:check`, `npm run build`, and `npm test`. The test suite includes PostgreSQL integration tests, so keep the Compose database running while running tests outside the containers.

## Architecture

The React client communicates with a stateless Fastify API over REST. PostgreSQL is the sole inventory authority. The API holds no inventory state in memory, so multiple API instances can safely serve requests.

The main tables are `users`, `products`, `reservations`, `reservation_items`, and `inventory_adjustments`. Products expose available inventory and a monotonically increasing version. Every stock mutation increments the version for traceability.

## Reservation correctness

### Concurrent requests

Creating a reservation runs in one transaction. Requested product rows are locked with `SELECT ... FOR UPDATE` in stable ID order. The API checks all requested quantities while locks are held, creates the reservation and items, decrements inventory, and commits. The first transaction to secure the final unit succeeds; later transactions see the reduced quantity and fail. This prevents overselling.

### Retried requests

The client sends a UUID idempotency key when creating a reservation. A unique database constraint binds the key to a single reservation. A retry after a lost response returns the original reservation rather than deducting stock twice.

## Verification and security

The automated PostgreSQL integration suite verifies that exactly one of two concurrent customers receives the final unit, a multi-product reservation cannot partially complete, idempotent retries do not deduct inventory twice, and cancellation/expiry restores stock once. Authentication tokens expire after 15 minutes by default. Login performs a bcrypt comparison even for unknown email addresses, preventing an observable shortcut for account discovery. The JWT package is pinned to `@fastify/jwt` 10.2.1, which contains the patched `fast-jwt` dependency for CVE-2026-44351.

### Multi-product reservations

Products are validated and mutated in the same transaction. A missing or insufficient product rolls back the entire transaction, so no partial reservation can exist.

### Cancellation and expiry

Pending reservations expire after ten minutes, as required. The API runs expiry processing once each minute and also processes due expirations before reservation operations. Cancellation and expiry change status and return all reserved quantities in the same transaction. State guards make these operations idempotent.

### Admin stock changes

An administrator can adjust available stock only when the result remains non-negative. Each adjustment is written to an audit record. Existing reservations retain their held inventory because it has already been deducted from available stock.

## Failure cases and recovery

- Database failure before commit: PostgreSQL rolls the full transaction back.
- Client timeout after commit: idempotency returns the original result.
- API process crash: no in-memory state is needed; the database transaction either committed or rolled back.
- Expiry worker interruption: the next worker tick or reservation operation processes due reservations.
- Concurrent cancellation/expiry: status guards ensure inventory is returned only once.

## Scaling to 100,000 concurrent users

To scale this, we have to intoduce redis lock for concurrent request for same product, Rate liting, db connection pool, maybe read replica and all, It totally depends, there is no single solution can satisfy this. We have to check how users using it, what the bottleneck, then have to do that way.

## Production readiness improvements

Before production I would add database migration version tracking, HTTP security headers, refresh-token rotation, email verification, secrets management, observability and alerting, structured audit retention, backup/restore testing, distributed tracing, rate limits, accessibility testing, CI, and load tests. Payment integration would require a separate payment state machine and webhook idempotency.

## AI use

Architecture, idempotency, concurrency control strategies decision took by me, ai just helped to write raw dumb code, thats it.
