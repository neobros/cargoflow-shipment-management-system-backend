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

  /**
   * Notification transports.
   *
   * Both default to `log`, so a fresh clone runs the whole notification path —
   * templates, queue, dispatcher, retries — without an account anywhere. What
   * a customer would have received is written to the console and stored, and
   * the boot log says plainly that nothing left the building.
   */
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().default('CargoFlow <no-reply@cargoflow.example>'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  SMS_TRANSPORT: z.enum(['log', 'twilio']).default('log'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_FROM: z.string().default(''),
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
