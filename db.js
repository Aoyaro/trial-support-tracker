// SQLite persistence layer using Node's built-in node:sqlite (zero native deps).
// Requires Node >= 22.5 (--experimental-sqlite on 22.x; unflagged on 23+).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'trial.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  caller_name TEXT,
  caller_phone TEXT,
  caller_role TEXT CHECK (caller_role IN ('technician','engineer','client')),
  nature_of_call TEXT,
  issue_description TEXT,
  troubleshooting_steps TEXT,
  solution_offered TEXT,
  solved INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','escalated')),
  site_name TEXT,
  client TEXT,
  location_text TEXT,
  latitude REAL,
  longitude REAL
);

CREATE TABLE IF NOT EXISTS location_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  technician_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_locreq_token ON location_requests(token);
`);

function rowToIssue(row) {
  if (!row) return null;
  return { ...row, solved: !!row.solved };
}

const Issues = {
  create(data) {
    const info = db.prepare(`
      INSERT INTO issues (caller_name, caller_phone, caller_role, nature_of_call,
        issue_description, troubleshooting_steps, solution_offered, solved, status,
        site_name, client, location_text, latitude, longitude)
      VALUES (@caller_name, @caller_phone, @caller_role, @nature_of_call,
        @issue_description, @troubleshooting_steps, @solution_offered, @solved, @status,
        @site_name, @client, @location_text, @latitude, @longitude)`).run({
      caller_name: data.caller_name || null,
      caller_phone: data.caller_phone || null,
      caller_role: data.caller_role || null,
      nature_of_call: data.nature_of_call || null,
      issue_description: data.issue_description || null,
      troubleshooting_steps: data.troubleshooting_steps || null,
      solution_offered: data.solution_offered || null,
      solved: data.solved ? 1 : 0,
      status: data.status || 'pending',
      site_name: data.site_name || null,
      client: data.client || null,
      location_text: data.location_text || null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
    });
    return Issues.get(Number(info.lastInsertRowid));
  },

  get(id) {
    return rowToIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(id));
  },

  list({ q, status } = {}) {
    let sql = 'SELECT * FROM issues';
    const where = [];
    const params = [];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (q) {
      where.push(`(issue_description LIKE ? OR troubleshooting_steps LIKE ? OR solution_offered LIKE ?
        OR nature_of_call LIKE ? OR site_name LIKE ? OR client LIKE ? OR caller_name LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like, like, like, like, like);
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY id DESC';
    return db.prepare(sql).all(...params).map(rowToIssue);
  },

  update(id, data) {
    const allowed = ['caller_name','caller_phone','caller_role','nature_of_call','issue_description',
      'troubleshooting_steps','solution_offered','solved','status','site_name','client',
      'location_text','latitude','longitude'];
    const sets = [];
    const params = {};
    for (const key of allowed) {
      if (key in data) {
        sets.push(`${key} = @${key}`);
        params[key] = key === 'solved' ? (data[key] ? 1 : 0) : (data[key] ?? null);
      }
    }
    if (!sets.length) return Issues.get(id);
    db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = @id`).run({ ...params, id });
    return Issues.get(id);
  },

  remove(id) {
    return Number(db.prepare('DELETE FROM issues WHERE id = ?').run(id).changes);
  },

  setLocation(id, latitude, longitude) {
    db.prepare('UPDATE issues SET latitude = ?, longitude = ? WHERE id = ?').run(latitude, longitude, id);
    return Issues.get(id);
  },

  counts() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM issues GROUP BY status').all();
    const counts = { pending: 0, resolved: 0, escalated: 0, total: 0 };
    for (const r of rows) {
      counts[r.status] = Number(r.n);
      counts.total += Number(r.n);
    }
    return counts;
  },
};

function newToken() {
  // URL-safe random token, unique per request.
  return crypto.randomBytes(16).toString('base64url');
}

const LocationRequests = {
  create(issueId, technicianPhone) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const token = newToken();
        const info = db.prepare(`
          INSERT INTO location_requests (token, issue_id, technician_phone)
          VALUES (?, ?, ?)`).run(token, issueId, technicianPhone);
        return LocationRequests.getById(Number(info.lastInsertRowid));
      } catch (e) {
        if (!/UNIQUE/i.test(e.message)) throw e;
      }
    }
    throw new Error('Could not generate a unique location request token');
  },

  getById(id) {
    return db.prepare('SELECT * FROM location_requests WHERE id = ?').get(id);
  },

  getByToken(token) {
    return db.prepare('SELECT * FROM location_requests WHERE token = ?').get(token);
  },

  getByIssue(issueId) {
    return db.prepare('SELECT * FROM location_requests WHERE issue_id = ? ORDER BY id DESC').all(issueId);
  },

  markSent(id) {
    db.prepare(`UPDATE location_requests SET status = 'sent' WHERE id = ? AND status = 'pending'`).run(id);
    return LocationRequests.getById(id);
  },

  complete(token, latitude, longitude) {
    const req = LocationRequests.getByToken(token);
    if (!req) return { error: 'not_found' };
    if (req.status === 'completed') return { error: 'already_completed', request: req };
    if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
        !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { error: 'invalid_coordinates' };
    }
    db.prepare(`UPDATE location_requests
      SET status = 'completed', completed_at = datetime('now')
      WHERE token = ?`).run(token);
    Issues.setLocation(req.issue_id, latitude, longitude);
    return { request: LocationRequests.getByToken(token), issue: Issues.get(req.issue_id) };
  },
};

module.exports = { db, Issues, LocationRequests };
