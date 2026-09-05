import type { FastifyInstance } from 'fastify';
import { badRequest } from '../../shared/errors.js';
import { requireCustomer } from '../customers/routes.js';
import { CreateBooking, createBooking, previewTrackingIds } from './service.js';

export const bookingRoutes = async (app: FastifyInstance): Promise<void> => {
  /**
   * Requirements 1.1, 1.2 and 1.3 land here together: the pieces the customer
   * chose, both parties in full, and the submission itself.
   *
   * Requires a signed-in customer. The quote before it stays public — anyone
   * can price a shipment without identifying themselves — but the booking is
   * attached to an account, so "my shipments" and "my invoices" can be scoped
   * by the session rather than by a reference anyone could guess.
   *
   * The sender block is still asked for separately, because the person paying
   * is not always the person whose door the boxes are collected from.
   */
  app.post('/v1/bookings', { preHandler: requireCustomer }, async (request, reply) => {
    const parsed = CreateBooking.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Some details are missing or do not look right',
        'invalid_booking',
        parsed.error.flatten(),
      );
    }

    const booking = await createBooking(parsed.data, request.customer!);
    reply.code(201);
    return {
      booking,
      // Shown on the confirmation as what will be on each label, so the
      // customer can write them on the boxes before dropping them off. They
      // are not live until the depot receives the box.
      labelsToExpect: previewTrackingIds(booking.reference, booking.pieceCount),
    };
  });
};
