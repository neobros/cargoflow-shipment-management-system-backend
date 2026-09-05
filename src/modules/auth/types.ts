import type { ObjectId } from 'mongodb';

/**
 * Staff roles.
 *
 * The separation that matters: the person who measures a box cannot be the
 * person who decides what it costs. A depot operator can raise a re-rate but
 * not approve it, waive it, or issue an invoice. That is a fraud control, not
 * an org chart, and it is enforced on the server.
 */
export const ROLES = ['operator', 'supervisor', 'billing', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  operator: 'Depot operator',
  supervisor: 'Depot supervisor',
  billing: 'Billing',
  admin: 'Administrator',
};

export type Permission =
  | 'admin:access'
  | 'bookings:read'
  | 'adjustments:read'
  | 'adjustments:remind'
  | 'adjustments:approve'
  | 'adjustments:waive'
  | 'invoices:issue'
  | 'documents:read'
  | 'customers:read'
  | 'depot:receive'
  | 'depot:verify'
  | 'depot:label'
  | 'containers:read'
  | 'containers:load'
  | 'containers:seal'
  | 'containers:manage'
  | 'rates:read'
  | 'rates:publish'
  | 'staff:manage';

/**
 * What each role may do. Deliberately explicit rather than hierarchical —
 * "billing outranks operator" is not true in any useful sense, and a table you
 * can read beats an inheritance chain you have to reason about.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  /**
   * The floor, and only the floor. An operator receives boxes, weighs them,
   * prints labels and loads containers — that is the whole job, and it is
   * enough to run a warehouse.
   *
   * They can look a shipment up, because they are holding a box and need to
   * know whose it is. They cannot see the money: not the exceptions queue, not
   * the price changes, not the invoices. Measuring a box and deciding what it
   * costs must not be the same pair of hands.
   */
  operator: [
    'bookings:read',
    'depot:receive',
    'depot:verify',
    'depot:label',
    'containers:read',
    'containers:load',
  ],

  /**
   * The floor, plus responsibility for it. Everything an operator does, plus
   * closing a container's doors and seeing which shipments on their floor are
   * held on an unapproved price change — so they know what not to load, and can
   * chase the customer.
   *
   * They still cannot approve one. Being senior on the warehouse floor is not
   * the same as having authority over a customer's bill.
   */
  supervisor: [
    'admin:access',
    'bookings:read',
    'adjustments:read',
    'adjustments:remind',
    'depot:receive',
    'depot:verify',
    'depot:label',
    'containers:read',
    'containers:load',
    'containers:seal',
    'containers:manage',
    // A supervisor seals the container and hands the bill of lading over.
    'documents:read',
  ],

  /**
   * The money, and none of the floor. Billing approves and waives price
   * changes, issues invoices and reads rate cards. They can see where cargo is,
   * because an invoice depends on it — but they never record a measurement,
   * because then the same person could both invent a difference and approve it.
   */
  billing: [
    'admin:access',
    'bookings:read',
    'adjustments:read',
    'adjustments:remind',
    'adjustments:approve',
    'adjustments:waive',
    'invoices:issue',
    'documents:read',
    'customers:read',
    'containers:read',
    'rates:read',
  ],

  /** Everything, including publishing rate cards and managing staff. */
  admin: [
    'admin:access',
    'bookings:read',
    'adjustments:read',
    'adjustments:remind',
    'adjustments:approve',
    'adjustments:waive',
    'invoices:issue',
    'documents:read',
    'customers:read',
    'depot:receive',
    'depot:verify',
    'depot:label',
    'containers:read',
    'containers:load',
    'containers:seal',
    'containers:manage',
    'rates:read',
    'rates:publish',
    'staff:manage',
  ],
};

/**
 * A one-line description of what a role is for, shown next to the person's name
 * so the boundary is legible rather than something you discover by being
 * refused.
 */
export const ROLE_SCOPE: Record<Role, string> = {
  operator: 'Receives, weighs, labels and loads',
  supervisor: 'Runs the floor and seals containers',
  billing: 'Approves price changes and invoices',
  admin: 'Full access',
};

export const can = (role: Role, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

/** Said the way a person would say it, for the message on a refusal. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'admin:access': 'open the operations panel',
  'bookings:read': 'view bookings',
  'adjustments:read': 'view price changes',
  'adjustments:remind': 'send reminders',
  'adjustments:approve': 'approve a price change',
  'adjustments:waive': 'waive a price change',
  'invoices:issue': 'issue invoices',
  'documents:read': 'open shipping documents',
  'customers:read': 'view the customer directory',
  'depot:receive': 'receive boxes at the depot',
  'depot:verify': 'weigh and measure boxes',
  'depot:label': 'print shipping labels',
  'containers:read': 'view containers',
  'containers:load': 'load boxes into a container',
  'containers:seal': 'seal a container',
  'containers:manage': 'open and schedule containers',
  'rates:read': 'view rate cards',
  'rates:publish': 'publish rate cards',
  'staff:manage': 'manage staff',
};

export interface StaffDoc {
  _id?: ObjectId;
  email: string;
  name: string;
  role: Role;
  /** scrypt: salt:derivedKey, both hex. */
  passwordHash: string;
  depotId: string | null;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface SessionDoc {
  _id?: ObjectId;
  /** SHA-256 of the cookie value — a database leak must not hand over sessions. */
  tokenHash: string;
  staffId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
  ip: string | null;
}

/** What the client is told about who it is. Never the hash, never the id. */
export interface CurrentUser {
  email: string;
  name: string;
  role: Role;
  roleLabel: string;
  /** What this role is for, in one line. */
  roleScope: string;
  depotId: string | null;
  permissions: Permission[];
}

export const toCurrentUser = (staff: StaffDoc): CurrentUser => ({
  email: staff.email,
  name: staff.name,
  role: staff.role,
  roleLabel: ROLE_LABELS[staff.role],
  roleScope: ROLE_SCOPE[staff.role],
  depotId: staff.depotId,
  permissions: ROLE_PERMISSIONS[staff.role],
});

export const SESSION_COOKIE = 'cf_staff_session';
export const SESSION_TTL_HOURS = 12;
