import { MongoClient, type Collection, type Db, type Document } from 'mongodb';
import { env } from '../config/env.js';

/**
 * Collection names in one place. Pieces are their own collection rather than an
 * array inside the booking, because four depot operators scanning at once must
 * not contend on a single document — see section 10 of the architecture doc.
 */
export const COLLECTIONS = {
  customers: 'customers',
  bookings: 'bookings',
  pieces: 'pieces',
  quotes: 'quotes',
  adjustments: 'adjustments',
  containers: 'containers',
  invoices: 'invoices',
  documents: 'documents',
  notifications: 'notifications',
  rateCards: 'rateCards',
  staff: 'staff',
  sessions: 'sessions',
  counters: 'counters',
  /** Time-series, append-only. Never updated. */
  pieceEvents: 'pieceEvents',
} as const;

let client: MongoClient | null = null;
let db: Db | null = null;
/** Only set when we booted a throwaway server for development. */
let memoryServer: { stop: () => Promise<boolean> } | null = null;

export const getDb = (): Db => {
  if (!db) throw new Error('Database not connected — call connectToDatabase() first');
  return db;
};

export const collection = <T extends Document = Document>(
  name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS],
): Collection<T> => getDb().collection<T>(name);

export interface ConnectionInfo {
  uri: string;
  database: string;
  inMemory: boolean;
}

/**
 * Connect, and in development conjure a database if none was configured.
 *
 * A developer cloning this repo should be able to run `npm run dev` and have a
 * working API, without installing MongoDB or Docker first. Production refuses
 * to start without a real URI (see config/env.ts).
 */
export const connectToDatabase = async (): Promise<ConnectionInfo> => {
  let uri = env.MONGODB_URI;
  let inMemory = false;

  if (!uri) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    // A replica set, not a standalone: multi-document transactions and change
    // streams both need one, and both are load-bearing in this system.
    const server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = server.getUri();
    memoryServer = server;
    inMemory = true;
  }

  client = new MongoClient(uri, { retryWrites: true });
  await client.connect();
  db = client.db(env.MONGODB_DB);

  return { uri, database: env.MONGODB_DB, inMemory };
};

export const closeDatabase = async (): Promise<void> => {
  await client?.close();
  await memoryServer?.stop();
  client = null;
  db = null;
  memoryServer = null;
};

/**
 * Indexes are created at boot, not by hand in a console. Built to the
 * equality–sort–range rule; the partial index on adjustments keeps the
 * exceptions queue reading a handful of documents out of hundreds of thousands.
 */
export const ensureIndexes = async (): Promise<void> => {
  const database = getDb();

  await database.collection(COLLECTIONS.customers).createIndexes([
    { key: { mobile: 1 }, unique: true, name: 'customer_mobile_unique' },
    { key: { reference: 1 }, unique: true, name: 'customer_reference_unique' },
  ]);

  await database.collection(COLLECTIONS.bookings).createIndexes([
    { key: { reference: 1 }, unique: true, name: 'booking_reference_unique' },
    { key: { customerId: 1, createdAt: -1 }, name: 'booking_by_customer' },
    { key: { status: 1, createdAt: -1 }, name: 'booking_by_status' },
  ]);

  await database.collection(COLLECTIONS.pieces).createIndexes([
    { key: { trackingId: 1 }, unique: true, name: 'piece_tracking_unique' },
    { key: { bookingId: 1, status: 1 }, name: 'piece_by_booking' },
    { key: { containerId: 1, status: 1 }, name: 'piece_by_container' },
    { key: { depotId: 1, status: 1, receivedAt: -1 }, name: 'piece_intake_queue' },
  ]);

  await database.collection(COLLECTIONS.quotes).createIndexes([
    { key: { bookingId: 1, createdAt: -1 }, name: 'quote_by_booking' },
  ]);

  await database.collection(COLLECTIONS.adjustments).createIndexes([
    { key: { bookingId: 1 }, name: 'adjustment_by_booking' },
    // The exceptions queue only ever asks for the unsettled ones.
    {
      key: { state: 1, raisedAt: 1 },
      name: 'adjustment_open',
      partialFilterExpression: { state: 'awaiting_approval' },
    },
    { key: { autoApproveAt: 1 }, name: 'adjustment_auto_approve', sparse: true },
  ]);

  await database.collection(COLLECTIONS.containers).createIndexes([
    { key: { containerNumber: 1 }, unique: true, name: 'container_number_unique' },
    { key: { status: 1, cutOffAt: 1 }, name: 'container_open' },
  ]);

  await database.collection(COLLECTIONS.invoices).createIndexes([
    { key: { number: 1 }, unique: true, name: 'invoice_number_unique' },
    { key: { bookingId: 1 }, name: 'invoice_by_booking' },
    { key: { status: 1, dueAt: 1 }, name: 'invoice_overdue' },
  ]);

  await database.collection(COLLECTIONS.rateCards).createIndexes([
    { key: { version: 1 }, unique: true, name: 'rate_card_version_unique' },
    { key: { effectiveFrom: -1 }, name: 'rate_card_effective' },
  ]);

  await database.collection(COLLECTIONS.notifications).createIndexes([
    // One notification per (entity, event, channel). A retried worker cannot
    // send a second SMS about the same adjustment.
    {
      key: { entityId: 1, event: 1, channel: 1 },
      unique: true,
      name: 'notification_idempotency',
    },
    { key: { status: 1, createdAt: -1 }, name: 'notification_by_status' },
  ]);

  await database.collection(COLLECTIONS.staff).createIndexes([
    { key: { email: 1 }, unique: true, name: 'staff_email_unique' },
  ]);

  await database.collection(COLLECTIONS.sessions).createIndexes([
    { key: { tokenHash: 1 }, unique: true, name: 'session_token_unique' },
    { key: { staffId: 1 }, name: 'session_by_staff' },
    // Mongo evicts dead sessions for us; nothing has to remember to sweep.
    { key: { expiresAt: 1 }, name: 'session_ttl', expireAfterSeconds: 0 },
  ]);

  await database.collection(COLLECTIONS.counters).createIndexes([
    { key: { _id: 1 }, name: 'counter_id' },
  ]);
};

/**
 * pieceEvents is a time-series collection: append-only, write-heavy, with a
 * natural time axis. MongoDB buckets it automatically, which keeps eighteen
 * months of audit history compact and fast to scan for one piece.
 */
export const ensureTimeSeriesCollections = async (): Promise<void> => {
  const database = getDb();
  const existing = await database.listCollections({ name: COLLECTIONS.pieceEvents }).toArray();
  if (existing.length > 0) return;

  await database.createCollection(COLLECTIONS.pieceEvents, {
    timeseries: {
      timeField: 'at',
      metaField: 'pieceId',
      granularity: 'minutes',
    },
  });
};
