import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { pool, transaction } from '../../src/db/client.js';
import { AppError } from '../../src/errors.js';
import {
  createReservation,
  expireReservations,
  releaseReservation,
} from '../../src/reservations.js';

const createdUserIds: string[] = [];
const createdProductIds: string[] = [];

async function createUser() {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
    [`integration-${randomUUID()}@example.com`, 'not-used-by-reservation-tests'],
  );
  const user = result.rows[0];
  if (!user) throw new Error('Unable to create integration-test user.');
  createdUserIds.push(user.id);
  return user;
}

async function createProduct(availableQuantity: number) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO products (name, available_quantity) VALUES ($1, $2) RETURNING id`,
    [`Integration product ${randomUUID()}`, availableQuantity],
  );
  const product = result.rows[0];
  if (!product) throw new Error('Unable to create integration-test product.');
  createdProductIds.push(product.id);
  return product;
}

async function availableQuantity(productId: string) {
  const result = await pool.query<{ available_quantity: number }>(
    `SELECT available_quantity FROM products WHERE id = $1`,
    [productId],
  );
  return result.rows[0]?.available_quantity;
}

afterEach(async () => {
  if (createdUserIds.length) {
    await pool.query(
      `DELETE FROM reservation_items WHERE reservation_id IN (SELECT id FROM reservations WHERE user_id = ANY($1::uuid[]))`,
      [createdUserIds],
    );
    await pool.query(`DELETE FROM reservations WHERE user_id = ANY($1::uuid[])`, [createdUserIds]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
  }
  if (createdProductIds.length) {
    await pool.query(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [createdProductIds]);
  }
  createdUserIds.length = 0;
  createdProductIds.length = 0;
});

describe('PostgreSQL reservation integration', () => {
  it('gives exactly one concurrent customer the final unit', async () => {
    const [firstCustomer, secondCustomer] = await Promise.all([createUser(), createUser()]);
    const product = await createProduct(1);

    const outcomes = await Promise.allSettled([
      transaction((client) =>
        createReservation(client, {
          userId: firstCustomer.id,
          idempotencyKey: randomUUID(),
          items: [{ productId: product.id, quantity: 1 }],
        }),
      ),
      transaction((client) =>
        createReservation(client, {
          userId: secondCustomer.id,
          idempotencyKey: randomUUID(),
          items: [{ productId: product.id, quantity: 1 }],
        }),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')?.reason).toMatchObject({
      code: 'INSUFFICIENT_INVENTORY',
    } satisfies Partial<AppError>);
    expect(await availableQuantity(product.id)).toBe(0);
  });

  it('does not create a partial reservation when one product is unavailable', async () => {
    const customer = await createUser();
    const [availableProduct, unavailableProduct] = await Promise.all([
      createProduct(1),
      createProduct(0),
    ]);

    await expect(
      transaction((client) =>
        createReservation(client, {
          userId: customer.id,
          idempotencyKey: randomUUID(),
          items: [
            { productId: availableProduct.id, quantity: 1 },
            { productId: unavailableProduct.id, quantity: 1 },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });

    expect(await availableQuantity(availableProduct.id)).toBe(1);
    expect(await availableQuantity(unavailableProduct.id)).toBe(0);
  });

  it('returns the original reservation for an idempotent retry without deducting stock twice', async () => {
    const customer = await createUser();
    const product = await createProduct(2);
    const idempotencyKey = randomUUID();
    const input = {
      userId: customer.id,
      idempotencyKey,
      items: [{ productId: product.id, quantity: 1 }],
    };

    const first = await transaction((client) => createReservation(client, input));
    const retry = await transaction((client) => createReservation(client, input));

    expect(retry.id).toBe(first.id);
    expect(await availableQuantity(product.id)).toBe(1);
  });

  it('returns inventory exactly once for cancellation and expiry', async () => {
    const customer = await createUser();
    const product = await createProduct(2);
    const reservation = await transaction((client) =>
      createReservation(client, {
        userId: customer.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: product.id, quantity: 1 }],
      }),
    );

    await transaction((client) => releaseReservation(client, reservation.id, 'cancelled'));
    await transaction((client) => releaseReservation(client, reservation.id, 'cancelled'));
    expect(await availableQuantity(product.id)).toBe(2);

    const expiringReservation = await transaction((client) =>
      createReservation(client, {
        userId: customer.id,
        idempotencyKey: randomUUID(),
        items: [{ productId: product.id, quantity: 1 }],
      }),
    );
    await pool.query(
      `UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [expiringReservation.id],
    );
    await transaction(expireReservations);
    await transaction(expireReservations);

    expect(await availableQuantity(product.id)).toBe(2);
  });
});
