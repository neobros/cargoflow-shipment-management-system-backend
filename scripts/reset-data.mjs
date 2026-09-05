/**
 * Empty the operational data, keeping the configuration.
 *
 *     node scripts/reset-data.mjs            show what would go
 *     node scripts/reset-data.mjs --yes      actually do it
 *
 * Shipments, pieces, containers, invoices, documents, notifications, customers
 * and the reference-number counters all go, so the next booking is BK-26-0001
 * again. Rate cards and staff accounts stay: without a rate card nothing can be
 * priced, and without an account nobody can sign in.
 *
 * Refuses to run against NODE_ENV=production. This is a development tool, and
 * a script that empties a live freight system on a mistyped command is not one
 * worth having.
 */

import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';

// Read .env directly rather than importing the app's config, so this stays
// usable when the app itself will not start.
const env = (() => {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../.env', import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'))
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
})();

const URI = process.env.MONGODB_URI ?? env.MONGODB_URI;
const DB = process.env.MONGODB_DB ?? env.MONGODB_DB ?? 'cargoflow';
const NODE_ENV = process.env.NODE_ENV ?? env.NODE_ENV ?? 'development';

if (NODE_ENV === 'production') {
  console.error('Refusing to run against NODE_ENV=production.');
  process.exit(1);
}

if (!URI) {
  console.error(
    'No MONGODB_URI. With none set the app runs on a throwaway in-memory database,\n' +
      'which is already empty every time it starts — there is nothing to reset.',
  );
  process.exit(1);
}

/** Everything a shipment touches. Emptied. */
const OPERATIONAL = [
  'bookings',
  'pieces',
  'quotes',
  'adjustments',
  'containers',
  'invoices',
  'documents',
  'notifications',
  'customers',
  'customerSessions',
  'pieceEvents',
  // Reference numbers restart, so the first booking after a reset is BK-26-0001
  // rather than continuing from whatever the test data reached.
  'counters',
];

/** Configuration and staff access. Kept. Customer accounts are not — they
 * belong to the shipments, and a reset that leaves orphaned logins behind is
 * a reset that lies about being empty. */
const KEPT = ['rateCards', 'staff', 'sessions'];

const apply = process.argv.includes('--yes');

const client = new MongoClient(URI);
await client.connect();
const db = client.db(DB);

const present = new Set((await db.listCollections().toArray()).map((c) => c.name));

console.log(`\n${DB} at ${URI.replace(/\/\/[^@]*@/, '//***@')}\n`);

let total = 0;
for (const name of OPERATIONAL) {
  if (!present.has(name)) continue;
  const count = await db.collection(name).countDocuments();
  total += count;
  if (count === 0) continue;

  if (apply) {
    // Drop rather than deleteMany: pieceEvents is a time-series collection and
    // its backing buckets go with it. A deleteMany would leave them behind.
    await db.collection(name).drop();
  }
  console.log(`  ${apply ? 'dropped' : 'would drop'}  ${String(count).padStart(5)}  ${name}`);
}

console.log('');
for (const name of KEPT) {
  if (!present.has(name)) continue;
  console.log(`  kept       ${String(await db.collection(name).countDocuments()).padStart(5)}  ${name}`);
}

await client.close();

console.log(
  apply
    ? `\nRemoved ${total} documents. Restart the API so it recreates the indexes and the` +
        ' time-series collection.\n'
    : `\n${total} documents would be removed. Run again with --yes to do it.\n`,
);
