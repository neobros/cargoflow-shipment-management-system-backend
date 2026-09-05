# CargoFlow — backend

Shipment booking, warehouse verification, container consolidation, invoicing and
Bill of Lading API.

**Node 20+ · TypeScript · Fastify · MongoDB · Zod**

---

## Run it

```bash
npm install
npm run dev
```

That's the whole setup. With no `MONGODB_URI` in `.env`, the server boots a
throwaway in-memory MongoDB replica set for you — so a fresh clone runs without
installing MongoDB or Docker first. The API comes up on
[http://localhost:4000](http://localhost:4000).

Data in that mode disappears when the process stops. To keep it, point at a real
database:

```bash
# .env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/cargoflow?retryWrites=true&w=majority
```

Production refuses to start without one.

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch mode on `src/index.ts` |
| `npm test` | Pricing engine test suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm run seed` | Write the rate cards into a real database |
| `node scripts/walk-the-brief.py` | Drive every requirement over HTTP against a running API |
| `node scripts/reset-data.mjs` | Show what a data reset would remove (add `--yes` to do it) |

---

## The one idea this is built around

A customer prices their shipment from a tape measure. The depot prices it from a
certified scale. They disagree about a fifth of the time, and **everything here
is arranged around handling that disagreement honestly**.

The consequence is that a price is never recomputed in place. A quote is an
immutable priced document that stores its inputs and its rate-card version.
Verification produces a *second* quote. The difference between the two is a
first-class object with a lifecycle — raised, notified, approved or declined,
invoiced — and until it reaches a terminal state, invoicing is blocked.

## Layout

```
src/
  config/env.ts            Zod-validated environment
  db/
    mongo.ts               Connection, collections, indexes, time-series
    seed.ts                Rate cards v12 (live) and v13 (draft)
  modules/
    pricing/               ← the heart of the system
      engine.ts            Pure function: measurements + rate card → quote
      engine.test.ts       24 tests pinning the worked example
      rate-cards.ts        Lane rates, surcharges, tolerance policy
      repository.ts        Effective-dated card lookup
      routes.ts            /v1/reference, /v1/quotes/*
      types.ts             Zod contracts + domain types
  shared/
    units.ts               Integer millimetres, grams, minor units
    errors.ts              Typed errors with codes and HTTP status
  server.ts                Fastify app factory
  index.ts                 Boot, indexes, seed, graceful shutdown
```

Modules expose a public surface and nothing else. Cross-module side effects go
through the event collection, read by a change stream — not by one module
reaching into another.

## Units

Floats never touch a measurement or a price.

| Quantity | Stored as | Example |
| --- | --- | --- |
| Length | integer millimetres | `600` |
| Mass | integer grams | `24000` |
| Volume | integer ten-thousandths of m³ | `1215` → 0.1215 m³ |
| Money | integer minor units | `34912` → A$349.12 |

Volume rounds **per piece**, never once at the end — a barrel at 450×450×900 mm
is 0.1823 m³, and summing before rounding would lose that half-unit.

## The pricing engine

`priceShipment(request, rateCard)` is pure: no database, no clock, no I/O. That
purity is what makes re-rating trivially correct — verification runs the
identical function on the depot's measurements, and `assessRerate` diffs the two
results.

```
1. Chargeable quantity   sea: Σ round(L·W·H / 1e9) per piece, floored at lane minimum
                         air: max(actual grams, L·W·H / divisor)
2. Freight               quantity × lane rate, at the quoted card version
3. Surcharges            per piece: handling, oversize
                         per shipment: destination customs clearance
4. Tax                   GST on the subtotal
5. Persist               every component in minor units, with the inputs
                         and card version that produced it
```

### The tolerance rule

A verified measurement only disturbs a customer when the difference clears
**2% or A$10, whichever is greater**. Below that it is absorbed and the booked
price stands. Getting that comparison backwards is the failure mode the rule
exists to prevent, so there is a test named after it.

| Condition | Outcome |
| --- | --- |
| No change | `unchanged` |
| Smaller than booked | `refund` — credit note, nobody is asked |
| Within tolerance | `absorbed` — booked price stands, no message sent |
| Over tolerance | `approval_required` — invoicing held, 14-day window |
| Over 40% | `hard_stop` — never auto-approves, an agent phones |

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/v1/reference` | Lanes, packaging presets, surcharges — the booking wizard renders itself from this |
| `POST` | `/v1/quotes/estimate` | Price a shipment. Public, writes nothing |
| `POST` | `/v1/quotes/compare` | Price booked vs verified and assess the difference |

```bash
curl -s localhost:4000/v1/quotes/estimate \
  -H 'content-type: application/json' \
  -d '{"lane":"LKCMB-AUMEL","service":"sea_lcl",
       "pieces":[{"packaging":"large_box","lengthMm":600,"widthMm":450,"heightMm":450,"weightGrams":24000}]}'
```

## Notifications

Requirement 3.1. Four layers, so each can be reasoned about alone:

```
templates.ts    every message the system sends, in one file — email and SMS
                written separately, because 160 characters is not a shortened
                email
service.ts      decides what to send and to whom; the unique index on
                (entityId, event, channel) guarantees exactly once
dispatcher.ts   claims one message at a time with findOneAndUpdate, so two
                instances cannot both text the same customer; retries with
                backoff, gives up after five attempts
transports.ts   log | smtp | twilio — chosen by configuration, never by code
```

**Both transports default to `log`**, so a fresh clone runs the whole path —
templates, queue, dispatcher, retries — with no account anywhere. Messages are
composed, stored and printed, and the boot log says plainly that nothing left
the building. Point `MAIL_TRANSPORT=smtp` or `SMS_TRANSPORT=twilio` at real
credentials and the same code sends for real.

A transport reports failure by returning, not throwing, and says whether it is
worth retrying. An SMTP 5xx and a bad phone number are permanent; a refused
connection or a 429 is not. Retrying the first kind forever is how a queue
fills with rubbish, so the dispatcher distinguishes them and the operations
panel shows what failed and why, with a button to requeue.

## Documents

Requirement 3.2. Both documents exist three ways: on screen, printed through
the browser, and as a PDF the server draws.

| | Invoice | Master BOL |
| --- | --- | --- |
| Screen | `/admin/invoices`, `/account/invoices/:number` | `/admin/containers` |
| Print | A4 print stylesheet | A4 print stylesheet |
| File | `GET /v1/invoices/:number/pdf` | `GET /v1/containers/:no/bol.pdf` |

Drawn with **pdfkit**, not by rendering HTML — a headless browser to produce a
page of text and numbers is a hundred megabytes and a security surface. Only
the standard 14 fonts are used, so nothing licence-encumbered ships with it.

**The invoice records what the price did**, not just what it ended at. A
booking that was re-rated carries the original total, the difference, the
percentage and how it was settled — approved, auto-approved after the notice
period, or waived. Without that a re-rated customer receives a figure that does
not match their confirmation email and has to ring to find out why, which is
the dispute the whole re-rate flow exists to prevent.

Documents are scoped like everything else: a customer can only fetch their own
invoice, and a missing one returns 404 rather than 403 so an invoice number
cannot be probed for existence. The bill of lading needs `documents:read` — it
names every shipper and consignee with their address, which is more than
someone who only loads boxes needs.

## No sample shipments

Nothing operational is seeded. A fresh database has rate cards and staff
accounts and nothing else — no bookings, no containers, no invoices — so the
first booking anyone makes is `BK-26-0001` and everything on every screen is
something a person actually did.

Two things are still written at boot, because without them the system cannot
run at all rather than merely looking empty:

- **Rate cards** (v12 live, v13 effective 01 Oct). Nothing can be priced
  without one, and they are configuration, not sample data.
- **Staff accounts**, in development only — one per role, so the separation of
  duties can be walked rather than described. Production seeds none and the
  first administrator is created out of band.

`node scripts/reset-data.mjs` empties the operational collections again and
restarts the reference numbering. It refuses to run against
`NODE_ENV=production`.

## Worked example

Four boxes, Colombo to Melbourne. These figures appear in the UI deck, the
architecture document and the test suite, and are produced by the engine rather
than typed in anywhere. They are a fixture inside the test, not a row in any
database.

| | Declared | Verified |
| --- | --- | --- |
| Volume | 0.5828 m³ | 0.6814 m³ |
| Weight | 105.5 kg | 110.9 kg |
| Freight | 224.38 | 262.34 |
| Handling · clearance | 48.00 · 45.00 | unchanged |
| GST 10% | 31.74 | 35.53 |
| **Total** | **A$349.12** | **A$390.87** |

Difference **+A$41.75 (+11.96%)** — over tolerance, so the customer is asked.

The charge lines are deliberately only the ones the brief asks for: freight
priced on packaging, weight and destination, plus the two a consolidator
applies to every shipment without asking. There is no cargo cover, no
collection surcharge and no remote-delivery fee — those were removed as scope
the requirements never called for.

## Status

Built: units, pricing engine, re-rate assessment, rate cards with effective
dating, Mongo connection with indexes and time-series events, quote endpoints.

Next: identity and OTP sessions, bookings and pieces, tracking ID allocation,
warehouse verification, container consolidation, invoicing, documents,
notifications.
