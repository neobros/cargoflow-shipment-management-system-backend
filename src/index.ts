import { env } from './config/env.js';
import { closeDatabase, connectToDatabase, ensureIndexes, ensureTimeSeriesCollections } from './db/mongo.js';
import { seedRateCards } from './db/seed.js';
import { seedStaff } from './modules/auth/seed.js';
import { seedDemoShipment } from './modules/shipments/demo-seed.js';
import { buildServer } from './server.js';

const start = async (): Promise<void> => {
  const connection = await connectToDatabase();
  await ensureTimeSeriesCollections();
  await ensureIndexes();
  await seedRateCards();
  await seedStaff();

  // Development convenience: one real shipment so /track works from minute one.
  // Guarded inside on the booking count, so it never touches a used database.
  if (env.NODE_ENV !== 'production') await seedDemoShipment();

  const app = await buildServer();

  if (connection.inMemory) {
    app.log.warn(
      'No MONGODB_URI set — running on a throwaway in-memory MongoDB. ' +
        'Data disappears when this process stops. Set MONGODB_URI in .env to use a real database.',
    );
  } else {
    app.log.info({ database: connection.database }, 'Connected to MongoDB');
  }

  /**
   * Multi-document transactions need a replica set. A standalone mongod — what
   * the Windows and Homebrew installers give you — cannot run them, so those
   * writes fall back to running without a session. Correct under one operator,
   * not safe under load, and never what you want in production. Say so.
   */
  if (!connection.transactions) {
    app.log.warn(
      'This MongoDB is a standalone, so multi-document transactions are unavailable ' +
        'and writes that should be atomic are not. Fine for development. For production, ' +
        'or to test the real write path, use a replica set: ' +
        'mongod --replSet rs0 then rs.initiate(), or leave MONGODB_URI empty to get one automatically.',
    );
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`CargoFlow API ready on http://localhost:${env.PORT}`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

start().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
