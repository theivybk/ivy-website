const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'dist');

const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      from: 'The Ivy Bar and Kitchen <onboarding@resend.dev>',
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
