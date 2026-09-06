/**
 * Regression check for the lane/address bug.
 *
 * The original defect had two halves: a booking could be created whose
 * receiver was in the wrong country entirely, and the container gate compared
 * the receiver's SUBURB to the port label — so a legitimate Geelong delivery
 * on the Melbourne lane was refused as well. Both halves are exercised here.
 */
const API = 'http://localhost:4000';

const jar = new Map();
const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  let json;
  try { json = JSON.parse(await res.text()); } catch { json = null; }
  return { status: res.status, body: json, code: json?.error?.code, message: json?.error?.message };
};

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`        ${detail}`);
};

const party = (city, country, mobile, postcode) => ({
  name: 'Test Person', mobile, line1: '1 Test Road', city, postcode, country,
});
const LK = party('Kurunegala', 'LK', '+94771234567', '60000');
const BOX = { packaging: 'medium_box', lengthMm: 500, widthMm: 400, heightMm: 400, weightGrams: 12_000 };

// ── 1. The lane now carries its countries ─────────────────────────────────
const ref = await call('/v1/reference');
const mel = ref.body.lanes.find((l) => l.code === 'LKCMB-AUMEL');
check('the lane carries both countries',
  mel?.fromCountry === 'LK' && mel?.toCountry === 'AU',
  `LKCMB-AUMEL: ${mel?.from}/${mel?.fromCountry} → ${mel?.to}/${mel?.toCountry}`);

await call('/v1/customer/sign-in', {
  method: 'POST',
  body: { email: 'nadeesha@example.lk', password: 'a long enough passphrase' },
});

// ── 2. The booking that caused the bug is now impossible ──────────────────
const bad = await call('/v1/bookings', {
  method: 'POST',
  body: { lane: 'LKCMB-AUMEL', service: 'sea_lcl', pieces: [BOX], sender: LK, receiver: LK },
});
check('a Melbourne lane with a Sri Lankan receiver is refused at booking',
  bad.status === 400 && bad.code === 'receiver_off_lane',
  `${bad.status} ${bad.code} — ${bad.message}`);

// ── 3. A real suburb that is not the port still books, and still loads ────
const good = await call('/v1/bookings', {
  method: 'POST',
  body: {
    lane: 'LKCMB-AUMEL', service: 'sea_lcl', pieces: [BOX],
    sender: LK,
    receiver: party('Geelong', 'AU', '+61412345678', '3220'),
  },
});
const reference = good.body?.booking?.reference;
check('a Geelong address on the Melbourne lane is accepted',
  good.status < 300 && Boolean(reference),
  `${good.status} ${reference ?? JSON.stringify(good.body).slice(0, 120)}`);

jar.clear();
await call('/v1/auth/login', {
  method: 'POST',
  body: { email: 'supervisor@cargoflow.test', password: 'cargoflow' },
});

const received = await call(`/v1/depot/bookings/${reference}/receive`, { method: 'POST', body: {} });
const trackingId = received.body?.received?.[0]?.trackingId;
await call(`/v1/depot/pieces/${trackingId}/verify`, { method: 'POST', body: BOX });

const load = await call('/v1/containers/CFLU%20400%20002/load', {
  method: 'POST',
  body: { trackingIds: [trackingId] },
});
const refused = load.body?.refused ?? [];
check('that box loads into the Melbourne container (the old code refused it)',
  load.status < 300 && refused.length === 0,
  refused.length
    ? `refused: ${refused.map((r) => r.reason).join('; ')}`
    : `${load.status} — loaded ${trackingId} into CFLU 400 002`);

// ── 4. A box on a different lane is still refused, by PORT not suburb ────
// BK-26-0003 is the Brisbane lane. Received and measured exactly as declared,
// so nothing holds it — the only thing that may refuse it is the port.
const brisbane = await call('/v1/depot/bookings/BK-26-0003/receive', { method: 'POST', body: {} });
const bneId = brisbane.body?.received?.[0]?.trackingId;
await call(`/v1/depot/pieces/${bneId}/verify`, {
  method: 'POST',
  body: { lengthMm: 1200, widthMm: 800, heightMm: 900, weightGrams: 180_000 },
});

const wrongShip = await call('/v1/containers/CFLU%20400%20002/load', {
  method: 'POST',
  body: { trackingIds: [bneId] },
});
const why = wrongShip.body?.refused?.[0]?.reason ?? '';
check('a Brisbane-lane box is refused from the Melbourne container, by port',
  why === 'Sailing to Brisbane, not Melbourne',
  `${bneId}: ${why || JSON.stringify(wrongShip.body).slice(0, 140)}`);

console.log(failures === 0 ? '\n  all checks passed' : `\n  ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
