'use strict';
// Every email the site sends is built here (or, for private event agreements,
// in contract.cjs using the pieces below). The builders are pure functions that
// return { subject, text, html }, so the admin preview page can show each email
// exactly as it is sent.
//
// NOTE: the plain-text bodies of the reservation and inquiry emails are parsed
// back out of Resend's history to rebuild the database (see server.cjs), so
// keep their labels exactly as they are.

const SITE = 'https://theivybk.com';
const PHONE = '(773) 799-8160';
const PHONE_LINK = '+17737998160';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const dayLabel = (dateStr) => new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

// Simple branded HTML wrapper for customer-facing emails: table-based layout
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
              <img src="${SITE}/assets/img/logo/logo-gold.png" alt="The Ivy Bar and Kitchen" width="64" style="display:block; width:64px; height:auto;">
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
                The Ivy Bar and Kitchen &middot; 1625 W Irving Park Rd, Chicago, IL 60613 &middot; ${PHONE}
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

// ------------------------------------------------------------ building blocks

// rows: [label, value, link?]. link can be 'tel', 'mailto', or a URL. Rows with
// an empty value are skipped. Multi-line values keep their line breaks.
function emailDetails(rows, labelWidth = 140) {
  const body = rows
    .filter((r) => r && r[1] != null && String(r[1]).trim() !== '')
    .map(([label, value, link]) => {
      const text = escapeHtml(value);
      let cell;
      if (link === 'tel') cell = `<a href="tel:${escapeHtml(String(value).replace(/[^+\d]/g, ''))}" style="color:#1F3D2A;">${text}</a>`;
      else if (link === 'mailto') cell = `<a href="mailto:${text}" style="color:#1F3D2A;">${text}</a>`;
      else if (link) cell = `<a href="${escapeHtml(link)}" style="color:#1F3D2A;">${text}</a>`;
      else cell = text.replace(/\n/g, '<br>');
      return `<tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; width:${labelWidth}px; vertical-align:top;">${escapeHtml(label)}</td><td style="padding:4px 0; vertical-align:top;">${cell}</td></tr>`;
    })
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; font-size:14px;">${body}</table>`;
}

function emailButton(label, url) {
  return `<p style="margin:0 0 20px; text-align:center;"><a href="${escapeHtml(url)}" style="display:inline-block; background-color:#1F3D2A; color:#FBF7EE; text-decoration:none; padding:12px 28px; border-radius:2px; font-size:14px; font-family:Arial,Helvetica,sans-serif;">${escapeHtml(label)}</a></p>`;
}

// A quieter link under a button.
function emailLink(label, url) {
  return `<p style="margin:0 0 20px; text-align:center; font-size:13px;"><a href="${escapeHtml(url)}" style="color:#1F3D2A;">${escapeHtml(label)}</a></p>`;
}

function emailPara(text) {
  return `<p style="margin:0 0 16px;">${escapeHtml(text)}</p>`;
}

function emailFine(text) {
  return `<p style="margin:0 0 12px; font-size:13px; color:#686860;">${escapeHtml(text)}</p>`;
}

// A highlighted box. tone 'action' (red edge) for things that need a person,
// 'next' (brass edge) for the next step.
function emailCallout(title, text, tone = 'next') {
  const edge = tone === 'action' ? '#8C2F1B' : '#B8923D';
  const bg = tone === 'action' ? '#F6E9E3' : '#F3ECDC';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px;"><tr><td style="background-color:${bg}; border-left:3px solid ${edge}; padding:12px 16px; font-size:14px; line-height:1.55;"><strong style="color:#14140F;">${escapeHtml(title)}</strong><br>${escapeHtml(text)}</td></tr></table>`;
}

function emailContact() {
  return `<p style="margin:0 0 16px;">Questions? Call <a href="tel:${PHONE_LINK}" style="color:#1F3D2A;">${PHONE}</a> or reply to this email.</p>`;
}

// -------------------------------------------------------------- reservations

function reservationEmails({ fullName, phone, email, date, time, partySize, notes }) {
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
  // The `text` above is what the database rebuild parses. The HTML below is
  // only a nicer-looking display layer on top.
  const notificationHtml = emailTemplate({
    heading: 'New Reservation Request',
    bodyHtml: `
      ${emailDetails([
        ['Name', fullName],
        ['Phone', phone, 'tel'],
        ['Email', email, 'mailto'],
        ['Date', `${dayLabel(date)} (${date})`],
        ['Time', time],
        ['Party Size', partySize],
        ['Special Requests', notes !== '—' ? notes : ''],
      ], 120)}
      <p style="margin:0; font-size:13px; color:#686860;">Reply directly to this email to reach ${escapeHtml(fullName)} at ${escapeHtml(email)}.</p>
    `,
  });

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
    `Need to make a change or have a question? Call us at ${PHONE} — happy to help.`,
    ``,
    `We can't wait to see you.`,
    ``,
    `The Ivy Bar and Kitchen`,
    `1625 W Irving Park Rd, Chicago, IL 60613`,
    PHONE,
  ].join('\n');
  const confirmationHtml = emailTemplate({
    heading: "You're all set!",
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi ${escapeHtml(fullName)},</p>
      <p style="margin:0 0 16px;">Here's your reservation at The Ivy Bar and Kitchen:</p>
      ${emailDetails([
        ['Date', dayLabel(date)],
        ['Time', time],
        ['Party Size', partySize],
        ['Special Requests', notes !== '—' ? notes : ''],
      ], 120)}
      <p style="margin:0 0 16px;">Need to make a change or have a question? Call us at <a href="tel:${PHONE_LINK}" style="color:#1F3D2A;">${PHONE}</a> — happy to help.</p>
      <p style="margin:0;">We can't wait to see you.</p>
    `,
  });
  return {
    notification: { subject, text, html: notificationHtml },
    confirmation: { subject: "You're Confirmed — The Ivy Bar and Kitchen", text: confirmationText, html: confirmationHtml },
  };
}

// ---------------------------------------------------------- private event inquiries

function inquiryEmails({ fullName, phone, email, company, eventDate, eventTime, guestCount, duration, occasion, spacePreference, budgetPerPerson, referralSource, details }) {
  const subject = `Private Event Inquiry — ${occasion} — ${fullName}`;
  const text = [
    `Name: ${fullName}`,
    `Phone: ${phone}`,
    `Email: ${email}`,
    `Company: ${company}`,
    `Preferred Date: ${eventDate}`,
    `Preferred Time: ${eventTime}`,
    `Number of Guests: ${guestCount}`,
    `Duration: ${duration}`,
    `Occasion: ${occasion}`,
    `Space Preference: ${spacePreference}`,
    `Budget Per Person: ${budgetPerPerson}`,
    `How They Heard About Us: ${referralSource}`,
    ``,
    `Details:`,
    details,
  ].join('\n');
  const dash = (v) => (v !== '—' ? v : '');
  const notificationHtml = emailTemplate({
    heading: 'New Private Event Inquiry',
    bodyHtml: `
      ${emailDetails([
        ['Name', fullName],
        ['Phone', phone, 'tel'],
        ['Email', email, 'mailto'],
        ['Company', dash(company)],
        ['Preferred Date', eventDate],
        ['Preferred Time', eventTime],
        ['Guests', guestCount],
        ['Duration', dash(duration)],
        ['Occasion', occasion],
        ['Space', spacePreference],
        ['Budget/Person', dash(budgetPerPerson)],
        ['Heard About Us', dash(referralSource)],
        ['Details', dash(details)],
      ], 150)}
      <p style="margin:0; font-size:13px; color:#686860;">Reply directly to this email to reach ${escapeHtml(fullName)} at ${escapeHtml(email)}.</p>
    `,
  });

  const confirmationText = [
    `Hi ${fullName},`,
    ``,
    `Thanks for your interest in hosting at The Ivy Bar and Kitchen! Here's what you sent us:`,
    ``,
    `Preferred Date: ${eventDate}`,
    `Preferred Time: ${eventTime}`,
    `Number of Guests: ${guestCount}`,
    `Occasion: ${occasion}`,
    `Space Preference: ${spacePreference}`,
    ``,
    `Our events team will follow up within one business day. Have a question in the meantime? Call us at ${PHONE}.`,
    ``,
    `The Ivy Bar and Kitchen`,
    `1625 W Irving Park Rd, Chicago, IL 60613`,
    PHONE,
  ].join('\n');
  const confirmationHtml = emailTemplate({
    heading: 'Got your inquiry!',
    bodyHtml: `
      <p style="margin:0 0 16px;">Hi ${escapeHtml(fullName)},</p>
      <p style="margin:0 0 16px;">Thanks for your interest in hosting at The Ivy Bar and Kitchen! Here's what you sent us:</p>
      ${emailDetails([
        ['Preferred Date', eventDate],
        ['Preferred Time', eventTime],
        ['Guests', guestCount],
        ['Occasion', occasion],
        ['Space', spacePreference],
      ], 140)}
      <p style="margin:0 0 16px;">Our events team will follow up within one business day. Have a question in the meantime? Call us at <a href="tel:${PHONE_LINK}" style="color:#1F3D2A;">${PHONE}</a>.</p>
    `,
  });
  return {
    notification: { subject, text, html: notificationHtml },
    confirmation: { subject: 'Got your inquiry — The Ivy Bar and Kitchen', text: confirmationText, html: confirmationHtml },
  };
}

// -------------------------------------------------------------- newsletter welcome

function welcomeEmail(email) {
  const unsubscribeUrl = `${SITE}/unsubscribe?email=${encodeURIComponent(email)}`;
  const text = [
    `You're on the list!`,
    ``,
    `Thanks for signing up for updates from The Ivy Bar and Kitchen. Here's what's happening every week:`,
    ``,
    `Weekly Specials`,
    `Monday — Monday Night Pizza: half off pizza with the purchase of a drink`,
    `Tuesday — Taco Tuesday: $3 tacos, $6 Modelos, $9 margaritas`,
    `Wednesday — Burger & Brew: burger and beer combo, $20`,
    `Thursday — Girl Dinner Thursday: salad, truffle fries & a glass of wine, $30`,
    `Friday & Saturday — Night Caps: $10 signature cocktails, 10pm-12am`,
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
    PHONE,
    ``,
    `Unsubscribe from marketing emails: ${unsubscribeUrl}`,
  ].join('\n');
  const html = emailTemplate({
    heading: "You're on the list!",
    bodyHtml: `
      <p style="margin:0 0 20px;">Thanks for signing up for updates from The Ivy Bar and Kitchen. Here's what's happening every week:</p>
      <p style="margin:0 0 8px; font-weight:bold; color:#7A5F27; text-transform:uppercase; font-size:12px; letter-spacing:.04em;">Weekly Specials</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 16px; font-size:14px;">
        <tr><td style="padding:4px 0; font-weight:bold; width:90px; vertical-align:top;">Mon</td><td style="padding:4px 0;">Monday Night Pizza — half off pizza with a drink</td></tr>
        <tr><td style="padding:4px 0; font-weight:bold; vertical-align:top;">Tue</td><td style="padding:4px 0;">Taco Tuesday — $3 tacos, $6 Modelos, $9 margaritas</td></tr>
        <tr><td style="padding:4px 0; font-weight:bold; vertical-align:top;">Wed</td><td style="padding:4px 0;">Burger &amp; Brew — burger + beer combo, $20</td></tr>
        <tr><td style="padding:4px 0; font-weight:bold; vertical-align:top;">Thu</td><td style="padding:4px 0;">Girl Dinner Thursday — salad, truffle fries &amp; a glass of wine, $30</td></tr>
        <tr><td style="padding:4px 0; font-weight:bold; vertical-align:top;">Fri &amp; Sat</td><td style="padding:4px 0;">Night Caps — $10 signature cocktails, 10pm&ndash;12am</td></tr>
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
  return {
    subject: "You're on the list — The Ivy Bar and Kitchen",
    text,
    html,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

// ---------------------------------------------------------------- internal notices

function weeklyReportEmail({ mondayStr, sundayStr, inRange, byDay }) {
  const reportUrl = `${SITE}/admin/reservations?week=${mondayStr}`;
  const lines = [`Reservation requests for the week of ${dayLabel(mondayStr)} - ${dayLabel(sundayStr)}`, ''];
  const days = Object.keys(byDay).sort();
  if (inRange.length === 0) {
    lines.push('No reservation requests for this week.');
  } else {
    for (const dateStr of days) {
      lines.push(dayLabel(dateStr).toUpperCase());
      for (const r of byDay[dateStr]) {
        lines.push(`  ${r.time} — ${r.full_name}, party of ${r.party_size} — ${r.phone} — ${r.email}${r.notes ? ` — ${r.notes}` : ''}`);
      }
      lines.push('');
    }
  }
  lines.push(`Full printable report: ${reportUrl}`);

  let bodyHtml = `<p style="margin:0 0 16px;">Week of <strong>${escapeHtml(dayLabel(mondayStr))}</strong> to <strong>${escapeHtml(dayLabel(sundayStr))}</strong>: ${inRange.length === 0 ? 'no reservation requests.' : `<strong>${inRange.length}</strong> reservation request${inRange.length === 1 ? '' : 's'}.`}</p>`;
  for (const dateStr of days) {
    bodyHtml += `<p style="margin:18px 0 6px; font-weight:bold; color:#7A5F27; text-transform:uppercase; font-size:12px; letter-spacing:.04em; border-bottom:1px solid rgba(31,61,42,.15); padding-bottom:4px;">${escapeHtml(dayLabel(dateStr))}</p>`;
    bodyHtml += '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; font-size:14px; margin:0 0 4px;">';
    for (const r of byDay[dateStr]) {
      const contact = [r.phone, r.email].filter(Boolean).map(escapeHtml).join(' &middot; ');
      bodyHtml += `<tr><td style="padding:6px 12px 6px 0; width:78px; vertical-align:top; font-weight:bold; color:#1F3D2A; white-space:nowrap;">${escapeHtml(r.time)}</td><td style="padding:6px 0; vertical-align:top;"><strong>${escapeHtml(r.full_name)}</strong>, party of ${escapeHtml(r.party_size)}<br><span style="font-size:13px; color:#686860;">${contact}</span>${r.notes ? `<br><span style="font-size:13px; font-style:italic;">${escapeHtml(r.notes)}</span>` : ''}</td></tr>`;
    }
    bodyHtml += '</table>';
  }
  bodyHtml += `<div style="margin-top:24px;">${emailButton('Open the printable report', reportUrl)}</div>`;
  return {
    subject: `Weekly Reservations — ${mondayStr} to ${sundayStr} (${inRange.length})`,
    text: lines.join('\n'),
    html: emailTemplate({ heading: 'Reservations this week', bodyHtml }),
  };
}

function backupEmail({ reason, stamp, counts }) {
  const summary = `Agreements: ${counts.agreements}\nReservations: ${counts.reservations}\nEvent inquiries: ${counts.event_inquiries}`;
  const lead = reason === 'manual' ? 'Backup requested by an admin.' : 'Weekly backup.';
  const text = `${lead}\n\n${summary}\n\nAttached:\n- ivy-database-${stamp}.db is the full database (agreements, reservations, and event inquiries). It can be restored as is.\n- agreements-${stamp}.csv is a spreadsheet of every agreement.\n\nKeep the latest copy somewhere safe.`;
  const html = emailTemplate({
    heading: 'Database backup',
    bodyHtml: `
      ${emailPara(lead)}
      ${emailDetails([
        ['Agreements', String(counts.agreements)],
        ['Reservations', String(counts.reservations)],
        ['Event inquiries', String(counts.event_inquiries)],
        ['Backup date', stamp],
      ], 140)}
      ${emailPara('Two files are attached:')}
      <ul style="margin:0 0 16px; padding-left:20px;">
        <li style="margin:0 0 6px;"><strong>ivy-database-${escapeHtml(stamp)}.db</strong> is the full database. It can be restored as is.</li>
        <li style="margin:0 0 6px;"><strong>agreements-${escapeHtml(stamp)}.csv</strong> is a spreadsheet of every agreement.</li>
      </ul>
      ${emailFine('Keep the latest copy somewhere safe. A new one arrives every Monday morning.')}
    `,
  });
  return { subject: `Database backup ${stamp}`, text, html };
}

function applicationEmail({ fullName, phone, email, position, availability, experience, file, message }) {
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
  const dash = (v) => (v && v !== '—' ? v : '');
  const html = emailTemplate({
    heading: 'New job application',
    bodyHtml: `
      ${emailDetails([
        ['Name', fullName],
        ['Position', position],
        ['Phone', phone, 'tel'],
        ['Email', email, 'mailto'],
        ['Availability', dash(availability)],
        ['Experience', dash(experience)],
        ['Resume', file ? `${file.filename} (attached)` : 'None attached'],
        ['Message', dash(message)],
      ], 120)}
      <p style="margin:0; font-size:13px; color:#686860;">Reply directly to this email to reach ${escapeHtml(fullName)} at ${escapeHtml(email)}.</p>
    `,
  });
  return { subject: `Job Application — ${position} — ${fullName}`, text, html };
}

function menusEmail() {
  const html = emailTemplate({
    heading: 'Updated print menus',
    bodyHtml: `
      ${emailPara('Attached are the latest print-ready menu PDFs:')}
      <ul style="margin:0 0 16px; padding-left:20px;">
        <li style="margin:0 0 6px;">Beer &amp; Cocktails</li>
        <li style="margin:0 0 6px;">Food &amp; Pizza</li>
        <li style="margin:0 0 6px;">Spirits</li>
      </ul>
      ${emailFine('Print on legal paper (8.5 x 14 in).')}
    `,
  });
  return {
    subject: 'Updated Print Menus',
    text: 'Attached are the latest print-ready menu PDFs: Beer & Cocktails, Food & Pizza, and Spirits.',
    html,
  };
}

// ------------------------------------------------------------- preview page

// items: [{ group, title, from, to, mail: { subject, text, html } }]
function emailPreviewPage(items) {
  const groups = [
    ['Guests', 'Emails to guests', 'These go to the person who reserved, asked about an event, or joined the newsletter.'],
    ['Clients', 'Emails to event clients', 'These go to a client during the private event agreement process.'],
    ['Our team', 'Emails to our team', 'Notices sent to info@ and events@.'],
  ];
  const cards = (list) => list.map((it, i) => {
    const html = it.mail.html.replace('<html>', '<html><head><base target="_blank"></head>');
    return `
      <article class="card">
        <h3>${escapeHtml(it.title)}</h3>
        <dl class="meta">
          <div><dt>Subject</dt><dd>${escapeHtml(it.mail.subject)}</dd></div>
          <div><dt>From</dt><dd>${escapeHtml(it.from)}</dd></div>
          <div><dt>To</dt><dd>${escapeHtml(it.to)}</dd></div>
        </dl>
        <iframe class="mail" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(html)}" title="${escapeHtml(it.title)}"></iframe>
        <details><summary>Plain-text version</summary><pre>${escapeHtml(it.mail.text)}</pre></details>
      </article>`;
  }).join('');
  const sections = groups.map(([key, title, blurb]) => {
    const list = items.filter((it) => it.group === key);
    if (!list.length) return '';
    return `<section><h2>${escapeHtml(title)}</h2><p class="blurb">${escapeHtml(blurb)}</p><div class="grid">${cards(list)}</div></section>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Email preview | The Ivy</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;1,500;1,600&family=Outfit:wght@400;500;600&display=swap');
  :root { --ivy:#1F3D2A; --brass:#7A5F27; --ink:#14140F; --mute:#686860; --cream:#F5EFE3; --pure:#FBF7EE; --line:rgba(31,61,42,.18); }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--cream); color:var(--ink); font:16px/1.6 'Outfit',-apple-system,'Segoe UI',Arial,sans-serif; padding:32px 16px 80px; }
  .wrap { max-width:1180px; margin:0 auto; }
  h1 { font:italic 600 40px/1.1 'Cormorant Garamond',Georgia,serif; color:var(--ivy); margin:0 0 6px; }
  h2 { font:italic 600 28px/1.15 'Cormorant Garamond',Georgia,serif; color:var(--ivy); margin:44px 0 4px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .lede, .blurb { color:var(--mute); margin:0 0 18px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 520px), 1fr)); gap:22px; align-items:start; }
  .card { background:var(--pure); border:1px solid var(--line); border-radius:4px; padding:18px; min-width:0; }
  .card h3 { font:600 17px/1.3 'Outfit',sans-serif; color:var(--ivy); margin:0 0 8px; }
  .meta { margin:0 0 12px; font-size:13px; }
  .meta div { display:grid; grid-template-columns:64px 1fr; gap:8px; padding:2px 0; }
  .meta dt { color:var(--brass); font-weight:600; text-transform:uppercase; letter-spacing:.06em; font-size:11px; padding-top:2px; }
  .meta dd { margin:0; overflow-wrap:anywhere; }
  iframe.mail { width:100%; border:1px solid var(--line); border-radius:2px; background:#EBE3D2; height:640px; display:block; }
  details { margin-top:10px; font-size:13px; }
  summary { cursor:pointer; color:var(--ivy); font-weight:600; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#fff; border:1px solid var(--line); border-radius:2px; padding:10px 12px; font:12px/1.5 ui-monospace,Menlo,Consolas,monospace; margin:8px 0 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Every email we send</h1>
  <p class="lede">Each email below is built by the same code that sends the real one, filled with sample details. Nothing here is sent.</p>
  ${sections}
</div>
<script>
  document.querySelectorAll('iframe.mail').forEach(function (f) {
    function fit() { try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 4) + 'px'; } catch (e) {} }
    f.addEventListener('load', fit);
    fit();
  });
</script>
</body>
</html>`;
}

module.exports = {
  emailPreviewPage,
  SITE, PHONE, PHONE_LINK,
  escapeHtml, dayLabel, emailTemplate,
  emailDetails, emailButton, emailLink, emailPara, emailFine, emailCallout, emailContact,
  reservationEmails, inquiryEmails, welcomeEmail, weeklyReportEmail, backupEmail, applicationEmail, menusEmail,
};
