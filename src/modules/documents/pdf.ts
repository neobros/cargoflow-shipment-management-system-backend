import PDFDocument from 'pdfkit';
import { formatMinor } from '../../shared/units.js';
import type { Bol } from './service.js';
import type { InvoiceDoc } from './service.js';

/**
 * Invoices and bills of lading as real PDFs.
 *
 * Both screens already print through the browser, which produces a good page —
 * but "printable or downloadable" (requirement 4.1) means a file the customer
 * can keep, forward to their accountant, and attach to an email. A print
 * dialog is not a file, and a customer who has closed the tab has nothing.
 *
 * Drawn with pdfkit rather than rendered from HTML, so generating one needs no
 * browser on the server — a headless Chrome to make an invoice is a hundred
 * megabytes and a security surface for a page of text and numbers.
 *
 * Only the built-in Helvetica and Courier are used. Embedding a font would
 * mean shipping a licence-encumbered binary; the standard 14 are guaranteed
 * present in every reader.
 */

const A4 = { size: 'A4' as const, margin: 48 };
const INK = '#111111';
const MUTED = '#555555';
const RULE = '#BBBBBB';

const collect = (doc: PDFKit.PDFDocument): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });

const day = (value: Date | string) =>
  new Date(value).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });

/** A hairline across the content width. */
const rule = (doc: PDFKit.PDFDocument, y?: number, weight = 0.5) => {
  const top = y ?? doc.y;
  doc
    .save()
    .lineWidth(weight)
    .strokeColor(RULE)
    .moveTo(doc.page.margins.left, top)
    .lineTo(doc.page.width - doc.page.margins.right, top)
    .stroke()
    .restore();
};

const label = (doc: PDFKit.PDFDocument, text: string) =>
  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED).text(text.toUpperCase(), { characterSpacing: 0.8 });

const value = (doc: PDFKit.PDFDocument, text: string, size = 10) =>
  doc.font('Helvetica').fontSize(size).fillColor(INK).text(text);

// ── Invoice ────────────────────────────────────────────────────────────────

export const invoicePdf = async (invoice: InvoiceDoc): Promise<Buffer> => {
  const doc = new PDFDocument({ ...A4, info: { Title: invoice.number, Author: 'CargoFlow' } });
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;

  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text('TAX INVOICE');
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    'CargoFlow Consolidators (Pvt) Ltd\n118 Negombo Road, Peliyagoda 11600, Sri Lanka\nABN [to be issued] · Registered for GST',
    { lineGap: 1 },
  );

  // The number block sits top-right, where every accounts department looks.
  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
    .text('INVOICE NUMBER', left, 48, { width, align: 'right' });
  doc.font('Courier-Bold').fontSize(14).fillColor(INK)
    .text(invoice.number, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Issued ${day(invoice.issuedAt)}    Due ${day(invoice.dueAt)}`, { width, align: 'right' });
  if (invoice.status === 'paid' && invoice.paidAt) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
      .text(`PAID ${day(invoice.paidAt)}`, { width, align: 'right' });
  }

  doc.moveDown(1.5);
  rule(doc, doc.y, 1.2);
  doc.moveDown(0.8);

  const partyTop = doc.y;
  label(doc, 'Bill to');
  value(doc, invoice.billTo.name, 11);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    [
      invoice.billTo.line1,
      invoice.billTo.line2,
      `${invoice.billTo.city} ${invoice.billTo.postcode}, ${invoice.billTo.country}`,
      invoice.billTo.mobile,
      invoice.billTo.email,
    ]
      .filter(Boolean)
      .join('\n'),
    { width: width / 2 - 10, lineGap: 1 },
  );

  const partyBottom = doc.y;
  doc.y = partyTop;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
    .text('FOR', left + width / 2, partyTop, { width: width / 2, align: 'right' });
  doc.font('Courier-Bold').fontSize(11).fillColor(INK)
    .text(invoice.bookingRef, { width: width / 2, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    `Customer ${invoice.customerRef}\nPriced on ${
      invoice.basis === 'verified' ? 'our depot measurements' : 'declared sizes'
    }\nRate card v${invoice.rateCardVersion}`,
    { width: width / 2, align: 'right', lineGap: 1 },
  );

  doc.y = Math.max(partyBottom, doc.y) + 18;
  doc.x = left;
  rule(doc);
  doc.moveDown(0.6);

  // ── Lines ────────────────────────────────────────────────────────────────
  const money = (x: number) => x;
  const amountX = doc.page.width - right - 80;
  const basisX = left + width * 0.45;

  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED);
  doc.text('CHARGE', left, doc.y, { width: width * 0.45, continued: false });
  doc.text('WORKED OUT FROM', basisX, doc.y - 9, { width: amountX - basisX - 10 });
  doc.text(invoice.currency, amountX, doc.y - 9, { width: 80, align: 'right' });
  doc.moveDown(0.5);
  rule(doc);
  doc.moveDown(0.4);

  for (const line of invoice.lines) {
    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(line.label, left, top, { width: width * 0.45 });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(line.basis, basisX, top, {
      width: amountX - basisX - 10,
    });
    doc.font('Courier').fontSize(10).fillColor(INK)
      .text(formatMinor(money(line.amount)), amountX, top, { width: 80, align: 'right' });
    doc.y = Math.max(doc.y, top + 14);
  }

  doc.moveDown(0.4);
  rule(doc);
  doc.moveDown(0.4);

  const total = (text: string, amount: string, bold = false, size = 10) => {
    const top = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor(INK)
      .text(text, basisX - 60, top, { width: amountX - basisX + 50, align: 'right' });
    doc.font(bold ? 'Courier-Bold' : 'Courier').fontSize(size).fillColor(INK)
      .text(amount, amountX, top, { width: 80, align: 'right' });
    doc.y = top + (bold ? 18 : 14);
  };

  total('Subtotal', formatMinor(invoice.subtotal));
  total('GST', formatMinor(invoice.tax));
  rule(doc, doc.y + 2);
  doc.moveDown(0.5);
  total(`Total due ${invoice.currency}`, formatMinor(invoice.total), true, 14);

  // ── The price change, if there was one ───────────────────────────────────
  if (invoice.adjustment) {
    doc.x = left;
    doc.moveDown(1);
    rule(doc);
    doc.moveDown(0.6);
    label(doc, 'Price adjustment');
    doc.moveDown(0.3);

    const a = invoice.adjustment;
    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    doc.text(`You originally booked ${invoice.currency} ${formatMinor(a.bookedTotal)}.`, left, doc.y, {
      width,
    });

    if (a.settledAs === 'waived') {
      doc.text(
        'Your boxes measured larger, but the difference was waived — you are charged the price you booked.',
        left,
        doc.y,
        { width, lineGap: 1 },
      );
    } else {
      doc.text(
        `Your boxes measured larger at our depot, so ${invoice.currency} ${formatMinor(a.difference)} ` +
          `(${a.differencePercent}%) was added. This was ${
            a.settledAs === 'auto_approved' ? 'approved automatically after the notice period' : 'approved'
          }${a.settledAt ? ` on ${day(a.settledAt)}` : ''}.`,
        left,
        doc.y,
        { width, lineGap: 1 },
      );
    }
    doc.font('Courier').fontSize(8.5).fillColor(MUTED)
      .text(`Reference ${a.reference}`, left, doc.y, { width });
  }

  // ── Footer ───────────────────────────────────────────────────────────────
  doc.x = left;
  doc.moveDown(1.5);
  rule(doc);
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text('Payment', left, doc.y, { width });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
    `Bank transfer to [account details to be issued]. Quote ${invoice.number} as the reference. ` +
      `Payment is due within 14 days of the issue date above.\n\n` +
      `Goods are held against payment. Where this invoice was raised on our depot measurements, ` +
      `those were taken on certified equipment; a copy is available on request against ${invoice.bookingRef}.`,
    left,
    doc.y,
    { width, lineGap: 1.5 },
  );

  return collect(doc);
};

// ── Master Bill of Lading ──────────────────────────────────────────────────

export const bolPdf = async (bol: Bol): Promise<Buffer> => {
  const doc = new PDFDocument({ ...A4, info: { Title: bol.number, Author: 'CargoFlow' } });
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;

  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK).text('MASTER BILL OF LADING');
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(bol.carrier);

  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
    .text('B/L NUMBER', left, 48, { width, align: 'right' });
  doc.font('Courier-Bold').fontSize(14).fillColor(INK)
    .text(bol.number, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Issued ${day(bol.issuedAt)}`, { width, align: 'right' });

  doc.moveDown(1.5);
  rule(doc, doc.y, 1.2);
  doc.moveDown(0.7);

  // Two columns of the blocks a port reads first.
  const blocks: [string, string][] = [
    ['Vessel and voyage', `${bol.container.vessel} ${bol.container.voyage}`],
    [
      'Container / seal',
      `${bol.container.containerNumber} · ${bol.container.type}${
        bol.container.sealNumber ? ` · seal ${bol.container.sealNumber}` : ' · not yet sealed'
      }`,
    ],
    ['Port of loading', bol.container.portOfLoading],
    ['Port of discharge', bol.container.portOfDischarge],
    ['Sailed', day(bol.container.sailsAt)],
    ['Estimated arrival', day(bol.container.etaAt)],
  ];

  for (let i = 0; i < blocks.length; i += 2) {
    const top = doc.y;
    for (const [column, index] of [[0, i], [1, i + 1]] as const) {
      const block = blocks[index];
      if (!block) continue;
      const x = left + column * (width / 2);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
        .text(block[0].toUpperCase(), x, top, { width: width / 2 - 10, characterSpacing: 0.8 });
      doc.font('Helvetica').fontSize(9.5).fillColor(INK)
        .text(block[1], x, top + 10, { width: width / 2 - 10 });
    }
    doc.y = top + 30;
  }

  doc.x = left;
  rule(doc, doc.y, 1.2);
  doc.moveDown(0.7);

  // Totals — what the carrier and customs work from.
  const totals: [string, string][] = [
    ['Packages', String(bol.totals.packages)],
    ['Gross weight', `${bol.totals.grossWeightKg} kg`],
    ['Measurement', `${bol.totals.measurementM3} m³`],
    ['House bills', String(bol.totals.houses)],
  ];
  const totalsTop = doc.y;
  totals.forEach(([name, figure], index) => {
    const x = left + index * (width / 4);
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
      .text(name.toUpperCase(), x, totalsTop, { width: width / 4 - 8, characterSpacing: 0.8 });
    doc.font('Courier-Bold').fontSize(13).fillColor(INK)
      .text(figure, x, totalsTop + 11, { width: width / 4 - 8 });
  });
  doc.y = totalsTop + 34;
  doc.x = left;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK)
    .text(`${bol.freightTerms} · SAID TO CONTAIN · SHIPPER'S LOAD, STOW AND COUNT`, { characterSpacing: 0.5 });
  doc.moveDown(0.6);
  rule(doc, doc.y, 1.2);

  // ── House bills ──────────────────────────────────────────────────────────
  for (const house of bol.houses) {
    // Keep a house entry whole rather than split across the page break.
    if (doc.y > doc.page.height - 190) {
      doc.addPage();
    }

    doc.moveDown(0.7);
    const top = doc.y;
    const third = width / 3;

    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
      .text(`SHIPPER — ${house.bookingRef}`, left, top, { width: third - 10, characterSpacing: 0.8 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
      .text(house.shipper.name, left, top + 11, { width: third - 10 });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
      `${house.shipper.line1}\n${house.shipper.city} ${house.shipper.postcode}, ${house.shipper.country}\n${house.shipper.mobile}`,
      left, top + 24, { width: third - 10, lineGap: 1 },
    );

    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
      .text('CONSIGNEE', left + third, top, { width: third - 10, characterSpacing: 0.8 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
      .text(house.consignee.name, left + third, top + 11, { width: third - 10 });
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
      `${house.consignee.line1}\n${house.consignee.city} ${house.consignee.region ?? ''} ${house.consignee.postcode}, ${house.consignee.country}\n${house.consignee.mobile}`,
      left + third, top + 24, { width: third - 10, lineGap: 1 },
    );

    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
      .text('PACKAGES · WEIGHT · MEASURE', left + third * 2, top, { width: third, characterSpacing: 0.8 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
      .text(`${house.packageCount} × ${house.packaging}`, left + third * 2, top + 11, { width: third });
    doc.font('Courier').fontSize(8.5).fillColor(MUTED)
      .text(`${house.grossWeightKg} kg\n${house.measurementM3} m³`, left + third * 2, top + 24, {
        width: third,
        lineGap: 1,
      });

    doc.y = top + 66;
    doc.x = left;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
      .text('MARKS AND NUMBERS', { characterSpacing: 0.8 });
    doc.font('Courier').fontSize(8.5).fillColor(INK).text(house.marks.join('  ·  '), { width, lineGap: 1 });
    doc.moveDown(0.6);
    rule(doc);
  }

  // ── Signature blocks ─────────────────────────────────────────────────────
  if (doc.y > doc.page.height - 130) doc.addPage();
  doc.moveDown(2);
  const signTop = doc.y;
  ['For the carrier', 'Place and date of issue'].forEach((name, index) => {
    const x = left + index * (width / 2);
    doc.save().lineWidth(0.7).strokeColor(INK)
      .moveTo(x, signTop + 26).lineTo(x + width / 2 - 30, signTop + 26).stroke().restore();
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED)
      .text(name.toUpperCase(), x, signTop + 31, { width: width / 2 - 30, characterSpacing: 0.8 });
  });

  return collect(doc);
};
