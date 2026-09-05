import type { NotificationEvent } from './types.js';

/**
 * Every message the system sends, in one file.
 *
 * The copy used to be written inline in whichever service happened to trigger
 * it — a booking body in the booking service, a price-change body in the depot
 * service. That means nobody can review what customers actually receive without
 * reading four modules, and the tone drifts apart between them. It also makes
 * translation impossible: a Sri Lankan consolidator will want Sinhala and Tamil
 * long before it wants a second lane.
 *
 * An email and an SMS are not the same message shortened. An SMS has 160
 * characters, no subject, no formatting, and costs money per segment, so each
 * event writes both deliberately rather than truncating one into the other.
 */

export interface TemplateData {
  customerName: string;
  bookingRef: string;
  [key: string]: string | number | undefined;
}

export interface Rendered {
  subject: string;
  /** Plain text. HTML is a separate concern; most freight mail is read on a phone. */
  email: string;
  /** Kept under 160 characters including the reference. */
  sms: string;
}

const firstName = (full: string) => full.trim().split(/\s+/)[0] ?? full;

/** Trim an SMS to one segment, keeping the reference that makes it actionable. */
const oneSegment = (text: string, reference: string): string => {
  const tail = ` Ref ${reference}`;
  const room = 160 - tail.length;
  const body = text.trim().replace(/\s+/g, ' ');
  return (body.length > room ? `${body.slice(0, room - 1)}…` : body) + tail;
};

type Renderer = (data: TemplateData) => Rendered;

const TEMPLATES: Record<NotificationEvent, Renderer> = {
  booking_confirmed: (d) => ({
    subject: `Booking ${d.bookingRef} confirmed — ${d.total}`,
    email: [
      `Thanks ${firstName(d.customerName)}, your booking is in.`,
      '',
      `Reference: ${d.bookingRef}`,
      `${d.pieceCount} ${Number(d.pieceCount) === 1 ? 'box' : 'boxes'} · ${d.route}`,
      `Estimated price: ${d.total} including GST`,
      '',
      `Bring your boxes to ${d.depot}, ${d.depotAddress}.`,
      '',
      'We weigh and measure every box on arrival. If anything differs from what',
      'you told us, we send you the new price and wait for your yes before',
      'charging it.',
    ].join('\n'),
    sms: oneSegment(
      `Booking confirmed. ${d.pieceCount} boxes, ${d.total} estimated. Drop them at ${d.depot}.`,
      String(d.bookingRef),
    ),
  }),

  received_at_depot: (d) => ({
    subject: `We have ${d.receivedCount} of your boxes`,
    email: [
      `${d.receivedCount} ${Number(d.receivedCount) === 1 ? 'box' : 'boxes'} from ${d.bookingRef} arrived at our depot.`,
      '',
      String(d.trackingIds ?? ''),
      '',
      'Next we weigh and measure each one. If anything differs from what you',
      'told us, we will send you the new price before charging it.',
    ].join('\n'),
    sms: oneSegment(
      `${d.receivedCount} of your boxes arrived at our depot. We weigh them next.`,
      String(d.bookingRef),
    ),
  }),

  price_changed: (d) => ({
    subject: `${d.bookingRef}: your price has changed to ${d.verifiedTotal}`,
    email: [
      `We measured your boxes and ${d.changedCount === 1 ? 'one is' : 'some are'} bigger than booked.`,
      '',
      `You booked: ${d.bookedTotal}`,
      `Now:        ${d.verifiedTotal}`,
      `Difference: ${d.difference} (${d.differencePercent}%)`,
      '',
      'Nothing ships and nothing is charged until you say yes.',
      d.autoApproveAt
        ? `If we do not hear from you by ${d.autoApproveAt} the new price applies. We will remind you first.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    sms: oneSegment(
      `Your boxes measured bigger. ${d.bookedTotal} to ${d.verifiedTotal}. Nothing ships until you approve.`,
      String(d.bookingRef),
    ),
  }),

  price_settled: (d) => ({
    subject: `${d.bookingRef}: price change settled`,
    email: [
      `Thanks — the price on ${d.bookingRef} is settled at ${d.finalTotal}.`,
      '',
      'Your boxes are released for loading.',
    ].join('\n'),
    sms: oneSegment(`Price settled at ${d.finalTotal}. Your boxes are moving again.`, String(d.bookingRef)),
  }),

  price_reminder: (d) => ({
    subject: `Still waiting on you — ${d.bookingRef}`,
    email: [
      `Your boxes are held at our depot waiting for one answer.`,
      '',
      `You booked: ${d.bookedTotal}`,
      `Now:        ${d.verifiedTotal}`,
      '',
      d.autoApproveAt
        ? `If we do not hear from you by ${d.autoApproveAt} the new price applies automatically.`
        : 'Please let us know either way.',
    ].join('\n'),
    sms: oneSegment(
      `Reminder: your boxes are held pending a price change to ${d.verifiedTotal}.`,
      String(d.bookingRef),
    ),
  }),

  invoice_issued: (d) => ({
    subject: `Invoice ${d.invoiceNumber} — ${d.currency} ${d.total}`,
    email: [
      `Invoice ${d.invoiceNumber} for booking ${d.bookingRef}.`,
      '',
      `Amount due: ${d.currency} ${d.total} (including GST)`,
      `Due by: ${d.dueAt}`,
      '',
      d.basis === 'verified'
        ? 'This is based on the measurements we took at our depot.'
        : 'This is based on the sizes you gave us. We will re-check at the depot.',
    ].join('\n'),
    sms: oneSegment(
      `Invoice ${d.invoiceNumber}: ${d.currency} ${d.total} due ${d.dueAt}.`,
      String(d.bookingRef),
    ),
  }),

  loaded_into_container: (d) => ({
    subject: `${d.bookingRef} is loaded`,
    email: [
      `Your ${d.pieceCount} ${Number(d.pieceCount) === 1 ? 'box is' : 'boxes are'} in container ${d.containerNumber}.`,
      '',
      `It sails on ${d.vessel} ${d.voyage}.`,
    ].join('\n'),
    sms: oneSegment(
      `Your boxes are loaded into ${d.containerNumber}, sailing on ${d.vessel}.`,
      String(d.bookingRef),
    ),
  }),

  departed: (d) => ({
    subject: `${d.bookingRef} is on its way`,
    email: [
      `Your ${d.pieceCount} ${Number(d.pieceCount) === 1 ? 'box is' : 'boxes are'} aboard ${d.vessel} ${d.voyage}.`,
      '',
      `Container: ${d.containerNumber} (seal ${d.sealNumber})`,
      `Arriving ${d.destination} around ${d.etaAt}`,
      '',
      `Follow it with ${d.bookingRef}.`,
    ].join('\n'),
    sms: oneSegment(
      `Sailed on ${d.vessel}, arriving ${d.destination} around ${d.etaAt}.`,
      String(d.bookingRef),
    ),
  }),
};

export const render = (event: NotificationEvent, data: TemplateData): Rendered =>
  TEMPLATES[event](data);
