const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'dist');

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || '').trim();
const WEEKLY_REPORT_SECRET = (process.env.WEEKLY_REPORT_SECRET || '').trim();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
        if (typeof item.subject === 'string' && item.subject.startsWith('Table Reservation — ')) {
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
        reservations.push(parseReservationEmailText(result.body.text));
      }
    } catch (err) {
      console.error('Resend fetch email error:', err.message);
    }
  }
  return reservations;
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

function resendSubscribe(email) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ email, unsubscribed: false });
    const options = {
      hostname: 'api.resend.com',
      path: '/contacts',
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

function resendSendEmail({ to, subject, text, replyTo }) {
  return new Promise((resolve, reject) => {
    const payload = {
      from: 'The Ivy Bar and Kitchen <info@theivybk.com>',
      to: [to],
      subject,
      text,
    };
    if (replyTo) payload.reply_to = replyTo;
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

  try {
    const result = await resendSendEmail({ to: RESERVATION_TO_EMAIL, subject, text, replyTo: email });
    if (result.status === 200 || result.status === 201) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      resendSubscribe(email).catch((err) => console.error('Reservation newsletter subscribe error:', err.message));
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

function serveFile(filePath, req, res) {
  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
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

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST' && urlPath === '/api/newsletter') {
    handleNewsletterSignup(req, res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/reserve') {
    handleReservation(req, res);
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
});
