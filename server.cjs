const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'dist');

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || '').trim();
const WEEKLY_REPORT_SECRET = (process.env.WEEKLY_REPORT_SECRET || '').trim();

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
  CREATE TABLE IF NOT EXISTS newsletter_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resend_contact_id TEXT UNIQUE,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const insertReservation = db.prepare(
  `INSERT OR IGNORE INTO reservations (resend_email_id, full_name, phone, email, date, time, party_size, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertNewsletterSignup = db.prepare(
  `INSERT OR IGNORE INTO newsletter_signups (resend_contact_id, email) VALUES (?, ?)`
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

// Reservation history lives entirely in already-sent Resend emails -- no
// separate database needed. We list recent emails, keep the ones whose
// subject matches our reservation format, then fetch each one's full body
// (the list endpoint only returns metadata) to recover the structured data.
//
// Resend has no email-delete API, so "clearing" old (test) reservations
// isn't possible at the source -- instead we hide anything sent before this
// cutoff. Real reservations from this point on are unaffected.
const RESERVATIONS_VISIBLE_SINCE = '2026-08-15 23:30:55+00';

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
  return reservations;
}

async function hydrateDbFromResend() {
  if (!RESEND_API_KEY) return;
  try {
    const reservations = await readReservations();
    for (const r of reservations) {
      insertReservation.run(r.resend_email_id, r.full_name, r.phone, r.email, r.date, r.time, r.party_size, r.notes);
    }
    console.log(`DB hydration: ${reservations.length} reservation(s) from Resend history.`);
  } catch (err) {
    console.error('DB hydration (reservations) error:', err.message);
  }

  try {
    const result = await resendGet(`/audiences/${RESEND_AUDIENCE_ID}/contacts`);
    const contacts = (result.status < 300 && result.body.data) || [];
    for (const c of contacts) {
      insertNewsletterSignup.run(c.id, c.email);
    }
    console.log(`DB hydration: ${contacts.length} newsletter signup(s) from Resend audience.`);
  } catch (err) {
    console.error('DB hydration (newsletter) error:', err.message);
  }
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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const dayLabel = (dateStr) => new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

// Simple branded HTML wrapper for customer-facing emails — table-based layout
// with inline styles, since email clients don't support external stylesheets
// or much modern CSS.
function emailTemplate({ heading, bodyHtml, unsubscribeUrl }) {
  return `<!doctype html>
<html>
<body style="margin:0; padding:0; background-color:#EBE3D2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EBE3D2; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#FBF7EE; border-radius:4px; overflow:hidden; max-width:480px; width:100%;">
          <tr>
            <td align="center" style="background-color:#1F3D2A; padding:32px 24px;">
              <img src="https://theivybk.com/assets/img/logo/logo-gold.png" alt="The Ivy Bar and Kitchen" width="64" style="display:block; width:64px; height:auto;">
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px; font-family:Georgia,'Times New Roman',serif;">
              <h1 style="font-style:italic; font-weight:normal; font-size:26px; color:#1F3D2A; margin:0 0 16px; text-align:center;">${heading}</h1>
              <div style="font-size:15px; line-height:1.6; color:#14140F;">
                ${bodyHtml}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 32px; font-family:Georgia,'Times New Roman',serif;">
              <p style="font-size:12px; color:#686860; text-align:center; margin:16px 0 0; border-top:1px solid rgba(31,61,42,.15); padding-top:16px;">
                The Ivy Bar and Kitchen &middot; 1625 W Irving Park Rd, Chicago, IL 60613 &middot; (773) 799-8160
              </p>
              ${unsubscribeUrl ? `<p style="font-size:12px; color:#686860; text-align:center; margin:8px 0 0;"><a href="${unsubscribeUrl}" style="color:#686860;">Unsubscribe from marketing emails</a></p>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function getWeekReservations(weekParam) {
  const monday = mondayOf(weekParam);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const mondayStr = toDateStr(monday);
  const sundayStr = toDateStr(sunday);

  const all = await readReservations();
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

  const lines = [`Reservation requests for the week of ${dayLabel(mondayStr)} - ${dayLabel(sundayStr)}`, ''];
  if (inRange.length === 0) {
    lines.push('No reservation requests for this week.');
  } else {
    for (const dateStr of Object.keys(byDay).sort()) {
      lines.push(dayLabel(dateStr).toUpperCase());
      for (const r of byDay[dateStr]) {
        lines.push(`  ${r.time} — ${r.full_name}, party of ${r.party_size} — ${r.phone} — ${r.email}${r.notes ? ` — ${r.notes}` : ''}`);
      }
      lines.push('');
    }
  }
  lines.push(`Full printable report: https://www.theivybk.com/admin/reservations?week=${mondayStr}`);

  try {
    const result = await resendSendEmail({
      to: RESERVATION_TO_EMAIL,
      subject: `Weekly Reservations — ${mondayStr} to ${sundayStr} (${inRange.length})`,
      text: lines.join('\n'),
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

function resendSendEmail({ to, subject, text, html, replyTo, attachments, headers }) {
  return new Promise((resolve, reject) => {
    const payload = {
      from: 'The Ivy Bar and Kitchen <info@theivybk.com>',
      to: [to],
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
  const unsubscribeUrl = `https://theivybk.com/unsubscribe?email=${encodeURIComponent(email)}`;
  const welcomeText = [
    `You're on the list!`,
    ``,
    `Thanks for signing up for updates from The Ivy Bar and Kitchen. Here's what's happening every week:`,
    ``,
    `Weekly Specials`,
    `Monday — Monday Night Pizza: half off pizza with the purchase of a drink`,
    `Tuesday — Taco Tuesday: $3 tacos, $6 Modelos, $9 margaritas`,
    `Wednesday — Burger & Brew: burger and beer combo, $20`,
    `Thursday — Girl Dinner Thursday: salad, truffle fries & a glass of wine, $30`,
    ``,
    `HAPPY HOUR — Monday–Thursday, 3-5pm`,
    `$1 off draft, cans & bottles · $2 off wine · $3 off cocktails`,
    ``,
    `TRIVIA NIGHT — Every Wednesday, 7-9pm`,
    `Hosted by Geeks Who Drink.`,
    ``,
    `Order Online`,
    `https://order.toasttab.com/online/the-ivy-1625-west-irving-park-road`,
    ``,
    `See you soon.`,
    ``,
    `The Ivy Bar and Kitchen`,
    `1625 W Irving Park Rd, Chicago, IL 60613`,
    `(773) 799-8160`,
    ``,
    `Unsubscribe from marketing emails: ${unsubscribeUrl}`,
  ].join('\n');
  const welcomeHtml = emailTemplate({
    heading: "You're on the list!",
    bodyHtml: `
      <p style="margin:0 0 20px;">Thanks for signing up for updates from The Ivy Bar and Kitchen. Here's what's happening every week:</p>
      <p style="margin:0 0 8px; font-weight:bold; color:#7A5F27; text-transform:uppercase; font-size:12px; letter-spacing:.04em;">Weekly Specials</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 16px; font-size:14px;">
        <tr><td style="padding:4px 0; font-weight:bold; width:90px; vertical-align:top;">Mon</td><td style="padding:4px 0;">Monday Night Pizza — half off pizza with a drink</td></tr>
        <tr><td style="padding:4px 0; font-weight:bold; vertical-align:top;">Tue</td><td style="padding:4px 0;">Taco Tuesday — $3 tacos, $6 Modelos, $9 margaritas</td></tr>
        <tr><td style="padding:4px 0; font-weight:bold; vertical-align:top;">Wed</td><td style="padding:4px 0;">Burger &amp; Brew — burger + beer combo, $20</td></tr>
        <tr><td style="padding:4px 0; font-weight:bold; vertical-align:top;">Thu</td><td style="padding:4px 0;">Girl Dinner Thursday — salad, truffle fries &amp; a glass of wine, $30</td></tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 24px;">
        <tr>
          <td style="background-color:#1F3D2A; border-radius:4px; padding:18px 20px; text-align:center;">
            <p style="margin:0 0 4px; color:#D8B563; text-transform:uppercase; font-size:12px; letter-spacing:.06em; font-weight:bold;">Happy Hour</p>
            <p style="margin:0 0 8px; color:#FBF7EE; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:19px;">Monday&ndash;Thursday, 3&ndash;5pm</p>
            <p style="margin:0; color:rgba(251,247,238,.85); font-size:13px;">$1 off draft, cans &amp; bottles &nbsp;&middot;&nbsp; $2 off wine &nbsp;&middot;&nbsp; $3 off cocktails</p>
          </td>
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 24px;">
        <tr>
          <td style="background-color:#FBF7EE; border:1px solid #B8923D; border-radius:4px; padding:18px 20px; text-align:center;">
            <p style="margin:0 0 4px; color:#7A5F27; text-transform:uppercase; font-size:12px; letter-spacing:.06em; font-weight:bold;">Trivia Night</p>
            <p style="margin:0 0 8px; color:#1F3D2A; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:19px;">Every Wednesday, 7&ndash;9pm</p>
            <p style="margin:0; color:#686860; font-size:13px;">Hosted by Geeks Who Drink</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 24px; text-align:center;">
        <a href="https://order.toasttab.com/online/the-ivy-1625-west-irving-park-road" style="display:inline-block; background-color:#1F3D2A; color:#FBF7EE; text-decoration:none; padding:12px 28px; border-radius:2px; font-size:14px;">Order Online</a>
      </p>
      <p style="margin:0;">See you soon.</p>
    `,
    unsubscribeUrl,
  });
  return resendSendEmail({
    to: email,
    subject: "You're on the list — The Ivy Bar and Kitchen",
    text: welcomeText,
    html: welcomeHtml,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}

const RESERVATION_TO_EMAIL = 'info@theivybk.com';

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

  const subject = `Table Reservation — ${date} at ${time} — ${fullName}`;
  const text = [
    `Name: ${fullName}`,
    `Phone: ${phone}`,
    `Email: ${email}`,
    `Date: ${date}`,
    `Time: ${time}`,
    `Party Size: ${partySize}`,
    ``,
    `Special Requests:`,
    notes,
  ].join('\n');
  // The admin reservations report parses this exact plain-text format out of
  // Resend's email history (see parseReservationEmailText), so the `text`
  // field above must keep its labels as-is. The `html` version below is
  // purely a nicer-looking display layer on top — it doesn't touch parsing.
  const notificationHtml = emailTemplate({
    heading: 'New Reservation Request',
    bodyHtml: `
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; font-size:14px;">
        <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; width:120px; vertical-align:top;">Name</td><td style="padding:4px 0;">${escapeHtml(fullName)}</td></tr>
        <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Phone</td><td style="padding:4px 0;"><a href="tel:${escapeHtml(phone)}" style="color:#1F3D2A;">${escapeHtml(phone)}</a></td></tr>
        <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Email</td><td style="padding:4px 0;"><a href="mailto:${escapeHtml(email)}" style="color:#1F3D2A;">${escapeHtml(email)}</a></td></tr>
        <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Date</td><td style="padding:4px 0;">${escapeHtml(date)}</td></tr>
        <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Time</td><td style="padding:4px 0;">${escapeHtml(time)}</td></tr>
        <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Party Size</td><td style="padding:4px 0;">${escapeHtml(partySize)}</td></tr>
        ${notes !== '—' ? `<tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Special Requests</td><td style="padding:4px 0;">${escapeHtml(notes)}</td></tr>` : ''}
      </table>
      <p style="margin:0; font-size:13px; color:#686860;">Reply directly to this email to reach ${escapeHtml(fullName)} at ${escapeHtml(email)}.</p>
    `,
  });

  try {
    const result = await resendSendEmail({ to: RESERVATION_TO_EMAIL, subject, text, html: notificationHtml, replyTo: email });
    if (result.status === 200 || result.status === 201) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      resendSubscribe(email).catch((err) => console.error('Reservation newsletter subscribe error:', err.message));
      // Delayed a day so it doesn't land alongside the reservation confirmation.
      // In-memory timer -- if the server restarts before it fires (e.g. a
      // redeploy), this send is lost. Acceptable for a non-critical marketing
      // email; not worth a durable job queue for this volume.
      setTimeout(() => {
        sendWelcomeEmail(email).catch((err) => console.error('Reservation welcome email error:', err.message));
      }, 24 * 60 * 60 * 1000).unref();

      try {
        insertReservation.run(result.body.id, fullName, phone, email, date, time, partySize, notes);
      } catch (err) {
        console.error('Reservation DB insert error:', err.message);
      }

      const confirmationText = [
        `Hi ${fullName},`,
        ``,
        `You're all set! Here's your reservation at The Ivy Bar and Kitchen:`,
        ``,
        `Date: ${dayLabel(date)}`,
        `Time: ${time}`,
        `Party Size: ${partySize}`,
        ...(notes !== '—' ? [`Special Requests: ${notes}`] : []),
        ``,
        `Need to make a change or have a question? Call us at (773) 799-8160 — happy to help.`,
        ``,
        `We can't wait to see you.`,
        ``,
        `The Ivy Bar and Kitchen`,
        `1625 W Irving Park Rd, Chicago, IL 60613`,
        `(773) 799-8160`,
      ].join('\n');
      const confirmationHtml = emailTemplate({
        heading: "You're all set!",
        bodyHtml: `
          <p style="margin:0 0 16px;">Hi ${escapeHtml(fullName)},</p>
          <p style="margin:0 0 16px;">Here's your reservation at The Ivy Bar and Kitchen:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; font-size:14px;">
            <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; width:120px; vertical-align:top;">Date</td><td style="padding:4px 0;">${escapeHtml(dayLabel(date))}</td></tr>
            <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Time</td><td style="padding:4px 0;">${escapeHtml(time)}</td></tr>
            <tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Party Size</td><td style="padding:4px 0;">${escapeHtml(partySize)}</td></tr>
            ${notes !== '—' ? `<tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; vertical-align:top;">Special Requests</td><td style="padding:4px 0;">${escapeHtml(notes)}</td></tr>` : ''}
          </table>
          <p style="margin:0 0 16px;">Need to make a change or have a question? Call us at <a href="tel:+17737998160" style="color:#1F3D2A;">(773) 799-8160</a> — happy to help.</p>
          <p style="margin:0;">We can't wait to see you.</p>
        `,
      });
      resendSendEmail({ to: email, subject: "You're Confirmed — The Ivy Bar and Kitchen", text: confirmationText, html: confirmationHtml })
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

  const subject = `Job Application — ${position} — ${fullName}`;
  const text = [
    `Name: ${fullName}`,
    `Phone: ${phone}`,
    `Email: ${email}`,
    `Position: ${position}`,
    `Availability: ${availability}`,
    `Experience: ${experience}`,
    `Resume: ${file ? file.filename : '—'}`,
    ``,
    `Message:`,
    message,
  ].join('\n');

  const attachments = [];
  if (file && file.buffer && file.buffer.length) {
    attachments.push({ filename: file.filename, content: file.buffer.toString('base64') });
  }

  try {
    const result = await resendSendEmail({ to: RESERVATION_TO_EMAIL, subject, text, replyTo: email, attachments });
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
    const result = await resendSubscribe(email);
    const alreadyExists = /already|exist/i.test(result.body && result.body.message || '');
    if (result.status === 200 || result.status === 201 || alreadyExists) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, alreadySubscribed: alreadyExists && result.status >= 400 }));

      try {
        insertNewsletterSignup.run(result.body && result.body.id, email);
      } catch (err) {
        console.error('Newsletter signup DB insert error:', err.message);
      }

      if (!alreadyExists) {
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
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// Only compress text-based formats — images/fonts are already compressed.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.xml', '.txt']);

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

function checkRateLimit(req, routeGroup) {
  const key = `${routeGroup}:${getClientIp(req)}`;
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count++;
  return true;
}

function rejectRateLimited(res) {
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Too many requests. Please try again in a few minutes.' }));
}

const server = http.createServer((req, res) => {
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

  if (req.method === 'GET' && urlPath === '/admin/db') {
    if (!checkBasicAuth(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reservations"', 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    // Test data from development (Claude-generated reservations/signups) is
    // permanently baked into Resend's history -- Resend has no email-delete
    // API -- so we filter it out here rather than at the source.
    const isTestReservation = (r) =>
      /test/i.test(r.full_name) || /@example\.com$/i.test(r.email) || /please ignore/i.test(r.notes || '');
    const isTestSignup = (s) => /@example\.com$/i.test(s.email) || /^sqlite-test@/i.test(s.email);

    const realReservations = db.prepare('SELECT * FROM reservations ORDER BY id DESC').all().filter((r) => !isTestReservation(r));
    const realSignups = db.prepare('SELECT * FROM newsletter_signups ORDER BY id DESC').all().filter((s) => !isTestSignup(s));
    const reservations = realReservations.slice(0, 50);
    const signups = realSignups.slice(0, 50);
    const reservationCount = realReservations.length;
    const signupCount = realSignups.length;

    if (query.get('format') === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reservationCount, signupCount, reservations, signups }, null, 2));
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

    const signupRows = signups.length
      ? signups.map((s) => `
        <tr>
          <td data-label="Email"><a href="mailto:${escapeHtml(s.email)}">${escapeHtml(s.email)}</a></td>
          <td data-label="Added" class="muted small">${escapeHtml(s.created_at)}</td>
        </tr>`).join('')
      : `<tr><td colspan="2" class="empty">No signups yet.</td></tr>`;

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
    <p class="muted">Rebuilt from Resend on every server restart — nothing here can be lost.</p>
    <div class="stats">
      <div class="stat"><div class="n">${reservationCount}</div><div class="label">Reservations</div></div>
      <div class="stat"><div class="n">${signupCount}</div><div class="label">Newsletter Signups</div></div>
    </div>
    <section>
      <h2>Reservations</h2>
      <table>
        <thead><tr><th>Date</th><th>Name</th><th class="center">Party</th><th>Contact</th><th>Notes</th><th>Added</th></tr></thead>
        <tbody>${reservationRows}</tbody>
      </table>
    </section>
    <section>
      <h2>Newsletter Signups</h2>
      <table>
        <thead><tr><th>Email</th><th>Added</th></tr></thead>
        <tbody>${signupRows}</tbody>
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
});
