// Trial backend: remote support issue tracker for a water/energy support department.
require('dotenv').config();
const path = require('path');
const express = require('express');
const { Issues, LocationRequests } = require('./db');
const { sendLocationRequest, normalizePhone } = require('./whatsapp');

const app = express();
app.set('trust proxy', 1); // Render / proxies: honor X-Forwarded-Proto for link building
app.use(express.json({ limit: '256kb' }));

const CALLER_ROLES = ['technician', 'engineer', 'client'];
const STATUSES = ['pending', 'resolved', 'escalated'];

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function locationMessage(issue, magicLink) {
  const site = issue.site_name || 'the site';
  const client = issue.client ? ` (${issue.client})` : '';
  return (
    `Hello, this is Remote Support. Please share your GPS location for site: ${site}${client}.\n` +
    `Open this link on your phone and tap "Share my location": ${magicLink}\n` +
    `This link is for this site visit only. Thank you.`
  );
}

// ---------- Support UI ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Technician magic-link page (mobile-friendly).
app.get('/t/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tech.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- JSON API ----------
app.get('/api/stats', (req, res) => res.json(Issues.counts()));

app.post('/api/issues', (req, res) => {
  const b = req.body || {};
  if (b.caller_role && !CALLER_ROLES.includes(b.caller_role)) {
    return res.status(400).json({ error: `caller_role must be one of ${CALLER_ROLES.join(', ')}` });
  }
  if (b.status && !STATUSES.includes(b.status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }
  res.status(201).json(Issues.create(b));
});

app.get('/api/issues', (req, res) => {
  const { q, status } = req.query;
  if (status && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }
  res.json({ issues: Issues.list({ q, status }), counts: Issues.counts() });
});

app.get('/api/issues/:id', (req, res) => {
  const issue = Issues.get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'issue not found' });
  res.json({ issue, location_requests: LocationRequests.getByIssue(issue.id) });
});

app.put('/api/issues/:id', (req, res) => {
  const b = req.body || {};
  if (b.caller_role && !CALLER_ROLES.includes(b.caller_role)) {
    return res.status(400).json({ error: `caller_role must be one of ${CALLER_ROLES.join(', ')}` });
  }
  if (b.status && !STATUSES.includes(b.status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }
  const issue = Issues.get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'issue not found' });
  res.json(Issues.update(req.params.id, b));
});

app.delete('/api/issues/:id', (req, res) => {
  const changes = Issues.remove(req.params.id);
  if (!changes) return res.status(404).json({ error: 'issue not found' });
  res.json({ deleted: true });
});

// Generate a location request for an issue (support engineer flow).
app.post('/api/issues/:id/location-requests', async (req, res) => {
  const issue = Issues.get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'issue not found' });

  const phone = normalizePhone(req.body && req.body.technician_phone);
  if (!phone) return res.status(400).json({ error: 'technician_phone is required (international format, e.g. 254712345678)' });

  const request = LocationRequests.create(issue.id, phone);
  const magicLink = `${baseUrl(req)}/t/${request.token}`;
  const messageText = locationMessage(issue, magicLink);

  // Attempt automatic WhatsApp send; falls back to wa.me URL when unconfigured.
  const whatsapp = await sendLocationRequest(phone, messageText);
  if (whatsapp.autoSent) {
    LocationRequests.markSent(request.id);
  }

  res.status(201).json({
    request: LocationRequests.getById(request.id),
    magic_link: magicLink,
    message_text: messageText,
    whatsapp: {
      auto_sent: whatsapp.autoSent,
      fallback_url: whatsapp.waUrl || null,
      message_id: whatsapp.messageId || null,
      error: whatsapp.error || null,
      note: whatsapp.note || null,
    },
  });
});

app.get('/api/issues/:id/location-requests', (req, res) => {
  const issue = Issues.get(req.params.id);
  if (!issue) return res.status(404).json({ error: 'issue not found' });
  res.json({ location_requests: LocationRequests.getByIssue(issue.id) });
});

// Token info for the technician page (limited fields only).
app.get('/api/location-requests/:token', (req, res) => {
  const lr = LocationRequests.getByToken(req.params.token);
  if (!lr) return res.status(404).json({ error: 'invalid or expired link' });
  const issue = Issues.get(lr.issue_id);
  res.json({
    token: lr.token,
    status: lr.status,
    technician_phone: lr.technician_phone,
    site_name: issue && issue.site_name,
    client: issue && issue.client,
    location_text: issue && issue.location_text,
  });
});

// Technician submits GPS coordinates.
app.post('/api/location-requests/:token/complete', (req, res) => {
  const { latitude, longitude } = req.body || {};
  const result = LocationRequests.complete(req.params.token, latitude, longitude);
  if (result.error === 'not_found') return res.status(404).json({ error: 'invalid or expired link' });
  if (result.error === 'already_completed') {
    return res.status(409).json({ error: 'this link has already been used', request: result.request });
  }
  if (result.error === 'invalid_coordinates') {
    return res.status(400).json({ error: 'latitude/longitude must be valid numbers (-90..90, -180..180)' });
  }
  res.json({ ok: true, request: result.request, issue: result.issue });
});

// Health check (useful for Render).
app.get('/health', (req, res) => res.json({ ok: true }));

// 404 for unknown API routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`trial-support-tracker listening on :${PORT}`));
}
module.exports = app;
