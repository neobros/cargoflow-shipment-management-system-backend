import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { AppError, badRequest } from '../../shared/errors.js';
import { formatMinor } from '../../shared/units.js';
import { invoicePdf } from '../documents/pdf.js';
import {
  changePassword,
  currentCustomer,
  invoiceFor,
  invoicesFor,
  register,
  resolveCustomerSession,
  shipmentsFor,
  signIn,
  signOut,
} from './service.js';
import {
  CUSTOMER_SESSION_COOKIE,
  RegisterInput,
  SignInInput,
  type CustomerDoc,
} from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    customer?: CustomerDoc;
  }
}

/**
 * Attach the customer to every request that carries the cookie. Runs alongside
 * `attachStaff` and never interferes with it — a person can be both a customer
 * at home and a staff member at work, on the same browser, and neither session
 * should evict the other.
 */
export const attachCustomer = async (request: FastifyRequest): Promise<void> => {
  const token = request.cookies[CUSTOMER_SESSION_COOKIE];
  const customer = await resolveCustomerSession(token);
  if (customer) request.customer = customer;
};

/** Guard a route that belongs to a signed-in customer. */
export const requireCustomer = async (request: FastifyRequest): Promise<void> => {
  if (!request.customer) {
    throw new AppError('Please sign in to continue', 'not_authenticated', 401);
  }
};

const setCookie = (reply: FastifyReply, token: string, expiresAt: Date): void => {
  reply.setCookie(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    expires: expiresAt,
  });
};

const context = (request: FastifyRequest) => ({
  userAgent: request.headers['user-agent'],
  ip: request.ip,
});

export const customerRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/v1/customer/register', async (request, reply) => {
    const parsed = RegisterInput.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Check the details and try again',
        'invalid_registration',
        parsed.error.flatten(),
      );
    }

    const result = await register(parsed.data, context(request));
    setCookie(reply, result.token, result.expiresAt);
    reply.code(201);
    return { customer: currentCustomer(result.customer) };
  });

  app.post('/v1/customer/sign-in', async (request, reply) => {
    const parsed = SignInInput.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Enter your email and password', 'invalid_sign_in');
    }

    const result = await signIn(parsed.data, context(request));
    setCookie(reply, result.token, result.expiresAt);
    return { customer: currentCustomer(result.customer) };
  });

  app.post('/v1/customer/sign-out', async (request, reply) => {
    await signOut(request.cookies[CUSTOMER_SESSION_COOKIE]);
    reply.clearCookie(CUSTOMER_SESSION_COOKIE, { path: '/' });
    return { signedOut: true };
  });

  /** Who am I? Returns null rather than 401 — the browser has to ask to find out. */
  app.get('/v1/customer/me', async (request) => ({
    customer: request.customer ? currentCustomer(request.customer) : null,
  }));

  app.post('/v1/customer/password', { preHandler: requireCustomer }, async (request) => {
    const body = request.body as { current?: string; next?: string } | undefined;
    if (!body?.current || !body?.next) {
      throw badRequest('Enter your current and new password', 'invalid_password_change');
    }
    await changePassword(request.customer!, body.current, body.next);
    return { changed: true };
  });

  /** Their shipments. Scoped by the session, never by anything in the request. */
  app.get('/v1/customer/shipments', { preHandler: requireCustomer }, async (request) => ({
    shipments: await shipmentsFor(request.customer!._id!),
  }));

  app.get('/v1/customer/invoices', { preHandler: requireCustomer }, async (request) => ({
    invoices: (await invoicesFor(request.customer!.reference)).map((invoice) => ({
      number: invoice.number,
      bookingRef: invoice.bookingRef,
      currency: invoice.currency,
      total: formatMinor(invoice.total),
      status: invoice.status,
      issuedAt: invoice.issuedAt.toISOString(),
      dueAt: invoice.dueAt.toISOString(),
      paidAt: invoice.paidAt?.toISOString() ?? null,
      overdue: invoice.status === 'issued' && invoice.dueAt < new Date(),
    })),
  }));

  /** Their own invoice as a PDF, scoped by the session like everything else. */
  app.get<{ Params: { number: string } }>(
    '/v1/customer/invoices/:number/pdf',
    { preHandler: requireCustomer },
    async (request, reply) => {
      const invoice = await invoiceFor(request.customer!.reference, request.params.number);
      reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${invoice.number}.pdf"`);
      return invoicePdf(invoice);
    },
  );

  /** Requirement 7.1: the customer invoice page. */
  app.get<{ Params: { number: string } }>(
    '/v1/customer/invoices/:number',
    { preHandler: requireCustomer },
    async (request) => {
      const invoice = await invoiceFor(request.customer!.reference, request.params.number);
      return {
        invoice: {
          number: invoice.number,
          bookingRef: invoice.bookingRef,
          customerRef: invoice.customerRef,
          customerName: invoice.customerName,
          billTo: invoice.billTo,
          currency: invoice.currency,
          lines: invoice.lines.map((line) => ({
            code: line.code,
            label: line.label,
            basis: line.basis,
            amount: formatMinor(line.amount),
          })),
          subtotal: formatMinor(invoice.subtotal),
          tax: formatMinor(invoice.tax),
          total: formatMinor(invoice.total),
          totalMinor: invoice.total,
          basis: invoice.basis,
          adjustment: invoice.adjustment
            ? {
                reference: invoice.adjustment.reference,
                bookedTotal: formatMinor(invoice.adjustment.bookedTotal),
                difference: formatMinor(invoice.adjustment.difference),
                differencePercent: invoice.adjustment.differencePercent,
                settledAs: invoice.adjustment.settledAs,
                settledAt: invoice.adjustment.settledAt?.toISOString() ?? null,
              }
            : null,
          rateCardVersion: invoice.rateCardVersion,
          status: invoice.status,
          issuedAt: invoice.issuedAt.toISOString(),
          dueAt: invoice.dueAt.toISOString(),
          paidAt: invoice.paidAt?.toISOString() ?? null,
          issuedBy: invoice.issuedBy,
          overdue: invoice.status === 'issued' && invoice.dueAt < new Date(),
        },
      };
    },
  );
};
