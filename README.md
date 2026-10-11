# Remote Support Issue Tracker — Trial Backend

Trial backend prototype for a water & energy solutions support department.
Support engineers log remote-support calls; technicians receive a magic link,
tap **“Share my location”** on their phone, and the GPS coordinates land back
on the issue. WhatsApp sending works two ways:

- **Out of the box (trial default):** the server generates a `wa.me` link with
  the message pre-filled — you tap it, WhatsApp opens, you press send.
- **Fully automatic:** configure WhatsApp Cloud API credentials and the server
  sends the message itself via Meta's API (see §6).

Stack: **Node.js + Express**, **SQLite** (built into Node via `node:sqlite` —
no native modules, no external services). Server-rendered support UI + a
mobile-friendly technician page.

## 1. Run locally (single command)

Requirements: Node.js **22.5+** (Node 23+ recommended; on 22.x start with
`node --experimental-sqlite server.js`).

```bash
npm install && npm start
```

Then open http://localhost:3000

Run the automated checks (integration + WhatsApp unit tests, Meta API mocked —
no real network calls):

```bash
npm test
```

## 2. Environment variables

Copy `.env.example` to `.env` and adjust:

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port |
| `DB_PATH` | no | `./data/trial.db` | SQLite file location |
| `BASE_URL` | no | built from request | Public URL used in technician magic links. **Set this in production**, e.g. `https://trial-support-tracker.onrender.com` — otherwise links are built from the incoming request host. |
| `WHATSAPP_PHONE_NUMBER_ID` | no | — | WhatsApp Cloud API Phone Number ID (§6). If unset, sends fall back to `wa.me` links. |
| `WHATSAPP_TOKEN` | no | — | WhatsApp Cloud API permanent token (§6). If unset, sends fall back to `wa.me` links. |

## 3. Trial flow end-to-end

1. **Log an issue** — open the app, click **+ Log issue**, fill in caller
   details (technician / engineer / client), the site section (site name,
   client, location text), then nature of call, issue description,
   troubleshooting steps, solution offered, solved?, and status
   (pending / resolved / escalated). Save.
2. **Generate a location request** — open the issue detail, enter the
   technician's phone number in international format (e.g. `254712345678`),
   click **Generate location request**. You get:
   - a magic link like `https://<your-app>/t/<token>`,
   - the message text,
   - either “sent automatically via WhatsApp” (API configured) or a
     tap-to-open WhatsApp link with the message pre-filled (trial default).
3. **Technician opens the link** on their smartphone → sees the site name and
   client → taps **Share my location** → allows location access when the
   phone asks.
4. **Location saved** — coordinates are stored on the issue; the issue detail
   shows them with an **Open in Google Maps** link. The request is marked
   completed and the link can't be reused.

Keyword search (issue description, troubleshooting steps, solution, site,
client, caller) and status filters with counts are on the main list.

## 4. Deploy to Render (free tier) with Docker

1. Push this folder to a GitHub repo.
2. In Render: **New → Web Service →** select the repo.
   - **Runtime:** Docker (Render auto-detects the `Dockerfile`).
   - **Instance type:** Free.
   - **Environment variables:** set `BASE_URL` to your Render URL
     (e.g. `https://trial-support-tracker.onrender.com`). Add the WhatsApp
     vars from §6 only if you want automatic sending.
3. Deploy. Health check: `GET /health`.

> ⚠️ Free-tier disks are **ephemeral**: the SQLite database resets on
> redeploy/restart. Fine for a trial; for production use Render's paid disk
> or move to a managed database (Postgres).

## 5. API reference (JSON)

| Method & path | Purpose |
|---|---|
| `POST /api/issues` | Create issue |
| `GET /api/issues?q=&status=` | List + keyword search + status filter (returns `{issues, counts}`) |
| `GET /api/issues/:id` | Issue detail + its location requests |
| `PUT /api/issues/:id` | Update issue |
| `DELETE /api/issues/:id` | Delete issue |
| `POST /api/issues/:id/location-requests` `{technician_phone}` | Create request → `{request, magic_link, message_text, whatsapp:{auto_sent, fallback_url, …}}` |
| `GET /api/issues/:id/location-requests` | List requests for an issue |
| `GET /api/location-requests/:token` | Token info for the technician page |
| `POST /api/location-requests/:token/complete` `{latitude, longitude}` | Technician submits GPS; stores coords on the issue |
| `GET /t/:token` | Technician mobile page |
| `GET /health` | Health check |

## 6. What Meta/WhatsApp Cloud API setup is still needed for fully automatic sending

The trial's tap-to-open `wa.me` flow needs **nothing** from Meta. For the
server to send WhatsApp messages by itself (no WhatsApp app opening), you
must complete all of the following — none of it can be done from inside this
codebase:

1. **Meta Developer account** — create an app at developers.facebook.com.
2. **Meta Business Manager** — a verified business (business verification is
   required before production use; test numbers work in development mode).
3. **WhatsApp Business Account (WABA)** — created inside Business Manager and
   linked to the Meta app.
4. **A dedicated phone number** — either a new number, or migrate your
   existing WhatsApp Business number into the Cloud API. ⚠️ Once migrated,
   that number **stops working in the WhatsApp / WhatsApp Business phone
   app** — it becomes API-only.
5. **Permanent access token** — create a system user in Business Manager,
   assign it the WhatsApp permissions, and generate a long-lived token. Put it
   in `WHATSAPP_TOKEN` (never commit it to git).
6. **Phone Number ID** — shown in the WhatsApp dashboard for the number;
   put it in `WHATSAPP_PHONE_NUMBER_ID`.
7. **Message template** — business-initiated messages (like the location
   request) must use a **pre-approved template** in the `utility` category.
   The current code sends free-form `text` messages, which only works within
   the 24-hour customer-service window (i.e. after the technician messages
   you first). For cold outreach, switch `whatsapp.js` to send the approved
   template via the `template` message type.
8. **Costs** — Meta charges per conversation (per 24h window), rates vary by
   country/category. Kenya utility-template pricing applies; check Meta's
   current rate card.

Until those are in place, leave `WHATSAPP_PHONE_NUMBER_ID` /
`WHATSAPP_TOKEN` unset: the app logs a warning and hands you the `wa.me`
fallback link, so the whole trial flow works end-to-end.

## 7. Project layout

```
server.js            Express app + all routes
db.js                SQLite schema + data access (issues, location_requests)
whatsapp.js          Cloud API sender with wa.me fallback
public/index.html    Support UI (list, search, log form, issue detail)
public/tech.html     Technician magic-link page (geolocation)
test/run-tests.js    Integration + unit tests (Meta API mocked)
Dockerfile           Render-ready container (node:24-slim)
.env.example         Env template
```

## 8. Trial limitations (by design)

- Single shared SQLite file — fine for a small trial team, not for heavy
  concurrent use.
- No login/auth — anyone with the URL can use the support UI. Add auth
  before any real deployment.
- Location requests are single-use bearer links — treat them like temporary
  passwords and send each only to its technician.
- Technician must still tap “Allow” for location — browsers never share GPS
  silently.
