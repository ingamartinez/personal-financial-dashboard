# iOS Shortcuts — Findash

iOS automations that feed transactions into Findash via authenticated webhooks.

> **Prerequisites**
>
> - iPhone on iOS 17 or later (Transaction trigger requires iOS 17+).
> - Findash reachable over Tailscale (e.g. `https://ia-server.tailcabcc8.ts.net:3100`).
> - A per-user webhook token minted via `/settings/webhooks` (one per purpose: `debug` for the discovery shortcut, `sms` for the SMS ingest shortcut). The plaintext is shown only once — paste it into the Shortcut immediately.

---

## Shortcut 1: Discovery — Capture raw Transaction payloads

**Purpose (issue #39)**: Apple's documentation does not specify what fields the Transaction automation trigger actually exposes (`Card or Pass`, `Merchant`, `Amount` are confirmed, but the string format for card, whether currency/date/category are included, etc. vary by bank and iOS version). This shortcut captures EVERY available field from real purchases so we can design the final `/api/ingest/apple-pay` contract (#11) with real data, not guesses.

The endpoint `/api/ingest/debug` stores the full request (headers + body) in the `ingestion_logs` table with `status='debug'`. No transactions are inserted from this path — it is pure capture.

### Setup

1. Open **Shortcuts → Automation → New Automation → Transaction**.
2. _When I tap_: select **every card** you want to observe. _Any Merchant_, _Any Category_. Enable **Run Immediately**.
3. Add action: **Get Contents of URL**.
   - **URL**: `https://ia-server.tailcabcc8.ts.net:3100/api/ingest/debug`
   - **Method**: `POST`
   - **Headers**:
     - `Authorization` → `Bearer <token>` (paste a token minted for `purpose=debug` at `/settings/webhooks`)
     - `Content-Type` → `application/json`
   - **Request Body**: `JSON` — build an object with every variable available from the Shortcut Input. At minimum:

     ```json
     {
       "cardOrPass": "<Shortcut Input → Card or Pass>",
       "merchant": "<Shortcut Input → Merchant>",
       "amount": "<Shortcut Input → Amount>",
       "capturedAt": "<Current Date>",
       "source": "apple-pay-discovery"
     }
     ```

     **Important**: when you tap the `Shortcut Input` variable inside a JSON field, iOS offers a sub-picker — add **one key per discoverable sub-property** you find. That is precisely what we are trying to learn. If the Card or Pass variable exposes `Name`, `Type`, `Last 4`, etc., send each as its own key:

     ```json
     {
       "cardName": "<Shortcut Input → Card or Pass → Name>",
       "cardType": "<Shortcut Input → Card or Pass → Type>",
       "cardLast4": "<Shortcut Input → Card or Pass → Last Four>",
       "merchant": "<Shortcut Input → Merchant>",
       "amountNumber": "<Shortcut Input → Amount → Number>",
       "amountCurrency": "<Shortcut Input → Amount → Currency>",
       "capturedAt": "<Current Date>",
       "source": "apple-pay-discovery"
     }
     ```

     Fields that do not exist will simply be empty — that is useful negative evidence.

4. Save the automation.

### Verify it works

Make ONE small Apple Pay purchase (even a $1 test), then on the server:

```bash
psql -d findash -c "
  SELECT id, started_at, payload->'bodyParsed'
  FROM ingestion_logs
  WHERE status='debug'
  ORDER BY id DESC
  LIMIT 5;
"
```

You should see your payload. Comment the JSON dump on issue #39.

### Capture goal

Make 3–5 purchases across **different cards** (debit, credit #1, credit #2, e-card) so we see how the Card or Pass string differs per card. Ideally include:

- A physical-card Apple Pay tap (in-store).
- An online Apple Pay checkout (web/app).
- A recurring subscription charge (if Apple Pay is used).
- At least one refund if one happens naturally.

---

## Shortcut 2: SMS Bancolombia

Tracked in issue #12 — not yet implemented.

## Shortcut 3: Apple Pay ingest (post-discovery)

Tracked in issue #11 — blocked on #39 until we know the real payload shape.
