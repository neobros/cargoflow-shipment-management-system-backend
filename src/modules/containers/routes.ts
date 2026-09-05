import type { FastifyInstance, FastifyRequest } from 'fastify';
import { badRequest } from '../../shared/errors.js';
import { requireStaff } from '../auth/routes.js';
import { bolPdf } from '../documents/pdf.js';
import { buildBol } from '../documents/service.js';
import {
  CreateContainer,
  createContainer,
  getContainer,
  listContainers,
  LoadInput,
  loadPieces,
  SealInput,
  sealContainer,
  type Actor,
} from './service.js';

const actorFrom = (request: FastifyRequest): Actor => ({
  name: request.staff?.name ?? 'unknown',
  workstation: (request.headers['x-workstation'] as string | undefined)?.slice(0, 24) ?? 'WS-03',
});

export const containerRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/v1/containers', { preHandler: requireStaff('containers:read') }, async () =>
    listContainers(),
  );

  app.get<{ Params: { containerNumber: string } }>(
    '/v1/containers/:containerNumber',
    { preHandler: requireStaff('containers:read') },
    async (request) => getContainer(decodeURIComponent(request.params.containerNumber)),
  );

  app.post('/v1/containers', { preHandler: requireStaff('containers:manage') }, async (request) => {
    const parsed = CreateContainer.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('That container does not look right', 'invalid_container', parsed.error.flatten());
    }
    return { container: await createContainer(parsed.data) };
  });

  /** 2.3 — group boxes into the container. */
  app.post<{ Params: { containerNumber: string } }>(
    '/v1/containers/:containerNumber/load',
    { preHandler: requireStaff('containers:load') },
    async (request) => {
      const parsed = LoadInput.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Tell me which boxes to load', 'invalid_load', parsed.error.flatten());
      }
      return loadPieces(
        decodeURIComponent(request.params.containerNumber),
        parsed.data,
        actorFrom(request),
      );
    },
  );

  /**
   * Sealing is irreversible, so it needs more than the operator who loaded it —
   * the same separation that keeps measuring apart from pricing.
   */
  app.post<{ Params: { containerNumber: string } }>(
    '/v1/containers/:containerNumber/seal',
    { preHandler: requireStaff('containers:seal') },
    async (request) => {
      const parsed = SealInput.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('A seal number is required', 'invalid_seal', parsed.error.flatten());
      }
      return {
        container: await sealContainer(
          decodeURIComponent(request.params.containerNumber),
          parsed.data,
          actorFrom(request),
        ),
      };
    },
  );

  /**
   * 3.2 — the Master Bill of Lading for this container.
   *
   * Not `containers:read`: the bill names every shipper and consignee with
   * their full address, which is more than someone who only loads boxes needs
   * to see.
   */
  app.get<{ Params: { containerNumber: string } }>(
    '/v1/containers/:containerNumber/bol',
    { preHandler: requireStaff('documents:read') },
    async (request) => ({ bol: await buildBol(decodeURIComponent(request.params.containerNumber)) }),
  );

  /** The same bill as a file, for the carrier and the customs broker. */
  app.get<{ Params: { containerNumber: string } }>(
    '/v1/containers/:containerNumber/bol.pdf',
    { preHandler: requireStaff('documents:read') },
    async (request, reply) => {
      const bol = await buildBol(decodeURIComponent(request.params.containerNumber));
      reply
        .type('application/pdf')
        .header('content-disposition', `attachment; filename="${bol.number}.pdf"`);
      return bolPdf(bol);
    },
  );
};
