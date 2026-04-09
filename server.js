require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const path = require('path');

const fs = require('fs');

const app = express();
const DB_PATH = process.env.DB_PATH || 'checklist.db';
const DB_DIR = path.dirname(DB_PATH);
if (DB_DIR !== '.' && !fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    facility      TEXT    NOT NULL,
    submitted_by  TEXT    NOT NULL,
    submitted_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    week_of       TEXT    NOT NULL,

    -- Maintenance (1 = yes, 0 = no)
    bathrooms_clean   INTEGER NOT NULL,
    windscreens_up    INTEGER NOT NULL,
    windscreen_courts TEXT,

    -- Inventory stored as JSON so new items need no schema change
    inventory     TEXT NOT NULL,

    -- Free-form notes
    notes         TEXT
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── POST /api/submit ──────────────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  const {
    facility, submitted_by,
    bathrooms_clean, windscreens_up, windscreen_courts,
    inventory, notes
  } = req.body;

  if (!facility || !submitted_by) {
    return res.status(400).json({ error: 'facility and submitted_by are required' });
  }

  const week_of = getWeekOf();

  const stmt = db.prepare(`
    INSERT INTO submissions
      (facility, submitted_by, week_of, bathrooms_clean, windscreens_up, windscreen_courts, inventory, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    facility,
    submitted_by,
    week_of,
    bathrooms_clean ? 1 : 0,
    windscreens_up  ? 1 : 0,
    windscreen_courts || null,
    JSON.stringify(inventory || {}),
    notes || null
  );

  try {
    await sendEmail({ facility, submitted_by, week_of, bathrooms_clean, windscreens_up, windscreen_courts, inventory, notes });
  } catch (e) {
    console.error('Email failed:', e.message);
  }

  res.json({ success: true, id: result.lastInsertRowid });
});

// ── GET /api/submissions ──────────────────────────────────────────────────────
app.get('/api/submissions', (req, res) => {
  const { week, facility } = req.query;
  let query = 'SELECT * FROM submissions WHERE 1=1';
  const params = [];

  if (week)     { query += ' AND week_of = ?';   params.push(week); }
  if (facility) { query += ' AND facility = ?';  params.push(facility); }

  query += ' ORDER BY submitted_at DESC';

  const rows = db.prepare(query).all(...params);
  res.json(rows.map(r => ({ ...r, inventory: JSON.parse(r.inventory) })));
});

// ── GET /api/weeks ────────────────────────────────────────────────────────────
app.get('/api/weeks', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT week_of FROM submissions ORDER BY week_of DESC').all();
  res.json(rows.map(r => r.week_of));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getWeekOf() {
  const d = new Date();
  const day = d.getDay(); // 0 = Sunday
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d);
  monday.setDate(diff);
  return monday.toISOString().split('T')[0];
}

async function sendEmail({ facility, submitted_by, week_of, bathrooms_clean, windscreens_up, windscreen_courts, inventory, notes }) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS || !process.env.ADMIN_EMAIL) return;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });

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

  await transporter.sendMail({
    from: `"Facility Checklist" <${process.env.EMAIL_USER}>`,
    to: process.env.ADMIN_EMAIL,
    subject: `[${facility}] Weekly Checklist — ${week_of} (${submitted_by})`,
    html
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Checklist app running on http://localhost:${PORT}`));
