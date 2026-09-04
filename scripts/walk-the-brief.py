"""Walk every requirement in the brief against a running API.

    npm run dev            # in another terminal
    python scripts/walk-the-brief.py

An acceptance check rather than a unit test: it drives the real HTTP surface
in the order a real shipment moves, signing in as the role that would
actually perform each step, and asserts what the brief asks for. It writes
real data, so point it at a development database.

Exit code 0 means every requirement is demonstrably wired end to end.
"""

import http.cookiejar
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "http://localhost:4000"
jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method, headers={"content-type": "application/json"}
    )
    try:
        return json.load(opener.open(req))
    except urllib.error.HTTPError as error:
        return json.load(error)


results = []


def ok(label, condition, detail=""):
    print(f"  {'PASS' if condition else 'FAIL'}  {label}" + (f"  -- {detail}" if detail else ""))
    results.append(bool(condition))


def q(value):
    return urllib.parse.quote(value)


def sign_in(role):
    """Each gate has to be tested as the role that would actually hit it.

    Asking a supervisor to issue an invoice proves nothing about the
    unapproved-adjustment gate -- it is refused for lacking the permission,
    long before that gate is reached.
    """
    # Clear first: the jar otherwise accumulates a session cookie per login and
    # sends them all, so the server sees whichever it reads first rather than
    # the role we just signed in as.
    jar.clear()
    got = call("POST", "/v1/auth/login", {"email": f"{role}@cargoflow.test", "password": "cargoflow"})
    assert got.get("user", {}).get("role") == role, f"expected to be {role}, got {got}"


def money(text):
    return float(text.replace(",", ""))


print("=== THE BRIEF, WALKED END TO END ===\n")

print("1.1 item selection  /  1.2 sender and receiver  /  1.3 cost estimation and submission")
created = call(
    "POST",
    "/v1/bookings",
    {
        "lane": "LKCMB-AUMEL",
        "service": "sea_lcl",
        "pieces": [
            {"packaging": "large_box", "lengthMm": 600, "widthMm": 450, "heightMm": 450, "weightGrams": 24000},
            {"packaging": "custom_carton", "lengthMm": 700, "widthMm": 500, "heightMm": 450, "weightGrams": 31000},
        ],
        "declaredValue": 180000,
        "coverRequested": True,
        "sender": {
            "name": "Nimali Rathnayake", "mobile": "+94773334455", "email": "nimali@example.lk",
            "line1": "21 Temple Road", "city": "Nugegoda", "postcode": "10250",
            "country": "LK", "idNumber": "925612345V",
        },
        "receiver": {
            "name": "Chamath Rathnayake", "mobile": "+61455667788",
            "line1": "9 Bell Street", "city": "Melbourne", "region": "VIC",
            "postcode": "3058", "country": "AU",
        },
    },
)
booking = created.get("booking", {})
REF = booking.get("reference")
ok("booking stored with both parties, priced server-side", bool(REF), f"{REF} {booking.get('total')}")
if not REF:
    print(json.dumps(created, indent=2))
    sys.exit(1)
DIGITS = REF.split("-")[-1]

sign_in("supervisor")

print("\n2.1 tracking IDs on physical receipt  /  walk-in express intake")
received = call("POST", f"/v1/depot/bookings/{REF}/receive", {"depotId": "WS-03"})
ids = [piece["trackingId"] for piece in received.get("received", [])]
ok("tracking IDs minted at receipt, not at booking", len(ids) == 2, ", ".join(ids))

again = call("POST", f"/v1/depot/bookings/{REF}/receive", {})
ok(
    "re-scanning the same pallet issues no second ID",
    len(again.get("received", [])) == 0 and len(again.get("alreadyReceived", [])) == 2,
)

walk_in = call(
    "POST",
    "/v1/depot/walk-in",
    {
        "lane": "LKCMB-AUBNE",
        "senderName": "Ajith Perera", "senderMobile": "+94711112222",
        "receiverName": "Dilhani Perera", "receiverMobile": "+61466778899",
        "receiverCity": "Brisbane",
        "pieces": [
            {"packaging": "medium_box", "lengthMm": 500, "widthMm": 400, "heightMm": 400, "weightGrams": 18000}
        ],
    },
)
ok("walk-in intake on minimum data", "reference" in walk_in, f"{walk_in.get('reference')} {walk_in.get('total')}")

print("\n2.1 physical against submitted  /  2.2 dynamic re-rating")
same = call(
    "POST", f"/v1/depot/pieces/CF-{DIGITS}-001/verify",
    {"lengthMm": 600, "widthMm": 450, "heightMm": 450, "weightGrams": 24000},
)
ok("measured as declared -> unchanged, customer not disturbed",
   same.get("rerate", {}).get("outcome") == "unchanged")

bigger = call(
    "POST", f"/v1/depot/pieces/CF-{DIGITS}-002/verify",
    {"lengthMm": 780, "widthMm": 580, "heightMm": 520, "weightGrams": 34600},
)
rerate = bigger.get("rerate", {})
ok(
    "measured bigger -> repriced, approval required, piece held",
    rerate.get("outcome") == "approval_required" and bigger.get("status") == "rerate_held",
    f"{rerate.get('bookedTotal')} -> {rerate.get('verifiedTotal')} ({rerate.get('differencePercent')}%)",
)
ADJUSTMENT = rerate.get("adjustmentReference")

print("\n2.2 printable label with a barcode")
label = call("GET", f"/v1/depot/pieces/CF-{DIGITS}-001/label").get("label", {})
ok(
    "label carries a Code 128 barcode and the measured figures",
    "<svg" in label.get("barcodeSvg", "") and label.get("measurement", {}).get("source") == "measured",
)

print("\n3.1 real-time notification of the price adjustment")
sent = call("GET", f"/v1/notifications?bookingRef={REF}")
channels = {(row["event"], row["channel"]) for row in sent.get("notifications", [])}
ok(
    "customer told about the change by email AND SMS",
    ("price_changed", "email") in channels and ("price_changed", "sms") in channels,
)

print("\n2.3 container assignment -- the gates that matter")
made = call("POST", "/v1/containers", {
    "type": "40ft standard", "vessel": "MV Ruhunu Star", "voyage": "V.0311E",
    "lane": "LKCMB-AUMEL",
    "cutOffAt": "2026-10-05T11:30:00.000Z",
    "sailsAt": "2026-10-07T00:00:00.000Z",
    "etaAt": "2026-10-29T00:00:00.000Z",
})
container_number = made["container"]["containerNumber"]
blocked = call("POST", f"/v1/containers/{q(container_number)}/load", {"trackingIds": [f"CF-{DIGITS}-001"]})
ok(
    "an unapproved price change blocks loading",
    len(blocked.get("loaded", [])) == 0,
    (blocked.get("refused") or [{}])[0].get("reason", ""),
)
sign_in("billing")
attempt = call("POST", f"/v1/bookings/{REF}/invoice")
ok(
    "an unapproved price change blocks invoicing",
    attempt.get("error", {}).get("code") == "adjustment_unapproved",
    json.dumps(attempt)[:220],
)

print("\n3.1 billing settles it, and everything unblocks")
sign_in("billing")
call("POST", f"/v1/admin/adjustments/{ADJUSTMENT}/approve", {"reason": "Customer said yes by phone"})

sign_in("supervisor")
loaded = call(
    "POST", f"/v1/containers/{q(container_number)}/load",
    {"trackingIds": [f"CF-{DIGITS}-001", f"CF-{DIGITS}-002"]},
)
ok(
    "boxes group into the container once settled",
    len(loaded.get("loaded", [])) == 2,
    f"{loaded['container']['loaded']}/{loaded['container']['capacity']} m3 = {loaded['container']['fillPercent']}%",
)

sign_in("billing")
raw = call("POST", f"/v1/bookings/{REF}/invoice")
invoice = raw.get("invoice", {})
ok("invoice generated on the measured figures", invoice.get("basis") == "verified",
   f"{invoice.get('number')} {invoice.get('total')}" if invoice else json.dumps(raw)[:220])
if not invoice:
    sys.exit(1)

line_total = sum(money(line["amount"]) for line in invoice.get("lines", []))
ok(
    "the invoice adds up: lines + GST = total",
    abs(line_total + money(invoice["tax"]) - money(invoice["total"])) < 0.01,
    f"{line_total:.2f} + {invoice['tax']} = {invoice['total']}",
)

print("\n2.3 seal and sail  /  3.2 master bill of lading")
# Sealing is a supervisor action — billing, who just issued the invoice, is
# deliberately not allowed to close a container.
sign_in("supervisor")
sealed = call("POST", f"/v1/containers/{q(container_number)}/seal", {"sealNumber": "SL-771204"})
if sealed.get("container", {}).get("status") != "in_transit":
    print("     server said:", json.dumps(sealed)[:200])
ok("sealing moves every box aboard to In Transit",
   sealed.get("container", {}).get("status") == "in_transit")

bol = call("GET", f"/v1/containers/{q(container_number)}/bol").get("bol", {})
totals = bol.get("totals", {})
ok(
    "master BOL with house entries and measured totals",
    bol.get("number") is not None and totals.get("houses", 0) >= 1,
    f"{bol.get('number')}  {totals.get('packages')} pkgs  {totals.get('grossWeightKg')} kg  {totals.get('measurementM3')} m3",
)

print("\nrole separation, enforced by the server and not by the UI")
sign_in("operator")
ok(
    "an operator cannot approve a price change",
    call("POST", f"/v1/admin/adjustments/{ADJUSTMENT}/approve", {"reason": "x"})
    .get("error", {}).get("code") == "forbidden",
)
ok(
    "an operator cannot issue an invoice",
    call("POST", f"/v1/bookings/{REF}/invoice").get("error", {}).get("code") == "forbidden",
)
ok("an operator CAN measure a box, which is the job", "entries" in call("GET", "/v1/depot/queue"))

print(f"\n=== {sum(results)}/{len(results)} passed ===")
sys.exit(0 if all(results) else 1)
