# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the server (`node server.js`)
- `npm run dev` — run with `--watch` for auto-reload
- `./seed-demo.sh` — seed demo data

There are no tests, linter, or build step. The app is a single Node/Express file serving static HTML from `public/`.

## Required env vars

`.env.example` is out of date — the real set the server depends on is:

- `TURSO_URL`, `TURSO_TOKEN` — libSQL/Turso database (the checked-in `checklist.db` is local/legacy; production uses Turso)
- `PORT` — optional, Render sets it
- `RESEND_API_KEY` — Resend API key for the weekly alert email. Without it, the weekly job logs a warning and skips.
- `EMAIL_FROM` — optional sender for the weekly email. Defaults to `Rippner Tennis <onboarding@resend.dev>` (Resend's sandbox sender, which only delivers to the address used to sign up for Resend). Set to a verified domain address (e.g. `alerts@rippnertennis.com`) once a domain is verified at resend.com.
- `ADMIN_EMAIL` — recipient of the weekly alert email. Defaults to `manager@rippnertennis.com`.
- `NOTIFY_TOKEN` — shared secret for the weekly-email trigger endpoints. Required to call `/api/notify/alerts/*`.

Cloudflare in front of the app is the only auth layer. There is no app-level Basic Auth gate or admin key middleware (both were removed); `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` are no longer read by the server.

`EMAIL_USER` / `EMAIL_PASS` were used by an earlier nodemailer/Gmail SMTP implementation but Render's free tier blocks outbound SMTP, so the email path was switched to Resend (HTTPS API). These two vars are no longer read.

## Architecture

Single-process Express app. All server logic lives in `server.js`; the frontend is hand-written HTML files in `public/` that call the JSON API. No framework, no bundler, no build.

### Auth layers

1. Cloudflare in front (external) — the only access gate.
2. Per-IP rate limit (20/hr) on write endpoints via `rateLimit` (`server.js`).
3. `NOTIFY_TOKEN` Bearer token guards the `/api/notify/alerts/*` endpoints.

### Data model (libSQL/Turso)

Five tables, auto-created in `initDB()`:

- `inventory_counts` — point-in-time snapshots. `items` is a JSON blob shaped `{ category: { item: { storage: N, display: M } } }`. Legacy rows may store a bare number instead of the `{storage, display}` object; `readCountItem()` normalizes both shapes on read.
- `inventory_pulls` — movement events. The `type` column distinguishes:
  - `pull` — storage → display (total unchanged)
  - `sale` — display → out (total decreases) — legacy; new UI no longer emits these
  - `receipt` — external shipment into storage (total increases)
  `type` was added later via `ALTER TABLE`; rows with NULL `type` are backfilled to `sale`.
- `inventory_transfers` — between facilities (from/to).
- `pos_reconciliations` — POS-reported sold quantities keyed 1:1 to a count via `count_id UNIQUE`, upserted on POST.
- `app_config` — generic key/value config persistence. Currently stores:
  - `alert_thresholds` — JSON for the alert config (see below).
  - `last_alert_email_sent` — `YYYY-MM-DD` (Central) of the most recent successful weekly email; used to dedup.

### Inventory state computation

`getInventoryState(facility)` is the core read path. It takes the **most recent count** per `count_type` (biweekly, monthly) as a baseline, then applies every pull/sale/receipt/transfer since `submitted_at` to produce an `estimated` current state. Each item tracks `{ storage, display, total }`.

`buildCombinedView(perFacility)` rolls per-facility states into the combined-facility view used for alerts. The combined view is what the dashboard banner and the weekly email both consume.

The category set is split between count types — `biweekly` handles consumables (reels, gut_strings, multifilament, ball_cases, concessions, supplies); `monthly` handles accessories (prime_tour_grips, pro_grips, hydrosorb_pro, wristbands, headbands, hats, dampeners, rackets). This split matters: when you add a category, you must add it to the right list in `getInventoryState` or it won't be aggregated.

### Alerts

Alert config lives in the `app_config` table under key `alert_thresholds`, loaded into the in-memory `ALERT_CONFIG` at boot and reloaded after every successful `POST /api/config/alerts`. `DEFAULT_ALERT_CONFIG` seeds the table on first boot.

Shape:

```js
{
  thresholds: { category: { item: number } },
  groups: [
    {
      id: string,
      category: string,
      label: string,
      multipliers: { item: factor },  // factors > 1 combine packets with loose units
      threshold: number,
    },
  ],
}
```

- **Item thresholds** fire when an item's combined-facility total is ≤ threshold.
- **Group alerts** sum `Σ(item_total × factor)` and fire one alert when the sum is ≤ threshold. Examples:
  - `prime_tour_grips` per color: `color_packets × 3 + color × 1` (replaces the old per-color singleton thresholds).
  - `dampeners`: `packets × 2 + singles × 1`.
  - `polytour_pro_all` (reels): all five Polytour Pro colors with factor 1.

Group alerts are emitted with `group: true`, the group `id`, the `multipliers` map, and the `item` field set to the human-readable label.

"Total" means `storage + display`. Alerts are computed only on the combined-facility view, not per-facility.

### Weekly alert email

`sendWeeklyAlertEmail()` builds the combined-facility alert summary and sends an HTML email via Resend (`RESEND_API_KEY`). Resend was chosen over Gmail SMTP because Render's free tier blocks outbound SMTP on both 465 and 587.

Triggering:

- `POST /api/notify/alerts/test` (Bearer `NOTIFY_TOKEN`) — always sends. For manual testing.
- `POST /api/notify/alerts/scheduled` (Bearer `NOTIFY_TOKEN`) — calls `maybeSendWeeklyAlertEmail()`, which checks: weekday is Friday in `America/Chicago`, hour is 9 (any minute, to absorb cron drift), and `last_alert_email_sent` ≠ today. Only sends if all match. Safe to call repeatedly.
- In-process `setInterval` every 5 minutes also calls `maybeSendWeeklyAlertEmail()`. **This is a no-op on Render free tier** because the dyno sleeps after 15 min idle. Kept because it's harmless on paid tiers and gives a fallback if cron fails.

The dedup key is the Central-time date (`YYYY-MM-DD`), so even if the scheduled endpoint is hit twice (e.g. GitHub Actions firing at both 14:00 and 15:00 UTC to handle DST), only the first one in the 9 AM CT hour sends.

GitHub Actions handles the actual weekly trigger — see `.github/workflows/weekly-alert-email.yml`. It POSTs to `/api/notify/alerts/scheduled` at 14:00 and 15:00 UTC every Friday (= 9 AM CDT and 9 AM CST respectively). The repo needs two GitHub secrets: `APP_URL` (e.g. `https://weekly-checklist.onrender.com`) and `NOTIFY_TOKEN` (matches the Render env var). GitHub disables scheduled workflows after 60 days of repo inactivity — pushes reset that timer.

### Schedule

`COUNT_SCHEDULE` (`server.js`) hardcodes the biweekly/monthly cadence start dates and interval. `getScheduleDates` computes the current period and next-due date. Update the `startDate` values when the cycle resets.

### Facilities

Hardcoded whitelist: `['SATC', 'Pharr', 'Wilco']`. Adding a facility is a one-line change but every existing count/pull/transfer endpoint validates against this array.

## Frontend

Five standalone pages in `public/`:
- `index.html` — home, shows schedule + links.
- `biweekly.html`, `monthly.html` — count-entry forms.
- `pull.html` — pull / receipt / transfer activity logging.
- `admin.html` — dashboard. No separate auth (Cloudflare gates it). Renders derived totals for water (cases × 24 + loose bottles) and Prime Tour / Pro grips (packets × 3 + loose grips) as footer rows under their categories. Header has a `⚙ Alerts` link to the config page.
- `config.html` — alert threshold editor. Hides categories whose alerts are managed via groups (`prime_tour_grips`, `dampeners`, `rackets`) and the Polytour Pro item rows within `reels`. Hidden values are preserved on save (form rebuilds the visible portion of `thresholds` only).

All pages POST/GET the `/api/*` endpoints directly with `fetch`. No shared JS bundle — each page inlines what it needs. The catalog (item display names) is duplicated across `monthly.html`, `pull.html`, `admin.html`, `config.html`, and `server.js` (`ITEM_LABELS`/`CATEGORY_LABELS` for the email). When adding a new item, update all five.

## Deployment

Render (`render.yaml`) for the web service. Production env vars set in the Render dashboard:
- `TURSO_URL`, `TURSO_TOKEN`
- `RESEND_API_KEY`, `ADMIN_EMAIL`, `NOTIFY_TOKEN` (and optionally `EMAIL_FROM`).

The `disk` mount at `/data` in `render.yaml` is a leftover from the SQLite-file era and is no longer used by the code.

GitHub Actions (`.github/workflows/weekly-alert-email.yml`) drives the Friday email. Required GitHub repo secrets: `APP_URL`, `NOTIFY_TOKEN`.

## Count-form quirks

- String categories (`reels`, `gut_strings`, `multifilament`) accept `0.5` increments; everything else is integer-only. Enforced both client-side (count form) and server-side (`sanitizeItems` in `server.js`).
- `ball_cases` uses storage-only (no display column on the count form) — schema flag is `storageOnly: true` on the card.
- `supplies.hand_soap` is also a 0.5-increment, storage-only item (added to `DECIMAL_ITEMS`).

## Database scripts

`scripts/db-*.js` — one-off maintenance scripts. Each uses `@libsql/client` via the same `TURSO_URL`/`TURSO_TOKEN` env vars; run with `node -r dotenv/config scripts/<name>.js`. When passing args:[] is empty, set `args: []` explicitly — `db.execute({ sql })` without an `args` field throws `TypeError: Cannot convert undefined or null to object` in `@libsql/client` 0.14.
