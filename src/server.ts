import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { pricingRoutes } from './modules/pricing/routes.js';
import { shipmentRoutes } from './modules/shipments/routes.js';
import { AppError } from './shared/errors.js';

export const buildServer = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: env.isProduction
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
    // Every request carries an id through its logs, and through any job it
    // enqueues, so one customer's journey can be followed across retries.
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : true,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 240,
    timeWindow: '1 minute',
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn({ code: error.code, details: error.details }, error.message);
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation_failed', message: 'Request body is not valid', details: error.flatten() },
      });
    }

    // Fastify's own errors (rate limit, body parsing) carry a statusCode.
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code ?? 'request_failed',
          message: fastifyError.message ?? 'Request failed',
          details: null,
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        // Never leak a stack trace or a driver message to a browser.
        message: 'Something went wrong on our side. The team has been notified.',
        details: null,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'route_not_found', message: `No route for ${request.method} ${request.url}`, details: null },
    }),
  );

  app.get('/health', async () => ({
    status: 'ok',
    service: 'cargoflow-backend',
    version: '0.1.0',
    time: new Date().toISOString(),
  }));

  await app.register(pricingRoutes);
  await app.register(shipmentRoutes);

  return app;
};
