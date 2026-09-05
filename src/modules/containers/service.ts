import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { COLLECTIONS, collection, withTransaction } from '../../db/mongo.js';
import { badRequest, blockedByAdjustment, conflict, notFound } from '../../shared/errors.js';
import { formatVolume } from '../../shared/units.js';
import * as notifications from '../notifications/service.js';
import { LANES } from '../pricing/rate-cards.js';
import { nextContainerNumber } from '../shipments/sequences.js';
import {
  deriveBookingStatus,
  type AdjustmentDoc,
  type BookingDoc,
  type ContainerDoc,
  type PieceDoc,
  type PieceEventDoc,
} from '../shipments/types.js';

const bookings = () => collection<BookingDoc>(COLLECTIONS.bookings);
const pieces = () => collection<PieceDoc>(COLLECTIONS.pieces);
const containers = () => collection<ContainerDoc>(COLLECTIONS.containers);
const adjustments = () => collection<AdjustmentDoc>(COLLECTIONS.adjustments);
const events = () => collection<PieceEventDoc>(COLLECTIONS.pieceEvents);

export interface Actor {
  name: string;
  workstation: string;
}

/** Nominal internal capacity, in ten-thousandths of m³. */
const CONTAINER_TYPES = {
  '20ft standard': 330_000,
  '40ft standard': 670_000,
  '40ft high cube': 760_000,
} as const;

export type ContainerType = keyof typeof CONTAINER_TYPES;

const normalise = (number: string) => number.trim().toUpperCase().replace(/\s+/g, ' ');

// ── 2.3 The board ──────────────────────────────────────────────────────────

export interface ContainerSummary {
  containerNumber: string;
  type: string;
  vessel: string;
  voyage: string;
  lane: string;
  route: string;
  destinationLabel: string;
  status: ContainerDoc['status'];
  sealNumber: string | null;
  capacity: string;
  loaded: string;
  fillPercent: number;
  pieceCount: number;
  bookingCount: number;
  cutOffAt: string;
  sailsAt: string;
  etaAt: string;
}

const summarise = async (container: ContainerDoc): Promise<ContainerSummary> => {
  const loaded = await pieces().find({ containerId: container._id! }).toArray();
  const usedVolume = loaded.reduce(
    (total, piece) => total + (piece.verified ?? piece.declared).volume,
    0,
  );
  const lane = LANES.find((l) => l.code === container.lane);

  return {
    containerNumber: container.containerNumber,
    type: container.type,
    vessel: container.vessel,
    voyage: container.voyage,
    lane: container.lane,
    route: lane ? `${lane.from} → ${lane.to}` : container.lane,
    destinationLabel: container.destinationLabel,
    status: container.status,
    sealNumber: container.sealNumber,
    capacity: formatVolume(container.capacityVolume),
    loaded: formatVolume(usedVolume),
    fillPercent:
      container.capacityVolume === 0
        ? 0
        : Math.round((usedVolume / container.capacityVolume) * 100),
    pieceCount: loaded.length,
    bookingCount: new Set(loaded.map((p) => p.bookingRef)).size,
    cutOffAt: container.cutOffAt.toISOString(),
    sailsAt: container.sailsAt.toISOString(),
    etaAt: container.etaAt.toISOString(),
  };
};

export const listContainers = async (): Promise<{ containers: ContainerSummary[] }> => {
  const all = await containers().find({}).sort({ cutOffAt: 1 }).limit(50).toArray();
  return { containers: await Promise.all(all.map(summarise)) };
};

export const getContainer = async (
  containerNumber: string,
): Promise<{
  container: ContainerSummary;
  pieces: {
    trackingId: string;
    bookingRef: string;
    consignee: string;
    destination: string;
    packaging: string;
    volume: string;
    weightKg: string;
    status: string;
  }[];
}> => {
  const container = await containers().findOne({ containerNumber: normalise(containerNumber) });
  if (!container) throw notFound(`Container ${containerNumber}`, 'container_not_found');

  const loaded = await pieces().find({ containerId: container._id! }).sort({ bookingRef: 1, sequence: 1 }).toArray();

  return {
    container: await summarise(container),
    pieces: loaded.map((piece) => {
      const m = piece.verified ?? piece.declared;
      return {
        trackingId: piece.trackingId!,
        bookingRef: piece.bookingRef,
        consignee: piece.consigneeName,
        destination: piece.destination,
        packaging: piece.packaging.replace(/_/g, ' '),
        volume: formatVolume(m.volume),
        weightKg: (m.weightGrams / 1000).toFixed(1),
        status: piece.status,
      };
    }),
  };
};

export const CreateContainer = z.object({
  type: z.enum(['20ft standard', '40ft standard', '40ft high cube']),
  vessel: z.string().trim().min(2).max(80),
  voyage: z.string().trim().min(1).max(24),
  lane: z.string().min(3),
  cutOffAt: z.string().datetime(),
  sailsAt: z.string().datetime(),
  etaAt: z.string().datetime(),
  containerNumber: z.string().trim().max(24).optional(),
});

export const createContainer = async (
  input: z.infer<typeof CreateContainer>,
): Promise<ContainerSummary> => {
  const lane = LANES.find((l) => l.code === input.lane);
  if (!lane) throw badRequest(`We do not ship ${input.lane}`, 'unknown_lane');

  const sailsAt = new Date(input.sailsAt);
  const cutOffAt = new Date(input.cutOffAt);
  const etaAt = new Date(input.etaAt);

  // A cut-off after the sailing means boxes accepted for a ship that has left.
  if (cutOffAt > sailsAt) {
    throw badRequest('Cut-off has to be before the vessel sails', 'cutoff_after_sailing');
  }
  if (etaAt < sailsAt) {
    throw badRequest('Arrival has to be after the vessel sails', 'eta_before_sailing');
  }

  const doc: ContainerDoc = {
    containerNumber: input.containerNumber
      ? normalise(input.containerNumber)
      : await nextContainerNumber(),
    type: input.type,
    vessel: input.vessel,
    voyage: input.voyage,
    lane: input.lane,
    destinationLabel: lane.to,
    status: 'open',
    capacityVolume: CONTAINER_TYPES[input.type],
    cutOffAt,
    sailsAt,
    etaAt,
    sealNumber: null,
  };

  try {
    await containers().insertOne(doc);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw conflict(`Container ${doc.containerNumber} already exists`, 'container_exists');
    }
    throw error;
  }

  return summarise(doc);
};

// ── 2.3 Loading ────────────────────────────────────────────────────────────

export const LoadInput = z.object({
  trackingIds: z.array(z.string().trim().min(4)).min(1).max(200),
});

export interface LoadResult {
  containerNumber: string;
  loaded: string[];
  refused: { trackingId: string; reason: string }[];
  container: ContainerSummary;
}

/**
 * Requirement 2.3: group boxes into a container.
 *
 * Three things are refused here, and each is a real operational failure the
 * system is the last line of defence against:
 *
 *   — a piece whose booking has an unapproved price change. Once it is in a
 *     sealed container on the water, the customer's leverage to dispute the
 *     price is gone and ours to hold the goods is too. This is why
 *     `blockedByAdjustment` exists.
 *   — a piece that has not been measured. Its volume is the customer's guess,
 *     and the container's fill would be fiction.
 *   — a piece for a different destination. Melbourne boxes in the Sydney
 *     container are only discovered after the ship sails.
 *
 * Refusals are reported per piece rather than failing the whole scan: an
 * operator loading forty boxes needs to know which two to set aside, not that
 * "loading failed".
 */
export const loadPieces = async (
  containerNumber: string,
  input: z.infer<typeof LoadInput>,
  actor: Actor,
): Promise<LoadResult> => {
  const container = await containers().findOne({ containerNumber: normalise(containerNumber) });
  if (!container) throw notFound(`Container ${containerNumber}`, 'container_not_found');
  if (container.status !== 'open') {
    throw conflict(
      `Container ${container.containerNumber} is ${container.status} and cannot take more boxes`,
      'container_not_open',
    );
  }

  const ids = input.trackingIds.map((id) => id.trim().toUpperCase());
  const found = await pieces().find({ trackingId: { $in: ids } }).toArray();
  const byId = new Map(found.map((piece) => [piece.trackingId!, piece]));

  const refused: { trackingId: string; reason: string }[] = [];
  const loadable: PieceDoc[] = [];

  // One lookup per booking, not per piece — forty boxes are usually a handful
  // of shipments.
  const heldBookings = new Set(
    (
      await adjustments()
        .find({
          bookingId: { $in: [...new Set(found.map((p) => p.bookingId.toHexString()))].map((id) => new ObjectId(id)) },
          state: 'awaiting_approval',
        })
        .toArray()
    ).map((adjustment) => adjustment.bookingId.toHexString()),
  );

  for (const id of ids) {
    const piece = byId.get(id);
    if (!piece) {
      refused.push({ trackingId: id, reason: 'No box with that tracking ID' });
      continue;
    }
    if (piece.containerId) {
      const other = await containers().findOne({ _id: piece.containerId });
      refused.push({
        trackingId: id,
        reason:
          other && !other._id!.equals(container._id!)
            ? `Already in ${other.containerNumber}`
            : 'Already in this container',
      });
      continue;
    }
    if (!piece.verified) {
      refused.push({ trackingId: id, reason: 'Not measured yet' });
      continue;
    }
    if (heldBookings.has(piece.bookingId.toHexString())) {
      refused.push({
        trackingId: id,
        reason: `${piece.bookingRef} has a price change the customer has not approved`,
      });
      continue;
    }
    if (piece.destination.split(',')[0]?.trim() !== container.destinationLabel) {
      refused.push({
        trackingId: id,
        reason: `Going to ${piece.destination}, not ${container.destinationLabel}`,
      });
      continue;
    }
    loadable.push(piece);
  }

  if (loadable.length > 0) {
    const now = new Date();
    await withTransaction(async (session) => {
      await pieces().updateMany(
        { _id: { $in: loadable.map((p) => p._id!) } },
        { $set: { containerId: container._id!, status: 'loaded' } },
        { session },
      );
      await events().insertMany(
        loadable.map((piece) => ({
          at: now,
          pieceId: piece.trackingId!,
          bookingRef: piece.bookingRef,
          code: 'loaded' as const,
          actor: actor.name,
          workstation: actor.workstation,
          detail: `Loaded into ${container.containerNumber} · ${container.vessel} ${container.voyage}`,
        })),
        { session },
      );

      for (const bookingId of new Set(loadable.map((p) => p.bookingId.toHexString()))) {
        const id = new ObjectId(bookingId);
        const after = await pieces().find({ bookingId: id }, { session }).toArray();
        await bookings().updateOne(
          { _id: id },
          { $set: { status: deriveBookingStatus(after), updatedAt: now } },
          { session },
        );
      }
    });
  }

  return {
    containerNumber: container.containerNumber,
    loaded: loadable.map((piece) => piece.trackingId!),
    refused,
    container: await summarise(container),
  };
};

/** Refuse to load a single piece loudly, for callers that want the exception. */
export const assertLoadable = async (bookingId: ObjectId, reference: string): Promise<void> => {
  const open = await adjustments().findOne({ bookingId, state: 'awaiting_approval' });
  if (open) throw blockedByAdjustment(reference);
};

// ── 2.3 Sealing and departure ──────────────────────────────────────────────

export const SealInput = z.object({
  sealNumber: z.string().trim().min(3).max(24),
});

/**
 * Sealing is the point of no return: the doors close, the seal number goes on
 * the bill of lading, and every box inside becomes In Transit. Nothing can be
 * added or re-measured afterwards, which is why loading validates as hard as
 * it does.
 */
export const sealContainer = async (
  containerNumber: string,
  input: z.infer<typeof SealInput>,
  actor: Actor,
): Promise<ContainerSummary> => {
  const container = await containers().findOne({ containerNumber: normalise(containerNumber) });
  if (!container) throw notFound(`Container ${containerNumber}`, 'container_not_found');
  if (container.status !== 'open') {
    throw conflict(`Container ${container.containerNumber} is already ${container.status}`, 'container_not_open');
  }

  const loaded = await pieces().find({ containerId: container._id! }).toArray();
  if (loaded.length === 0) {
    throw badRequest('There is nothing in this container to seal', 'container_empty');
  }

  const now = new Date();
  await withTransaction(async (session) => {
      await containers().updateOne(
        { _id: container._id! },
        { $set: { status: 'in_transit', sealNumber: input.sealNumber } },
        { session },
      );
      await pieces().updateMany(
        { containerId: container._id! },
        { $set: { status: 'in_transit' } },
        { session },
      );
      await events().insertMany(
        loaded.map((piece) => ({
          at: now,
          pieceId: piece.trackingId!,
          bookingRef: piece.bookingRef,
          code: 'sealed' as const,
          actor: actor.name,
          workstation: actor.workstation,
          detail: `${container.containerNumber} sealed ${input.sealNumber} · ${container.vessel} ${container.voyage}`,
        })),
        { session },
      );

      for (const bookingId of new Set(loaded.map((p) => p.bookingId.toHexString()))) {
        const id = new ObjectId(bookingId);
        const after = await pieces().find({ bookingId: id }, { session }).toArray();
        await bookings().updateOne(
          { _id: id },
          { $set: { status: deriveBookingStatus(after), updatedAt: now } },
          { session },
        );
      }
    });

  // Every customer with a box aboard hears that it sailed.
  for (const reference of new Set(loaded.map((p) => p.bookingRef))) {
    const booking = await bookings().findOne({ reference });
    if (!booking) continue;
    const mine = loaded.filter((p) => p.bookingRef === reference);
    await notifications.send({
      entityId: `${container.containerNumber}:${reference}`,
      event: 'departed',
      bookingRef: reference,
      to: { email: booking.sender.email, mobile: booking.sender.mobile },
      data: {
        customerName: booking.customerName,
        bookingRef: reference,
        pieceCount: mine.length,
        vessel: container.vessel,
        voyage: container.voyage,
        containerNumber: container.containerNumber,
        sealNumber: input.sealNumber,
        destination: container.destinationLabel,
        etaAt: container.etaAt.toDateString(),
      },
    });
  }

  const updated = await containers().findOne({ _id: container._id! });
  return summarise(updated!);
};

/** Containers that can still take boxes for a given destination. */
export const openContainersFor = async (destinationLabel: string): Promise<ContainerSummary[]> => {
  const open = await containers()
    .find({ status: 'open', destinationLabel })
    .sort({ cutOffAt: 1 })
    .toArray();
  return Promise.all(open.map(summarise));
};
