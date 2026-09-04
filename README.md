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
| Money | integer minor units | `37882` → A$378.82 |

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
                         per shipment: clearance, pickup, remote
4. Cover and tax         max(declared × 1.5%, A$10), then GST on the subtotal
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
  -d '{"lane":"LKCMB-AUMEL","service":"sea_lcl","declaredValue":180000,"coverRequested":true,
       "pieces":[{"packaging":"large_box","lengthMm":600,"widthMm":450,"heightMm":450,"weightGrams":24000}]}'
```

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
| Handling · clearance · cover | 48.00 · 45.00 · 27.00 | unchanged |
| GST 10% | 34.44 | 38.23 |
| **Total** | **A$378.82** | **A$420.57** |

Difference **+A$41.75 (+11.0%)** — over tolerance, so the customer is asked.

## Status

Built: units, pricing engine, re-rate assessment, rate cards with effective
dating, Mongo connection with indexes and time-series events, quote endpoints.

Next: identity and OTP sessions, bookings and pieces, tracking ID allocation,
warehouse verification, container consolidation, invoicing, documents,
notifications.
