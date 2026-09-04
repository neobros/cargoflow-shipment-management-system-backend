import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest } from '../../shared/errors.js';
import { requireStaff } from '../auth/routes.js';
import {
  depotQueue,
  labelFor,
  lookupPiece,
  markLabelled,
  ReceiveInput,
  receiveBooking,
  VerifyInput,
  verifyPiece,
  WalkInInput,
  walkIn,
  type Actor,
} from './service.js';

/**
 * Who did it and where. Every depot write is attributed — a disputed
 * measurement three weeks later is answered by the audit trail, and an
 * unattributed one is not answerable at all.
 */
const actorFrom = (request: FastifyRequest): Actor => ({
  name: request.staff?.name ?? 'unknown',
  workstation: (request.headers['x-workstation'] as string | undefined)?.slice(0, 24) ?? 'WS-03',
});

const parse = <T extends { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { flatten: () => unknown } } }>(
  schema: T,
  body: unknown,
  message: string,
  code: string,
) => {
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest(message, code, result.error!.flatten());
  return result.data as never;
};

export const depotRoutes = async (app: FastifyInstance): Promise<void> => {
  /** What is on the floor. */
  app.get('/v1/depot/queue', { preHandler: requireStaff('depot:receive') }, async () => depotQueue());

  /** One scan, everything about that box. */
  app.get<{ Params: { trackingId: string } }>(
    '/v1/depot/pieces/:trackingId',
    { preHandler: requireStaff('depot:receive') },
    async (request) => ({ piece: await lookupPiece(request.params.trackingId) }),
  );

  /** 2.1 — physical receipt mints the tracking IDs. */
  app.post<{ Params: { reference: string } }>(
    '/v1/depot/bookings/:reference/receive',
    { preHandler: requireStaff('depot:receive') },
    async (request) =>
      receiveBooking(
        request.params.reference,
        parse(ReceiveInput, request.body ?? {}, 'That receipt does not look right', 'invalid_receive'),
        actorFrom(request),
      ),
  );

  /** 2.1 + 2.2 — measure, and find out what it costs in the same breath. */
  app.post<{ Params: { trackingId: string } }>(
    '/v1/depot/pieces/:trackingId/verify',
    { preHandler: requireStaff('depot:verify') },
    async (request) =>
      verifyPiece(
        request.params.trackingId,
        parse(VerifyInput, request.body, 'Those measurements do not look right', 'invalid_measurement'),
        actorFrom(request),
      ),
  );

  /** 2.2 — the label, barcode included. */
  app.get<{ Params: { trackingId: string } }>(
    '/v1/depot/pieces/:trackingId/label',
    { preHandler: requireStaff('depot:label') },
    async (request) => ({ label: await labelFor(request.params.trackingId) }),
  );

  app.post('/v1/depot/labels/printed', { preHandler: requireStaff('depot:label') }, async (request) => {
    const body = request.body as { trackingIds?: string[] } | undefined;
    if (!Array.isArray(body?.trackingIds) || body.trackingIds.length === 0) {
      throw badRequest('Tell me which labels were printed', 'no_tracking_ids');
    }
    return { labelled: await markLabelled(body.trackingIds, actorFrom(request)) };
  });

  /** 2.1 — the counter. Minimum data, boxes measured on the spot. */
  app.post('/v1/depot/walk-in', { preHandler: requireStaff('depot:verify') }, async (request) =>
    walkIn(
      parse(WalkInInput, request.body, 'That walk-in does not look right', 'invalid_walk_in'),
      actorFrom(request),
    ),
  );
};
