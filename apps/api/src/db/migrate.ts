import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';

const migrationName = '001_initial_schema';
const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
const schema = await readFile(schemaPath, 'utf8');

await pool.query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
);
const applied = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [
  migrationName,
]);
if (!applied.rowCount) {
  await pool.query('BEGIN');
  try {
    await pool.query(schema);
    await pool.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [migrationName]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}
await pool.end();
