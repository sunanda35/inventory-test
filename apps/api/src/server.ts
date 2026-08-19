import { buildApp } from './app.js';
import { config } from './config.js';
import { pool, transaction } from './db/client.js';
import { expireReservations } from './reservations.js';

const app = buildApp();
const expiryTimer = setInterval(() => {
  transaction(expireReservations).catch((error: unknown) =>
    app.log.error(error, 'Reservation expiry failed'),
  );
}, 60_000);

const close = async () => {
  clearInterval(expiryTimer);
  await app.close();
  await pool.end();
};

process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

await app.listen({ port: config.PORT, host: '0.0.0.0' });
