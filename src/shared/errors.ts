/**
 * Errors carry a machine-readable code and an HTTP status, so a route handler
 * never has to guess how to respond and the client never has to parse prose.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string, code = 'not_found'): AppError =>
  new AppError(`${what} not found`, code, 404);

export const badRequest = (message: string, code = 'bad_request', details?: unknown): AppError =>
  new AppError(message, code, 400, details);

export const conflict = (message: string, code = 'conflict'): AppError =>
  new AppError(message, code, 409);

/**
 * The customer has not answered the price change yet, so nothing downstream is
 * allowed to happen. Thrown by loading and invoicing, never swallowed.
 */
export const blockedByAdjustment = (reference: string): AppError =>
  new AppError(
    `Booking ${reference} has an unapproved price change and cannot proceed`,
    'adjustment_unapproved',
    409,
  );
