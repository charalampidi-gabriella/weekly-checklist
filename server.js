require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN
});

const VALID_FACILITIES = ['SATC', 'Pharr', 'Wilco'];

const COUNT_SCHEDULE = {
  biweekly: { startDate: '2026-04-23', intervalDays: 14 },
  monthly:  { startDate: '2026-04-22', intervalDays: 28 },
};

function getScheduleDates(startDate, intervalDays) {
  const msPerDay = 86400000;
  const parts = startDate.split('-').map(Number);
  const startMs = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const toDateStr = ms => new Date(ms).toISOString().slice(0, 10);

  if (todayMs < startMs) {
    return {
      current_period_start: null,
      days_into_period: null,
      next_due: startDate,
      days_until: Math.ceil((startMs - todayMs) / msPerDay),
    };
  }

  const daysSinceStart = Math.floor((todayMs - startMs) / msPerDay);
  const cycleIndex = Math.floor(daysSinceStart / intervalDays);
  const currentDueMs = startMs + cycleIndex * intervalDays * msPerDay;
  const nextDueMs = startMs + (cycleIndex + 1) * intervalDays * msPerDay;

  return {
    current_period_start: toDateStr(currentDueMs),
    days_into_period: Math.floor((todayMs - currentDueMs) / msPerDay),
    next_due: toDateStr(nextDueMs),
    days_until: Math.ceil((nextDueMs - todayMs) / msPerDay),
  };
}

// Alert thresholds: item is "low" when count is AT or BELOW this number
const ALERT_THRESHOLDS = {
  reels: {
    hawk_touch: 3, hawk_tour_rpet: 3, lynx_tour: 3,
    lynx_touch: 3, velocity_mlt: 3, rpm_blast: 4,
  },
  prime_tour_grips: { white: 15, black: 15, pink: 15, blue: 15 },
  pro_grips: { total: 20 },
};

// ── Schema ─────────────────────────────────────────────────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS inventory_counts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      facility     TEXT    NOT NULL,
      count_type   TEXT    NOT NULL,
      submitted_by TEXT    NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      items        TEXT    NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS inventory_pulls (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      facility  TEXT    NOT NULL,
      category  TEXT    NOT NULL,
      item      TEXT    NOT NULL,
      quantity  INTEGER NOT NULL,
      pulled_by TEXT    NOT NULL,
      pulled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes     TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS inventory_transfers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      from_facility    TEXT    NOT NULL,
      to_facility      TEXT    NOT NULL,
      category         TEXT    NOT NULL,
      item             TEXT    NOT NULL,
      quantity         INTEGER NOT NULL,
      transferred_by   TEXT    NOT NULL,
      transferred_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes            TEXT
    )
  `);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ──────────────────────────────────────────────────────────────
const submitCounts = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = submitCounts.get(ip) || { count: 0, reset: now + 3600000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 3600000; }
  if (entry.count >= 20) return res.status(429).json({ error: 'Too many submissions. Try again later.' });
  entry.count++;
  submitCounts.set(ip, entry);
  next();
}

// ── Admin key middleware ────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function sanitizeItems(items) {
  const result = {};
  if (!items || typeof items !== 'object') return result;
  for (const [cat, subItems] of Object.entries(items)) {
    if (typeof subItems !== 'object' || subItems === null) continue;
    const cleanCat = String(cat).slice(0, 50);
    result[cleanCat] = {};
    for (const [itm, val] of Object.entries(subItems)) {
      const n = parseInt(val);
      result[cleanCat][String(itm).slice(0, 100)] = isNaN(n) || n < 0 ? 0 : n;
    }
  }
  return result;
}

// ── POST /api/count ────────────────────────────────────────────────────────────
app.post('/api/count', rateLimit, async (req, res) => {
  try {
    const { facility, count_type, submitted_by, items } = req.body;

    if (!VALID_FACILITIES.includes(facility))
      return res.status(400).json({ error: 'Invalid facility' });
    if (!['biweekly', 'monthly'].includes(count_type))
      return res.status(400).json({ error: 'Invalid count type' });
    if (!submitted_by || typeof submitted_by !== 'string' || submitted_by.trim().length === 0)
      return res.status(400).json({ error: 'Name is required' });
    if (submitted_by.length > 100)
      return res.status(400).json({ error: 'Name too long' });

    const sanitized = sanitizeItems(items);

    await db.execute({
      sql: `INSERT INTO inventory_counts (facility, count_type, submitted_by, items) VALUES (?, ?, ?, ?)`,
      args: [facility, count_type, submitted_by.trim(), JSON.stringify(sanitized)]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/count:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/pull ─────────────────────────────────────────────────────────────
app.post('/api/pull', rateLimit, async (req, res) => {
  try {
    const { facility, category, item, quantity, pulled_by, notes } = req.body;

    if (!VALID_FACILITIES.includes(facility))
      return res.status(400).json({ error: 'Invalid facility' });
    if (!pulled_by || typeof pulled_by !== 'string' || pulled_by.trim().length === 0)
      return res.status(400).json({ error: 'Name is required' });
    if (pulled_by.length > 100)
      return res.status(400).json({ error: 'Name too long' });
    const qty = parseInt(quantity);
    if (!qty || qty < 1 || qty > 10000)
      return res.status(400).json({ error: 'Invalid quantity' });
    if (!category || typeof category !== 'string' || category.length > 50)
      return res.status(400).json({ error: 'Invalid category' });
    if (!item || typeof item !== 'string' || item.length > 100)
      return res.status(400).json({ error: 'Invalid item' });

    const cleanNotes = notes ? String(notes).trim().slice(0, 500) : null;

    await db.execute({
      sql: `INSERT INTO inventory_pulls (facility, category, item, quantity, pulled_by, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [facility, category, item, qty, pulled_by.trim(), cleanNotes]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/pull:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Inventory state helper ─────────────────────────────────────────────────────
async function getInventoryState(facility) {
  const [bwRows, moRows] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM inventory_counts WHERE facility = ? AND count_type = 'biweekly' ORDER BY submitted_at DESC LIMIT 1`,
      args: [facility]
    }),
    db.execute({
      sql: `SELECT * FROM inventory_counts WHERE facility = ? AND count_type = 'monthly' ORDER BY submitted_at DESC LIMIT 1`,
      args: [facility]
    })
  ]);

  const state = {};

  for (const [type, rows] of [['biweekly', bwRows.rows], ['monthly', moRows.rows]]) {
    const categories = type === 'biweekly'
      ? ['reels', 'ball_cases', 'concessions', 'supplies']
      : ['prime_tour_grips', 'pro_grips', 'wristbands', 'headbands', 'rackets'];
    const catPlaceholders = categories.map(() => '?').join(',');

    // No count yet — still show any transfers received so far
    if (rows.length === 0) {
      const trInOnly = await db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_transfers
              WHERE to_facility = ? AND category IN (${catPlaceholders})
              GROUP BY category, item`,
        args: [facility, ...categories]
      });
      if (trInOnly.rows.length === 0) {
        state[type] = null;
      } else {
        const transfersIn = {};
        const estimated  = {};
        for (const row of trInOnly.rows) {
          if (!transfersIn[row.category]) transfersIn[row.category] = {};
          if (!estimated[row.category])   estimated[row.category]   = {};
          transfersIn[row.category][row.item] = Number(row.total);
          estimated[row.category][row.item]   = Number(row.total);
        }
        const alerts = [];
        for (const [cat, thresholds] of Object.entries(ALERT_THRESHOLDS)) {
          if (!estimated[cat]) continue;
          for (const [itm, threshold] of Object.entries(thresholds)) {
            if (estimated[cat][itm] !== undefined && estimated[cat][itm] <= threshold)
              alerts.push({ category: cat, item: itm, threshold, current: estimated[cat][itm] });
          }
        }
        state[type] = { last_count: null, pulls_since: {}, transfers_out: {}, transfers_in: transfersIn, estimated, alerts };
      }
      continue;
    }

    const count = rows[0];
    let items;
    try {
      items = JSON.parse(count.items);
    } catch (e) {
      console.error(`Malformed items JSON in inventory_counts id=${count.id}:`, e.message);
      state[type] = null;
      continue;
    }

    const [pullRows, trOutRows, trInRows] = await Promise.all([
      db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_pulls
              WHERE facility = ? AND category IN (${catPlaceholders}) AND pulled_at > ?
              GROUP BY category, item`,
        args: [facility, ...categories, count.submitted_at]
      }),
      db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_transfers
              WHERE from_facility = ? AND category IN (${catPlaceholders}) AND transferred_at > ?
              GROUP BY category, item`,
        args: [facility, ...categories, count.submitted_at]
      }),
      db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_transfers
              WHERE to_facility = ? AND category IN (${catPlaceholders}) AND transferred_at > ?
              GROUP BY category, item`,
        args: [facility, ...categories, count.submitted_at]
      }),
    ]);

    const pullsSince = {};
    for (const row of pullRows.rows) {
      if (!pullsSince[row.category]) pullsSince[row.category] = {};
      pullsSince[row.category][row.item] = Number(row.total);
    }

    const transfersOut = {};
    for (const row of trOutRows.rows) {
      if (!transfersOut[row.category]) transfersOut[row.category] = {};
      transfersOut[row.category][row.item] = Number(row.total);
    }

    const transfersIn = {};
    for (const row of trInRows.rows) {
      if (!transfersIn[row.category]) transfersIn[row.category] = {};
      transfersIn[row.category][row.item] = Number(row.total);
    }

    const estimated = JSON.parse(JSON.stringify(items));
    for (const [cat, subItems] of Object.entries(pullsSince)) {
      for (const [itm, qty] of Object.entries(subItems)) {
        if (estimated[cat]?.[itm] !== undefined)
          estimated[cat][itm] = Math.max(0, estimated[cat][itm] - qty);
      }
    }
    for (const [cat, subItems] of Object.entries(transfersOut)) {
      for (const [itm, qty] of Object.entries(subItems)) {
        if (estimated[cat]?.[itm] !== undefined)
          estimated[cat][itm] = Math.max(0, estimated[cat][itm] - qty);
      }
    }
    for (const [cat, subItems] of Object.entries(transfersIn)) {
      for (const [itm, qty] of Object.entries(subItems)) {
        if (!estimated[cat]) estimated[cat] = {};
        estimated[cat][itm] = (estimated[cat][itm] ?? 0) + qty;
      }
    }

    state[type] = {
      last_count: { date: count.submitted_at, submitted_by: count.submitted_by, items },
      pulls_since: pullsSince,
      transfers_out: transfersOut,
      transfers_in: transfersIn,
      estimated,
      alerts: []  // alerts are computed on combined totals only
    };
  }

  return state;
}

// ── GET /api/inventory ─────────────────────────────────────────────────────────
app.get('/api/inventory', requireAdmin, async (req, res) => {
  try {
    const result = {};
    for (const fac of VALID_FACILITIES) {
      result[fac] = await getInventoryState(fac);
    }

    // Combined totals across all facilities
    const combined = { biweekly: null, monthly: null };
    for (const type of ['biweekly', 'monthly']) {
      const totalEst = {};
      let hasData = false;

      for (const fac of VALID_FACILITIES) {
        const s = result[fac][type];
        if (!s) continue;
        hasData = true;
        for (const [cat, itms] of Object.entries(s.estimated)) {
          if (!totalEst[cat]) totalEst[cat] = {};
          for (const [itm, qty] of Object.entries(itms)) {
            totalEst[cat][itm] = (totalEst[cat][itm] || 0) + qty;
          }
        }
      }

      if (hasData) {
        // Alerts fire on combined totals across all facilities
        const combinedAlerts = [];
        for (const [cat, thresholds] of Object.entries(ALERT_THRESHOLDS)) {
          if (!totalEst[cat]) continue;
          for (const [itm, threshold] of Object.entries(thresholds)) {
            if (totalEst[cat][itm] !== undefined && totalEst[cat][itm] <= threshold)
              combinedAlerts.push({ category: cat, item: itm, threshold, current: totalEst[cat][itm] });
          }
        }
        combined[type] = { estimated: totalEst, alerts: combinedAlerts };
      }
    }
    result.combined = combined;

    res.json(result);
  } catch (err) {
    console.error('GET /api/inventory:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/pulls ─────────────────────────────────────────────────────────────
app.get('/api/pulls', requireAdmin, async (req, res) => {
  try {
    const { facility } = req.query;
    const args = [];
    let sql = 'SELECT * FROM inventory_pulls';
    if (facility && VALID_FACILITIES.includes(facility)) {
      sql += ' WHERE facility = ?';
      args.push(facility);
    }
    sql += ' ORDER BY pulled_at DESC LIMIT 200';
    const rows = await db.execute({ sql, args });
    res.json(rows.rows);
  } catch (err) {
    console.error('GET /api/pulls:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/transfer ─────────────────────────────────────────────────────────
app.post('/api/transfer', rateLimit, async (req, res) => {
  try {
    const { from_facility, to_facility, category, item, quantity, transferred_by, notes } = req.body;

    if (!VALID_FACILITIES.includes(from_facility))
      return res.status(400).json({ error: 'Invalid source facility' });
    if (!VALID_FACILITIES.includes(to_facility))
      return res.status(400).json({ error: 'Invalid destination facility' });
    if (from_facility === to_facility)
      return res.status(400).json({ error: 'Source and destination must be different' });
    if (!transferred_by || typeof transferred_by !== 'string' || transferred_by.trim().length === 0)
      return res.status(400).json({ error: 'Name is required' });
    if (transferred_by.length > 100)
      return res.status(400).json({ error: 'Name too long' });
    const qty = parseInt(quantity);
    if (!qty || qty < 1 || qty > 10000)
      return res.status(400).json({ error: 'Invalid quantity' });
    if (!category || typeof category !== 'string' || category.length > 50)
      return res.status(400).json({ error: 'Invalid category' });
    if (!item || typeof item !== 'string' || item.length > 100)
      return res.status(400).json({ error: 'Invalid item' });

    const cleanNotes = notes ? String(notes).trim().slice(0, 500) : null;

    await db.execute({
      sql: `INSERT INTO inventory_transfers (from_facility, to_facility, category, item, quantity, transferred_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [from_facility, to_facility, category, item, qty, transferred_by.trim(), cleanNotes]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/transfer:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/counts ────────────────────────────────────────────────────────────
app.get('/api/counts', requireAdmin, async (req, res) => {
  try {
    const { facility } = req.query;
    const args = [];
    let sql = 'SELECT id, facility, count_type, submitted_by, submitted_at FROM inventory_counts';
    if (facility && VALID_FACILITIES.includes(facility)) {
      sql += ' WHERE facility = ?';
      args.push(facility);
    }
    sql += ' ORDER BY submitted_at DESC LIMIT 200';
    const rows = await db.execute({ sql, args });
    res.json(rows.rows);
  } catch (err) {
    console.error('GET /api/counts:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/schedule ──────────────────────────────────────────────────────────
app.get('/api/schedule', (req, res) => {
  const result = {};
  for (const [type, config] of Object.entries(COUNT_SCHEDULE)) {
    result[type] = { ...getScheduleDates(config.startDate, config.intervalDays), interval_days: config.intervalDays };
  }
  res.json(result);
});

// ── GET /api/transfers ─────────────────────────────────────────────────────────
app.get('/api/transfers', requireAdmin, async (req, res) => {
  try {
    const { facility } = req.query;
    const args = [];
    let sql = 'SELECT * FROM inventory_transfers';
    if (facility && VALID_FACILITIES.includes(facility)) {
      sql += ' WHERE from_facility = ? OR to_facility = ?';
      args.push(facility, facility);
    }
    sql += ' ORDER BY transferred_at DESC LIMIT 200';
    const rows = await db.execute({ sql, args });
    res.json(rows.rows);
  } catch (err) {
    console.error('GET /api/transfers:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Inventory app running on http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
