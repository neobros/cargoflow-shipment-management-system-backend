import type { FastifyInstance } from 'fastify';
import { badRequest } from '../../shared/errors.js';
import { CreateBooking, createBooking, previewTrackingIds } from './service.js';

export const bookingRoutes = async (app: FastifyInstance): Promise<void> => {
  /**
   * Requirements 1.1, 1.2 and 1.3 land here together: the pieces the customer
   * chose, both parties in full, and the submission itself.
   *
   * Public and unauthenticated, like the quote that precedes it. Requiring an
   * account before a stranger can send a box loses the booking; the mobile
   * number in the sender block is the identity, and it is verified by the fact
   * that the tracking link and the price-change SMS both go to it.
   */
  app.post('/v1/bookings', async (request, reply) => {
    const parsed = CreateBooking.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest(
        'Some details are missing or do not look right',
        'invalid_booking',
        parsed.error.flatten(),
      );
    }

    const booking = await createBooking(parsed.data);
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
