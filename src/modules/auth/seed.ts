import { env } from '../../config/env.js';
import { countStaff, createStaff } from './service.js';

/**
 * One account per role, so the separation of duties can actually be walked:
 * sign in as the operator and the approve button is refused by the server, not
 * merely hidden by the client.
 *
 * Development only. Production seeds nothing and the first administrator is
 * created out of band.
 */
const DEMO_STAFF = [
  { email: 'admin@cargoflow.test', name: 'Anusha Dias', role: 'admin' as const, depotId: null },
  { email: 'billing@cargoflow.test', name: 'Priya Mendis', role: 'billing' as const, depotId: null },
  {
    email: 'supervisor@cargoflow.test',
    name: 'Ruwan Fernando',
    role: 'supervisor' as const,
    depotId: 'PELIYAGODA',
  },
  {
    email: 'operator@cargoflow.test',
    name: 'Kasun Silva',
    role: 'operator' as const,
    depotId: 'PELIYAGODA',
  },
];

export const DEMO_PASSWORD = 'cargoflow';

export const seedStaff = async (): Promise<void> => {
  if (env.isProduction) return;
  if ((await countStaff()) > 0) return;

  for (const person of DEMO_STAFF) {
    await createStaff({ ...person, password: DEMO_PASSWORD });
  }
};
