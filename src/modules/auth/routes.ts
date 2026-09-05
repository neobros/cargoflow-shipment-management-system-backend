import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { login, logout, resolveSession } from './service.js';
import {
  PERMISSION_LABELS,
  SESSION_COOKIE,
  ROLE_LABELS,
  can,
  toCurrentUser,
  type Permission,
  type StaffDoc,
} from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    staff?: StaffDoc;
  }
}

/**
 * Attach the signed-in staff member to the request, if there is one.
 * Runs on every request; it does not reject anything by itself.
 */
export const attachStaff = async (request: FastifyRequest): Promise<void> => {
  const token = request.cookies[SESSION_COOKIE];
  const account = await resolveSession(token);
  if (account) request.staff = account;
};

/** Guard a route. `requireStaff('adjustments:approve')` reads as it behaves. */
export const requireStaff =
  (...permissions: Permission[]) =>
  async (request: FastifyRequest): Promise<void> => {
    if (!request.staff) {
      throw new AppError('Please sign in', 'not_authenticated', 401);
    }
    for (const permission of permissions) {
      if (!can(request.staff.role, permission)) {
        // Say which permission is missing. An operator hitting an approve
        // button should be told they cannot approve, not shown a blank 403.
        throw new AppError(
          // "A billing cannot..." reads as broken English, because two of the
          // four role names are job titles and two are departments. Address the
          // person instead of naming their role in the third person.
          `Your role (${ROLE_LABELS[request.staff.role]}) cannot ${PERMISSION_LABELS[permission]}`,
          'forbidden',
          403,
          { required: permission, role: request.staff.role },
        );
      }
    }
  };

const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: Date): void => {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    expires: expiresAt,
  });
};

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/v1/auth/login', async (request, reply) => {
    const Body = z.object({
      email: z.string().email('That does not look like an email address'),
      password: z.string().min(1, 'Enter your password'),
    });

    const parsed = Body.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('Check your email and password', 'invalid_login', 400, parsed.error.flatten());
    }

    const result = await login(parsed.data.email, parsed.data.password, {
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });

    setSessionCookie(reply, result.token, result.expiresAt);
    request.log.info({ email: result.staff.email, role: result.staff.role }, 'Staff signed in');

    return { user: toCurrentUser(result.staff) };
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    await logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Who am I? The app calls this to decide what to render. */
  app.get('/v1/auth/me', async (request) => {
    if (!request.staff) {
      throw new AppError('Not signed in', 'not_authenticated', 401);
    }
    return { user: toCurrentUser(request.staff) };
  });
};
