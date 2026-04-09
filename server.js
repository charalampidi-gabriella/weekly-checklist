require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const { Resend } = require('resend');
const path = require('path');

const app = express();
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN
});

// ── Schema ────────────────────────────────────────────────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS submissions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      facility          TEXT    NOT NULL,
      submitted_by      TEXT    NOT NULL,
      submitted_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      week_of           TEXT    NOT NULL,
      bathrooms_clean   INTEGER NOT NULL,
      windscreens_up    INTEGER NOT NULL,
      windscreen_courts TEXT,
      inventory         TEXT NOT NULL,
      notes             TEXT
    )
  `);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting (max 10 submits per IP per hour) ────────────────────────────
const submitCounts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = submitCounts.get(ip) || { count: 0, reset: now + 3600000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 3600000; }
  if (entry.count >= 10) return res.status(429).json({ error: 'Too many submissions. Try again later.' });
  entry.count++;
  submitCounts.set(ip, entry);
  next();
}

// ── Admin key middleware ───────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /api/submit ──────────────────────────────────────────────────────────
app.post('/api/submit', rateLimit, async (req, res) => {
  const {
    facility, submitted_by,
    bathrooms_clean, windscreens_up, windscreen_courts,
    inventory, notes
  } = req.body;

  const validFacilities = ['SATC', 'Pharr', 'Wilco'];
  if (!facility || !validFacilities.includes(facility)) {
    return res.status(400).json({ error: 'Invalid facility' });
  }
  if (!submitted_by || typeof submitted_by !== 'string' || submitted_by.trim().length === 0) {
    return res.status(400).json({ error: 'submitted_by is required' });
  }
  if (submitted_by.length > 100) return res.status(400).json({ error: 'Name too long' });
  if (notes && notes.length > 1000) return res.status(400).json({ error: 'Notes too long' });
  if (windscreen_courts && windscreen_courts.length > 500) return res.status(400).json({ error: 'Courts field too long' });
  // Sanitize inventory: values must be non-negative integers
  const cleanInventory = {};
  for (const [k, v] of Object.entries(inventory || {})) {
    const n = parseInt(v);
    cleanInventory[String(k).slice(0, 100)] = isNaN(n) || n < 0 ? 0 : n;
  }

  const week_of = getWeekOf();

  const result = await db.execute({
    sql: `INSERT INTO submissions
            (facility, submitted_by, week_of, bathrooms_clean, windscreens_up, windscreen_courts, inventory, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      facility,
      submitted_by,
      week_of,
      bathrooms_clean ? 1 : 0,
      windscreens_up  ? 1 : 0,
      windscreen_courts || null,
      JSON.stringify(cleanInventory),
      notes || null
    ]
  });

  res.json({ success: true, id: Number(result.lastInsertRowid) });

  sendEmail({ facility, submitted_by, week_of, bathrooms_clean, windscreens_up, windscreen_courts, inventory: cleanInventory, notes })
    .catch(e => console.error('Email failed:', e.message));
});

// ── GET /api/submissions ──────────────────────────────────────────────────────
app.get('/api/submissions', requireAdmin, async (req, res) => {
  const { week, facility } = req.query;
  let sql = 'SELECT * FROM submissions WHERE 1=1';
  const args = [];

  if (week)     { sql += ' AND week_of = ?';  args.push(week); }
  if (facility) { sql += ' AND facility = ?'; args.push(facility); }

  sql += ' ORDER BY submitted_at DESC';

  const result = await db.execute({ sql, args });
  res.json(result.rows.map(r => ({ ...r, inventory: JSON.parse(r.inventory) })));
});

// ── GET /api/weeks ────────────────────────────────────────────────────────────
app.get('/api/weeks', requireAdmin, async (req, res) => {
  const result = await db.execute('SELECT DISTINCT week_of FROM submissions ORDER BY week_of DESC');
  res.json(result.rows.map(r => r.week_of));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getWeekOf() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  return monday.toISOString().split('T')[0];
}

async function sendEmail({ facility, submitted_by, week_of, bathrooms_clean, windscreens_up, windscreen_courts, inventory, notes }) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;

  const resend = new Resend(process.env.RESEND_API_KEY);

  const inventoryRows = Object.entries(inventory || {})
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${k}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600">${v}</td></tr>`)
    .join('');

  const maintenanceRows = [
    { label: 'Bathrooms clean', ok: bathrooms_clean, note: null },
    { label: 'Windscreens up',  ok: windscreens_up,  note: !windscreens_up && windscreen_courts ? `Courts needing help: ${windscreen_courts}` : null }
  ].map(({ label, ok, note }) => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #eee">${label}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee">
        ${ok ? '✅ Yes' : '❌ No'}
        ${note ? `<br><span style="color:#888;font-size:13px">${note}</span>` : ''}
      </td>
    </tr>`).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#2c7a3e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">Weekly Report — ${facility}</h2>
        <p style="margin:4px 0 0;opacity:.85">Week of ${week_of} &nbsp;·&nbsp; Submitted by ${submitted_by}</p>
      </div>
      <div style="background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;padding:24px">
        <h3 style="color:#2c7a3e;margin-top:0">Maintenance</h3>
        <table style="width:100%;border-collapse:collapse">${maintenanceRows}</table>
        <h3 style="color:#2c7a3e;margin-top:24px">Inventory</h3>
        ${inventoryRows
          ? `<table style="width:100%;border-collapse:collapse"><tr><th style="text-align:left;padding:6px 12px;background:#f5f5f5">Item</th><th style="text-align:left;padding:6px 12px;background:#f5f5f5">Count</th></tr>${inventoryRows}</table>`
          : '<p style="color:#888">No inventory entered.</p>'}
        ${notes ? `<h3 style="color:#2c7a3e;margin-top:24px">Notes</h3><p style="background:#f9f9f9;padding:12px;border-radius:6px">${notes}</p>` : ''}
      </div>
    </div>`;

  await resend.emails.send({
    from: 'Facility Checklist <onboarding@resend.dev>',
    to: process.env.ADMIN_EMAIL,
    subject: `[${facility}] Weekly Checklist — ${week_of} (${submitted_by})`,
    html
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Checklist app running on http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
