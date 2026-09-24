'use strict';
// Private Event Space Agreement: terms, rendering, and the routes that issue,
// display and e-sign it.
//
// Storage model: nothing is kept in the database. Railway's disk is wiped on
// every deploy and Resend history is not a reliable long-term store, so each
// agreement lives inside its own link. The link is the agreement, compressed
// and encrypted (AES-256-GCM), so it can't be read or altered without the
// server key. Signing produces a second, sealed "signed" link, and the signed
// copy is emailed to the client and to The Ivy, which is the permanent record.
//
// IMPORTANT: agreements are rendered from the terms version stored inside
// them (`tv`). Never edit a released version in TERMS_VERSIONS; add a new
// version and bump CURRENT_TERMS so signed agreements keep the wording their
// client actually signed.

const crypto = require('crypto');
const zlib = require('zlib');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const VENUE = {
  name: 'The Ivy Bar and Kitchen',
  // The contracting party named in the agreement (registered entity and DBA).
  legalName: 'Thirsty Angus LLC d/b/a The Ivy Bar & Kitchen',
  address: '1625 W Irving Park Rd, Chicago, IL 60613',
  phone: '(773) 799-8160',
  eventsEmail: 'events@theivybk.com',
  notifyTo: ['events@theivybk.com', 'info@theivybk.com'],
  origin: 'https://theivybk.com',
  logo: 'https://theivybk.com/assets/img/logo/logo-gold.png',
};

const DEPOSIT_RATE = 0.2;
const SERVICE_RATE = 0.2;

const SPACES = [
  'The Ivy Rooftop',
  'The Ivy Room',
  'The Gathering Room',
  'The Ivy Bundle (Rooftop + Ivy Room)',
  'Full Buyout',
];

const EVENT_TYPES = [
  'Anniversary', 'Baby Shower', 'Bachelor/Bachelorette Party', 'Bar/Bat Mitzvah', 'Birthday',
  'Bridal Shower', 'Family Reunion', 'Graduation', 'Rehearsal Dinner', 'Reception', 'Retirement',
  'Holiday Party', 'Business/Corporate Function', 'Game Day Watch Party', 'Other',
];

// Prices come from the Event Packages menu. A line item stores its own label
// and price when an agreement is issued, so changing this catalog never alters
// agreements that were already sent.
const CATALOG = [
  {
    group: 'Food package',
    kind: 'food',
    items: [
      { label: 'Classic Buffet, 2 hours (per guest)', price: 30, perGuest: true },
    ],
  },
  {
    group: 'Beverage packages (per wristband)',
    kind: 'bev',
    items: [
      { label: 'The Classic open bar, 2 hours: beer, wine & seltzers', price: 35, perGuest: true },
      { label: 'The Classic open bar, 3 hours: beer, wine & seltzers', price: 45, perGuest: true },
      { label: 'The Signature open bar, 2 hours: call spirits, classic cocktails & standard pours', price: 55, perGuest: true },
      { label: 'The Signature open bar, 3 hours: call spirits, classic cocktails & standard pours', price: 80, perGuest: true },
      { label: 'The Premium open bar, 2 hours: premium spirits & signature cocktails', price: 70, perGuest: true },
      { label: 'The Premium open bar, 3 hours: premium spirits & signature cocktails', price: 95, perGuest: true },
    ],
  },
  {
    group: 'A la carte',
    kind: 'alc',
    items: [
      { label: 'Fries, half tray', price: 15 },
      { label: 'Fries, full tray', price: 25 },
      { label: 'Chicken tenders, half tray (20 pcs)', price: 35 },
      { label: 'Chicken tenders, full tray (40 pcs)', price: 70 },
      { label: 'Wings, half tray (25 pcs)', price: 35 },
      { label: 'Wings, full tray (50 pcs)', price: 70 },
      { label: 'House or Caesar salad, half tray', price: 25 },
      { label: 'House or Caesar salad, full tray', price: 45 },
      { label: 'Add grilled chicken to a salad tray', price: 15 },
      { label: 'Cheese quesadillas, half tray (16 pcs)', price: 45 },
      { label: 'Cheese quesadillas, full tray (32 pcs)', price: 75 },
      { label: 'Add chicken to a quesadilla tray', price: 15 },
    ],
  },
];

const LINE_KINDS = new Set(['food', 'bev', 'alc', 'custom']);

// ---------------------------------------------------------------- formatting

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function multiline(s) {
  return esc(s).replace(/\n/g, '<br>');
}

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fmtMoney(n) {
  const v = r2(n);
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function fmtDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

function fmtDateShort(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function fmtTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return hhmm || '';
  const h = parseInt(m[1], 10);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

function fmtStamp(iso) {
  return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'long', timeStyle: 'short' }) + ' CT';
}

function chicagoToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function isExpired(c) {
  return chicagoToday() > c.exp;
}

function refOf(c) {
  return 'IVY-' + String(c.id || '').slice(0, 6).toUpperCase();
}

function computeTotals(c) {
  const est = r2((c.lines || []).reduce((sum, l) => sum + l[1] * l[2], 0));
  const min = r2(c.min || 0);
  const base = Math.max(est, min);
  const deposit = r2(c.dep || 0);
  return {
    est,
    min,
    base,
    deposit,
    remaining: r2(Math.max(base - deposit, 0)),
    service: r2(base * SERVICE_RATE),
  };
}

// --------------------------------------------------------------------- terms

// Sections 1 (Event Information) and 2 (Selections & Pricing) are generated
// from the agreement data. Everything from section 3 on is the text below.
const TERMS_VERSIONS = {
  1: function termsV1(c) {
    const hasRoof = /roof|bundle|buyout/i.test(c.space);
    const hasGathering = /gathering/i.test(c.space);
    const hasFood = c.lines.some((l) => l[3] === 'food');
    const hasBev = c.lines.some((l) => l[3] === 'bev');

    const pricingNotes = `
      <p>Pricing excludes applicable taxes and a required <strong>20% service charge</strong>, which are added to the final bill. The service charge is calculated on food and beverage before tax. Any additional gratuity for our team beyond the 20% is always at the Client's discretion.</p>
      <p>No separate room rental, setup, or service fees apply except as described in this agreement.</p>
      <p>If the Client's total food and beverage charges (before tax and service charge) come to less than the <strong>Food &amp; Beverage Minimum</strong>, the difference is added to the final bill.</p>`;

    const sections = [];

    sections.push({
      title: 'Booking, Deposit & Payment',
      html: `
        <p>A <strong>20% deposit</strong> is required to secure the event date. The event is not confirmed until The Ivy has received the deposit, and The Ivy will confirm by email once it has. The Ivy accepts this agreement by confirming the date, so no separate signature from The Ivy is required.</p>
        <p>The Ivy is holding the date for the Client through <strong>${esc(fmtDateShort(c.exp))}</strong>. If The Ivy has not received the signed agreement and the deposit by then, The Ivy may release the date.</p>
        <p>After the agreement is signed, The Ivy will contact the Client to collect the deposit by credit card. Please do not email or text card numbers.</p>
        <p>The deposit is credited toward the Client's final bill.</p>
        <p>The remaining balance is due <strong>on the day of the event</strong>. Final payment must be made using <strong>one credit card</strong>; the balance cannot be split across cards. Drinks that guests buy on their own individual tabs are separate from the Client's final bill.</p>
        <p>By signing, the Client authorizes The Ivy to charge the credit card the Client provides for any amount owed under this agreement, including the remaining balance and any damage fees. The Ivy will let the Client know before charging for damage fees.</p>`,
    });

    sections.push({
      title: 'Guest Count',
      html: `
        <p>The guest count listed in this agreement is an estimate. The Client must provide the <strong>final guaranteed guest count</strong>, along with final menu selections, dietary needs, and the number of beverage-package wristbands, <strong>7 days before the event</strong>.</p>
        <p>The guaranteed guest count is the minimum number of guests the Client will be billed for. Billing is based on the <strong>guaranteed guest count or actual attendance, whichever is greater</strong>.</p>
        <p>The Ivy may limit attendance to the legal capacity of the space.</p>`,
    });

    sections.push({
      title: 'Setup & Event Time',
      html: `
        <p>A <strong>30-minute setup window</strong> is provided immediately before the Event Start Time. Additional setup time may be arranged in advance, based on availability, and may be subject to additional charges.</p>
        <p>The event must end at the agreed End Time unless The Ivy approves an extension, which may be subject to additional charges. The End Time does not move if the event starts late. The Client's decorations, gifts, and belongings must be removed by the End Time, and The Ivy is not responsible for items left behind.</p>
        ${hasGathering ? '<p>The Gathering Room is a semi-private space within our dining room. The Ivy remains open to the public, and other guests may be nearby.</p>' : ''}`,
    });

    const foodBevParts = [];
    if (hasFood) {
      foodBevParts.push(`<p><strong>Classic Buffet.</strong> A 2-hour buffet that includes up to three pizza varieties (cheese, pepperoni, sausage, veggie), crispy chicken wings with one sauce (Buffalo, BBQ, Butter Chicken, or Giardiniera Hot Honey), french fries, hummus with veggies, and a choice of salad (Caesar, house, or crispy chicken chopped). Menu selections are due with the final guest count.</p>`);
    }
    if (hasBev) {
      foodBevParts.push(`<p><strong>Beverage packages.</strong> Packages are open bar for the selected duration. Each guest on a package receives a wristband, wristbands are not transferable, and service begins at the Event Start Time. Packages include unlimited beverages within the selected offering for the duration of service. Shots are excluded from all packages. When a package ends, guests may continue purchasing beverages on individual tabs. The Classic covers beer, wine, and seltzers. The Signature covers call spirits, classic cocktails, and standard pours. The Premium covers premium spirits and signature cocktails. Brands may be substituted with comparable products if something is unavailable.</p>`);
    }
    sections.push({
      title: 'Food, Beverage & Alcohol',
      html: `
        ${foodBevParts.join('')}
        <p>All food and beverage must be provided by The Ivy. Outside food and beverage may not be brought in without The Ivy's prior written approval (for example, a celebration cake).</p>
        <p>Alcohol is served only by The Ivy's staff, and outside alcohol is not permitted. Anyone consuming alcohol must show a valid government-issued photo ID showing they are 21 or older. The Ivy will not serve anyone who is under 21 or who appears intoxicated, and may stop service at any time to comply with Illinois and Chicago law, without refund.${hasRoof ? ' The rooftop is 21+ only.' : ''}</p>
        <p>Please share allergies and dietary needs with the final guest count. Our kitchen handles common allergens, and The Ivy cannot guarantee that any item is free of them. If an item becomes unavailable, The Ivy may substitute a comparable item.</p>`,
    });

    sections.push({
      title: 'Decorations, Vendors & Damage',
      html: `
        <p>Decorations are permitted provided they are installed and removed with care and do not damage the space or create safety concerns. All decorations must be approved by The Ivy in advance.</p>
        <p>The following are not permitted:</p>
        <ul>
          <li>Tape, staples, nails, or other materials that may damage walls, furniture, or fixtures</li>
          <li>Confetti, glitter, or similar materials that are difficult to remove</li>
          <li>Open flames, candles, sparklers, or other flame-producing items</li>
          <li>Any decoration or installation deemed unsafe or potentially damaging to the property</li>
        </ul>
        <p>Outside vendors hired by the Client (DJs, photographers, decorators, and similar) must be approved by The Ivy in advance and must follow these guidelines. The Client is responsible for them.</p>
        <p>A <strong>$200 damage fee</strong> will be charged for damage to the space or property, or for violations of the decoration and facility guidelines. If damage or cleanup costs more than $200, the Client is responsible for the actual cost. The Client is responsible for damage caused by the Client, the Client's guests, and the Client's vendors.</p>`,
    });

    sections.push({
      title: 'Cancellation',
      html: `
        <p>Cancellations must be made <strong>in writing</strong> (email ${esc(VENUE.eventsEmail)}).</p>
        <p>All deposits are <strong>non-refundable</strong> and are forfeited upon cancellation. If the event is cancelled less than 7 days before the event date, or the Client does not show up, the result is the same: the deposit is forfeited and the Client owes no further charges for the cancellation.</p>
        <p>If The Ivy cancels the event, see <em>Weather &amp; Events Beyond Our Control</em>.</p>`,
    });

    sections.push({
      title: 'Date Changes',
      html: `
        <p>Requests to change the event date may be accommodated based on availability. Date-change requests must be made at least <strong>7 days before the original event date</strong>; later requests are treated as cancellations.</p>
        <p>If approved, the original deposit may be transferred to the new event date. If the new date carries a different Food &amp; Beverage Minimum, The Ivy will confirm the updated terms in writing.</p>
        <p>Date changes are subject to availability and confirmation by The Ivy.</p>`,
    });

    sections.push({
      title: 'Weather & Events Beyond Our Control',
      html: `
        ${hasRoof ? '<p>Rooftop events are weather dependent. If weather makes the rooftop unsafe or unusable, The Ivy will offer another available space or work with the Client on a new date. Weather alone is not grounds for cancellation under the Cancellation terms.</p>' : ''}
        <p>If The Ivy cannot host the event as agreed, including because of a closure, fire, utility failure, government order, or other circumstances beyond its reasonable control, The Ivy will offer to move the event to a new date and transfer the deposit, or will refund the deposit in full. In that case The Ivy has no further liability to the Client.</p>`,
    });

    sections.push({
      title: 'Conduct, Safety & Liability',
      html: `
        <ul>
          <li>The Client is responsible for the conduct of the Client's guests and vendors and for making sure they follow The Ivy's rules and all applicable laws, including smoking and vaping rules.</li>
          <li>The Ivy may remove any guest whose behavior is unsafe, disorderly, or harassing, and may end the event if necessary for safety or legal reasons, without refund.</li>
          <li>Music, DJs, live entertainment, and AV equipment brought in by the Client must be approved by The Ivy in advance and kept at a volume that complies with the law and respects our neighbors. The Ivy is not responsible for outside equipment.</li>
          <li>The Ivy is not responsible for lost, stolen, or damaged personal property or decorations left in the space before, during, or after the event.</li>
          <li>The Client is responsible for injuries and losses caused by the Client, the Client's guests, and the Client's vendors. The Ivy is not liable for injuries or losses at the event except to the extent caused by The Ivy's own negligence.</li>
        </ul>`,
    });

    sections.push({
      title: 'General Terms',
      html: `
        <ul>
          <li>This agreement is the entire agreement between the Client and The Ivy about the event. It can be changed only in writing agreed to by both parties; an email from ${esc(VENUE.eventsEmail)} counts as writing.</li>
          <li>If the Client is signing for a company or organization, the Client confirms they are authorized to sign for it, and it is bound by this agreement.</li>
          <li>The Client may not transfer this agreement to anyone else without The Ivy's written consent.</li>
          <li>Illinois law governs this agreement. Any dispute will be handled in the state or federal courts located in Cook County, Illinois.</li>
          <li>If any part of this agreement is found unenforceable, the rest stays in effect.</li>
          <li><strong>Electronic signature.</strong> Typing a name and clicking Sign is a legally binding electronic signature with the same effect as a handwritten signature. The Client consents to receive this agreement and related notices electronically at the email address provided, and may request a paper copy at any time by contacting ${esc(VENUE.eventsEmail)}.</li>
        </ul>`,
    });

    return { pricingNotes, sections };
  },
};
const CURRENT_TERMS = 1;

function termsFor(c) {
  const build = TERMS_VERSIONS[c.tv] || TERMS_VERSIONS[CURRENT_TERMS];
  return build(c);
}

// ------------------------------------------------------------------ document

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,600;1,500;1,600&family=Outfit:wght@400;500;600&display=swap');
:root { --ivy:#1F3D2A; --ivy-deep:#16301F; --brass:#B8923D; --brass-deep:#7A5F27; --ink:#14140F; --ink-soft:#4A4A42; --ink-mute:#686860; --cream:#F5EFE3; --cream-warm:#EBE3D2; --cream-pure:#FBF7EE; --border:rgba(31,61,42,.18); --brick:#8C2F1B; --ok:#2E6B45; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; background:var(--cream); color:var(--ink); font:16px/1.6 'Outfit',-apple-system,'Segoe UI',Arial,sans-serif; }
.top { background:var(--ivy); color:var(--cream); padding:16px 24px; display:flex; align-items:center; gap:14px; }
.top img { height:40px; width:auto; display:block; }
.top span { font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:22px; }
.sheet { max-width:800px; margin:28px auto 80px; padding:0 16px; }
.notice { border:1px solid var(--border); border-left:3px solid var(--brass); background:var(--cream-pure); border-radius:2px; padding:14px 18px; margin:0 0 20px; font-size:15px; }
.notice.ok { border-left-color:var(--ok); }
.notice strong { color:var(--ivy); }
.doc { background:var(--cream-pure); border:1px solid var(--border); border-radius:4px; padding:48px 52px; }
.eyebrow { display:block; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--brass-deep); font-weight:600; margin-bottom:6px; }
h1 { font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-weight:600; font-size:40px; line-height:1.1; color:var(--ivy); margin:0 0 14px; }
.lede { color:var(--ink-soft); margin:0 0 8px; }
h2 { font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-weight:600; font-size:26px; color:var(--ivy); margin:38px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--border); display:flex; gap:10px; align-items:baseline; break-after:avoid; }
h2 .n { font-family:'Outfit',sans-serif; font-style:normal; font-size:13px; font-weight:600; color:var(--brass-deep); min-width:22px; }
p { margin:0 0 12px; }
ul { margin:0 0 12px; padding-left:20px; }
li { margin:0 0 6px; }
.facts { width:100%; border-collapse:collapse; }
.facts th { text-align:left; vertical-align:top; width:36%; padding:7px 16px 7px 0; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--brass-deep); font-weight:600; }
.facts td { padding:7px 0; border-bottom:1px solid var(--border); }
.facts tr:last-child td, .facts tr:last-child th { border-bottom:0; }
.facts .sub { display:block; font-size:12px; color:var(--ink-mute); }
.tbl { width:100%; border-collapse:collapse; margin:0 0 14px; font-variant-numeric:tabular-nums; }
.tbl th { text-align:left; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--brass-deep); font-weight:600; padding:6px 8px; border-bottom:1px solid var(--border); }
.tbl td { padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
.tbl .r { text-align:right; white-space:nowrap; }
.sum td:first-child { padding-left:0; }
.sum td:last-child { padding-right:0; text-align:right; white-space:nowrap; font-weight:600; }
.sum tr.strong td { font-weight:600; color:var(--ivy); }
.sum .hint { display:block; font-weight:400; font-size:12px; color:var(--ink-mute); }
.callout { background:var(--cream); border:1px solid var(--border); border-radius:2px; padding:12px 16px; margin:0 0 14px; }
.sigs { display:grid; grid-template-columns:1fr 1fr; gap:32px; margin:22px 0 6px; }
.sigs.one { grid-template-columns:minmax(0,440px); }
.sigline { min-height:54px; border-bottom:1px solid var(--ink); display:flex; align-items:flex-end; padding-bottom:4px; }
.script { font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:32px; line-height:1.1; color:var(--ivy); }
.pending { color:var(--ink-mute); font-size:14px; font-style:italic; }
.siglabel { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--brass-deep); font-weight:600; margin-top:6px; }
.sigmeta { font-size:13px; color:var(--ink-soft); }
.audit { margin-top:26px; padding-top:14px; border-top:1px solid var(--border); font-size:12px; color:var(--ink-mute); }
.audit strong { color:var(--ink-soft); }
.sign { margin-top:18px; padding:24px; background:var(--cream); border:1px solid var(--border); border-radius:4px; }
.sign h3 { font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:24px; color:var(--ivy); margin:0 0 14px; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px 18px; margin-bottom:18px; }
.sign label.f { display:block; font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--ivy); font-weight:600; }
.sign .opt { font-weight:400; text-transform:none; letter-spacing:0; color:var(--ink-mute); }
.sign input[type=text], .sign input[type=email], .sign input[type=tel] { display:block; width:100%; margin-top:5px; padding:11px 12px; font:inherit; font-size:16px; color:var(--ink); background:#fff; border:1px solid var(--border); border-radius:2px; }
.sign input:focus { outline:2px solid var(--ivy); outline-offset:1px; }
.sigfield { margin:6px 0 4px; }
.sig-preview { min-height:56px; font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:36px; color:var(--ivy); border-bottom:1px solid var(--ink); padding:4px 2px; margin-bottom:4px; overflow-wrap:anywhere; }
.sig-preview.empty { color:rgba(31,61,42,.3); }
.datestamp { font-size:13px; color:var(--ink-soft); margin:0 0 16px; }
.check { display:flex; gap:10px; align-items:flex-start; margin:0 0 10px; font-size:14px; line-height:1.5; }
.check input { margin-top:4px; width:18px; height:18px; flex:none; accent-color:var(--ivy); }
.btn { display:inline-block; width:100%; margin-top:8px; padding:15px 20px; font:600 15px 'Outfit',sans-serif; letter-spacing:.04em; color:var(--cream); background:var(--ivy); border:0; border-radius:2px; cursor:pointer; }
.btn:hover { background:var(--ivy-deep); }
.btn[disabled] { opacity:.6; cursor:default; }
.btn.ghost { width:auto; background:transparent; color:var(--ivy); border:1px solid var(--ivy); padding:10px 18px; }
.err { color:var(--brick); font-size:14px; margin:8px 0 0; }
.fine { font-size:13px; color:var(--ink-mute); margin:12px 0 0; }
.foot { text-align:center; font-size:13px; color:var(--ink-mute); margin-top:24px; }
.status { max-width:520px; margin:12vh auto; padding:0 20px; text-align:center; }
.status h1 { font-size:34px; }
@media (max-width:640px) {
  .doc { padding:28px 20px; }
  h1 { font-size:32px; }
  .facts th, .facts td { display:block; width:auto; }
  .facts th { padding:8px 0 0; }
  .facts td { padding:2px 0 8px; }
  .grid2, .sigs { grid-template-columns:1fr; }
  .tbl th:nth-child(3), .tbl td:nth-child(3) { display:none; }
}
@media print {
  body { background:#fff; }
  .top { background:none; color:#000; border-bottom:1px solid #000; padding:8px 0; }
  .top img { display:none; }
  .top span { color:#000; }
  .sheet { margin:12px auto; max-width:none; padding:0; }
  .doc { border:0; padding:0; background:#fff; }
  .noprint { display:none !important; }
  h2 { margin-top:24px; }
  .facts tr, .sigs, .callout { break-inside:avoid; }
}
`;

function shell({ title, body, script }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><img src="${esc(VENUE.logo)}" alt="${esc(VENUE.name)}"><span>Private Event Agreement</span></header>
<main class="sheet">
${body}
<p class="foot">${esc(VENUE.name)} &middot; ${esc(VENUE.address)} &middot; ${esc(VENUE.phone)}</p>
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

function statusPage(heading, message) {
  return shell({
    title: heading,
    body: `<div class="status"><span class="eyebrow">Private Events</span><h1>${esc(heading)}</h1><p>${message}</p></div>`,
  });
}

function factRow(label, value, sub) {
  if (value == null || value === '') return '';
  return `<tr><th>${label}</th><td>${value}${sub ? `<span class="sub">${sub}</span>` : ''}</td></tr>`;
}

// `signed` is null for an unsigned offer, or { cl, sig } once executed.
function documentHtml(c, signed) {
  const t = computeTotals(c);
  const terms = termsFor(c);
  const cl = signed ? signed.cl : {};
  const phone = cl.phone || c.phone;
  const email = cl.email || c.email;
  const company = signed ? cl.company : c.company;

  const timeRange = `${fmtTime(c.start)} &ndash; ${fmtTime(c.end)}`;
  const dayOf = signed ? (cl.dayName || 'Same as Client') : 'To be provided at signing';
  const dayOfPhone = signed ? (cl.dayPhone || phone) : '';

  const facts = [
    factRow('Client Name', esc(c.name)),
    factRow('Company / Organization', esc(company)),
    factRow('Phone', esc(phone)),
    factRow('Email', esc(email)),
    factRow('Event Date', esc(fmtDate(c.date))),
    factRow('Event Type', esc(c.type)),
    factRow('Event Time', timeRange, '30-minute setup window immediately before the start time'),
    factRow('Guest Arrival Time', c.arrive ? esc(fmtTime(c.arrive)) : ''),
    factRow('Estimated Guest Count', esc(c.guests), 'The final guaranteed count is due 7 days before the event'),
    factRow('Event Space', esc(c.space)),
    factRow('Day-of Contact', esc(dayOf)),
    factRow('Day-of Contact Phone', esc(dayOfPhone)),
  ].join('');

  const linesHtml = c.lines.length
    ? `<table class="tbl"><thead><tr><th>Selection</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${
      c.lines.map((l) => `<tr><td>${esc(l[0])}</td><td class="r">${esc(l[1])}</td><td class="r">${esc(fmtMoney(l[2]))}</td><td class="r">${esc(fmtMoney(l[1] * l[2]))}</td></tr>`).join('')
    }</tbody></table>`
    : '<p>Food and beverage selections will be confirmed with the final guest count.</p>';

  const sumRows = [
    c.lines.length ? `<tr><td>Estimated Food &amp; Beverage Total</td><td>${esc(fmtMoney(t.est))}</td></tr>` : '',
    t.min > 0 ? `<tr><td>Food &amp; Beverage Minimum</td><td>${esc(fmtMoney(t.min))}</td></tr>` : '',
    `<tr class="strong"><td>20% Deposit Due to Secure the Date<span class="hint">20% of the food &amp; beverage amount above; credited toward the final bill</span></td><td>${esc(fmtMoney(t.deposit))}</td></tr>`,
    `<tr><td>Estimated Remaining Balance<span class="hint">Before tax and service charge; due on the day of the event</span></td><td>${esc(fmtMoney(t.remaining))}</td></tr>`,
  ].join('');

  const extra = [];
  if (c.sel) extra.push(`<p><strong>Menu selections.</strong><br>${multiline(c.sel)}</p>`);
  if (c.notes) extra.push(`<p><strong>Notes &amp; special arrangements.</strong><br>${multiline(c.notes)}</p>`);

  const sectionHtml = terms.sections
    .map((s, i) => `<h2><span class="n">${i + 3}</span>${esc(s.title)}</h2>${s.html}`)
    .join('');

  const ackNum = terms.sections.length + 3;

  // Only the Client signs. The Ivy accepts by confirming the date once the
  // deposit is received (see Booking, Deposit & Payment).
  const issuedOn = fmtDateShort(new Date(c.iat).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }));

  let ack = '';
  if (signed) {
    ack = `
      <div class="sigs one">
        <div class="sigcol">
          <div class="sigline"><span class="script">${esc(signed.sig.name)}</span></div>
          <div class="siglabel">Client Signature</div>
          <div class="sigmeta">${esc(c.name)} &middot; Signed ${esc(fmtStamp(signed.sig.at))}</div>
        </div>
      </div>
      <div class="audit">
        <strong>Signed electronically.</strong> Agreement ${esc(refOf(c))} &middot; signed by ${esc(signed.sig.name)} on ${esc(fmtStamp(signed.sig.at))} &middot; IP ${esc(signed.sig.ip)} &middot; document fingerprint ${esc(signed.sig.fp)}.
      </div>`;
  }

  return `
    <div class="doc">
      <span class="eyebrow">Agreement ${esc(refOf(c))} &middot; Issued ${esc(issuedOn)}</span>
      <h1>Private Event Space Agreement</h1>
      <p class="lede">Thank you for choosing The Ivy for your upcoming event. This agreement outlines the event details, payment terms, cancellation policy, and guidelines for use of our private event space. In this agreement, &ldquo;The Ivy&rdquo; means ${esc(VENUE.legalName)}, ${esc(VENUE.address)}, and &ldquo;Client&rdquo; means the person or organization named below.</p>

      <h2><span class="n">1</span>Event Information</h2>
      <table class="facts">${facts}</table>

      <h2><span class="n">2</span>Selections &amp; Pricing</h2>
      ${linesHtml}
      <table class="tbl sum"><tbody>${sumRows}</tbody></table>
      <div class="callout">Estimated 20% service charge on the amount above: <strong>${esc(fmtMoney(t.service))}</strong></div>
      ${extra.join('')}
      ${terms.pricingNotes}

      ${sectionHtml}

      <h2><span class="n">${ackNum}</span>Client Acknowledgment</h2>
      <p>By signing, the Client acknowledges that they have reviewed and agree to the event details, pricing, payment terms, cancellation policy, guest-count requirements, setup guidelines, decoration policies, and other terms outlined in this agreement.</p>
      ${ack}
    </div>`;
}

function signFormHtml(c, token) {
  const t = computeTotals(c);
  return `
    <form class="sign noprint" id="sign-form" data-token="${esc(token)}" novalidate>
      <h3>Sign this agreement</h3>
      <div class="grid2">
        <label class="f">Phone<input type="tel" name="phone" value="${esc(c.phone)}" autocomplete="tel" required></label>
        <label class="f">Email<input type="email" name="email" value="${esc(c.email)}" autocomplete="email" required></label>
        <label class="f">Company / Organization <span class="opt">(optional)</span><input type="text" name="company" value="${esc(c.company)}" autocomplete="organization"></label>
        <label class="f">Day-of contact <span class="opt">(leave blank if it's you)</span><input type="text" name="dayName" autocomplete="off"></label>
        <label class="f">Day-of contact phone <span class="opt">(optional)</span><input type="tel" name="dayPhone" autocomplete="off"></label>
      </div>
      <label class="f sigfield">Type your full name to sign<input type="text" name="signature" id="sig-input" autocomplete="name" required></label>
      <div class="sig-preview empty" id="sig-preview" aria-hidden="true">Your name</div>
      <p class="datestamp">Date: ${esc(fmtDateShort(chicagoToday()))}</p>
      <label class="check"><input type="checkbox" name="agree" required><span>I have read and agree to this agreement, including the deposit, cancellation, and payment terms.</span></label>
      <label class="check"><input type="checkbox" name="consent" required><span>I agree to sign electronically and to receive this agreement and related notices by email.</span></label>
      <p class="err" id="sign-err" role="alert" hidden></p>
      <button type="submit" class="btn" id="sign-btn">Sign Agreement</button>
      <p class="fine">After you sign, The Ivy will contact you to collect the ${esc(fmtMoney(t.deposit))} deposit. Your date is held through ${esc(fmtDateShort(c.exp))}. Questions? Call ${esc(VENUE.phone)} or email ${esc(VENUE.eventsEmail)}.</p>
    </form>`;
}

const SIGN_SCRIPT = `
(function () {
  var form = document.getElementById('sign-form');
  if (!form) return;
  var input = document.getElementById('sig-input');
  var preview = document.getElementById('sig-preview');
  var errEl = document.getElementById('sign-err');
  var btn = document.getElementById('sign-btn');
  input.addEventListener('input', function () {
    var v = input.value.trim();
    preview.textContent = v || 'Your name';
    preview.className = v ? 'sig-preview' : 'sig-preview empty';
  });
  function fail(msg) { errEl.textContent = msg; errEl.hidden = false; }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.hidden = true;
    var f = form.elements;
    var body = {
      token: form.getAttribute('data-token'),
      phone: f.phone.value.trim(),
      email: f.email.value.trim(),
      company: f.company.value.trim(),
      dayName: f.dayName.value.trim(),
      dayPhone: f.dayPhone.value.trim(),
      signature: f.signature.value.trim(),
      agree: f.agree.checked,
      consent: f.consent.checked
    };
    if (body.phone.length < 7) return fail('Please enter a phone number.');
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(body.email)) return fail('Please enter a valid email address.');
    if (body.signature.length < 2) return fail('Please type your full name to sign.');
    if (!body.agree || !body.consent) return fail('Please check both boxes to continue.');
    btn.disabled = true;
    btn.textContent = 'Signing...';
    fetch('/api/contract/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.ok && res.d.signedUrl) { window.location.href = res.d.signedUrl; return; }
        btn.disabled = false; btn.textContent = 'Sign Agreement';
        fail(res.d.error || 'Something went wrong. Please try again or call us.');
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Sign Agreement';
        fail('Something went wrong. Please try again or call us.');
      });
  });
})();
`;

function offerPage(c, token) {
  const body = `
    <div class="notice noprint">This agreement is prepared for <strong>${esc(c.name)}</strong> and the date is held through <strong>${esc(fmtDateShort(c.exp))}</strong>. Review the terms below, then sign at the bottom of the page.</div>
    ${documentHtml(c, null)}
    ${signFormHtml(c, token)}`;
  return shell({ title: `Private Event Agreement | ${VENUE.name}`, body, script: SIGN_SCRIPT });
}

function signedPage(data, opts) {
  const c = data.c;
  const banner = opts.justSigned
    ? `<div class="notice ok noprint"><strong>Signed. Thank you.</strong> A copy is on its way to ${esc(data.cl.email)}. Next, The Ivy will contact you to collect the ${esc(fmtMoney(computeTotals(c).deposit))} deposit; your date is held through ${esc(fmtDateShort(c.exp))}, and it is confirmed once the deposit is received.</div>`
    : `<div class="notice ok noprint">This agreement was signed by <strong>${esc(data.sig.name)}</strong> on ${esc(fmtStamp(data.sig.at))}.</div>`;
  const body = `
    ${banner}
    ${documentHtml(c, data)}
    <p class="noprint" style="text-align:center;margin-top:18px"><button type="button" class="btn ghost" onclick="window.print()">Print or save as PDF</button></p>`;
  return shell({ title: `Signed Agreement ${refOf(c)} | ${VENUE.name}`, body });
}

// A frozen, script-free copy of the signed agreement to attach to emails.
function standaloneSignedHtml(data) {
  return shell({ title: `Signed Agreement ${refOf(data.c)} | ${VENUE.name}`, body: documentHtml(data.c, data) });
}

// --------------------------------------------------------------- admin page

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

const ADMIN_CSS = `
.wrap { max-width:900px; margin:0 auto; padding:32px 16px 80px; }
.wrap h1 { font-size:36px; }
fieldset { border:1px solid var(--border); border-radius:4px; background:var(--cream-pure); padding:18px 20px 8px; margin:0 0 20px; }
legend { font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:22px; color:var(--ivy); padding:0 8px; }
.row { display:grid; grid-template-columns:1fr 1fr; gap:0 18px; }
.row.three { grid-template-columns:1fr 1fr 1fr; }
.fld { margin-bottom:14px; }
.fld label { display:block; font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--ivy); font-weight:600; margin-bottom:5px; }
.fld input, .fld select, .fld textarea { width:100%; padding:10px 12px; font:inherit; font-size:15px; background:#fff; color:var(--ink); border:1px solid var(--border); border-radius:2px; }
.fld textarea { min-height:80px; resize:vertical; }
.fld .help { font-size:12px; color:var(--ink-mute); margin-top:4px; }
.cat { width:100%; border-collapse:collapse; margin-bottom:12px; font-variant-numeric:tabular-nums; }
.cat th, .cat td { padding:6px 8px; border-bottom:1px solid var(--border); text-align:left; font-size:14px; }
.cat tr.grp th { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--brass-deep); background:var(--cream); }
.cat td.r { text-align:right; white-space:nowrap; }
.cat input { width:74px; padding:6px 8px; font:inherit; border:1px solid var(--border); border-radius:2px; }
.cat input.txt { width:100%; }
.cat .fill { font-size:11px; margin-left:6px; padding:3px 7px; border:1px solid var(--border); background:var(--cream); border-radius:2px; cursor:pointer; color:var(--ivy); }
.totals { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:14px; }
.totals .box { background:var(--cream); border:1px solid var(--border); border-radius:2px; padding:10px 12px; }
.totals .box b { display:block; font-family:'Cormorant Garamond',Georgia,serif; font-style:italic; font-size:24px; color:var(--ivy); font-weight:600; }
.totals .box span { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--brass-deep); font-weight:600; }
.result { border:1px solid var(--border); border-left:3px solid var(--ok); background:var(--cream-pure); border-radius:2px; padding:18px 20px; margin-top:22px; }
.result input { width:100%; padding:10px 12px; font:13px monospace; border:1px solid var(--border); border-radius:2px; background:#fff; }
.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
.actions .btn { width:auto; margin:0; padding:11px 20px; }
.btn.plain { background:transparent; color:var(--ivy); border:1px solid var(--ivy); }
@media (max-width:700px) { .row, .row.three { grid-template-columns:1fr; } .totals { grid-template-columns:1fr 1fr; } }
`;

const ADMIN_SCRIPT = `
(function () {
  var CATALOG = __CATALOG__;
  var $ = function (id) { return document.getElementById(id); };
  var depositTouched = false;
  function money(n) {
    n = Math.round((Number(n) || 0) * 100) / 100;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function num(id) { var v = parseFloat($(id).value); return isFinite(v) ? v : 0; }

  var tbody = $('catalog');
  CATALOG.forEach(function (g, gi) {
    var head = document.createElement('tr');
    head.className = 'grp';
    var th = document.createElement('th');
    th.colSpan = 4;
    th.textContent = g.group;
    head.appendChild(th);
    tbody.appendChild(head);
    g.items.forEach(function (it, ii) {
      var tr = document.createElement('tr');
      var a = document.createElement('td'); a.textContent = it.label;
      var b = document.createElement('td'); b.className = 'r'; b.textContent = money(it.price);
      var c = document.createElement('td');
      var q = document.createElement('input');
      q.type = 'number'; q.min = '0'; q.step = '1'; q.value = '0'; q.className = 'qty';
      q.setAttribute('data-g', gi); q.setAttribute('data-i', ii);
      q.addEventListener('input', recalc);
      c.appendChild(q);
      if (it.perGuest) {
        var fill = document.createElement('button');
        fill.type = 'button'; fill.className = 'fill'; fill.textContent = 'guest count';
        fill.addEventListener('click', function () { q.value = $('guests').value || 0; recalc(); });
        c.appendChild(fill);
      }
      var d = document.createElement('td'); d.className = 'r amt'; d.textContent = '$0';
      tr.appendChild(a); tr.appendChild(b); tr.appendChild(c); tr.appendChild(d);
      tbody.appendChild(tr);
    });
  });
  for (var k = 0; k < 2; k++) {
    var cr = document.createElement('tr');
    cr.className = 'custom';
    cr.innerHTML = '<td><input class="txt c-label" placeholder="Custom item (optional)"></td><td class="r"><input class="c-price" type="number" min="0" step="0.01" placeholder="Price"></td><td><input class="c-qty" type="number" min="0" step="1" value="0"></td><td class="r amt">$0</td>';
    tbody.appendChild(cr);
  }
  tbody.addEventListener('input', recalc);

  function collectLines() {
    var lines = [];
    tbody.querySelectorAll('input.qty').forEach(function (inp) {
      var q = parseInt(inp.value, 10);
      if (!(q > 0)) return;
      var g = CATALOG[inp.getAttribute('data-g')];
      var it = g.items[inp.getAttribute('data-i')];
      lines.push([it.label, q, it.price, g.kind]);
    });
    tbody.querySelectorAll('tr.custom').forEach(function (tr) {
      var label = tr.querySelector('.c-label').value.trim();
      var q = parseInt(tr.querySelector('.c-qty').value, 10);
      var p = parseFloat(tr.querySelector('.c-price').value);
      if (label && q > 0 && p >= 0) lines.push([label, q, p, 'custom']);
    });
    return lines;
  }

  function recalc() {
    var est = 0;
    tbody.querySelectorAll('tr').forEach(function (tr) {
      var amt = tr.querySelector('.amt');
      if (!amt) return;
      var q, p;
      var qi = tr.querySelector('input.qty');
      if (qi) {
        var g = CATALOG[qi.getAttribute('data-g')];
        p = g.items[qi.getAttribute('data-i')].price;
        q = parseInt(qi.value, 10);
      } else {
        p = parseFloat(tr.querySelector('.c-price').value);
        q = parseInt(tr.querySelector('.c-qty').value, 10);
      }
      var v = (q > 0 && p >= 0) ? q * p : 0;
      amt.textContent = money(v);
      est += v;
    });
    var base = Math.max(est, num('fbmin'));
    if (!depositTouched) $('deposit').value = (Math.round(base * 0.2 * 100) / 100) || '';
    var dep = num('deposit');
    $('t-est').textContent = money(est);
    $('t-base').textContent = money(base);
    $('t-dep').textContent = money(dep);
    $('t-rem').textContent = money(Math.max(base - dep, 0));
  }
  $('fbmin').addEventListener('input', recalc);
  $('deposit').addEventListener('input', function () { depositTouched = true; recalc(); });

  var today = new Date();
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  var def = new Date(today.getTime() + 7 * 86400000);
  $('exp').value = ymd(def);
  try { $('rep').value = localStorage.getItem('ivy-contract-rep') || ''; } catch (e) {}
  recalc();

  var lastToken = null;
  var form = $('f');
  var msg = $('msg');
  function say(text, isErr) { msg.textContent = text; msg.style.color = isErr ? '#8C2F1B' : '#2E6B45'; msg.hidden = false; }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.hidden = true;
    var body = {
      name: $('name').value, company: $('company').value, phone: $('phone').value, email: $('email').value,
      date: $('date').value, type: $('type').value, start: $('start').value, end: $('end').value, arrive: $('arrive').value,
      guests: parseInt($('guests').value, 10), space: $('space').value,
      lines: collectLines(), min: num('fbmin'), dep: num('deposit'),
      sel: $('sel').value, notes: $('notes').value, exp: $('exp').value, rep: $('rep').value
    };
    try { localStorage.setItem('ivy-contract-rep', body.rep); } catch (e2) {}
    var btn = $('create');
    btn.disabled = true; btn.textContent = 'Creating...';
    fetch('/admin/contracts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Create agreement';
        if (!res.ok || !res.d.ok) { say(res.d.error || 'Could not create the agreement.', true); return; }
        lastToken = res.d.token;
        $('link').value = res.d.url;
        $('open').href = res.d.url;
        $('result').hidden = false;
        $('emailed').hidden = true;
        $('result').scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (res.d.recorded === false) say('Agreement created, but the record email to the events team did not send. Copy the link below.', true);
      })
      .catch(function () { btn.disabled = false; btn.textContent = 'Create agreement'; say('Network error. Please try again.', true); });
  });

  $('copy').addEventListener('click', function () {
    var el = $('link'); el.select();
    try { navigator.clipboard.writeText(el.value); } catch (e) { document.execCommand('copy'); }
    $('copy').textContent = 'Copied';
    setTimeout(function () { $('copy').textContent = 'Copy link'; }, 1500);
  });

  $('send').addEventListener('click', function () {
    if (!lastToken) return;
    var to = $('email').value;
    if (!confirm('Email the agreement link to ' + to + '?')) return;
    var b = $('send'); b.disabled = true; b.textContent = 'Sending...';
    fetch('/admin/contracts/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: lastToken }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        b.disabled = false; b.textContent = 'Email to client';
        var em = $('emailed');
        em.textContent = res.ok && res.d.ok ? 'Sent to ' + to + '.' : (res.d.error || 'Could not send the email.');
        em.style.color = res.ok && res.d.ok ? '#2E6B45' : '#8C2F1B';
        em.hidden = false;
      })
      .catch(function () { b.disabled = false; b.textContent = 'Email to client'; });
  });
})();
`;

function adminPageHtml() {
  const opts = (list) => list.map((v) => `<option>${esc(v)}</option>`).join('');
  const body = `
    <div class="wrap">
      <span class="eyebrow">Private Events</span>
      <h1>New event agreement</h1>
      <p class="lede">Fill this in, create the agreement, then send the link to the client. The client reviews the terms and signs on their phone or computer. A signed copy goes to the client and to the events team.</p>
      <form id="f" novalidate>
        <fieldset>
          <legend>Client</legend>
          <div class="row">
            <div class="fld"><label for="name">Client name</label><input id="name" required></div>
            <div class="fld"><label for="company">Company (optional)</label><input id="company"></div>
            <div class="fld"><label for="phone">Phone</label><input id="phone" type="tel" required></div>
            <div class="fld"><label for="email">Email</label><input id="email" type="email" required></div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Event</legend>
          <div class="row">
            <div class="fld"><label for="date">Event date</label><input id="date" type="date" required></div>
            <div class="fld"><label for="type">Event type</label><select id="type" required>${opts(EVENT_TYPES)}</select></div>
          </div>
          <div class="row three">
            <div class="fld"><label for="start">Start time</label><input id="start" type="time" required></div>
            <div class="fld"><label for="end">End time</label><input id="end" type="time" required></div>
            <div class="fld"><label for="arrive">Guest arrival (optional)</label><input id="arrive" type="time"></div>
          </div>
          <div class="row">
            <div class="fld"><label for="guests">Estimated guest count</label><input id="guests" type="number" min="1" step="1" required></div>
            <div class="fld"><label for="space">Event space</label><select id="space" required>${opts(SPACES)}</select></div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Selections</legend>
          <table class="cat"><thead><tr><th>Item</th><th class="r">Price</th><th>Qty</th><th class="r">Amount</th></tr></thead><tbody id="catalog"></tbody></table>
          <div class="fld"><label for="sel">Menu selections (optional)</label><textarea id="sel" placeholder="Pizza varieties, wing sauce, salad choice. These can also be finalized with the guest count."></textarea></div>
        </fieldset>

        <fieldset>
          <legend>Pricing</legend>
          <div class="row">
            <div class="fld"><label for="fbmin">Food &amp; beverage minimum ($)</label><input id="fbmin" type="number" min="0" step="0.01"></div>
            <div class="fld"><label for="deposit">Deposit ($)</label><input id="deposit" type="number" min="0" step="0.01" required><div class="help">Defaults to 20% of the greater of the estimated total or the minimum. Edit to override.</div></div>
          </div>
          <div class="totals">
            <div class="box"><span>Estimated total</span><b id="t-est">$0</b></div>
            <div class="box"><span>Billing basis</span><b id="t-base">$0</b></div>
            <div class="box"><span>Deposit</span><b id="t-dep">$0</b></div>
            <div class="box"><span>Remaining balance</span><b id="t-rem">$0</b></div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Offer</legend>
          <div class="row">
            <div class="fld"><label for="exp">Hold the date through</label><input id="exp" type="date" required><div class="help">The link stops working after this date, and the client is asked to sign and pay the deposit by then. Links can't be revoked, so keep this short.</div></div>
            <div class="fld"><label for="rep">Issued by (your name, for our records)</label><input id="rep" required></div>
          </div>
          <div class="fld"><label for="notes">Notes &amp; special arrangements (optional, shown to the client)</label><textarea id="notes"></textarea></div>
        </fieldset>

        <button class="btn" id="create" type="submit" style="max-width:280px">Create agreement</button>
        <p class="err" id="msg" hidden></p>
      </form>

      <div class="result" id="result" hidden>
        <strong>Agreement created.</strong> A record with this link was emailed to the events team.
        <p style="margin:12px 0 8px"><input id="link" readonly></p>
        <div class="actions">
          <button type="button" class="btn plain" id="copy">Copy link</button>
          <a class="btn plain" id="open" target="_blank" rel="noopener" style="text-decoration:none">Preview as client</a>
          <button type="button" class="btn" id="send">Email to client</button>
        </div>
        <p class="fine" id="emailed" hidden></p>
      </div>
    </div>`;
  const script = ADMIN_SCRIPT.replace('__CATALOG__', () => jsonForScript(CATALOG));
  return shell({ title: 'New Event Agreement | The Ivy', body, script }).replace('</style>', () => `${ADMIN_CSS}</style>`);
}

// ------------------------------------------------------- tokens & handlers

function createContractHandlers(deps) {
  const { resendSendEmail, emailTemplate, checkBasicAuth, readJsonBody, getClientIp, secret, hasResend } = deps;

  // In-memory only (resets on deploy): maps an agreement id to its signed
  // link so a repeat visit or double-click doesn't produce a second signature.
  const signedById = new Map();

  function key() {
    return crypto.createHash('sha256').update('ivy-agreement-v1:' + secret).digest();
  }

  function seal(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const packed = zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), 'utf8'));
    const enc = Buffer.concat([cipher.update(packed), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
  }

  function open(token) {
    try {
      if (typeof token !== 'string' || token.length < 40 || token.length > 30000) return null;
      const buf = Buffer.from(token, 'base64url');
      if (buf.length < 30) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      const packed = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
      const obj = JSON.parse(zlib.inflateRawSync(packed, { maxOutputLength: 200000 }).toString('utf8'));
      return obj && obj.c && (obj.k === 'offer' || obj.k === 'signed') ? obj : null;
    } catch {
      return null;
    }
  }

  const urlFor = (token) => `${VENUE.origin}/contract/${token}`;

  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    res.end(html);
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  function denyAdmin(res) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Reservations"', 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
  }

  // ---- client-facing

  function handleView(req, res, token) {
    const data = open(token);
    if (!data) {
      return sendHtml(res, 404, statusPage("This link isn't valid", `The link may have been copied incorrectly. Please use the link in the email we sent you, or call us at ${esc(VENUE.phone)}.`));
    }
    if (data.k === 'signed') {
      const q = new URL(req.url, 'http://localhost').searchParams;
      return sendHtml(res, 200, signedPage(data, { justSigned: q.get('signed') === '1' }));
    }
    const existing = signedById.get(data.c.id);
    if (existing) {
      res.writeHead(302, { Location: `/contract/${existing}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (isExpired(data.c)) {
      return sendHtml(res, 410, statusPage('This agreement has expired', `The hold on ${esc(fmtDateShort(data.c.date))} ended on ${esc(fmtDateShort(data.c.exp))}. Please contact our events team at ${esc(VENUE.eventsEmail)} or ${esc(VENUE.phone)} and we'll be glad to send a fresh one.`));
    }
    return sendHtml(res, 200, offerPage(data.c, token));
  }

  async function handleSign(req, res) {
    if (!hasResend()) return sendJson(res, 503, { ok: false, error: 'Signing is not available right now. Please call us.' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }

    const data = open(body.token);
    if (!data || data.k !== 'offer') return sendJson(res, 400, { ok: false, error: 'This link is not valid.' });
    const c = data.c;
    const already = signedById.get(c.id);
    if (already) return sendJson(res, 200, { ok: true, signedUrl: `/contract/${already}?signed=1` });
    if (isExpired(c)) return sendJson(res, 410, { ok: false, error: 'This agreement has expired. Please contact our events team.' });

    const phone = cleanLine(body.phone, 40);
    const email = cleanLine(body.email, 120);
    const signatureName = cleanLine(body.signature, 100);
    if (phone.length < 7) return sendJson(res, 400, { ok: false, error: 'Please enter a phone number.' });
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { ok: false, error: 'Please enter a valid email address.' });
    if (signatureName.length < 2) return sendJson(res, 400, { ok: false, error: 'Please type your full name to sign.' });
    if (body.agree !== true || body.consent !== true) return sendJson(res, 400, { ok: false, error: 'Please check both boxes to continue.' });

    const signedData = {
      k: 'signed',
      c,
      cl: {
        company: cleanLine(body.company, 100),
        phone,
        email,
        dayName: cleanLine(body.dayName, 100),
        dayPhone: cleanLine(body.dayPhone, 40),
      },
      sig: {
        name: signatureName,
        at: new Date().toISOString(),
        ip: String(getClientIp(req)).slice(0, 64),
        fp: crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16),
      },
    };
    const signedToken = seal(signedData);
    const signedLink = urlFor(signedToken) + '?signed=1';
    const attachment = {
      filename: `Ivy-Event-Agreement-${refOf(c)}-signed.html`,
      content: Buffer.from(standaloneSignedHtml(signedData), 'utf8').toString('base64'),
    };
    const t = computeTotals(c);
    const summary = [
      ['Client', c.name + (signedData.cl.company ? ` (${signedData.cl.company})` : '')],
      ['Event', `${c.type}, ${fmtDate(c.date)}`],
      ['Time', `${fmtTime(c.start)} to ${fmtTime(c.end)}`],
      ['Space', c.space],
      ['Estimated guests', String(c.guests)],
      ['Deposit due', `${fmtMoney(t.deposit)} (date held through ${fmtDateShort(c.exp)})`],
      ['Phone', signedData.cl.phone],
      ['Email', signedData.cl.email],
    ];
    const summaryText = summary.map(([k, v]) => `${k}: ${v}`).join('\n');
    const summaryHtml = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 20px; font-size:14px;">${
      summary.map(([k, v]) => `<tr><td style="padding:4px 0; color:#7A5F27; font-weight:bold; width:130px; vertical-align:top;">${esc(k)}</td><td style="padding:4px 0;">${esc(v)}</td></tr>`).join('')
    }</table>`;

    // The email to The Ivy is the permanent record, so the signature only
    // counts once that email has actually gone out.
    try {
      const venueResult = await resendSendEmail({
        to: VENUE.notifyTo,
        subject: `Agreement Signed: ${c.name}, ${c.date} (${refOf(c)})`,
        text: `${signedData.sig.name} signed the private event agreement on ${fmtStamp(signedData.sig.at)}.\n\n${summaryText}\n\nSigned agreement: ${signedLink}\n\nThe signed copy is also attached. The Ivy will confirm the date once the deposit is received.`,
        html: emailTemplate({
          heading: 'Agreement signed',
          bodyHtml: `<p style="margin:0 0 16px;">${esc(signedData.sig.name)} signed the private event agreement on ${esc(fmtStamp(signedData.sig.at))}.</p>${summaryHtml}<p style="margin:0 0 16px;"><a href="${esc(signedLink)}" style="color:#1F3D2A;">View the signed agreement</a> (a copy is attached). Next step: collect the deposit and confirm the date.</p>`,
        }),
        replyTo: signedData.cl.email,
        attachments: [attachment],
      });
      if (venueResult.status < 200 || venueResult.status >= 300) throw new Error(`Resend status ${venueResult.status}`);
    } catch (err) {
      console.error('Agreement signed-notification email failed:', err.message);
      return sendJson(res, 502, { ok: false, error: 'We could not record your signature just now. Please try again in a minute, or call us.' });
    }

    signedById.set(c.id, signedToken);
    sendJson(res, 200, { ok: true, signedUrl: `/contract/${signedToken}?signed=1` });

    resendSendEmail({
      to: signedData.cl.email,
      subject: 'Your signed agreement | The Ivy Bar and Kitchen',
      text: `Hi ${c.name},\n\nThank you for signing your private event agreement with The Ivy Bar and Kitchen. A copy is attached, and you can view it any time here:\n${signedLink}\n\n${summaryText}\n\nNext, we'll contact you to collect the deposit. Your date is confirmed once we receive it.\n\nQuestions? Call ${VENUE.phone} or email ${VENUE.eventsEmail}.\n\n${VENUE.name}\n${VENUE.address}`,
      html: emailTemplate({
        heading: 'Thank you for signing',
        bodyHtml: `<p style="margin:0 0 16px;">Hi ${esc(c.name)},</p><p style="margin:0 0 16px;">Thank you for signing your private event agreement. A copy is attached, and you can view it any time with the link below.</p>${summaryHtml}<p style="margin:0 0 20px;"><a href="${esc(signedLink)}" style="display:inline-block; background:#1F3D2A; color:#F5EFE3; padding:12px 22px; border-radius:2px; text-decoration:none; font-family:Arial,sans-serif; font-size:14px;">View signed agreement</a></p><p style="margin:0 0 16px;">Next, we'll contact you to collect the deposit. Your date is confirmed once we receive it. Questions? Call <a href="tel:+17737998160" style="color:#1F3D2A;">${esc(VENUE.phone)}</a> or reply to this email.</p>`,
      }),
      replyTo: VENUE.eventsEmail,
      attachments: [attachment],
    }).catch((err) => console.error('Agreement client copy email error:', err.message));
  }

  // ---- admin

  function handleAdminPage(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    sendHtml(res, 200, adminPageHtml());
  }

  async function handleAdminCreate(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    if (!secret || !hasResend()) return sendJson(res, 503, { ok: false, error: 'Agreements are not configured on the server.' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }

    const parsed = parseIssue(body);
    if (parsed.error) return sendJson(res, 400, { ok: false, error: parsed.error });
    const c = parsed.c;
    const token = seal({ k: 'offer', c });
    const url = urlFor(token);

    const t = computeTotals(c);
    const summaryText = [
      `Client: ${c.name}${c.company ? ` (${c.company})` : ''}`,
      `Contact: ${c.phone} / ${c.email}`,
      `Event: ${c.type}, ${fmtDate(c.date)}, ${fmtTime(c.start)} to ${fmtTime(c.end)}`,
      `Space: ${c.space}, about ${c.guests} guests`,
      `Estimated F&B: ${fmtMoney(t.est)}; minimum ${fmtMoney(t.min)}; deposit ${fmtMoney(t.deposit)}`,
      `Date held through: ${fmtDateShort(c.exp)}`,
      `Issued by: ${c.rep}`,
    ].join('\n');

    let recorded = true;
    try {
      const result = await resendSendEmail({
        to: VENUE.notifyTo,
        subject: `Agreement Created: ${c.name}, ${c.date} (${refOf(c)})`,
        text: `${summaryText}\n\nClient link:\n${url}\n\nThis is a record copy. The client has not been emailed unless you used "Email to client".`,
        html: emailTemplate({
          heading: 'Agreement created',
          bodyHtml: `<pre style="font-family:Georgia,serif; font-size:14px; white-space:pre-wrap; margin:0 0 16px;">${esc(summaryText)}</pre><p style="margin:0 0 16px;"><a href="${esc(url)}" style="color:#1F3D2A;">Open the client link</a></p><p style="margin:0; font-size:13px; color:#686860;">This is a record copy. The client has not been emailed unless you used "Email to client".</p>`,
        }),
      });
      if (result.status < 200 || result.status >= 300) recorded = false;
    } catch (err) {
      console.error('Agreement record email error:', err.message);
      recorded = false;
    }
    sendJson(res, 200, { ok: true, token, url, recorded });
  }

  async function handleAdminEmail(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }
    const data = open(body.token);
    if (!data || data.k !== 'offer') return sendJson(res, 400, { ok: false, error: 'That agreement link is not valid.' });
    const c = data.c;
    const url = urlFor(body.token);
    try {
      const result = await resendSendEmail({
        to: c.email,
        subject: `Your event agreement | The Ivy Bar and Kitchen`,
        text: `Hi ${c.name},\n\nThanks for choosing The Ivy for your ${c.type.toLowerCase()} on ${fmtDate(c.date)}. Your event agreement is ready to review and sign:\n\n${url}\n\nWe're holding the date through ${fmtDateShort(c.exp)}. To keep it, please sign and we'll follow up to collect the deposit.\n\nQuestions? Call ${VENUE.phone} or reply to this email.\n\n${VENUE.name}\n${VENUE.address}`,
        html: emailTemplate({
          heading: 'Your event agreement',
          bodyHtml: `<p style="margin:0 0 16px;">Hi ${esc(c.name)},</p><p style="margin:0 0 16px;">Thanks for choosing The Ivy for your ${esc(c.type.toLowerCase())} on ${esc(fmtDate(c.date))}. Your agreement is ready to review and sign.</p><p style="margin:0 0 20px; text-align:center;"><a href="${esc(url)}" style="display:inline-block; background:#1F3D2A; color:#F5EFE3; padding:13px 26px; border-radius:2px; text-decoration:none; font-family:Arial,sans-serif; font-size:15px;">Review &amp; Sign Agreement</a></p><p style="margin:0 0 16px;">We're holding the date through <strong>${esc(fmtDateShort(c.exp))}</strong>. To keep it, sign the agreement and we'll follow up to collect the deposit.</p><p style="margin:0 0 16px;">Questions? Call <a href="tel:+17737998160" style="color:#1F3D2A;">${esc(VENUE.phone)}</a> or reply to this email.</p>`,
        }),
        replyTo: VENUE.eventsEmail,
      });
      if (result.status < 200 || result.status >= 300) return sendJson(res, 502, { ok: false, error: 'The email service rejected the message.' });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('Agreement client email error:', err.message);
      sendJson(res, 502, { ok: false, error: 'Could not reach the email service.' });
    }
  }

  function cleanLine(v, max) {
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  function cleanText(v, max) {
    return typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '';
  }

  function validYmd(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T12:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function parseIssue(b) {
    const name = cleanLine(b.name, 100);
    if (!name) return { error: 'Client name is required.' };
    const email = cleanLine(b.email, 120);
    if (!EMAIL_RE.test(email)) return { error: 'Enter a valid client email.' };
    const phone = cleanLine(b.phone, 40);
    if (phone.length < 7) return { error: 'Enter the client phone number.' };
    const date = cleanLine(b.date, 10);
    if (!validYmd(date)) return { error: 'Enter the event date.' };
    const today = chicagoToday();
    if (date < today) return { error: 'The event date is in the past.' };
    const type = cleanLine(b.type, 60);
    if (!type) return { error: 'Choose an event type.' };
    const time = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '');
    const start = time(b.start);
    const end = time(b.end);
    if (!start || !end) return { error: 'Enter the start and end times.' };
    const arrive = time(b.arrive);
    const guests = parseInt(b.guests, 10);
    if (!(guests >= 1 && guests <= 1000)) return { error: 'Enter the estimated guest count.' };
    const space = cleanLine(b.space, 80);
    if (!space) return { error: 'Choose an event space.' };
    const exp = cleanLine(b.exp, 10);
    if (!validYmd(exp) || exp < today) return { error: 'Choose a valid "hold the date through" date (today or later).' };
    if (exp > date) return { error: 'The hold date must be on or before the event date.' };
    const rep = cleanLine(b.rep, 80);
    if (!rep) return { error: 'Enter who is issuing the agreement.' };

    const rawLines = Array.isArray(b.lines) ? b.lines : [];
    if (rawLines.length > 40) return { error: 'Too many line items.' };
    const lines = [];
    for (const l of rawLines) {
      if (!Array.isArray(l)) return { error: 'Invalid line item.' };
      const label = cleanLine(l[0], 140);
      const qty = parseInt(l[1], 10);
      const price = r2(l[2]);
      const kind = LINE_KINDS.has(l[3]) ? l[3] : 'custom';
      if (!label || !(qty >= 1 && qty <= 5000) || !(price >= 0 && price <= 100000)) return { error: 'Invalid line item.' };
      lines.push([label, qty, price, kind]);
    }
    const min = r2(b.min);
    if (!(min >= 0 && min <= 1000000)) return { error: 'Invalid food & beverage minimum.' };
    if (!lines.length && !(min > 0)) return { error: 'Add at least one selection or a food & beverage minimum.' };
    const dep = r2(b.dep);
    if (!(dep > 0 && dep <= 1000000)) return { error: 'Enter the deposit amount.' };

    return {
      c: {
        v: 1,
        tv: CURRENT_TERMS,
        id: crypto.randomBytes(5).toString('hex'),
        iat: new Date().toISOString(),
        exp,
        rep,
        name,
        company: cleanLine(b.company, 100),
        phone,
        email,
        date,
        type,
        start,
        end,
        arrive,
        guests,
        space,
        lines,
        min,
        dep,
        sel: cleanText(b.sel, 600),
        notes: cleanText(b.notes, 1200),
      },
    };
  }

  return { handleView, handleSign, handleAdminPage, handleAdminCreate, handleAdminEmail };
}

module.exports = {
  createContractHandlers,
  // Exposed so the rendering can be exercised without a server.
  _test: { documentHtml, offerPage, signedPage, adminPageHtml, computeTotals, termsFor, standaloneSignedHtml },
};
