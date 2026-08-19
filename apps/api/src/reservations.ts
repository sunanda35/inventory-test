import type { PoolClient } from 'pg';
import { AppError } from './errors.js';

type ReservationInput = {
  userId: string;
  idempotencyKey: string;
  items: Array<{ productId: string; quantity: number }>;
};

export async function expireReservations(client: PoolClient): Promise<void> {
  const expired = await client.query<{ id: string }>(
    `UPDATE reservations
     SET status = 'expired', updated_at = now()
     WHERE status = 'pending' AND expires_at <= now()
     RETURNING id`,
  );

  for (const reservation of expired.rows) {
    await client.query(
      `UPDATE products p
       SET available_quantity = p.available_quantity + ri.quantity,
           version = p.version + 1,
           updated_at = now()
       FROM reservation_items ri
       WHERE ri.reservation_id = $1 AND ri.product_id = p.id`,
      [reservation.id],
    );
  }
}

export async function createReservation(client: PoolClient, input: ReservationInput) {
  await expireReservations(client);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [input.idempotencyKey]);

  const previous = await client.query<{
    id: string;
    user_id: string;
    status: string;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT id, user_id, status, expires_at, created_at
     FROM reservations WHERE idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (previous.rowCount) {
    const existing = previous.rows[0];
    if (!existing)
      throw new AppError(500, 'INTERNAL_ERROR', 'Unable to load existing reservation.');
    if (existing.user_id !== input.userId) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key is already in use.');
    }
    return existing;
  }

  const quantities = new Map<string, number>();
  for (const item of input.items) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }
  const productIds = [...quantities.keys()].sort();
  const inventory = await client.query<{ id: string; available_quantity: number; active: boolean }>(
    `SELECT id, available_quantity, active
     FROM products
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR UPDATE`,
    [productIds],
  );

  if (inventory.rowCount !== productIds.length) {
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'One or more products do not exist.');
  }
  for (const product of inventory.rows) {
    const requested = quantities.get(product.id) ?? 0;
    if (!product.active || product.available_quantity < requested) {
      throw new AppError(409, 'INSUFFICIENT_INVENTORY', 'One or more products are unavailable.');
    }
  }

  const created = await client.query<{
    id: string;
    status: string;
    expires_at: Date;
    created_at: Date;
  }>(
    `INSERT INTO reservations (user_id, idempotency_key, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')
     RETURNING id, status, expires_at, created_at`,
    [input.userId, input.idempotencyKey],
  );
  const reservation = created.rows[0];
  if (!reservation) throw new AppError(500, 'INTERNAL_ERROR', 'Unable to create reservation.');

  for (const productId of productIds) {
    const quantity = quantities.get(productId);
    await client.query(
      `INSERT INTO reservation_items (reservation_id, product_id, quantity) VALUES ($1, $2, $3)`,
      [reservation.id, productId, quantity],
    );
    await client.query(
      `UPDATE products
       SET available_quantity = available_quantity - $1, version = version + 1, updated_at = now()
       WHERE id = $2`,
      [quantity, productId],
    );
  }

  return reservation;
}

export async function releaseReservation(
  client: PoolClient,
  reservationId: string,
  status: 'cancelled' | 'expired',
) {
  const changed = await client.query<{ id: string }>(
    `UPDATE reservations SET status = $2, updated_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [reservationId, status],
  );
  if (!changed.rowCount) return false;

  await client.query(
    `UPDATE products p
     SET available_quantity = p.available_quantity + ri.quantity,
         version = p.version + 1,
         updated_at = now()
     FROM reservation_items ri
     WHERE ri.reservation_id = $1 AND ri.product_id = p.id`,
    [reservationId],
  );
  return true;
}
