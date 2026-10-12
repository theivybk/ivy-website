'use strict';

// Daily host sheet email: the day's table reservations laid out for the host
// stand. Pure functions only (no database, no network) so they can be tested on
// their own. server.cjs reads the reservations, calls buildHostSheet, and sends
// the result to info@theivybk.com on days with enough reservations.

const COLORS = { ivy: '#1F3D2A', cream: '#F5EFE3', brass: '#8A6A26', brick: '#B0441E', line: '#D9D0BD', gray: '#555555' };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "11:30 AM" -> minutes since midnight. Unknown formats sort last.
function minutesOf(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t || '').trim());
  if (!m) return 24 * 60;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

function partyOf(r) {
  const n = parseInt(r.party_size, 10);
  return Number.isFinite(n) ? n : 0;
}

function phoneDigits(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d;
}

function formatPhone(p) {
  const d = phoneDigits(p);
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(p || '').trim();
}

// The reservation form stores an em dash when the guest left the notes blank.
function cleanNote(n) {
  const s = String(n || '').trim();
  return s === '—' || s === '-' ? '' : s;
}

function dayHeading(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Same guest phone + same date + same time is one table requested twice (a
// retry, or a corrected email address). Keep the latest request and remember
// the others so the sheet can say so.
function collapseSamePhone(reservations) {
  const groups = new Map();
  const order = [];
  (reservations || []).forEach((r) => {
    const d = phoneDigits(r.phone);
    const key = d ? d + '|' + r.date + '|' + r.time : 'id:' + r.id;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(r);
  });
  const rows = [];
  const collapsed = [];
  order.forEach((key) => {
    const g = groups.get(key);
    const sorted = g.slice().sort((a, b) => {
      const byCreated = String(b.created_at || '').localeCompare(String(a.created_at || ''));
      return byCreated || (b.id || 0) - (a.id || 0);
    });
    const best = sorted[0];
    const others = sorted.slice(1);
    rows.push({ ...best, _alsoRequested: others.map((o) => partyOf(o)) });
    if (others.length) collapsed.push({ name: best.full_name, requests: g.length });
  });
  return { rows, collapsed };
}

function buildHostSheet({ date, reservations, calendarItems, minReservations }) {
  const collapsedResult = collapseSamePhone(reservations);
  const collapsed = collapsedResult.collapsed;
  const rows = collapsedResult.rows
    .slice()
    .sort((a, b) => minutesOf(a.time) - minutesOf(b.time) || String(a.full_name).localeCompare(String(b.full_name)));
  const guests = rows.reduce((n, r) => n + partyOf(r), 0);

  const groups = [];
  rows.forEach((r) => {
    const last = groups[groups.length - 1];
    if (last && last.time === r.time) last.rows.push(r);
    else groups.push({ time: r.time, rows: [r] });
  });
  groups.forEach((g) => {
    g.guests = g.rows.reduce((n, r) => n + partyOf(r), 0);
  });

  const heading = dayHeading(date);
  const extras = (calendarItems || []).filter((e) => e && e.summary);

  const heads = [];
  const peak = groups.slice().sort((a, b) => b.guests - a.guests)[0];
  if (peak && peak.rows.length >= 3) {
    heads.push(peak.time + ': ' + peak.rows.length + ' tables, ' + peak.guests + ' guests arriving together.');
  }
  const big = rows.filter((r) => partyOf(r) >= 8);
  if (big.length) {
    heads.push('Large parties (8 or more): ' + big.map((r) => r.full_name + ' (' + partyOf(r) + ') at ' + r.time).join(', ') + '.');
  }
  const diet = rows.filter((r) => /celiac|gluten|allerg|vegan|vegetarian|dairy|shellfish/i.test(cleanNote(r.notes)));
  if (diet.length) {
    heads.push('Allergy or dietary notes: ' + diet.map((r) => r.full_name + ' (party of ' + partyOf(r) + ')').join(', ') + '.');
  }
  const roofKids = rows.filter((r) => {
    const n = cleanNote(r.notes);
    return /roof/i.test(n) && /child|kid|baby|infant|toddler|stroller/i.test(n);
  });
  if (roofKids.length) {
    heads.push('The rooftop is 21+. ' + roofKids.map((r) => r.full_name).join(', ') + ' asked for the rooftop with children, so plan indoor seating.');
  }
  if (collapsed.length) {
    heads.push('Requested twice with the same phone at the same time: ' + collapsed.map((c) => c.name).join(', ') + '. Showing the latest request only.');
  }
  heads.push('Online-form reservations only. Phone bookings and walk-ins are not on this list.');

  const subject = 'Host sheet: ' + heading + ', ' + rows.length + ' reservations, ' + guests + ' guests';

  // ---- HTML (inline styles so it survives email clients and prints cleanly)
  const th = (label, extra) =>
    '<th style="background:' + COLORS.ivy + ';color:' + COLORS.cream + ';font:bold 10px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;text-align:left;padding:5px 6px;' + (extra || '') + '">' + label + '</th>';
  const td = (inner, extra) =>
    '<td style="padding:5px 6px;border-bottom:1px solid ' + COLORS.line + ';vertical-align:top;font:13px Georgia,serif;color:#222;' + (extra || '') + '">' + inner + '</td>';

  let body = '';
  groups.forEach((g) => {
    body +=
      '<tr><td colspan="6" style="background:' + COLORS.cream + ';border-bottom:1px solid ' + COLORS.ivy + ';padding:4px 6px;font:bold 11px Arial,sans-serif;letter-spacing:1px;color:' + COLORS.ivy + ';">' +
      esc(g.time) + ' &middot; ' + g.rows.length + (g.rows.length === 1 ? ' table, ' : ' tables, ') + g.guests + ' guests</td></tr>';
    g.rows.forEach((r) => {
      const note = cleanNote(r.notes);
      const also = (r._alsoRequested || []).length
        ? '<span style="color:' + COLORS.gray + ';font-size:11px;">Also requested: party of ' + r._alsoRequested.join(', party of ') + ' (same phone).</span>'
        : '';
      const noteHtml = [note ? '<span style="color:' + COLORS.brick + ';font-weight:bold;">' + esc(note) + '</span>' : '', also].filter(Boolean).join('<br>');
      body +=
        '<tr>' +
        td('<b style="font-family:Arial,sans-serif;">' + esc(r.time) + '</b>', 'white-space:nowrap;') +
        td('<b style="font-family:Arial,sans-serif;font-size:14px;">' + esc(r.full_name) + '</b><br><span style="color:' + COLORS.gray + ';font-size:11px;">' + esc(r.email) + '</span>') +
        td('<b style="font-family:Arial,sans-serif;font-size:16px;color:' + COLORS.ivy + ';">' + esc(partyOf(r) || r.party_size) + '</b>', 'text-align:center;') +
        td('<span style="font-family:Arial,sans-serif;white-space:nowrap;">' + esc(formatPhone(r.phone)) + '</span>') +
        td(noteHtml) +
        td('&#9744;', 'text-align:center;font-size:16px;') +
        '</tr>';
    });
  });

  let extraHtml = '';
  if (extras.length) {
    extraHtml =
      '<div style="margin-top:14px;border:2px solid ' + COLORS.brass + ';padding:8px 10px;font:13px Georgia,serif;">' +
      '<div style="font:bold 11px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:' + COLORS.brass + ';margin-bottom:4px;">Also on the calendar today</div>' +
      extras
        .map((e) => '<div style="margin:2px 0;"><b>' + esc(e.when || '') + '</b> ' + esc(e.summary) + (e.detail ? ' <span style="color:' + COLORS.gray + ';font-size:12px;">' + esc(e.detail) + '</span>' : '') + '</div>')
        .join('') +
      '</div>';
  }

  const headsHtml =
    '<div style="margin-top:14px;font:13px Georgia,serif;">' +
    '<div style="font:bold 11px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:' + COLORS.brick + ';margin-bottom:4px;">Heads up</div>' +
    heads.map((h) => '<div style="border-left:3px solid ' + COLORS.brick + ';padding:1px 0 1px 8px;margin:4px 0;">' + esc(h) + '</div>').join('') +
    '</div>';

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(subject) + '</title></head>' +
    '<body style="margin:0;padding:16px;background:#ffffff;">' +
    '<div style="max-width:780px;margin:0 auto;">' +
    '<div style="border-bottom:3px solid ' + COLORS.ivy + ';padding-bottom:6px;margin-bottom:8px;">' +
    '<div style="font:italic bold 28px Georgia,serif;color:' + COLORS.ivy + ';">' + esc(heading) + '</div>' +
    '<div style="font:bold 11px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:' + COLORS.brass + ';margin-top:2px;">Reservations &middot; The Ivy Bar + Kitchen &middot; ' +
    rows.length + ' reservations &middot; ' + guests + ' guests</div></div>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;">' +
    '<thead><tr>' + th('Time') + th('Guest') + th('Party', 'text-align:center;') + th('Phone') + th('Notes') + th('Seated', 'text-align:center;') + '</tr></thead>' +
    '<tbody>' + body + '</tbody></table>' +
    extraHtml + headsHtml +
    '<div style="margin-top:12px;font:11px Arial,sans-serif;color:#777;">Sent automatically each morning at 8 AM on days with ' + (minReservations || 5) + ' or more reservations. Contains guest contact details: keep it at the host stand and shred after service. Print this email to use it as the sheet.</div>' +
    '</div></body></html>';

  // ---- Plain text fallback
  const lines = [heading + ': ' + rows.length + ' reservations, ' + guests + ' guests', ''];
  groups.forEach((g) => {
    lines.push(g.time + ' (' + g.rows.length + (g.rows.length === 1 ? ' table, ' : ' tables, ') + g.guests + ' guests)');
    g.rows.forEach((r) => {
      const note = cleanNote(r.notes);
      lines.push('  ' + r.full_name + ', party of ' + (partyOf(r) || r.party_size) + ', ' + formatPhone(r.phone) + ', ' + r.email + (note ? ' | ' + note : ''));
    });
    lines.push('');
  });
  if (extras.length) {
    lines.push('Also on the calendar today:');
    extras.forEach((e) => lines.push('  ' + (e.when ? e.when + ' ' : '') + e.summary + (e.detail ? ' (' + e.detail + ')' : '')));
    lines.push('');
  }
  lines.push('Heads up:');
  heads.forEach((h) => lines.push('  - ' + h));

  return { subject, html, text: lines.join('\n'), stats: { reservations: rows.length, guests, collapsed: collapsed.length } };
}

module.exports = { buildHostSheet, collapseSamePhone, dayHeading, formatPhone };
