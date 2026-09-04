import type { FastifyInstance } from 'fastify';
import { formatMinor } from '../../shared/units.js';
import { requireStaff } from '../auth/routes.js';
import * as notifications from '../notifications/service.js';
import {
  findInvoice,
  findInvoiceForBooking,
  issueInvoice,
  listInvoices,
  markInvoicePaid,
  type InvoiceDoc,
} from './service.js';

const present = (invoice: InvoiceDoc) => ({
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
  rateCardVersion: invoice.rateCardVersion,
  status: invoice.status,
  issuedAt: invoice.issuedAt.toISOString(),
  dueAt: invoice.dueAt.toISOString(),
  paidAt: invoice.paidAt?.toISOString() ?? null,
  issuedBy: invoice.issuedBy,
  overdue: invoice.status === 'issued' && invoice.dueAt < new Date(),
});

export const documentRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/v1/invoices', { preHandler: requireStaff('invoices:issue') }, async () => ({
    invoices: (await listInvoices()).map(present),
  }));

  app.get<{ Params: { number: string } }>(
    '/v1/invoices/:number',
    { preHandler: requireStaff('invoices:issue') },
    async (request) => ({ invoice: present(await findInvoice(request.params.number)) }),
  );

  /**
   * 3.1 — cut the invoice. Issuing is a billing action, not a depot one, and
   * the service refuses outright while a price change is unapproved.
   */
  app.post<{ Params: { reference: string } }>(
    '/v1/bookings/:reference/invoice',
    { preHandler: requireStaff('invoices:issue') },
    async (request, reply) => {
      const invoice = await issueInvoice(request.params.reference, request.staff?.name ?? 'system');
      reply.code(201);
      return { invoice: present(invoice) };
    },
  );

  app.post<{ Params: { number: string } }>(
    '/v1/invoices/:number/paid',
    { preHandler: requireStaff('invoices:issue') },
    async (request) => ({ invoice: present(await markInvoicePaid(request.params.number)) }),
  );

  app.get<{ Params: { reference: string } }>(
    '/v1/bookings/:reference/invoice',
    { preHandler: requireStaff('bookings:read') },
    async (request) => {
      const invoice = await findInvoiceForBooking(request.params.reference);
      return { invoice: invoice ? present(invoice) : null };
    },
  );

  /**
   * 3.1 — the message log. What was sent, to whom, on which channel and
   * whether it got through. A customer saying "you never told me" is answered
   * from here.
   */
  app.get('/v1/notifications', { preHandler: requireStaff('adjustments:read') }, async (request) => {
    const query = request.query as { bookingRef?: string };
    const rows = query.bookingRef
      ? await notifications.listForBooking(query.bookingRef.toUpperCase())
      : await notifications.listRecent();

    return {
      notifications: rows.map((row) => ({
        event: row.event,
        channel: row.channel,
        to: row.to,
        subject: row.subject,
        body: row.body,
        bookingRef: row.bookingRef,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
    };
  });
};
