import { hash } from 'bcryptjs';
import { pool } from './client.js';

const passwordHash = await hash('Password123!', 12);

await pool.query(
  `INSERT INTO users (email, password_hash, role)
   VALUES
     ($1, $2, 'admin'),
     ($3, $2, 'customer'),
     ($4, $2, 'customer'),
     ($5, $2, 'customer')
   ON CONFLICT (email) DO NOTHING`,
  [
    'admin@example.com',
    passwordHash,
    'customer@example.com',
    'customer.two@example.com',
    'customer.three@example.com',
  ],
);

await pool.query(
  `INSERT INTO products (name, description, available_quantity)
   SELECT item.name, item.description, item.quantity
   FROM (VALUES
     ('Mechanical Keyboard', 'Compact keyboard with tactile switches.', 12),
     ('Wireless Mouse', 'Ergonomic mouse for daily work.', 8),
     ('USB-C Dock', 'Dock with display and USB expansion.', 4)
   ) AS item(name, description, quantity)
   WHERE NOT EXISTS (SELECT 1 FROM products)`,
);

await pool.end();
