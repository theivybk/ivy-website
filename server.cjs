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
};

// Only compress text-based formats — images/fonts are already compressed.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg']);

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
