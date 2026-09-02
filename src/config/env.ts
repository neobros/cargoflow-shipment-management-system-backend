import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** Empty in development means "boot an in-memory MongoDB for me". */
  MONGODB_URI: z.string().default(''),
  MONGODB_DB: z.string().default('cargoflow'),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment:\n' + JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

if (env.isProduction && !env.MONGODB_URI) {
  console.error('MONGODB_URI is required in production — refusing to start on an in-memory database.');
  process.exit(1);
}
