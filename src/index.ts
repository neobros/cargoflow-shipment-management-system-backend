import { env } from './config/env.js';
import { closeDatabase, connectToDatabase, ensureIndexes, ensureTimeSeriesCollections } from './db/mongo.js';
import { seedRateCards } from './db/seed.js';
import { seedDemoShipment } from './modules/shipments/demo-seed.js';
import { buildServer } from './server.js';

const start = async (): Promise<void> => {
  const connection = await connectToDatabase();
  await ensureTimeSeriesCollections();
  await ensureIndexes();
  await seedRateCards();

  // Development convenience: one real shipment so /track works from minute one.
  if (connection.inMemory) await seedDemoShipment();

  const app = await buildServer();

  if (connection.inMemory) {
    app.log.warn(
      'No MONGODB_URI set — running on a throwaway in-memory MongoDB. ' +
        'Data disappears when this process stops. Set MONGODB_URI in .env to use a real database.',
    );
  } else {
    app.log.info({ database: connection.database }, 'Connected to MongoDB');
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
