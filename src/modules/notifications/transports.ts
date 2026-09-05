import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';

/**
 * The seam between "we decided to tell the customer" and "a provider carried
 * it". Everything above this line is ours and testable; everything below is a
 * credential and someone else's uptime.
 *
 * Three transports, chosen by configuration rather than by code:
 *
 *   log     — writes the message and reports success. The default, so a fresh
 *             clone runs the whole notification path without an account
 *             anywhere, and so tests never touch a network.
 *   smtp    — any SMTP server: a provider's relay, or a local MailHog.
 *   twilio  — the REST API directly rather than the SDK, which is a large
 *             dependency for one POST.
 *
 * A transport reports failure by returning, not by throwing. The dispatcher
 * decides whether a failure is worth retrying; a transport does not get to
 * decide that on its behalf.
 */

export interface Outgoing {
  to: string;
  subject: string;
  body: string;
}

export interface Delivery {
  ok: boolean;
  /** The provider's own id, kept so a support query can be traced. */
  providerId?: string;
  error?: string;
  /** False for a permanently bad address — retrying will never help. */
  retryable?: boolean;
}

export interface Transport {
  readonly name: string;
  send(message: Outgoing): Promise<Delivery>;
}

// ── Log ────────────────────────────────────────────────────────────────────

const logTransport = (channel: 'email' | 'sms'): Transport => ({
  name: `log:${channel}`,
  async send(message) {
    // eslint-disable-next-line no-console
    console.info(
      `\n── ${channel.toUpperCase()} → ${message.to} ─────────────\n` +
        (channel === 'email' ? `Subject: ${message.subject}\n\n` : '') +
        `${message.body}\n`,
    );
    return { ok: true, providerId: `log-${Date.now()}` };
  },
});

// ── SMTP ───────────────────────────────────────────────────────────────────

let mailer: Transporter | null = null;

const smtpTransport = (): Transport => ({
  name: 'smtp',
  async send(message) {
    mailer ??= createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      // Port 465 is implicit TLS; 587 upgrades with STARTTLS after connecting.
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });

    try {
      const result = await mailer.sendMail({
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.body,
      });
      return { ok: true, providerId: result.messageId };
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode;
      return {
        ok: false,
        error: (error as Error).message,
        // 5xx is the server saying "never"; anything else may be transient.
        retryable: !(code && code >= 500 && code < 600),
      };
    }
  },
});

// ── SMS ────────────────────────────────────────────────────────────────────

const twilioTransport = (): Transport => ({
  name: 'twilio',
  async send(message) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: message.to,
          From: env.TWILIO_FROM,
          Body: message.body,
        }),
      });

      const payload = (await response.json()) as { sid?: string; message?: string };
      if (!response.ok) {
        return {
          ok: false,
          error: payload.message ?? `Twilio returned ${response.status}`,
          // 400 means Twilio rejected the request itself — a bad number, or no
          // credit. Sending it again produces the same 400.
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      return { ok: true, providerId: payload.sid };
    } catch (error) {
      // A thrown fetch is a network problem, which is the retryable case.
      return { ok: false, error: (error as Error).message, retryable: true };
    }
  },
});

// ── Selection ──────────────────────────────────────────────────────────────

let email: Transport | null = null;
let sms: Transport | null = null;

export const transportFor = (channel: 'email' | 'sms'): Transport => {
  if (channel === 'email') {
    email ??= env.MAIL_TRANSPORT === 'smtp' ? smtpTransport() : logTransport('email');
    return email;
  }
  sms ??= env.SMS_TRANSPORT === 'twilio' ? twilioTransport() : logTransport('sms');
  return sms;
};

/** What the boot log reports, so nobody assumes mail is going out when it is not. */
export const describeTransports = (): { email: string; sms: string; live: boolean } => {
  const emailName = env.MAIL_TRANSPORT === 'smtp' ? `smtp ${env.SMTP_HOST}:${env.SMTP_PORT}` : 'log only';
  const smsName = env.SMS_TRANSPORT === 'twilio' ? `twilio ${env.TWILIO_FROM}` : 'log only';
  return {
    email: emailName,
    sms: smsName,
    live: env.MAIL_TRANSPORT === 'smtp' || env.SMS_TRANSPORT === 'twilio',
  };
};

/** Tests and the reset script need the cached clients dropped. */
export const resetTransports = (): void => {
  email = null;
  sms = null;
  mailer = null;
};
