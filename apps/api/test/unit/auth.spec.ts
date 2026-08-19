import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const app = buildApp();

afterAll(async () => {
  await app.close();
});

describe('authentication tokens', () => {
  it('includes an expiry claim in tokens issued by the API', async () => {
    await app.ready();
    const token = app.jwt.sign({
      id: '2cf6d964-cd2d-4a11-a3c7-4f8b7a3d5a99',
      email: 'customer@example.com',
      role: 'customer',
    });
    const payload = app.jwt.decode<{ exp?: number }>(token);

    expect(payload.exp).toBeTypeOf('number');
  });
});
