import {
  MongoClient,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type IndexDescription,
} from 'mongodb';
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
  /** False against a standalone mongod — see withTransaction below. */
  transactions: boolean;
}

let transactionsAvailable = false;

export const hasTransactions = (): boolean => transactionsAvailable;

/**
 * Run a unit of work atomically where the deployment allows it.
 *
 * Multi-document transactions need a replica set or a sharded cluster. Every
 * production target has one — Atlas is a replica set, so is any sane
 * self-hosted deployment — but a developer who installed MongoDB from the
 * Windows installer gets a standalone, and on a standalone every transaction
 * throws "Transaction numbers are only allowed on a replica set member".
 *
 * Refusing to start would be defensible; silently dropping atomicity would not
 * be. So the capability is detected once at connect time, the fallback path
 * runs the same writes without a session, and the server says loudly at boot
 * which mode it is in. The callback takes an optional session precisely so both
 * paths are the same code.
 */
export const withTransaction = async <T>(
  work: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> => {
  if (!transactionsAvailable) return work(undefined);

  const session = getClient().startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
};

export const getClient = (): MongoClient => {
  if (!client) throw new Error('Database not connected — call connectToDatabase() first');
  return client;
};

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

  // `hello` reports the topology: a replica set names itself, a mongos
  // identifies as isdbgrid. Anything else is a standalone.
  const hello = await db.admin().command({ hello: 1 });
  transactionsAvailable = Boolean(hello.setName) || hello.msg === 'isdbgrid';

  return { uri, database: env.MONGODB_DB, inMemory, transactions: transactionsAvailable };
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
/** Drop an index that a later version replaced. Absent is success. */
const dropIfPresent = async (collectionName: string, indexName: string): Promise<void> => {
  try {
    await getDb().collection(collectionName).dropIndex(indexName);
  } catch {
    // IndexNotFound, or the collection does not exist yet. Both are fine.
  }
};

/**
 * Create one collection's indexes, saying which collection when it goes wrong.
 *
 * The driver's own error names the index but not the collection, and at boot
 * that is the difference between a one-line fix and reading the whole file.
 */
const indexesFor = async (
  name: (typeof COLLECTIONS)[keyof typeof COLLECTIONS],
  specs: IndexDescription[],
): Promise<void> => {
  try {
    await getDb().collection(name).createIndexes(specs);
  } catch (error) {
    throw new Error(
      `Could not create indexes on "${name}": ${(error as Error).message}`,
      { cause: error },
    );
  }
};

export const ensureIndexes = async (): Promise<void> => {
  const database = getDb();

  // Superseded by piece_tracking_issued_unique below.
  await dropIfPresent(COLLECTIONS.pieces, 'piece_tracking_unique');

  await indexesFor(COLLECTIONS.customers, [
    // A returning customer is matched on mobile, not email: households share an
    // email far more often than they share a phone, and the mobile is what the
    // SMS goes to.
    { key: { mobile: 1 }, unique: true, name: 'customer_mobile_unique' },
    { key: { reference: 1 }, unique: true, name: 'customer_reference_unique' },
  ]);

  await indexesFor(COLLECTIONS.bookings, [
    { key: { reference: 1 }, unique: true, name: 'booking_reference_unique' },
    { key: { customerId: 1, createdAt: -1 }, name: 'booking_by_customer' },
    { key: { status: 1, createdAt: -1 }, name: 'booking_by_status' },
  ]);

  await indexesFor(COLLECTIONS.pieces, [
    /**
     * Partial, because a piece has no tracking ID until the depot physically
     * receives it. A plain unique index treats every unreceived piece's null
     * as the same value, so the second booking in the system fails to insert.
     * Uniqueness is only meaningful for IDs that have actually been issued.
     */
    {
      key: { trackingId: 1 },
      unique: true,
      name: 'piece_tracking_issued_unique',
      partialFilterExpression: { trackingId: { $type: 'string' } },
    },
    { key: { bookingId: 1, status: 1 }, name: 'piece_by_booking' },
    { key: { containerId: 1, status: 1 }, name: 'piece_by_container' },
    { key: { depotId: 1, status: 1, receivedAt: -1 }, name: 'piece_intake_queue' },
  ]);

  await indexesFor(COLLECTIONS.quotes, [
    { key: { bookingId: 1, createdAt: -1 }, name: 'quote_by_booking' },
  ]);

  await indexesFor(COLLECTIONS.adjustments, [
    { key: { bookingId: 1 }, name: 'adjustment_by_booking' },
    // The exceptions queue only ever asks for the unsettled ones.
    {
      key: { state: 1, raisedAt: 1 },
      name: 'adjustment_open',
      partialFilterExpression: { state: 'awaiting_approval' },
    },
    { key: { autoApproveAt: 1 }, name: 'adjustment_auto_approve', sparse: true },
  ]);

  await indexesFor(COLLECTIONS.containers, [
    { key: { containerNumber: 1 }, unique: true, name: 'container_number_unique' },
    { key: { status: 1, cutOffAt: 1 }, name: 'container_open' },
  ]);

  await indexesFor(COLLECTIONS.invoices, [
    { key: { number: 1 }, unique: true, name: 'invoice_number_unique' },
    { key: { bookingId: 1 }, name: 'invoice_by_booking' },
    { key: { status: 1, dueAt: 1 }, name: 'invoice_overdue' },
  ]);

  await indexesFor(COLLECTIONS.rateCards, [
    { key: { version: 1 }, unique: true, name: 'rate_card_version_unique' },
    { key: { effectiveFrom: -1 }, name: 'rate_card_effective' },
  ]);

  await indexesFor(COLLECTIONS.notifications, [
    // One notification per (entity, event, channel). A retried worker cannot
    // send a second SMS about the same adjustment.
    {
      key: { entityId: 1, event: 1, channel: 1 },
      unique: true,
      name: 'notification_idempotency',
    },
    { key: { status: 1, createdAt: -1 }, name: 'notification_by_status' },
  ]);

  await indexesFor(COLLECTIONS.staff, [
    { key: { email: 1 }, unique: true, name: 'staff_email_unique' },
  ]);

  await indexesFor(COLLECTIONS.sessions, [
    { key: { tokenHash: 1 }, unique: true, name: 'session_token_unique' },
    { key: { staffId: 1 }, name: 'session_by_staff' },
    // Mongo evicts dead sessions for us; nothing has to remember to sweep.
    { key: { expiresAt: 1 }, name: 'session_ttl', expireAfterSeconds: 0 },
  ]);

  await indexesFor(COLLECTIONS.documents, [
    // One BOL number per container, enforced by the database rather than by
    // hoping two people never open it at the same moment.
    { key: { key: 1 }, unique: true, name: 'document_key_unique' },
    { key: { kind: 1 }, name: 'document_by_kind' },
  ]);

  await indexesFor(COLLECTIONS.counters, [
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
