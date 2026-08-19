import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

export type Role = 'customer' | 'admin';

export type AuthUser = {
  id: string;
  role: Role;
  email: string;
};

export async function requireUser(request: FastifyRequest): Promise<AuthUser> {
  try {
    await request.jwtVerify();
    return request.user as AuthUser;
  } catch {
    throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  }
}

export async function requireAdmin(request: FastifyRequest): Promise<AuthUser> {
  const user = await requireUser(request);
  if (user.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Administrator access is required.');
  }
  return user;
}
