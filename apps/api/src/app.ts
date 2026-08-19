import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { compare, hash } from 'bcryptjs';
import Fastify from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireUser, type AuthUser } from './auth.js';
import { config } from './config.js';
import { pool, transaction } from './db/client.js';
import { AppError } from './errors.js';
import { createReservation, expireReservations, releaseReservation } from './reservations.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: AuthUser;
  }
}

const id = z.string().uuid();
const credentials = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});
const items = z
  .array(z.object({ productId: id, quantity: z.number().int().positive().max(1000) }))
  .min(1);

function serializeReservation(row: Record<string, unknown>) {
  return {
    id: row.id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    customerEmail: row.email,
    items: row.items,
  };
}

const reservationSelect = `
  SELECT r.id, r.status, r.expires_at, r.created_at, u.email,
    COALESCE(json_agg(json_build_object('productId', ri.product_id, 'name', p.name, 'quantity', ri.quantity)
      ORDER BY p.name) FILTER (WHERE ri.product_id IS NOT NULL), '[]') AS items
  FROM reservations r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN reservation_items ri ON ri.reservation_id = r.id
  LEFT JOIN products p ON p.id = ri.product_id`;

export function buildApp() {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: config.WEB_ORIGIN });
  app.register(jwt, { secret: config.JWT_SECRET });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues[0]?.message ?? 'Invalid request.',
        },
      });
    }
    app.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/auth/register', async (request, reply) => {
    const body = credentials.parse(request.body);
    const passwordHash = await hash(body.password, 12);
    try {
      const result = await pool.query<{ id: string; email: string; role: 'customer' }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role`,
        [body.email.toLowerCase(), passwordHash],
      );
      const user = result.rows[0];
      if (!user) throw new AppError(500, 'INTERNAL_ERROR', 'Unable to create user.');
      return reply.status(201).send({ token: app.jwt.sign(user), user });
    } catch (error: unknown) {
      if ((error as { code?: string }).code === '23505')
        throw new AppError(409, 'EMAIL_EXISTS', 'An account with that email already exists.');
      throw error;
    }
  });

  app.post('/auth/login', async (request) => {
    const body = credentials.parse(request.body);
    const result = await pool.query<{
      id: string;
      email: string;
      role: 'customer' | 'admin';
      password_hash: string;
    }>(`SELECT id, email, role, password_hash FROM users WHERE email = $1`, [
      body.email.toLowerCase(),
    ]);
    const user = result.rows[0];
    if (!user || !(await compare(body.password, user.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    const safeUser: AuthUser = { id: user.id, email: user.email, role: user.role };
    return { token: app.jwt.sign(safeUser), user: safeUser };
  });

  app.get('/products', async () => {
    const products = await pool.query(
      `SELECT id, name, description, available_quantity AS "availableQuantity", version
       FROM products WHERE active = true ORDER BY name`,
    );
    return { products: products.rows };
  });

  app.post('/reservations', async (request, reply) => {
    const user = await requireUser(request);
    const body = z.object({ items, idempotencyKey: id }).parse(request.body);
    const reservation = await transaction((client) =>
      createReservation(client, { userId: user.id, ...body }),
    );
    return reply.status(201).send({ reservation });
  });

  app.get('/reservations', async (request) => {
    const user = await requireUser(request);
    const reservations = await transaction(async (client) => {
      await expireReservations(client);
      return client.query(
        `${reservationSelect} WHERE r.user_id = $1 GROUP BY r.id, u.email ORDER BY r.created_at DESC`,
        [user.id],
      );
    });
    return { reservations: reservations.rows.map(serializeReservation) };
  });

  app.post('/reservations/:id/confirm', async (request) => {
    const user = await requireUser(request);
    const reservationId = id.parse((request.params as { id: string }).id);
    const result = await transaction(async (client) => {
      await expireReservations(client);
      return client.query(
        `UPDATE reservations SET status = 'confirmed', updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id, status`,
        [reservationId, user.id],
      );
    });
    if (!result.rowCount)
      throw new AppError(409, 'RESERVATION_UNAVAILABLE', 'This reservation cannot be confirmed.');
    return { reservation: result.rows[0] };
  });

  app.post('/reservations/:id/cancel', async (request) => {
    const user = await requireUser(request);
    const reservationId = id.parse((request.params as { id: string }).id);
    const cancelled = await transaction(async (client) => {
      await expireReservations(client);
      const ownership = await client.query(
        `SELECT id FROM reservations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [reservationId, user.id],
      );
      if (!ownership.rowCount)
        throw new AppError(404, 'RESERVATION_NOT_FOUND', 'Reservation not found.');
      return releaseReservation(client, reservationId, 'cancelled');
    });
    if (!cancelled)
      throw new AppError(409, 'RESERVATION_UNAVAILABLE', 'This reservation cannot be cancelled.');
    return { reservation: { id: reservationId, status: 'cancelled' } };
  });

  app.get('/admin/products', async (request) => {
    await requireAdmin(request);
    const products = await pool.query(
      `SELECT id, name, description, available_quantity AS "availableQuantity", version, active FROM products ORDER BY name`,
    );
    return { products: products.rows };
  });

  app.post('/admin/products', async (request, reply) => {
    await requireAdmin(request);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(1000).default(''),
        availableQuantity: z.number().int().min(0).max(1_000_000),
      })
      .parse(request.body);
    const product = await pool.query(
      `INSERT INTO products (name, description, available_quantity) VALUES ($1, $2, $3)
       RETURNING id, name, description, available_quantity AS "availableQuantity", version, active`,
      [body.name, body.description, body.availableQuantity],
    );
    return reply.status(201).send({ product: product.rows[0] });
  });

  app.post('/admin/products/:id/stock-adjustments', async (request) => {
    const admin = await requireAdmin(request);
    const productId = id.parse((request.params as { id: string }).id);
    const body = z
      .object({
        quantityDelta: z
          .number()
          .int()
          .refine((value) => value !== 0),
        reason: z.string().trim().min(3).max(500),
      })
      .parse(request.body);
    const product = await transaction(async (client) => {
      const updated = await client.query(
        `UPDATE products SET available_quantity = available_quantity + $1, version = version + 1, updated_at = now()
         WHERE id = $2 AND available_quantity + $1 >= 0
         RETURNING id, name, available_quantity AS "availableQuantity", version`,
        [body.quantityDelta, productId],
      );
      if (!updated.rowCount)
        throw new AppError(
          409,
          'INVALID_STOCK_ADJUSTMENT',
          'This adjustment would make available inventory negative.',
        );
      await client.query(
        `INSERT INTO inventory_adjustments (product_id, admin_id, quantity_delta, reason) VALUES ($1, $2, $3, $4)`,
        [productId, admin.id, body.quantityDelta, body.reason],
      );
      return updated.rows[0];
    });
    return { product };
  });

  app.get('/admin/reservations', async (request) => {
    await requireAdmin(request);
    const reservations = await transaction(async (client) => {
      await expireReservations(client);
      return client.query(`${reservationSelect} GROUP BY r.id, u.email ORDER BY r.created_at DESC`);
    });
    return { reservations: reservations.rows.map(serializeReservation) };
  });

  return app;
}
