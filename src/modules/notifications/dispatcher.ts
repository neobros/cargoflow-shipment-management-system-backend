import { COLLECTIONS, collection } from '../../db/mongo.js';
import { backoffMs, MAX_ATTEMPTS, type NotificationDoc, type NotificationEvent } from './types.js';
import { transportFor } from './transports.js';

const notifications = () => collection<NotificationDoc>(COLLECTIONS.notifications);

export interface DispatchReport {
  attempted: number;
  sent: number;
  retrying: number;
  failed: number;
}

/**
 * Hand queued messages to their transport.
 *
 * Claimed one at a time with `findOneAndUpdate`, which is what makes it safe to
 * run this on more than one instance: the update is atomic, so two workers
 * cannot both pick up the same message and send a customer two texts about one
 * price change. The claim pushes `nextAttemptAt` forward before the send is
 * attempted, so a worker that dies mid-flight releases the message by timeout
 * rather than holding it forever.
 */
const claimNext = async (now: Date): Promise<NotificationDoc | null> =>
  notifications().findOneAndUpdate(
    { status: 'pending', nextAttemptAt: { $lte: now } },
    {
      $inc: { attempts: 1 },
      $set: { lastAttemptAt: now, nextAttemptAt: new Date(now.getTime() + 60_000) },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );

export const dispatchPending = async (limit = 25): Promise<DispatchReport> => {
  const report: DispatchReport = { attempted: 0, sent: 0, retrying: 0, failed: 0 };

  for (let i = 0; i < limit; i += 1) {
    const now = new Date();
    const message = await claimNext(now);
    if (!message) break;

    report.attempted += 1;
    const transport = transportFor(message.channel);
    const result = await transport.send({
      to: message.to,
      subject: message.subject,
      body: message.body,
    });

    if (result.ok) {
      await notifications().updateOne(
        { _id: message._id! },
        {
          $set: {
            status: 'sent',
            sentAt: new Date(),
            providerId: result.providerId ?? null,
            transport: transport.name,
            error: null,
          },
        },
      );
      report.sent += 1;
      continue;
    }

    // A permanently bad address and a provider outage look the same in the
    // database if you only record "it failed". They are not the same, and
    // retrying the first one forever is how a queue fills up with rubbish.
    const giveUp = result.retryable === false || message.attempts >= MAX_ATTEMPTS;

    await notifications().updateOne(
      { _id: message._id! },
      {
        $set: {
          status: giveUp ? 'failed' : 'pending',
          transport: transport.name,
          error: result.error ?? 'The provider did not accept it',
          nextAttemptAt: giveUp
            ? message.nextAttemptAt
            : new Date(Date.now() + backoffMs(message.attempts)),
        },
      },
    );

    if (giveUp) report.failed += 1;
    else report.retrying += 1;
  }

  return report;
};

/** Put a failed message back in the queue — the admin panel's retry button. */
export const retry = async (entityId: string, event: NotificationEvent): Promise<number> => {
  const result = await notifications().updateMany(
    { entityId, event, status: 'failed' },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), error: null } },
  );
  return result.modifiedCount;
};

let timer: NodeJS.Timeout | null = null;

/**
 * Run the queue on an interval.
 *
 * In-process because this system is one service and one database, and a queue
 * that handles a few hundred messages a day does not need a broker. The seam is
 * `dispatchPending` — the day it needs to be a separate worker, that function
 * moves and nothing that calls `queue()` changes.
 */
export const startDispatcher = (
  everyMs = 15_000,
  onError: (error: unknown) => void = () => undefined,
): void => {
  if (timer) return;
  timer = setInterval(() => {
    void dispatchPending().catch(onError);
  }, everyMs);
  // Do not hold the process open for the sake of the queue.
  timer.unref?.();
};

export const stopDispatcher = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
};
