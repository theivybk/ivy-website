const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');
const {
  escapeHtml, dayLabel, emailTemplate, reservationEmails, inquiryEmails, welcomeEmail,
  weeklyReportEmail, backupEmail, applicationEmail, menusEmail, emailPreviewPage,
} = require('./emails.cjs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'dist');

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || '').trim();
const WEEKLY_REPORT_SECRET = (process.env.WEEKLY_REPORT_SECRET || '').trim();

const GOOGLE_CALENDAR_CLIENT_ID = (process.env.GOOGLE_CALENDAR_CLIENT_ID || '').trim();
const GOOGLE_CALENDAR_CLIENT_SECRET = (process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '').trim();
const GOOGLE_CALENDAR_REFRESH_TOKEN = (process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || '').trim();
const GOOGLE_CALENDAR_ID = (process.env.GOOGLE_CALENDAR_ID || 'events@theivybk.com').trim();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Railway's free tier has no persistent disk, so this file is wiped on every
// redeploy/restart. Resend (sent-email history + audience contacts) is the
// actual durable store; on boot we rehydrate this table from there, keyed by
// Resend's own IDs so re-running the rehydration never creates duplicates.
const DB_PATH = (process.env.DB_PATH || path.join(__dirname, 'data', 'ivy.db')).trim();
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resend_email_id TEXT UNIQUE,
    full_name TEXT,
    phone TEXT,
    email TEXT,
    date TEXT,
    time TEXT,
    party_size TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS event_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resend_email_id TEXT UNIQUE,
    full_name TEXT,
    phone TEXT,
    email TEXT,
    company TEXT,
    event_date TEXT,
    event_time TEXT,
    guest_count TEXT,
    duration TEXT,
    occasion TEXT,
    space_preference TEXT,
    budget_per_person TEXT,
    referral_source TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Newsletter subscribers live only in the Resend audience, which is the official
// list and handles unsubscribes. An earlier version kept a copy of the emails
// here, so remove it and reclaim the space so nothing lingers in the file.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'newsletter_signups'").get()) {
  db.exec('DROP TABLE newsletter_signups');
  db.exec('VACUUM');
  console.log('Removed the newsletter signup copy from the database.');
}
const insertReservation = db.prepare(
  `INSERT OR IGNORE INTO reservations (resend_email_id, full_name, phone, email, date, time, party_size, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertEventInquiry = db.prepare(
  `INSERT OR IGNORE INTO event_inquiries (resend_email_id, full_name, phone, email, company, event_date, event_time, guest_count, duration, occasion, space_preference, budget_per_person, referral_source, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

function resendGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.resend.com',
      path: pathAndQuery,
      method: 'GET',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseReservationEmailText(text) {
  const get = (label) => {
    const m = new RegExp(`^${label}: (.*)$`, 'm').exec(text || '');
    return m ? m[1].trim() : '';
  };
  const notesMatch = /Special Requests:\n([\s\S]*)$/.exec(text || '');
  const notesRaw = notesMatch ? notesMatch[1].trim() : '';
  return {
    full_name: get('Name'),
    phone: get('Phone'),
    email: get('Email'),
    date: get('Date'),
    time: get('Time'),
    party_size: get('Party Size'),
    notes: notesRaw === '—' ? '' : notesRaw,
  };
}

function parseEventInquiryEmailText(text) {
  const get = (label) => {
    const m = new RegExp(`^${label}: (.*)$`, 'm').exec(text || '');
    return m ? m[1].trim() : '';
  };
  const detailsMatch = /Details:\n([\s\S]*)$/.exec(text || '');
  const detailsRaw = detailsMatch ? detailsMatch[1].trim() : '';
  return {
    full_name: get('Name'),
    phone: get('Phone'),
    email: get('Email'),
    company: get('Company') === '—' ? '' : get('Company'),
    event_date: get('Preferred Date'),
    event_time: get('Preferred Time'),
    guest_count: get('Number of Guests'),
    duration: get('Duration') === '—' ? '' : get('Duration'),
    occasion: get('Occasion'),
    space_preference: get('Space Preference'),
    budget_per_person: get('Budget Per Person') === '—' ? '' : get('Budget Per Person'),
    referral_source: get('How They Heard About Us') === '—' ? '' : get('How They Heard About Us'),
    details: detailsRaw === '—' ? '' : detailsRaw,
  };
}

// Event inquiries older than this are excluded (development test data --
// Resend has no email-delete API, see RESERVATIONS_VISIBLE_SINCE above).
const EVENT_INQUIRIES_VISIBLE_SINCE = '2026-08-16 00:34:46+00';

async function readEventInquiries() {
  if (!RESEND_API_KEY) return [];
  const matches = [];
  let after;
  try {
    for (let page = 0; page < 10; page++) {
      const qs = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const result = await resendGet(`/emails${qs}`);
      if (result.status >= 300) {
        console.error('Resend list emails failed:', result.status, result.body);
        break;
      }
      const items = result.body.data || [];
      for (const item of items) {
        if (
          typeof item.subject === 'string' &&
          item.subject.startsWith('Private Event Inquiry — ') &&
          item.created_at >= EVENT_INQUIRIES_VISIBLE_SINCE
        ) {
          matches.push(item.id);
        }
      }
      if (!result.body.has_more || items.length === 0) break;
      after = items[items.length - 1].id;
    }
  } catch (err) {
    console.error('Resend list emails error:', err.message);
    return [];
  }

  const inquiries = [];
  for (const id of matches) {
    try {
      const result = await resendGet(`/emails/${id}`);
      if (result.status < 300 && result.body.text) {
        inquiries.push({ resend_email_id: id, ...parseEventInquiryEmailText(result.body.text) });
      }
    } catch (err) {
      console.error('Resend fetch email error:', err.message);
    }
  }
  return inquiries;
}

// Reservation history lives entirely in already-sent Resend emails -- no
// separate database needed. We list recent emails, keep the ones whose
// subject matches our reservation format, then fetch each one's full body
// (the list endpoint only returns metadata) to recover the structured data.
//
// Resend has no email-delete API, so "clearing" old (test) reservations
// isn't possible at the source -- instead we hide anything sent before this
// cutoff. Real reservations from this point on are unaffected.
const RESERVATIONS_VISIBLE_SINCE = '2026-08-16 00:10:46+00';

// Shared everywhere reservations are read (weekly report, weekly email,
// DB hydration, /admin/db) so test data never has to be filtered out in
// multiple places or via date-cutoff hacks that risk hiding real bookings.
function isTestReservation(r) {
  return /test/i.test(r.full_name) || /@example\.com$/i.test(r.email) || /please ignore/i.test(r.notes || '');
}

// Drops accidental double-submissions (e.g. a customer double-clicking
// "Request Reservation") that show up as two distinct Resend emails for the
// identical booking. Expects reservations newest-first so the most complete
// submission (often a retry with an added note) wins over the earlier one.
function dedupeReservations(reservations) {
  const seen = new Set();
  return reservations.filter((r) => {
    const key = [r.full_name, r.phone, r.email, r.date, r.time].map((v) => (v || '').toLowerCase()).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readReservations() {
  if (!RESEND_API_KEY) return [];
  const matches = [];
  let after;
  try {
    for (let page = 0; page < 10; page++) {
      const qs = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const result = await resendGet(`/emails${qs}`);
      if (result.status >= 300) {
        console.error('Resend list emails failed:', result.status, result.body);
        break;
      }
      const items = result.body.data || [];
      for (const item of items) {
        if (
          typeof item.subject === 'string' &&
          item.subject.startsWith('Table Reservation — ') &&
          item.created_at >= RESERVATIONS_VISIBLE_SINCE
        ) {
          matches.push(item.id);
        }
      }
      if (!result.body.has_more || items.length === 0) break;
      after = items[items.length - 1].id;
    }
  } catch (err) {
    console.error('Resend list emails error:', err.message);
    return [];
  }

  const reservations = [];
  for (const id of matches) {
    try {
      const result = await resendGet(`/emails/${id}`);
      if (result.status < 300 && result.body.text) {
        reservations.push({ resend_email_id: id, ...parseReservationEmailText(result.body.text) });
      }
    } catch (err) {
      console.error('Resend fetch email error:', err.message);
    }
  }
  return dedupeReservations(reservations.filter((r) => !isTestReservation(r)));
}

// The database now lives on a persistent volume and new reservations and
// inquiries are written to it as they arrive, so the slow rebuild from Resend
// history only runs for a table that is empty.
const dbCount = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function hydrateDbFromResend() {
  if (!RESEND_API_KEY) return;
  try {
    const reservations = dbCount('reservations') === 0 ? await readReservations() : [];
    for (const r of reservations) {
      insertReservation.run(r.resend_email_id, r.full_name, r.phone, r.email, r.date, r.time, r.party_size, r.notes);
    }
    console.log(`DB hydration: ${reservations.length} reservation(s) from Resend history.`);
  } catch (err) {
    console.error('DB hydration (reservations) error:', err.message);
  }

  try {
    const inquiries = dbCount('event_inquiries') === 0 ? await readEventInquiries() : [];
    for (const i of inquiries) {
      insertEventInquiry.run(
        i.resend_email_id, i.full_name, i.phone, i.email, i.company, i.event_date, i.event_time,
        i.guest_count, i.duration, i.occasion, i.space_preference, i.budget_per_person, i.referral_source, i.details
      );
    }
    console.log(`DB hydration: ${inquiries.length} event inquiry(ies) from Resend history.`);
  } catch (err) {
    console.error('DB hydration (event inquiries) error:', err.message);
  }
}

// Extra logins that can use ONLY the private event agreement pages (issuing
// agreements and confirming deposits), never reservations or the other admin
// tools. Set CONTRACT_USERS="maria:her-password,dan:his-password" in Railway
// (passwords cannot contain commas). The main admin login also works there.
const CONTRACT_USERS = (process.env.CONTRACT_USERS || '')
  .split(',')
  .map((pair) => pair.trim())
  .filter(Boolean)
  .map((pair) => {
    const i = pair.indexOf(':');
    return i > 0 ? [pair.slice(0, i), pair.slice(i + 1)] : null;
  })
  .filter((entry) => entry && entry[0] && entry[1]);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkContractAuth(req) {
  if (checkBasicAuth(req)) return true;
  if (!CONTRACT_USERS.length) return false;
  const match = (req.headers['authorization'] || '').match(/^Basic (.+)$/);
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sepIdx = decoded.indexOf(':');
  if (sepIdx === -1) return false;
  const user = decoded.slice(0, sepIdx);
  const pass = decoded.slice(sepIdx + 1);
  return CONTRACT_USERS.some(([u, p]) => {
    const userOk = safeEqual(u, user);
    const passOk = safeEqual(p, pass);
    return userOk && passOk;
  });
}

// ---- database backup
//
// The database on the Railway volume is the permanent record, so a copy of it
// is emailed every Monday morning (Central time). The email carries the real
// SQLite file, which can be restored as is, and a spreadsheet of agreements.
db.exec(`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)`);
const BACKUP_TO_EMAIL = 'info@theivybk.com';

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function chicagoNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday: get('weekday'), hour: parseInt(get('hour'), 10) % 24 };
}

async function sendDatabaseBackup(reason) {
  if (!RESEND_API_KEY) throw new Error('Email is not configured.');
  const stamp = chicagoNow().date;
  const copyPath = path.join(os.tmpdir(), `ivy-backup-${Date.now()}.db`);
  let dbBase64;
  try {
    // VACUUM INTO writes a clean, consistent copy even while the site is running.
    db.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`);
    dbBase64 = fs.readFileSync(copyPath).toString('base64');
  } finally {
    try { fs.unlinkSync(copyPath); } catch {}
  }

  const count = (table) => { try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch { return 0; } };
  const counts = {
    agreements: count('agreements'),
    reservations: count('reservations'),
    event_inquiries: count('event_inquiries'),
  };

  let csv = '';
  try {
    const columns = db.prepare('PRAGMA table_info(agreements)').all().map((c) => c.name);
    const rows = db.prepare('SELECT * FROM agreements ORDER BY event_date, start_time').all();
    csv = [columns.map(csvCell).join(',')].concat(rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))).join('\r\n') + '\r\n';
  } catch (err) {
    csv = `Could not export agreements: ${err.message}\r\n`;
  }

  const mail = backupEmail({ reason, stamp, counts });
  const result = await resendSendEmail({
    to: BACKUP_TO_EMAIL,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: [
      { filename: `ivy-database-${stamp}.db`, content: dbBase64 },
      { filename: `agreements-${stamp}.csv`, content: Buffer.from(csv, 'utf8').toString('base64') },
    ],
  });
  if (result.status < 200 || result.status >= 300) throw new Error(`Resend status ${result.status}`);
  db.prepare('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)').run('last_backup_date', stamp);
  return { ok: true, stamp, counts, dbKilobytes: Math.round((dbBase64.length * 3) / 4 / 1024), emailId: result.body && result.body.id };
}

async function maybeSendWeeklyBackup() {
  try {
    const now = chicagoNow();
    if (now.weekday !== 'Mon' || now.hour < 6) return;
    const last = db.prepare("SELECT value FROM app_state WHERE key = 'last_backup_date'").get();
    if (last && last.value === now.date) return;
    const r = await sendDatabaseBackup('weekly');
    console.log('Weekly database backup sent:', JSON.stringify(r));
  } catch (err) {
    console.error('Weekly database backup failed:', err.message);
  }
}

// Where the database lives, so the admin page can show whether it is on a
// persistent volume (survives deploys) or on the disk that is wiped each time.
function dbFileInfo() {
  const info = { path: DB_PATH, persistent: !path.resolve(DB_PATH).startsWith(path.resolve(__dirname)) };
  try {
    const st = fs.statSync(DB_PATH);
    info.sizeBytes = st.size;
    const born = st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.mtime;
    info.createdAt = born.toISOString();
  } catch {}
  return info;
}

function checkBasicAuth(req) {
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Basic (.+)$/);
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const sepIdx = decoded.indexOf(':');
  if (sepIdx === -1) return false;
  const user = decoded.slice(0, sepIdx);
  const pass = decoded.slice(sepIdx + 1);
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

function mondayOf(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((t || '').trim());
  if (!m) return 0;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

async function getWeekReservations(weekParam) {
  const monday = mondayOf(weekParam);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const mondayStr = toDateStr(monday);
  const sundayStr = toDateStr(sunday);

  const all = dedupeReservations(db.prepare('SELECT * FROM reservations ORDER BY id DESC').all().filter((r) => !isTestReservation(r)));
  const inRange = all.filter((r) => r.date >= mondayStr && r.date <= sundayStr);
  inRange.sort((a, b) => (a.date === b.date ? timeToMinutes(a.time) - timeToMinutes(b.time) : a.date < b.date ? -1 : 1));

  const byDay = {};
  for (const r of inRange) {
    (byDay[r.date] = byDay[r.date] || []).push(r);
  }

  return { monday, sunday, mondayStr, sundayStr, inRange, byDay };
}

async function handleReservationsReport(req, res, query) {
  if (!checkBasicAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reservations"', 'Content-Type': 'text/plain' });
    res.end('Authentication required.');
    return;
  }

  const { monday, mondayStr, sundayStr, inRange, byDay } = await getWeekReservations(query.get('week'));
  const prevWeek = new Date(monday); prevWeek.setDate(prevWeek.getDate() - 7);
  const nextWeek = new Date(monday); nextWeek.setDate(nextWeek.getDate() + 7);

  let rowsHtml = '';
  const days = Object.keys(byDay).sort();
  if (days.length === 0) {
    rowsHtml = '<p class="empty">No reservation requests for this week.</p>';
  } else {
    for (const dateStr of days) {
      rowsHtml += `<h2>${escapeHtml(dayLabel(dateStr))}</h2>`;
      rowsHtml += '<table><thead><tr><th>Time</th><th>Name</th><th>Party</th><th>Phone</th><th>Email</th><th>Notes</th></tr></thead><tbody>';
      for (const r of byDay[dateStr]) {
        rowsHtml += `<tr><td>${escapeHtml(r.time)}</td><td>${escapeHtml(r.full_name)}</td><td>${escapeHtml(r.party_size)}</td><td>${escapeHtml(r.phone)}</td><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.notes)}</td></tr>`;
      }
      rowsHtml += '</tbody></table>';
    }
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Reservations — ${escapeHtml(mondayStr)} to ${escapeHtml(sundayStr)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; color: #14140F; max-width: 900px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #555; font-size: 13px; margin: 0 0 24px; }
  .nav { display: flex; justify-content: space-between; margin-bottom: 24px; font-size: 14px; }
  .nav a { color: #1F3D2A; text-decoration: none; border-bottom: 1px solid #B8923D; }
  .print-btn { background: #1F3D2A; color: #F5EFE3; border: none; padding: 8px 16px; border-radius: 2px; cursor: pointer; font-size: 13px; }
  h2 { font-size: 16px; margin: 28px 0 8px; border-bottom: 2px solid #1F3D2A; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { text-align: left; padding: 6px 8px; font-size: 13px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { color: #555; text-transform: uppercase; font-size: 11px; letter-spacing: .04em; }
  .empty { color: #777; font-style: italic; }
  @media print {
    .nav, .print-btn { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <div class="nav">
    <a href="/admin/reservations?week=${toDateStr(prevWeek)}">&larr; Previous Week</a>
    <button class="print-btn" onclick="window.print()">Print</button>
    <a href="/admin/reservations?week=${toDateStr(nextWeek)}">Next Week &rarr;</a>
  </div>
  <h1>The Ivy Bar and Kitchen — Reservation Requests</h1>
  <p class="sub">Week of ${escapeHtml(dayLabel(mondayStr))} &ndash; ${escapeHtml(dayLabel(sundayStr))} &middot; ${inRange.length} request${inRange.length === 1 ? '' : 's'}</p>
  ${rowsHtml}
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function handleWeeklyReportEmail(req, res, query) {
  if (!WEEKLY_REPORT_SECRET || query.get('secret') !== WEEKLY_REPORT_SECRET) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized.');
    return;
  }
  if (!RESEND_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Not configured.');
    return;
  }

  const { mondayStr, sundayStr, inRange, byDay } = await getWeekReservations(query.get('week'));

  const mail = weeklyReportEmail({ mondayStr, sundayStr, inRange, byDay });

  try {
    const result = await resendSendEmail({
      to: RESERVATION_TO_EMAIL,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (result.status === 200 || result.status === 201) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Sent. ${inRange.length} reservation(s) for ${mondayStr} to ${sundayStr}.`);
    } else {
      console.error('Weekly report send failed:', result.status, result.body);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Failed to send.');
    }
  } catch (err) {
    console.error('Weekly report send error:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Failed to send.');
  }
}

async function handleUnsubscribe(req, res, query) {
  const email = (query.get('email') || '').trim();
  if (!EMAIL_RE.test(email)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid email address.');
    return;
  }

  try {
    await resendUnsubscribe(email);
  } catch (err) {
    console.error('Unsubscribe error:', err.message);
  }

  // RFC 8058 one-click unsubscribe: mail clients POST here automatically
  // without loading a page, so just acknowledge and stop.
  if (req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed — The Ivy Bar and Kitchen</title>
<style>
  body { margin: 0; font-family: -apple-system, Segoe UI, Arial, sans-serif; background: #F5EFE3; color: #14140F; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  .card { background: #FBF7EE; border-radius: 4px; padding: 40px 32px; max-width: 420px; text-align: center; box-shadow: 0 8px 24px rgba(20,20,15,.06); }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-style: italic; color: #1F3D2A; font-size: 26px; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.6; color: #4A4A42; margin: 0 0 20px; }
  a { color: #1F3D2A; }
</style>
</head>
<body>
  <div class="card">
    <h1>You're unsubscribed</h1>
    <p>${escapeHtml(email)} won't receive any more marketing emails from The Ivy Bar and Kitchen. You'll still get emails tied to a reservation you make.</p>
    <p><a href="/">Back to theivybk.com</a></p>
  </div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function parseMultipart(req, { maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    if (!boundaryMatch) {
      reject(new Error('Not multipart'));
      return;
    }
    const boundaryBuf = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('File too large'));
        return;
      }
      const body = Buffer.concat(chunks);
      const fields = {};
      let file = null;

      let start = body.indexOf(boundaryBuf);
      while (start !== -1) {
        const partStart = start + boundaryBuf.length;
        const next = body.indexOf(boundaryBuf, partStart);
        if (next === -1) break;

        const headerEnd = body.indexOf('\r\n\r\n', partStart);
        if (headerEnd === -1 || headerEnd >= next) { start = next; continue; }

        const rawHeaders = body.slice(partStart, headerEnd).toString('utf8');
        let content = body.slice(headerEnd + 4, next);
        if (content.slice(-2).toString('latin1') === '\r\n') content = content.slice(0, -2);

        const dispositionMatch = /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
        if (dispositionMatch) {
          const fieldName = dispositionMatch[1];
          const filename = dispositionMatch[2];
          if (filename) {
            if (filename.trim()) {
              const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);
              file = { filename: filename.trim(), contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream', buffer: content };
            }
          } else {
            fields[fieldName] = content.toString('utf8');
          }
        }
        start = next;
      }

      resolve({ fields, file });
    });
    req.on('error', reject);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const RESEND_AUDIENCE_ID = 'b863a5a1-8d0d-429c-ae9c-9f43887f688f';

function resendSubscribe(email) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, unsubscribed: false });
    const options = {
      hostname: 'api.resend.com',
      path: `/audiences/${RESEND_AUDIENCE_ID}/contacts`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function resendUnsubscribe(email) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ unsubscribed: true });
    const options = {
      hostname: 'api.resend.com',
      path: `/audiences/${RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Looks an address up in the Resend audience (the official newsletter list):
// { exists, unsubscribed }. Nothing about subscribers is stored on our side.
async function contactStatus(email) {
  const direct = await resendGet(`/audiences/${RESEND_AUDIENCE_ID}/contacts/${encodeURIComponent(email)}`);
  if (direct.status === 200 && direct.body && direct.body.id) {
    return { exists: true, unsubscribed: !!direct.body.unsubscribed };
  }
  if (direct.status === 404) return { exists: false, unsubscribed: false };
  // Unexpected answer: fall back to scanning the whole list.
  const list = await resendGet(`/audiences/${RESEND_AUDIENCE_ID}/contacts`);
  if (list.status < 300 && list.body && Array.isArray(list.body.data)) {
    const hit = list.body.data.find((c) => String(c.email || '').toLowerCase() === email.toLowerCase());
    return hit ? { exists: true, unsubscribed: !!hit.unsubscribed } : { exists: false, unsubscribed: false };
  }
  throw new Error(`Could not check the newsletter list (status ${direct.status}).`);
}

// Addresses whose welcome email is already queued in this process, so a double
// submit (or two quick reservations) can never queue two.
const welcomeQueued = new Set();

// Used after a reservation or private event inquiry. Adds the guest to the
// newsletter and sends the welcome email ONLY if they are not already on the
// list. Someone who is already subscribed gets nothing again, and someone who
// unsubscribed is never re-added or emailed.
async function subscribeNewGuest(email, label) {
  const key = email.toLowerCase();
  if (welcomeQueued.has(key)) return;
  welcomeQueued.add(key);
  try {
    const status = await contactStatus(email);
    if (status.exists) {
      welcomeQueued.delete(key);
      return;
    }
    const result = await resendSubscribe(email);
    if (result.status !== 200 && result.status !== 201) {
      welcomeQueued.delete(key);
      console.error(`${label} newsletter subscribe failed:`, result.status, result.body);
      return;
    }
    // Delayed a day so it does not land alongside the confirmation. In-memory
    // timer: if the server restarts before it fires (e.g. a redeploy), this
    // send is lost. Acceptable for a non-critical marketing email; keeping a
    // queue would mean storing subscriber emails, which we do not do.
    setTimeout(() => {
      welcomeQueued.delete(key);
      sendWelcomeEmail(email).catch((err) => console.error(`${label} welcome email error:`, err.message));
    }, 24 * 60 * 60 * 1000).unref();
  } catch (err) {
    welcomeQueued.delete(key);
    console.error(`${label} newsletter subscribe error:`, err.message);
  }
}

function resendSendEmail({ to, from, subject, text, html, replyTo, attachments, headers }) {
  return new Promise((resolve, reject) => {
    const payload = {
      from: from || 'The Ivy Bar and Kitchen <info@theivybk.com>',
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
    };
    if (html) payload.html = html;
    if (replyTo) payload.reply_to = replyTo;
    if (attachments && attachments.length) payload.attachments = attachments;
    if (headers) payload.headers = headers;
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendWelcomeEmail(email) {
  const mail = welcomeEmail(email);
  return resendSendEmail({ to: email, subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers });
}

const RESERVATION_TO_EMAIL = 'info@theivybk.com';
const RESERVATION_DURATION_MS = 2 * 60 * 60 * 1000;

// Open/close (minutes since midnight) by JS day-of-week (0=Sun..6=Sat).
// Mirrors the hours shown on the homepage (index.astro's
// openingHoursSpecification and hours table) -- keep both in sync if hours
// change. `close` runs past 24:00 for nights that close after midnight.
const RESERVATION_HOURS = {
  0: { open: 11 * 60, close: 24 * 60 }, // Sunday    11am - 12am
  1: { open: 15 * 60, close: 24 * 60 }, // Monday     3pm - 12am
  2: { open: 15 * 60, close: 24 * 60 }, // Tuesday    3pm - 12am
  3: { open: 15 * 60, close: 24 * 60 }, // Wednesday  3pm - 12am
  4: { open: 11 * 60, close: 24 * 60 }, // Thursday  11am - 12am
  5: { open: 11 * 60, close: 25 * 60 }, // Friday    11am - 1am (next day)
  6: { open: 11 * 60, close: 25 * 60 }, // Saturday  11am - 1am (next day)
};

// Parses "7:30 PM" (as produced by the reservation form's time <select>) into { hour24, minute }.
function parseTime12h(timeStr) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((timeStr || '').trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) hour += 12;
  return { hour24: hour, minute: parseInt(m[2], 10) };
}

let cachedCalendarToken = null; // { accessToken, expiresAt }

// Exchanges the events@theivybk.com refresh token for a short-lived access
// token via OAuth (cached until ~1min before expiry) so reservations can be
// written straight to the calendar through the Calendar API -- no email sent
// to events@, unlike the earlier .ics-invite approach.
function getGoogleCalendarAccessToken() {
  if (cachedCalendarToken && cachedCalendarToken.expiresAt > Date.now() + 60000) {
    return Promise.resolve(cachedCalendarToken.accessToken);
  }
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: GOOGLE_CALENDAR_CLIENT_SECRET,
      refresh_token: GOOGLE_CALENDAR_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString();
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(data); } catch {}
          if (res.statusCode !== 200 || !parsed.access_token) {
            reject(new Error(`Google token refresh failed: ${res.statusCode} ${data}`));
            return;
          }
          cachedCalendarToken = { accessToken: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 1000 };
          resolve(parsed.access_token);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Creates the reservation directly on the events@theivybk.com Google Calendar
// via the Calendar API. Requires GOOGLE_CALENDAR_CLIENT_ID/SECRET/REFRESH_TOKEN
// to be configured; silently no-ops otherwise (reservations still work, just
// without the calendar sync).
async function createReservationCalendarEvent({ fullName, phone, email, date, time, partySize, notes }) {
  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET || !GOOGLE_CALENDAR_REFRESH_TOKEN) return;
  const parsed = parseTime12h(time);
  const [year, month, day] = (date || '').split('-').map((n) => parseInt(n, 10));
  if (!year || !month || !day || !parsed) return;
  const pad = (n) => String(n).padStart(2, '0');
  const startLocal = `${year}-${pad(month)}-${pad(day)}T${pad(parsed.hour24)}:${pad(parsed.minute)}:00`;
  const endDate = new Date(year, month - 1, day, parsed.hour24, parsed.minute, 0);
  endDate.setTime(endDate.getTime() + RESERVATION_DURATION_MS);
  const endLocal = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;

  const descriptionParts = [`Phone: ${phone}`, `Email: ${email}`];
  if (notes && notes !== '—') descriptionParts.push(`Notes: ${notes}`);

  const event = {
    summary: `Reservation — ${fullName} (party of ${partySize})`,
    description: descriptionParts.join('\n'),
    location: 'The Ivy Bar and Kitchen, 1625 W Irving Park Rd, Chicago, IL 60613',
    start: { dateTime: startLocal, timeZone: 'America/Chicago' },
    end: { dateTime: endLocal, timeZone: 'America/Chicago' },
  };

  const accessToken = await getGoogleCalendarAccessToken();
  const body = JSON.stringify(event);
  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        path: `/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 300) {
            reject(new Error(`Calendar insert failed: ${res.statusCode} ${data}`));
            return;
          }
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Generic Calendar API insert, used by private event agreements. Returns null
// when the calendar isn't configured. Callers pass a fixed event id, so a 409
// means that event is already on the calendar (for example an agreement that
// was signed twice) and counts as success.
async function insertCalendarEvent(event) {
  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET || !GOOGLE_CALENDAR_REFRESH_TOKEN) return null;
  const accessToken = await getGoogleCalendarAccessToken();
  const body = JSON.stringify(event);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        path: `/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 409) {
            resolve({ duplicate: true });
            return;
          }
          if (res.statusCode >= 300) {
            reject(new Error(`Calendar insert failed: ${res.statusCode} ${data}`));
            return;
          }
          let parsed = {};
          try { parsed = JSON.parse(data); } catch {}
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Updates an existing calendar event by id. Resolves { missing } instead of
// throwing when the event no longer exists (404, 410, or a deleted tombstone),
// so the caller can create it fresh.
async function patchCalendarEvent(eventId, patch) {
  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET || !GOOGLE_CALENDAR_REFRESH_TOKEN) return null;
  const accessToken = await getGoogleCalendarAccessToken();
  const body = JSON.stringify(patch);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        path: `/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events/${encodeURIComponent(eventId)}`,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 404 || res.statusCode === 410) {
            resolve({ missing: res.statusCode });
            return;
          }
          if (res.statusCode >= 300) {
            reject(new Error(`Calendar update failed: ${res.statusCode} ${data}`));
            return;
          }
          let parsed = {};
          try { parsed = JSON.parse(data); } catch {}
          if (parsed.status === 'cancelled') {
            resolve({ missing: 'cancelled' });
            return;
          }
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Lists events on the events calendar for a prepared query string (used by the
// agreements list). Returns [] when the calendar is not configured.
async function listCalendarEvents(queryString) {
  if (!GOOGLE_CALENDAR_CLIENT_ID || !GOOGLE_CALENDAR_CLIENT_SECRET || !GOOGLE_CALENDAR_REFRESH_TOKEN) return [];
  const accessToken = await getGoogleCalendarAccessToken();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'www.googleapis.com',
        path: `/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events?${queryString}`,
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 300) {
            reject(new Error(`Calendar list failed: ${res.statusCode} ${data}`));
            return;
          }
          let parsed = {};
          try { parsed = JSON.parse(data); } catch {}
          resolve(parsed.items || []);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function handleReservation(req, res) {
  if (!RESEND_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Reservation requests are not configured yet.' }));
    return;
  }
  let data;
  try {
    data = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid request.' }));
    return;
  }

  const label = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '—');
  const fullName = label(data.full_name);
  const phone = label(data.phone);
  const email = label(data.email);
  const date = label(data.date);
  const time = label(data.time);
  const partySize = label(data.party_size);
  const notes = label(data.notes);

  if (fullName === '—' || phone === '—' || email === '—' || date === '—' || time === '—' || partySize === '—') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please fill in all required fields.' }));
    return;
  }
  if (!EMAIL_RE.test(email)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please enter a valid email address.' }));
    return;
  }
  const todayChicago = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayChicago) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please choose a valid, upcoming date.' }));
    return;
  }

  const parsedTime = parseTime12h(time);
  const [resYear, resMonth, resDay] = date.split('-').map((n) => parseInt(n, 10));
  const dayOfWeek = new Date(Date.UTC(resYear, resMonth - 1, resDay)).getUTCDay();
  const hours = RESERVATION_HOURS[dayOfWeek];
  const requestedMinutes = parsedTime ? parsedTime.hour24 * 60 + parsedTime.minute : null;
  if (!parsedTime || requestedMinutes < hours.open || requestedMinutes >= hours.close) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: "That time is outside our hours — please pick a time we're open." }));
    return;
  }

  const mail = reservationEmails({ fullName, phone, email, date, time, partySize, notes });

  try {
    const result = await resendSendEmail({ to: RESERVATION_TO_EMAIL, subject: mail.notification.subject, text: mail.notification.text, html: mail.notification.html, replyTo: email });
    if (result.status === 200 || result.status === 201) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      subscribeNewGuest(email, 'Reservation');

      createReservationCalendarEvent({ fullName, phone, email, date, time, partySize, notes }).catch((err) =>
        console.error('Calendar event creation error:', err.message)
      );

      try {
        insertReservation.run(result.body.id, fullName, phone, email, date, time, partySize, notes);
      } catch (err) {
        console.error('Reservation DB insert error:', err.message);
      }

      resendSendEmail({ to: email, subject: mail.confirmation.subject, text: mail.confirmation.text, html: mail.confirmation.html })
        .catch((err) => console.error('Reservation confirmation email error:', err.message));
    } else {
      console.error('Resend send failed:', result.status, result.body);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Could not send your request. Please call us instead.' }));
    }
  } catch (err) {
    console.error('Resend request error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Could not reach the reservation service. Please call us instead.' }));
  }
}

const EVENT_TO_EMAIL = 'events@theivybk.com';
// Everything about private events is sent from, and answered at, events@.
const EVENTS_FROM = 'The Ivy Bar and Kitchen <events@theivybk.com>';

async function handleEventInquiry(req, res) {
  if (!RESEND_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Event inquiries are not configured yet.' }));
    return;
  }
  let data;
  try {
    data = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid request.' }));
    return;
  }

  const label = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '—');
  const fullName = label(data.full_name);
  const phone = label(data.phone);
  const email = label(data.email);
  const company = label(data.company);
  const eventDate = label(data.event_date);
  const eventTime = label(data.event_time);
  const guestCount = label(data.guest_count);
  const duration = label(data.duration);
  const occasion = label(data.occasion);
  const spacePreference = label(data.space_preference);
  const budgetPerPerson = label(data.budget_per_person);
  const referralSource = label(data.referral_source);
  const details = label(data.details);

  if (
    fullName === '—' || phone === '—' || email === '—' || eventDate === '—' ||
    eventTime === '—' || guestCount === '—' || occasion === '—' || spacePreference === '—'
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please fill in all required fields.' }));
    return;
  }
  if (!EMAIL_RE.test(email)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please enter a valid email address.' }));
    return;
  }

  const mail = inquiryEmails({ fullName, phone, email, company, eventDate, eventTime, guestCount, duration, occasion, spacePreference, budgetPerPerson, referralSource, details });

  try {
    const result = await resendSendEmail({ to: EVENT_TO_EMAIL, from: EVENTS_FROM, subject: mail.notification.subject, text: mail.notification.text, html: mail.notification.html, replyTo: email });
    if (result.status === 200 || result.status === 201) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      subscribeNewGuest(email, 'Event inquiry');

      try {
        insertEventInquiry.run(
          result.body.id, fullName, phone, email, company, eventDate, eventTime,
          guestCount, duration, occasion, spacePreference, budgetPerPerson, referralSource, details
        );
      } catch (err) {
        console.error('Event inquiry DB insert error:', err.message);
      }

      resendSendEmail({ to: email, from: EVENTS_FROM, replyTo: EVENT_TO_EMAIL, subject: mail.confirmation.subject, text: mail.confirmation.text, html: mail.confirmation.html })
        .catch((err) => console.error('Event inquiry confirmation email error:', err.message));
    } else {
      console.error('Resend send failed:', result.status, result.body);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Could not send your inquiry. Please call us instead.' }));
    }
  } catch (err) {
    console.error('Resend request error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Could not reach the event inquiry service. Please call us instead.' }));
  }
}

async function handleApply(req, res) {
  if (!RESEND_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Applications are not configured yet.' }));
    return;
  }

  let fields, file;
  try {
    ({ fields, file } = await parseMultipart(req));
  } catch (err) {
    const message = err.message === 'File too large' ? 'Resume file is too large (max 8MB).' : 'Invalid request.';
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: message }));
    return;
  }

  const label = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '—');
  const fullName = label(fields.full_name);
  const phone = label(fields.phone);
  const email = label(fields.email);
  const position = label(fields.position);
  const availability = label(fields.availability);
  const experience = label(fields.experience);
  const message = label(fields.message);

  if (fullName === '—' || phone === '—' || email === '—' || position === '—' || availability === '—') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please fill in all required fields.' }));
    return;
  }
  if (!EMAIL_RE.test(email)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please enter a valid email address.' }));
    return;
  }

  const mail = applicationEmail({ fullName, phone, email, position, availability, experience, file, message });

  const attachments = [];
  if (file && file.buffer && file.buffer.length) {
    attachments.push({ filename: file.filename, content: file.buffer.toString('base64') });
  }

  try {
    const result = await resendSendEmail({ to: RESERVATION_TO_EMAIL, subject: mail.subject, text: mail.text, html: mail.html, replyTo: email, attachments });
    if (result.status === 200 || result.status === 201) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      console.error('Resend send failed:', result.status, result.body);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Could not send your application. Please email us directly instead.' }));
    }
  } catch (err) {
    console.error('Resend request error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Could not reach the application service. Please email us directly instead.' }));
  }
}

async function handleNewsletterSignup(req, res) {
  if (!RESEND_API_KEY) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Newsletter signup is not configured yet.' }));
    return;
  }
  let email;
  try {
    ({ email } = await readJsonBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid request.' }));
    return;
  }

  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Please enter a valid email address.' }));
    return;
  }

  try {
    let status = null;
    try {
      status = await contactStatus(email);
    } catch (err) {
      console.error('Newsletter status check error:', err.message);
    }
    if (status && status.exists && !status.unsubscribed) {
      // Already on the list: nothing to add and no second welcome email.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, alreadySubscribed: true }));
      return;
    }
    // New, or someone who unsubscribed and is choosing to join again.
    const result = await resendSubscribe(email);
    if (result.status === 200 || result.status === 201) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, alreadySubscribed: false }));

      // If the check itself failed we cannot tell whether they were new, so skip the welcome.
      if (status) {
        sendWelcomeEmail(email).catch((err) => console.error('Newsletter welcome email error:', err.message));
      }
    } else {
      console.error('Resend subscribe failed:', result.status, result.body);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Could not complete signup. Please try again.' }));
    }
  } catch (err) {
    console.error('Resend request error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Could not reach the signup service. Please try again.' }));
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Only compress text-based formats — images/fonts are already compressed.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.xml', '.txt', '.webmanifest']);

function pickEncoding(acceptEncoding) {
  const accepted = acceptEncoding || '';
  if (/\bbr\b/.test(accepted)) return 'br';
  if (/\bgzip\b/.test(accepted)) return 'gzip';
  return null;
}

// Astro fingerprints /_astro/ bundle filenames by content hash, so those can
// be cached forever. Everything else (images, hand-written CSS, HTML) keeps
// the same filename across deploys, so cache briefly instead of not at all.
function pickCacheControl(filePath, ext) {
  const relPath = path.relative(ROOT, filePath).replace(/\\/g, '/');
  if (relPath.startsWith('_astro/')) return 'public, max-age=31536000, immutable';
  if (ext === '.html') return 'public, max-age=0, must-revalidate';
  if (ext === '.css' || ext === '.js') return 'public, max-age=3600';
  return 'public, max-age=86400';
}

function serveFile(filePath, req, res) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': pickCacheControl(filePath, ext),
  };
  const encoding = COMPRESSIBLE.has(ext) ? pickEncoding(req.headers['accept-encoding']) : null;

  if (encoding) {
    headers['Content-Encoding'] = encoding;
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    const compressor = encoding === 'br' ? zlib.createBrotliCompress() : zlib.createGzip();
    fs.createReadStream(filePath).pipe(compressor).pipe(res);
  } else {
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

// Simple in-memory per-IP rate limiter for public write endpoints. Fine for
// a single Railway instance; resets on restart, which is an acceptable
// trade-off for a small site.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateLimitBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}, 30 * 60 * 1000).unref();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req, routeGroup, max = RATE_LIMIT_MAX) {
  const key = `${routeGroup}:${getClientIp(req)}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count++;
  return true;
}

function rejectRateLimited(res) {
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Too many requests. Please try again in a few minutes.' }));
}

// Private event agreements: issued from /admin/contracts, signed by the client
// at /contract/<token>. See contract.cjs for how they are stored (inside the
// link itself, since the local database does not survive a redeploy).
const contracts = require('./contract.cjs').createContractHandlers({
  resendSendEmail,
  emailTemplate,
  checkBasicAuth: checkContractAuth,
  readJsonBody,
  getClientIp,
  createCalendarEvent: insertCalendarEvent,
  updateCalendarEvent: patchCalendarEvent,
  listCalendarEvents,
  db,
  secret: (process.env.CONTRACT_SECRET || '').trim() || ADMIN_PASS,
  hasResend: () => !!RESEND_API_KEY,
});

const server = http.createServer((req, res) => {
  // Railway's default *.up.railway.app subdomain stays live alongside the
  // custom domain and serves identical content -- redirect it (and any other
  // stray host) to the canonical domain so it's never crawled/indexed as a
  // duplicate. www already gets redirected upstream at Railway's edge.
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  if (host && host !== 'theivybk.com' && host !== 'www.theivybk.com') {
    res.writeHead(301, { Location: `https://theivybk.com${req.url}` });
    res.end();
    return;
  }

  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://www.googletagmanager.com https://www.google-analytics.com",
    "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com",
    "frame-src https://www.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));

  if (req.method === 'POST' && urlPath === '/api/newsletter') {
    if (!checkRateLimit(req, 'newsletter')) return rejectRateLimited(res);
    handleNewsletterSignup(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/reserve') {
    if (!checkRateLimit(req, 'reserve')) return rejectRateLimited(res);
    handleReservation(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/apply') {
    if (!checkRateLimit(req, 'apply')) return rejectRateLimited(res);
    handleApply(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/private-event') {
    if (!checkRateLimit(req, 'private-event')) return rejectRateLimited(res);
    handleEventInquiry(req, res);
    return;
  }

  if (req.method === 'GET' && urlPath.startsWith('/contract/')) {
    if (!checkRateLimit(req, 'contract-view', 60)) return rejectRateLimited(res);
    contracts.handleView(req, res, urlPath.slice('/contract/'.length).replace(/\/+$/, ''));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/contract/sign') {
    if (!checkRateLimit(req, 'contract-sign', 10)) return rejectRateLimited(res);
    contracts.handleSign(req, res);
    return;
  }

  if (req.method === 'GET' && urlPath === '/admin/contracts') {
    contracts.handleAdminPage(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts') {
    contracts.handleAdminCreate(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/lookup') {
    contracts.handleAdminLookup(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/confirm-deposit') {
    contracts.handleAdminConfirmDeposit(req, res);
    return;
  }

  if (req.method === 'GET' && urlPath === '/admin/agreements') {
    contracts.handleAdminAgreementsPage(req, res);
    return;
  }

  if (req.method === 'GET' && urlPath === '/admin/agreements/data') {
    contracts.handleAdminAgreementsData(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/cancel') {
    contracts.handleAdminCancel(req, res);
    return;
  }

  // Shows every email the site sends, with sample data, exactly as built.
  if (req.method === 'GET' && urlPath === '/admin/email-preview') {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reservations"', 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const RES_FROM = 'The Ivy Bar and Kitchen <info@theivybk.com>';
    const sampleReservation = reservationEmails({ fullName: 'Jane Smith', phone: '312-555-0142', email: 'jane@example.com', date: '2026-10-09', time: '7:30 PM', partySize: '6', notes: 'Birthday dinner, one high chair please' });
    const sampleInquiry = inquiryEmails({ fullName: 'Marcus Lee', phone: '312-555-0188', email: 'marcus@example.com', company: 'Lee & Co', eventDate: '2026-11-14', eventTime: '6:00 PM', guestCount: '35 – 50', duration: '3 hours', occasion: 'Corporate Event', spacePreference: 'The Ivy Bundle', budgetPerPerson: '$60', referralSource: 'Search Engine', details: 'Holiday party for our team. Need AV for a short slideshow.' });
    const sampleWeek = { mondayStr: '2026-09-28', sundayStr: '2026-10-04', inRange: [
      { date: '2026-10-01', time: '6:00 PM', full_name: 'Ana Ruiz', party_size: '4', phone: '773-555-0101', email: 'ana@example.com', notes: '' },
      { date: '2026-10-01', time: '7:30 PM', full_name: 'Tom Baker', party_size: '8', phone: '773-555-0102', email: 'tom@example.com', notes: 'Rooftop if possible' },
      { date: '2026-10-03', time: '8:00 PM', full_name: 'Priya Shah', party_size: '2', phone: '773-555-0103', email: 'priya@example.com', notes: '' },
    ] };
    sampleWeek.byDay = {};
    for (const r of sampleWeek.inRange) (sampleWeek.byDay[r.date] = sampleWeek.byDay[r.date] || []).push(r);
    const items = [
      { group: 'Guests', title: 'Reservation confirmation', from: RES_FROM, to: 'the guest', mail: sampleReservation.confirmation },
      { group: 'Guests', title: 'Private event inquiry received', from: 'The Ivy Bar and Kitchen <events@theivybk.com>', to: 'the person who asked', mail: sampleInquiry.confirmation },
      { group: 'Guests', title: 'Newsletter welcome', from: RES_FROM, to: 'a new subscriber', mail: welcomeEmail('guest@example.com') },
      ...contracts.previewEmails().filter((e) => e.group === 'Clients'),
      { group: 'Our team', title: 'New reservation request', from: RES_FROM, to: 'info@theivybk.com', mail: sampleReservation.notification },
      { group: 'Our team', title: 'New private event inquiry', from: 'The Ivy Bar and Kitchen <events@theivybk.com>', to: 'events@theivybk.com', mail: sampleInquiry.notification },
      ...contracts.previewEmails().filter((e) => e.group === 'Our team'),
      { group: 'Our team', title: 'Weekly reservations', from: RES_FROM, to: 'info@theivybk.com', mail: weeklyReportEmail(sampleWeek) },
      { group: 'Our team', title: 'Database backup', from: RES_FROM, to: 'info@theivybk.com', mail: backupEmail({ reason: 'weekly', stamp: '2026-09-28', counts: { agreements: 12, reservations: 340, event_inquiries: 41 } }) },
      { group: 'Our team', title: 'Job application', from: RES_FROM, to: 'info@theivybk.com', mail: applicationEmail({ fullName: 'Sam Rivera', phone: '312-555-0177', email: 'sam@example.com', position: 'Bartender', availability: 'Evenings and weekends', experience: '3 years at a Wrigleyville bar', file: { filename: 'Sam-Rivera-Resume.pdf' }, message: 'Happy to come in for a shift trial.' }) },
      { group: 'Our team', title: 'Updated print menus', from: RES_FROM, to: 'info@theivybk.com', mail: menusEmail() },
    ];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    res.end(emailPreviewPage(items));
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/details') {
    contracts.handleAdminDetails(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/send-payment-link') {
    contracts.handleAdminSendPaymentLink(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/reminders/run') {
    contracts.handleAdminReminders(req, res, new URL(req.url, 'http://localhost').searchParams.get('send') === '1');
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/toast-invoice') {
    contracts.handleAdminToastInvoice(req, res);
    return;
  }

  if (req.method === 'GET' && urlPath.startsWith('/admin/event-sheet/')) {
    contracts.handleAdminEventSheet(req, res, urlPath.slice('/admin/event-sheet/'.length).replace(/\/+$/, ''));
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/void') {
    contracts.handleAdminVoid(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/backup-now') {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reservations"', 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    sendDatabaseBackup('manual')
      .then((r) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === 'POST' && urlPath === '/admin/contracts/email') {
    contracts.handleAdminEmail(req, res);
    return;
  }

  // Emails the three current print-menu PDFs to info@theivybk.com. Reads and
  // base64-encodes the files server-side (never through an LLM context) since
  // that's the only practical way to move ~1-2MB of binary attachment data.
  if (req.method === 'POST' && urlPath === '/admin/send-menus') {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reservations"', 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    (async () => {
      try {
        const menuFiles = ['Beer-Cocktails-Menu.pdf', 'Food-Pizza-Menu.pdf', 'Spirits-Menu.pdf'];
        const attachments = menuFiles.map((filename) => ({
          filename,
          content: fs.readFileSync(path.join(__dirname, 'print-menus', filename)).toString('base64'),
        }));
        const result = await resendSendEmail({
          to: 'info@theivybk.com',
          subject: menusEmail().subject,
          text: menusEmail().text,
          html: menusEmail().html,
          attachments,
        });
        const ok = result.status >= 200 && result.status < 300;
        res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok, resend: result.body }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  if (req.method === 'GET' && urlPath === '/admin/db') {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reservations"', 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    // Test data from development (Claude-generated reservations) is
    // permanently baked into Resend's history -- Resend has no email-delete
    // API -- so we filter it out here rather than at the source.
    const isTestInquiry = (i) => /test/i.test(i.full_name) || /@example\.com$/i.test(i.email);

    const realReservations = dedupeReservations(db.prepare('SELECT * FROM reservations ORDER BY id DESC').all().filter((r) => !isTestReservation(r)));
    const realInquiries = db.prepare('SELECT * FROM event_inquiries ORDER BY id DESC').all().filter((i) => !isTestInquiry(i));
    const reservations = realReservations.slice(0, 50);
    const inquiries = realInquiries.slice(0, 50);
    const dbInfo = dbFileInfo();
    const reservationCount = realReservations.length;
    const inquiryCount = realInquiries.length;

    if (query.get('format') === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ database: dbFileInfo(), reservationCount, inquiryCount, reservations, inquiries }, null, 2));
      return;
    }

    const reservationRows = reservations.length
      ? reservations.map((r) => `
        <tr>
          <td data-label="Date">${escapeHtml(r.date)}<span class="sub-line">${escapeHtml(r.time)}</span></td>
          <td data-label="Name">${escapeHtml(r.full_name)}</td>
          <td data-label="Party" class="center">${escapeHtml(r.party_size)}</td>
          <td data-label="Contact"><a href="tel:${escapeHtml(r.phone)}">${escapeHtml(r.phone)}</a><span class="sub-line"><a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a></span></td>
          <td data-label="Notes">${r.notes ? escapeHtml(r.notes) : '<span class="muted">&mdash;</span>'}</td>
          <td data-label="Added" class="muted small">${escapeHtml(r.created_at)}</td>
        </tr>`).join('')
      : `<tr><td colspan="6" class="empty">No reservations yet.</td></tr>`;

    const inquiryRows = inquiries.length
      ? inquiries.map((i) => `
        <tr>
          <td data-label="Date">${escapeHtml(i.event_date)}<span class="sub-line">${escapeHtml(i.event_time)}</span></td>
          <td data-label="Name">${escapeHtml(i.full_name)}${i.company ? `<span class="sub-line">${escapeHtml(i.company)}</span>` : ''}</td>
          <td data-label="Occasion">${escapeHtml(i.occasion)}<span class="sub-line">${escapeHtml(i.guest_count)} guests &middot; ${escapeHtml(i.space_preference)}</span></td>
          <td data-label="Contact"><a href="tel:${escapeHtml(i.phone)}">${escapeHtml(i.phone)}</a><span class="sub-line"><a href="mailto:${escapeHtml(i.email)}">${escapeHtml(i.email)}</a></span></td>
          <td data-label="Details">${i.details ? escapeHtml(i.details) : '<span class="muted">&mdash;</span>'}</td>
          <td data-label="Added" class="muted small">${escapeHtml(i.created_at)}</td>
        </tr>`).join('')
      : `<tr><td colspan="6" class="empty">No event inquiries yet.</td></tr>`;

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Ivy — Database</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;1,500&family=Outfit:wght@400;500;600&display=swap');
  :root {
    --ivy: #1F3D2A; --ivy-deep: #16301F; --brass: #B8923D; --brass-deep: #7A5F27;
    --ink: #14140F; --ink-soft: #4A4A42; --ink-mute: #686860;
    --cream: #F5EFE3; --cream-warm: #EBE3D2; --cream-pure: #FBF7EE;
    --border: rgba(31,61,42,.15);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Outfit', -apple-system, sans-serif; color: var(--ink); background: var(--cream); padding: 40px 24px 80px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-family: 'Cormorant Garamond', serif; font-style: italic; font-weight: 600; font-size: 36px; color: var(--ivy); margin: 0 0 4px; }
  .stats { display: flex; gap: 16px; margin: 20px 0 40px; flex-wrap: wrap; }
  .stat { background: var(--cream-pure); border: 1px solid var(--border); border-radius: 4px; padding: 14px 22px; }
  .stat .n { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 30px; color: var(--ivy); line-height: 1; }
  .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--brass-deep); font-weight: 600; margin-top: 4px; }
  section { margin-bottom: 48px; }
  h2 { font-family: 'Cormorant Garamond', serif; font-style: italic; font-weight: 600; font-size: 24px; color: var(--ivy); border-bottom: 2px solid var(--ivy); padding-bottom: 8px; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; background: var(--cream-pure); border-radius: 4px; overflow: hidden; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--brass-deep); font-weight: 600; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  td { padding: 12px 14px; font-size: 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  a { color: var(--ivy); text-decoration: none; }
  a:hover { color: var(--brass-deep); }
  .sub-line { display: block; font-size: 12px; color: var(--ink-mute); margin-top: 2px; }
  .center { text-align: center; }
  .muted { color: var(--ink-mute); }
  .small { font-size: 12px; white-space: nowrap; }
  .empty { text-align: center; color: var(--ink-mute); font-style: italic; padding: 24px; }
  @media (max-width: 700px) {
    table, thead, tbody, tr { display: block; }
    thead { display: none; }
    tr { border-bottom: 8px solid var(--cream); }
    td { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border); text-align: right; }
    td::before { content: attr(data-label); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--brass-deep); font-weight: 600; text-align: left; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>The Ivy — Database</h1>
    <p class="muted">Stored on the persistent volume. Reservations and inquiries are added as they arrive. Newsletter subscribers are kept only in Resend.</p>
    <p class="muted small" style="white-space:normal">Database file: ${escapeHtml(dbInfo.path)}${dbInfo.sizeBytes != null ? ` (${Math.round(dbInfo.sizeBytes / 1024)} KB)` : ''}${dbInfo.createdAt ? `, created ${escapeHtml(dbInfo.createdAt)}` : ''}${dbInfo.persistent ? ' &middot; on a persistent volume' : ' &middot; not on a volume, so it is wiped on every deploy'}</p>
    <div class="stats">
      <div class="stat"><div class="n">${reservationCount}</div><div class="label">Reservations</div></div>
      <div class="stat"><div class="n">${inquiryCount}</div><div class="label">Event Inquiries</div></div>
    </div>
    <section>
      <h2>Reservations</h2>
      <table>
        <thead><tr><th>Date</th><th>Name</th><th class="center">Party</th><th>Contact</th><th>Notes</th><th>Added</th></tr></thead>
        <tbody>${reservationRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Private Event Inquiries</h2>
      <table>
        <thead><tr><th>Date</th><th>Name</th><th>Occasion</th><th>Contact</th><th>Details</th><th>Added</th></tr></thead>
        <tbody>${inquiryRows}</tbody>
      </table>
    </section>
  </div>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && urlPath === '/admin/reservations') {
    const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    handleReservationsReport(req, res, query);
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/weekly-report-email') {
    const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    handleWeeklyReportEmail(req, res, query);
    return;
  }

  if ((req.method === 'GET' || req.method === 'POST') && urlPath === '/unsubscribe') {
    const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    handleUnsubscribe(req, res, query);
    return;
  }

  if (req.method === 'GET' && urlPath === '/mailer') {
    res.writeHead(302, { Location: '/?utm_source=eddm&utm_medium=direct_mail&utm_campaign=eddm_mailer' });
    res.end();
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(ROOT, urlPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      serveFile(filePath, req, res);
      return;
    }
    const withHtml = filePath + '.html';
    fs.stat(withHtml, (err2, stats2) => {
      if (!err2 && stats2.isFile()) {
        serveFile(withHtml, req, res);
      } else {
        fs.readFile(path.join(ROOT, '404.html'), (err3, data) => {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(err3 ? '404 Not Found' : data);
        });
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`The Ivy site running on port ${PORT}`);
  hydrateDbFromResend();
  setTimeout(maybeSendWeeklyBackup, 2 * 60 * 1000).unref();
  setInterval(maybeSendWeeklyBackup, 60 * 60 * 1000).unref();
  // Automatic event reminders (final details, event brief, date holds ending).
  const runEventReminders = async () => {
    try {
      const sent = (await contracts.runReminders()).filter((r) => r.sent || r.error);
      if (sent.length) console.log('Event reminders:', JSON.stringify(sent));
    } catch (err) {
      console.error('Event reminders error:', err.message);
    }
  };
  setTimeout(runEventReminders, 3 * 60 * 1000).unref();
  setInterval(runEventReminders, 60 * 60 * 1000).unref();
});
