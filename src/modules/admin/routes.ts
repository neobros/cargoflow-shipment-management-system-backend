import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { requireStaff } from '../auth/routes.js';
import { getActiveRateCard } from '../pricing/repository.js';
import { formatMinor } from '../../shared/units.js';
import {
  buildOverview,
  findAdjustments,
  listBookings,
  remindAboutAdjustment,
  settleAdjustment,
} from './service.js';

export const adminRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/v1/admin/overview', { preHandler: requireStaff('admin:access') }, async () =>
    buildOverview(),
  );

  app.get('/v1/admin/bookings', { preHandler: requireStaff('bookings:read') }, async () => ({
    bookings: await listBookings(),
  }));

  app.get('/v1/admin/adjustments', { preHandler: requireStaff('adjustments:read') }, async () => ({
    adjustments: await findAdjustments(),
  }));

  /**
   * Approve a price change on the customer's behalf.
   *
   * Legitimate — people phone in, people cannot get online — but it is never
   * allowed to look like the customer clicked the button themselves, so a
   * reason is mandatory and the actor is recorded on the event.
   */
  app.post(
    '/v1/admin/adjustments/:reference/approve',
    { preHandler: requireStaff('adjustments:approve') },
    async (request) => {
      const params = z.object({ reference: z.string().min(3) }).parse(request.params);
      const body = z
        .object({ reason: z.string().trim().min(4, 'Say why you are approving this') })
        .safeParse(request.body);

      if (!body.success) {
        throw new AppError(
          'An override needs a reason — it goes on the record and the customer is told',
          'reason_required',
          400,
          body.error.flatten(),
        );
      }

      const result = await settleAdjustment(params.reference, 'approved', request.staff!, body.data.reason);
      return { adjustment: { reference: result.reference, state: result.state } };
    },
  );

  /** Absorb the difference. The customer pays what they were originally quoted. */
  app.post(
    '/v1/admin/adjustments/:reference/waive',
    { preHandler: requireStaff('adjustments:waive') },
    async (request) => {
      const params = z.object({ reference: z.string().min(3) }).parse(request.params);
      const body = z
        .object({ reason: z.string().trim().min(4, 'Say why you are waiving this') })
        .safeParse(request.body);

      if (!body.success) {
        throw new AppError(
          'A waiver needs a reason — it goes on the record',
          'reason_required',
          400,
          body.error.flatten(),
        );
      }

      const result = await settleAdjustment(params.reference, 'waived', request.staff!, body.data.reason);
      return { adjustment: { reference: result.reference, state: result.state } };
    },
  );

  /** Nudge the customer again. Any staff role may do this; it costs nothing. */
  app.post(
    '/v1/admin/adjustments/:reference/remind',
    { preHandler: requireStaff('adjustments:remind') },
    async (request) => {
      const params = z.object({ reference: z.string().min(3) }).parse(request.params);
      return remindAboutAdjustment(params.reference, request.staff!);
    },
  );

  app.get('/v1/admin/rate-card', { preHandler: requireStaff('rates:read') }, async () => {
    const card = await getActiveRateCard();
    return {
      version: card.version,
      currency: card.currency,
      effectiveFrom: card.effectiveFrom,
      lanes: card.lanes.map((lane) => ({
        lane: lane.lane,
        service: lane.service,
        rate: formatMinor(lane.rate),
        minimumQuantity: lane.minimumQuantity,
        transit: { min: lane.transitDaysMin, max: lane.transitDaysMax },
      })),
      surcharges: Object.fromEntries(
        Object.entries(card.surcharges).map(([key, value]) => [
          key,
          typeof value === 'number' && key.startsWith('oversize') && !key.endsWith('Piece')
            ? value
            : formatMinor(Number(value)),
        ]),
      ),
      cover: { percent: (card.cover.basisPoints / 100).toFixed(1), minimum: formatMinor(card.cover.minimum) },
      taxPercent: (card.taxBasisPoints / 100).toFixed(0),
      tolerance: {
        percent: (card.rerateTolerance.basisPoints / 100).toFixed(0),
        minimum: formatMinor(card.rerateTolerance.minimum),
        hardStopPercent: (card.rerateTolerance.hardStopBasisPoints / 100).toFixed(0),
        autoApproveAfterDays: card.rerateTolerance.autoApproveAfterDays,
      },
    };
  });
};
