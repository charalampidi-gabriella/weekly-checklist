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
  biweekly: { startDate: '2026-04-30', intervalDays: 14 },
  monthly:  { startDate: '2026-05-06', intervalDays: 28 },
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
    hawk_touch: 3, hawk_tour_rpet: 3, hawk_power: 3,
    lynx_tour: 3, lynx_touch: 3,
    rpm_blast: 3, rpm_rough: 3, rpm_power: 3,
    polytour_pro_yellow: 2, polytour_pro_blue: 2, polytour_pro_teal: 2,
    polytour_pro_purple: 2, polytour_pro_black: 2, polytour_rev: 2,
    ice_code: 2, razor_soft: 2,
  },
  gut_strings: {
    synthetic_gut_head: 2, synthetic_gut_babolat: 2, touch_vs: 1,
  },
  multifilament: {
    x_one_biphase: 2, velocity_mlt: 2, reflex_mlt: 2,
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
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pos_reconciliations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      count_id    INTEGER NOT NULL UNIQUE,
      pos_sales   TEXT    NOT NULL,
      entered_by  TEXT,
      entered_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Add `type` column to inventory_pulls (idempotent: ALTER throws if exists)
  try { await db.execute(`ALTER TABLE inventory_pulls ADD COLUMN type TEXT`); } catch (e) {}
  // Legacy rows (type IS NULL) are treated as sales — that matches old behavior
  // where a "pull" directly decremented the single total count
  try { await db.execute(`UPDATE inventory_pulls SET type = 'sale' WHERE type IS NULL`); } catch (e) {}
}

// ── Basic Auth gate (applied to every request) ────────────────────────────────
app.use((req, res, next) => {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;
  if (!expectedUser || !expectedPass) {
    return res.status(500).send('Auth not configured');
  }
  const header = req.headers.authorization;
  if (header && header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === expectedUser && pass === expectedPass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Rippner Tennis", charset="UTF-8"');
  res.status(401).send('Authentication required');
});

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

// Items JSON shape: { category: { item: { storage: N, display: M } } }
// Accepts legacy shape { category: { item: N } } and normalizes to { storage: N, display: 0 }
function sanitizeItems(items) {
  const result = {};
  if (!items || typeof items !== 'object') return result;
  for (const [cat, subItems] of Object.entries(items)) {
    if (typeof subItems !== 'object' || subItems === null) continue;
    const cleanCat = String(cat).slice(0, 50);
    result[cleanCat] = {};
    for (const [itm, val] of Object.entries(subItems)) {
      const cleanItm = String(itm).slice(0, 100);
      let s = 0, d = 0;
      if (val && typeof val === 'object') {
        const sn = parseInt(val.storage);
        const dn = parseInt(val.display);
        s = isNaN(sn) || sn < 0 ? 0 : sn;
        d = isNaN(dn) || dn < 0 ? 0 : dn;
      } else {
        const n = parseInt(val);
        s = isNaN(n) || n < 0 ? 0 : n;
      }
      result[cleanCat][cleanItm] = { storage: s, display: d };
    }
  }
  return result;
}

// Reads a stored item value (may be legacy number) into { storage, display }
function readCountItem(val) {
  if (val && typeof val === 'object') {
    return {
      storage: Math.max(0, Number(val.storage) || 0),
      display: Math.max(0, Number(val.display) || 0),
    };
  }
  return { storage: Math.max(0, Number(val) || 0), display: 0 };
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
// type='pull'    moves stock from storage → display (total unchanged)
// type='sale'    removes stock from display (total decreases) — legacy; new UI omits
// type='receipt' adds stock to storage from an external shipment (total increases)
app.post('/api/pull', rateLimit, async (req, res) => {
  try {
    const { facility, category, item, quantity, pulled_by, notes, type } = req.body;

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
    const eventType = type || 'sale';
    if (!['pull', 'sale', 'receipt'].includes(eventType))
      return res.status(400).json({ error: 'Invalid type' });

    const cleanNotes = notes ? String(notes).trim().slice(0, 500) : null;

    await db.execute({
      sql: `INSERT INTO inventory_pulls (facility, category, item, quantity, pulled_by, notes, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [facility, category, item, qty, pulled_by.trim(), cleanNotes, eventType]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/pull:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Inventory state helper ─────────────────────────────────────────────────────
// Adds a delta to the storage/display/total of a nested map entry
function bumpEstimate(est, cat, itm, dStorage, dDisplay) {
  if (!est[cat]) est[cat] = {};
  if (!est[cat][itm]) est[cat][itm] = { storage: 0, display: 0, total: 0 };
  est[cat][itm].storage = Math.max(0, est[cat][itm].storage + dStorage);
  est[cat][itm].display = Math.max(0, est[cat][itm].display + dDisplay);
  est[cat][itm].total   = est[cat][itm].storage + est[cat][itm].display;
}

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
      ? ['reels', 'gut_strings', 'multifilament', 'ball_cases', 'concessions', 'supplies']
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
          transfersIn[row.category][row.item] = Number(row.total);
          bumpEstimate(estimated, row.category, row.item, Number(row.total), 0);
        }
        state[type] = {
          last_count: null, pulls_since: {}, sales_since: {},
          transfers_out: {}, transfers_in: transfersIn, estimated, alerts: []
        };
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
        sql: `SELECT category, item, type, SUM(quantity) as total FROM inventory_pulls
              WHERE facility = ? AND category IN (${catPlaceholders}) AND pulled_at > ?
              GROUP BY category, item, type`,
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

    const pullsSince    = {};  // type='pull':    storage → display (total unchanged)
    const salesSince    = {};  // type='sale':    display → out     (total decreases)
    const receiptsSince = {};  // type='receipt': external → storage (total increases)
    for (const row of pullRows.rows) {
      const bucket = row.type === 'pull'    ? pullsSince
                   : row.type === 'receipt' ? receiptsSince
                                            : salesSince;
      if (!bucket[row.category]) bucket[row.category] = {};
      bucket[row.category][row.item] = Number(row.total);
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

    // Normalize the stored count into { storage, display } for every item
    const normalizedItems = {};
    const estimated = {};
    for (const [cat, subItems] of Object.entries(items)) {
      if (typeof subItems !== 'object' || subItems === null) continue;
      normalizedItems[cat] = {};
      for (const [itm, val] of Object.entries(subItems)) {
        const { storage, display } = readCountItem(val);
        normalizedItems[cat][itm] = { storage, display };
        bumpEstimate(estimated, cat, itm, storage, display);
      }
    }

    // Apply movements (seed any cats/items not present in count with a zero baseline)
    const seedFrom = (bucket) => {
      for (const [cat, subItems] of Object.entries(bucket)) {
        for (const itm of Object.keys(subItems)) {
          if (!estimated[cat]?.[itm]) bumpEstimate(estimated, cat, itm, 0, 0);
        }
      }
    };
    seedFrom(pullsSince); seedFrom(salesSince); seedFrom(receiptsSince);
    seedFrom(transfersOut); seedFrom(transfersIn);

    for (const [cat, subItems] of Object.entries(pullsSince))
      for (const [itm, qty] of Object.entries(subItems)) bumpEstimate(estimated, cat, itm, -qty,  qty);
    for (const [cat, subItems] of Object.entries(salesSince))
      for (const [itm, qty] of Object.entries(subItems)) bumpEstimate(estimated, cat, itm,  0,   -qty);
    for (const [cat, subItems] of Object.entries(receiptsSince))
      for (const [itm, qty] of Object.entries(subItems)) bumpEstimate(estimated, cat, itm,  qty,  0);
    for (const [cat, subItems] of Object.entries(transfersOut))
      for (const [itm, qty] of Object.entries(subItems)) bumpEstimate(estimated, cat, itm, -qty,  0);
    for (const [cat, subItems] of Object.entries(transfersIn))
      for (const [itm, qty] of Object.entries(subItems)) bumpEstimate(estimated, cat, itm,  qty,  0);

    state[type] = {
      last_count: { date: count.submitted_at, submitted_by: count.submitted_by, items: normalizedItems },
      pulls_since:    pullsSince,
      sales_since:    salesSince,
      receipts_since: receiptsSince,
      transfers_out:  transfersOut,
      transfers_in:   transfersIn,
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
          for (const [itm, vals] of Object.entries(itms)) {
            if (!totalEst[cat][itm]) totalEst[cat][itm] = { storage: 0, display: 0, total: 0 };
            totalEst[cat][itm].storage += vals.storage;
            totalEst[cat][itm].display += vals.display;
            totalEst[cat][itm].total   += vals.total;
          }
        }
      }

      if (hasData) {
        // Alerts fire on combined totals (storage + display) across all facilities
        const combinedAlerts = [];
        for (const [cat, thresholds] of Object.entries(ALERT_THRESHOLDS)) {
          if (!totalEst[cat]) continue;
          for (const [itm, threshold] of Object.entries(thresholds)) {
            const cur = totalEst[cat][itm];
            if (cur !== undefined && cur.total <= threshold)
              combinedAlerts.push({ category: cat, item: itm, threshold, current: cur.total });
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
    let sql = 'SELECT id, facility, count_type, submitted_by, submitted_at, items FROM inventory_counts';
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

// ── GET /api/reconcile ─────────────────────────────────────────────────────────
// Returns the last two counts for a facility+count_type plus movements in between,
// for comparing against POS-reported sales.
app.get('/api/reconcile', requireAdmin, async (req, res) => {
  try {
    const { facility, count_type } = req.query;
    if (!VALID_FACILITIES.includes(facility))
      return res.status(400).json({ error: 'Invalid facility' });
    if (!['biweekly', 'monthly'].includes(count_type))
      return res.status(400).json({ error: 'Invalid count type' });

    const countsRes = await db.execute({
      sql: `SELECT id, submitted_at, submitted_by, items FROM inventory_counts
            WHERE facility = ? AND count_type = ? ORDER BY submitted_at DESC LIMIT 2`,
      args: [facility, count_type]
    });

    if (countsRes.rows.length < 2) {
      return res.json({
        facility, count_type,
        previous: null,
        current: countsRes.rows[0] ? {
          id: countsRes.rows[0].id,
          date: countsRes.rows[0].submitted_at,
          submitted_by: countsRes.rows[0].submitted_by,
        } : null,
        message: 'Need at least two counts to reconcile.',
      });
    }

    const [curr, prev] = countsRes.rows;

    const normalizeItems = (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return {}; }
      const out = {};
      for (const [cat, subItems] of Object.entries(parsed || {})) {
        if (typeof subItems !== 'object' || subItems === null) continue;
        out[cat] = {};
        for (const [itm, val] of Object.entries(subItems)) {
          const { storage, display } = readCountItem(val);
          out[cat][itm] = { storage, display, total: storage + display };
        }
      }
      return out;
    };

    const prevItems = normalizeItems(prev.items);
    const currItems = normalizeItems(curr.items);

    const [trInRows, trOutRows, saleRows, receiptRows, posRow] = await Promise.all([
      db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_transfers
              WHERE to_facility = ? AND transferred_at > ? AND transferred_at <= ?
              GROUP BY category, item`,
        args: [facility, prev.submitted_at, curr.submitted_at]
      }),
      db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_transfers
              WHERE from_facility = ? AND transferred_at > ? AND transferred_at <= ?
              GROUP BY category, item`,
        args: [facility, prev.submitted_at, curr.submitted_at]
      }),
      db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_pulls
              WHERE facility = ? AND type = 'sale' AND pulled_at > ? AND pulled_at <= ?
              GROUP BY category, item`,
        args: [facility, prev.submitted_at, curr.submitted_at]
      }),
      db.execute({
        sql: `SELECT category, item, SUM(quantity) as total FROM inventory_pulls
              WHERE facility = ? AND type = 'receipt' AND pulled_at > ? AND pulled_at <= ?
              GROUP BY category, item`,
        args: [facility, prev.submitted_at, curr.submitted_at]
      }),
      db.execute({
        sql: `SELECT pos_sales, entered_by, entered_at FROM pos_reconciliations WHERE count_id = ?`,
        args: [curr.id]
      }),
    ]);

    const bucketize = (rows) => {
      const out = {};
      for (const r of rows) {
        if (!out[r.category]) out[r.category] = {};
        out[r.category][r.item] = Number(r.total);
      }
      return out;
    };

    let posSales = {}, posEnteredBy = null, posEnteredAt = null;
    if (posRow.rows.length) {
      try { posSales = JSON.parse(posRow.rows[0].pos_sales) || {}; } catch (e) {}
      posEnteredBy = posRow.rows[0].entered_by;
      posEnteredAt = posRow.rows[0].entered_at;
    }

    res.json({
      facility,
      count_type,
      previous: {
        id: prev.id,
        date: prev.submitted_at,
        submitted_by: prev.submitted_by,
        items: prevItems,
      },
      current: {
        id: curr.id,
        date: curr.submitted_at,
        submitted_by: curr.submitted_by,
        items: currItems,
      },
      transfers_in:  bucketize(trInRows.rows),
      transfers_out: bucketize(trOutRows.rows),
      app_sales:     bucketize(saleRows.rows),
      receipts:      bucketize(receiptRows.rows),
      pos_sales:     posSales,
      pos_entered_by: posEnteredBy,
      pos_entered_at: posEnteredAt,
    });
  } catch (err) {
    console.error('GET /api/reconcile:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/reconcile ────────────────────────────────────────────────────────
// Save (upsert) POS-reported sold quantities keyed to the "current" count_id
app.post('/api/reconcile', requireAdmin, async (req, res) => {
  try {
    const { count_id, pos_sales, entered_by } = req.body;
    const cid = parseInt(count_id);
    if (!cid || cid < 1) return res.status(400).json({ error: 'Invalid count_id' });
    if (!pos_sales || typeof pos_sales !== 'object')
      return res.status(400).json({ error: 'Invalid pos_sales' });

    // Verify the count exists
    const existsRes = await db.execute({
      sql: `SELECT id FROM inventory_counts WHERE id = ?`,
      args: [cid]
    });
    if (!existsRes.rows.length)
      return res.status(404).json({ error: 'Count not found' });

    // Clean the pos_sales object: { category: { item: non-negative int } }
    const clean = {};
    for (const [cat, subItems] of Object.entries(pos_sales)) {
      if (typeof subItems !== 'object' || subItems === null) continue;
      const catKey = String(cat).slice(0, 50);
      const inner = {};
      for (const [itm, val] of Object.entries(subItems)) {
        const n = parseInt(val);
        if (!isNaN(n) && n >= 0) inner[String(itm).slice(0, 100)] = n;
      }
      if (Object.keys(inner).length) clean[catKey] = inner;
    }

    const name = (entered_by && typeof entered_by === 'string')
      ? entered_by.trim().slice(0, 100) : null;

    await db.execute({
      sql: `INSERT INTO pos_reconciliations (count_id, pos_sales, entered_by)
            VALUES (?, ?, ?)
            ON CONFLICT(count_id) DO UPDATE SET
              pos_sales = excluded.pos_sales,
              entered_by = excluded.entered_by,
              entered_at = CURRENT_TIMESTAMP`,
      args: [cid, JSON.stringify(clean), name]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/reconcile:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Inventory app running on http://localhost:${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
