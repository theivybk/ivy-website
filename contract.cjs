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
  notifyTo: ['events@theivybk.com'],
  // Every agreement email is sent from, and answered at, events@ (never info@).
  from: 'The Ivy Bar and Kitchen <events@theivybk.com>',
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
    const t = computeTotals(c);
    const hasRoof = /roof|bundle|buyout/i.test(c.space);
    const hasGathering = /gathering/i.test(c.space);
    const hasFood = c.lines.some((l) => l[3] === 'food');
    const hasBev = c.lines.some((l) => l[3] === 'bev');

    const pricingNotes = `
      <p><strong>Service charge and taxes.</strong> Pricing excludes applicable taxes and a required <strong>20% service charge</strong>, which are added to the final bill. The service charge is calculated on the food and beverage total before tax${t.min > 0 ? ' (or on the Food &amp; Beverage Minimum, if greater)' : ''}. Any additional gratuity for our team beyond the 20% is at the Client's discretion.</p>
      <p><strong>Credit card surcharge.</strong> Credit card payments, including the deposit and the final payment, are subject to a 3% surcharge (see Booking, Deposit &amp; Payment).</p>
      ${t.min > 0 ? '<p><strong>Food &amp; Beverage Minimum.</strong> If the Client\'s food and beverage charges (before tax, service charge, and surcharge) are less than the Food &amp; Beverage Minimum, the difference is added to the final bill.</p>' : ''}
      <p><strong>Other fees.</strong> No separate room rental, setup, or service fees apply except as described in this agreement.</p>`;

    const sections = [];

    sections.push({
      title: 'Booking, Deposit & Payment',
      html: `
        <p><strong>Deposit and effective date.</strong> A deposit of <strong>${esc(fmtMoney(t.deposit))}</strong> is required to secure the Event Date. The event is not confirmed until The Ivy has received the deposit. This agreement takes effect when The Ivy confirms the Event Date by email after receiving the deposit. That confirmation is The Ivy's acceptance, so no separate signature from The Ivy is required. If The Ivy is unable to confirm the date, any payment the Client has made will be refunded in full.</p>
        <p><strong>Date hold.</strong> The Ivy is holding the Event Date for the Client through <strong>${esc(fmtDateShort(c.exp))}</strong>. If The Ivy has not received the signed agreement and the deposit by then, The Ivy may release the date and this offer expires.</p>
        <p><strong>How to pay.</strong> After the agreement is signed, The Ivy will contact the Client to collect the deposit by credit card. Please do not email or text card numbers.</p>
        <p><strong>Credit card surcharge.</strong> Payments made by credit card, including the deposit and the final payment, carry a <strong>3% surcharge</strong>, which is added to the amount charged. The surcharge is not part of the deposit credit described below.</p>
        <p><strong>Deposit credit.</strong> The deposit is credited toward the Client's final bill.</p>
        <p><strong>Final payment.</strong> The remaining balance is due <strong>on the day of the event</strong>. Final payment must be made using <strong>one credit card</strong>; the balance cannot be split across cards. Drinks that guests buy on their own individual tabs are separate from the Client's final bill.</p>
        <p><strong>Card authorization.</strong> By signing, the Client authorizes The Ivy to charge the credit card the Client provides, plus the 3% surcharge, for any amount owed under this agreement, including the remaining balance and any damage fees, and confirms they are the cardholder or an authorized user of that card. The Ivy will let the Client know before charging for damage fees. If a payment is declined, disputed, or reversed, the Client remains responsible for the amount owed.</p>`,
    });

    sections.push({
      title: 'Guest Count',
      html: `
        <p>The guest count in this agreement is an estimate. The Client must provide the <strong>final guaranteed guest count</strong>, final menu selections, dietary needs, and the number of beverage-package wristbands <strong>7 days before the Event Date</strong>. If the Client does not, the estimated guest count becomes the guaranteed guest count. After that deadline the guaranteed guest count may be increased if The Ivy can accommodate it, but it may not be reduced.</p>
        <p>For per-guest food packages, the Client is billed for the <strong>guaranteed guest count or actual attendance, whichever is greater</strong>, with attendance as counted by The Ivy. Beverage packages are billed per wristband ordered.</p>
        <p>The Ivy may limit attendance to the legal capacity of the space.</p>`,
    });

    sections.push({
      title: 'Setup & Event Time',
      html: `
        <p>A <strong>30-minute setup window</strong> is provided immediately before the Event Start Time. Additional setup time may be arranged in advance, based on availability, and may be subject to additional charges, which The Ivy will tell the Client before agreeing.</p>
        <p>The event must end at the Event End Time unless The Ivy approves an extension in advance, which may be subject to additional charges. The Event End Time does not move if the event starts late. The Client's decorations, gifts, and belongings must be removed by the Event End Time, and The Ivy is not responsible for items left behind.</p>
        ${hasGathering ? '<p>The Gathering Room is a semi-private space within our dining room. The Ivy remains open to the public, and other guests may be nearby.</p>' : ''}`,
    });

    const foodBevParts = [];
    if (hasFood) {
      foodBevParts.push(`<p><strong>Classic Buffet.</strong> A 2-hour buffet, served beginning at a time set with The Ivy, that includes up to three pizza varieties (cheese, pepperoni, sausage, veggie), crispy chicken wings with one sauce (Buffalo, BBQ, Butter Chicken, or Giardiniera Hot Honey), french fries, hummus with veggies, and a choice of salad (Caesar, house, or crispy chicken chopped). Menu selections are due with the final guest count.</p>`);
    }
    if (hasBev) {
      foodBevParts.push(`<p><strong>Beverage packages.</strong> Packages are open bar for the selected duration. Each guest on a package receives a wristband, and wristbands are not transferable. Service begins at the Event Start Time, and the package time runs from then even if guests arrive later. Packages include unlimited beverages within the selected offering for the duration of service. Shots are excluded from all packages. When a package ends, guests may continue purchasing beverages on individual tabs. The Classic covers beer, wine, and seltzers. The Signature covers call spirits, classic cocktails, and standard pours. The Premium covers premium spirits and signature cocktails. Brands may be substituted with comparable products if something is unavailable.</p>`);
    }
    sections.push({
      title: 'Food, Beverage & Alcohol',
      html: `
        ${foodBevParts.join('')}
        <p>All food and beverage must be provided by The Ivy. Outside food and beverage may not be brought in without The Ivy's prior written approval (for example, a celebration cake).</p>
        <p>Alcohol is served only by The Ivy's staff, and outside alcohol is not permitted. Alcohol may not be taken off the premises. Anyone consuming alcohol must show a valid government-issued photo ID showing they are 21 or older. The Ivy will not serve anyone who is under 21 or who appears intoxicated, and may stop service at any time to comply with Illinois and Chicago law, without refund.${hasRoof ? ' The rooftop is 21+ only.' : ''}</p>
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
          <li>Anything that blocks an exit, aisle, or fire equipment</li>
          <li>Any decoration or installation deemed unsafe or potentially damaging to the property</li>
        </ul>
        <p>Outside vendors hired by the Client (DJs, photographers, decorators, and similar) must be approved by The Ivy in advance and must follow these guidelines. The Client is responsible for them.</p>
        <p>A <strong>$200 damage fee</strong> will be charged for damage to the space or property, or for violations of the decoration and facility guidelines. If the actual cost of repair or cleanup is more than $200, the Client is responsible for the actual cost. The parties agree that the $200 fee is a reasonable estimate of The Ivy's costs and not a penalty. The Client is responsible for damage caused by the Client, the Client's guests, and the Client's vendors.</p>`,
    });

    sections.push({
      title: 'Cancellation',
      html: `
        <p>Cancellations must be made <strong>in writing</strong> (email ${esc(VENUE.eventsEmail)}) and take effect on the day The Ivy receives them.</p>
        <p>The deposit, including any credit card surcharge paid with it, is <strong>non-refundable</strong> and is forfeited upon cancellation. If the event is cancelled less than 7 days before the Event Date, or the Client does not show up, the result is the same: the deposit is forfeited and the Client owes no further charges for the cancellation.</p>
        <p>If The Ivy cancels the event, see <em>Weather &amp; Events Beyond Our Control</em>.</p>`,
    });

    sections.push({
      title: 'Date Changes',
      html: `
        <p>Requests to change the Event Date may be accommodated based on availability. Date-change requests must be made at least <strong>7 days before the original Event Date</strong>; later requests are treated as cancellations.</p>
        <p>If approved, the original deposit may be transferred to the new date, and the change is not a cancellation. If the new date carries a different Food &amp; Beverage Minimum, The Ivy will confirm the updated terms in writing.</p>
        <p>Date changes are subject to availability and confirmation by The Ivy.</p>`,
    });

    sections.push({
      title: 'Weather & Events Beyond Our Control',
      html: `
        ${hasRoof ? '<p>Rooftop events are weather dependent. If weather makes the rooftop unsafe or unusable, The Ivy will offer another available space or work with the Client on a new date. Weather alone does not entitle the Client to a refund of the deposit.</p>' : ''}
        <p>If The Ivy cannot host the event as agreed, including because of a closure, fire, utility failure, government order, or other circumstances beyond its reasonable control, the Client may choose to move the event to a new date, with the deposit transferred, or to receive a full refund of all amounts paid, including any credit card surcharge. That choice is the Client's only remedy, and The Ivy has no further liability to the Client, including for costs the Client incurred with others, such as vendors or travel.</p>`,
    });

    sections.push({
      title: 'Conduct, Safety & Liability',
      html: `
        <ul>
          <li>The Client is responsible for the conduct of the Client's guests and vendors and for making sure they follow The Ivy's rules and all applicable laws, including smoking and vaping rules.</li>
          <li>The Ivy may remove any guest whose behavior is unsafe, disorderly, or harassing, and may end the event if necessary for safety or legal reasons, without refund.</li>
          <li>Music, DJs, live entertainment, and AV equipment brought in by the Client must be approved by The Ivy in advance and kept at a volume that complies with the law and respects our neighbors. The Ivy is not responsible for outside equipment.</li>
          <li>The Ivy is not responsible for lost, stolen, or damaged personal property or decorations left in the space before, during, or after the event.</li>
          <li>The Client will indemnify and hold harmless The Ivy, its owners, and its employees from claims, losses, and costs, including reasonable attorneys' fees, arising from the acts or omissions of the Client, the Client's guests, or the Client's vendors, except to the extent caused by The Ivy's negligence or willful misconduct.</li>
          <li>The Ivy is not liable for injuries or losses at the event except to the extent caused by The Ivy's negligence or willful misconduct. Otherwise, The Ivy's total liability under this agreement is limited to the amounts the Client has paid to The Ivy, and The Ivy is not liable for indirect or consequential damages.</li>
        </ul>`,
    });

    sections.push({
      title: 'General Terms',
      html: `
        <ul>
          <li><strong>Entire agreement.</strong> This agreement, including the selections, pricing, and notes above, is the entire agreement between the Client and The Ivy about the event. If it conflicts with any menu, brochure, guidelines sheet, or earlier communication, this agreement controls. It can be changed only in writing agreed to by both parties, and email is sufficient.</li>
          <li><strong>Authority.</strong> The person signing confirms they are at least 18 years old and, if signing for a company or organization, that they are authorized to sign for it and that it is bound by this agreement.</li>
          <li><strong>Transfer.</strong> The Client may not transfer this agreement to anyone else without The Ivy's written consent.</li>
          <li><strong>Governing law.</strong> Illinois law governs this agreement. Any dispute must be brought in the state or federal courts located in Cook County, Illinois, and each party consents to those courts.</li>
          <li><strong>If a term fails.</strong> If any part of this agreement is found unenforceable, the rest stays in effect. If The Ivy does not enforce a term, that is not a waiver of it.</li>
          <li><strong>Notices.</strong> Notices to The Ivy go to ${esc(VENUE.eventsEmail)}. Notices to the Client go to the email address in this agreement.</li>
          <li><strong>Electronic signature.</strong> Typing a name and clicking Sign is a legally binding electronic signature with the same effect as a handwritten signature. The Client consents to receive this agreement and related notices electronically at the email address provided, and may request a paper copy or withdraw this consent at any time by contacting ${esc(VENUE.eventsEmail)}.</li>
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

  const dayOf = signed ? (cl.dayName || 'Same as Client') : 'To be provided at signing';
  const dayOfPhone = signed ? (cl.dayPhone || phone) : '';

  const facts = [
    factRow('Client Name', esc(c.name)),
    factRow('Company / Organization', esc(company)),
    factRow('Phone', esc(phone)),
    factRow('Email', esc(email)),
    factRow('Event Date', esc(fmtDate(c.date))),
    factRow('Event Type', esc(c.type)),
    factRow('Event Start Time', esc(fmtTime(c.start)), '30-minute setup window immediately before this time'),
    factRow('Event End Time', esc(fmtTime(c.end))),
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
    `<tr class="strong"><td>Deposit Due to Secure the Date<span class="hint">${t.deposit === r2(t.base * DEPOSIT_RATE) ? '20% of the food &amp; beverage amount above; ' : ''}credited toward the final bill</span></td><td>${esc(fmtMoney(t.deposit))}</td></tr>`,
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
      <p class="lede">Thank you for choosing The Ivy for your upcoming event. This agreement outlines the event details, payment terms, cancellation policy, and guidelines for use of our private event space. In this agreement, &ldquo;The Ivy&rdquo; means ${esc(VENUE.legalName)}, ${esc(VENUE.address)}; &ldquo;Client&rdquo; means the person or organization named below; and &ldquo;event&rdquo; means the event described below. Capitalized terms such as Event Date, Event Start Time, and Event End Time refer to the details listed in Event Information.</p>

      <h2><span class="n">1</span>Event Information</h2>
      <table class="facts">${facts}</table>

      <h2><span class="n">2</span>Selections &amp; Pricing</h2>
      ${linesHtml}
      <table class="tbl sum"><tbody>${sumRows}</tbody></table>
      <div class="callout">Estimated 20% service charge on the amount above: <strong>${esc(fmtMoney(t.service))}</strong><br>A 3% surcharge applies to all credit card payments, including the deposit.</div>
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
      <p class="fine">After you sign, The Ivy will contact you to collect the ${esc(fmtMoney(t.deposit))} deposit (credit card payments carry a 3% surcharge). Your date is held through ${esc(fmtDateShort(c.exp))}. Questions? Call ${esc(VENUE.phone)} or email ${esc(VENUE.eventsEmail)}.</p>
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

  // ---- confirm a deposit
  var cInfo = null;
  var amountTouched = false;
  function cSay(text, isErr) { var m = $('c-msg'); m.textContent = text; m.style.color = isErr ? '#8C2F1B' : '#2E6B45'; m.hidden = false; }
  function suggestAmount() {
    if (!cInfo || amountTouched) return;
    var mult = $('c-method').value === 'Credit card' ? 1.03 : 1;
    $('c-amount').value = (Math.round(cInfo.deposit * mult * 100) / 100).toFixed(2);
  }
  $('c-amount').addEventListener('input', function () { amountTouched = true; });
  $('c-method').addEventListener('change', suggestAmount);
  $('c-date').value = ymd(new Date());

  $('c-lookup').addEventListener('click', function () {
    $('c-msg').hidden = true;
    fetch('/admin/contracts/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ link: $('c-link').value }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { $('c-panel').hidden = true; cSay(res.d.error || 'Could not look that up.', true); return; }
        cInfo = res.d;
        amountTouched = false;
        $('c-summary').textContent = res.d.name + ' (' + res.d.ref + '): ' + res.d.type + ' on ' + res.d.date + ', about ' + res.d.guests + ' guests. Deposit due ' + money(res.d.deposit) + '. Signed ' + res.d.signedAt + '.' + (res.d.alreadyConfirmed ? ' Already marked received.' : '');
        suggestAmount();
        $('c-panel').hidden = false;
      })
      .catch(function () { cSay('Network error. Please try again.', true); });
  });

  $('c-confirm').addEventListener('click', function () {
    if (!cInfo) return;
    if (!confirm('Mark the deposit received and email ' + cInfo.email + ' that the date is confirmed?')) return;
    var b = $('c-confirm');
    b.disabled = true; b.textContent = 'Confirming...';
    fetch('/admin/contracts/confirm-deposit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link: $('c-link').value, amount: parseFloat($('c-amount').value), receivedOn: $('c-date').value, method: $('c-method').value, note: $('c-note').value })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        b.disabled = false; b.textContent = 'Deposit received: confirm the date';
        if (res.ok && res.d.ok) cSay('Confirmed. Emailed ' + res.d.emailed + '. Calendar: ' + res.d.calendar + '.', false);
        else cSay(res.d.error || 'Could not confirm the deposit.', true);
      })
      .catch(function () { b.disabled = false; b.textContent = 'Deposit received: confirm the date'; cSay('Network error. Please try again.', true); });
  });

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
      <p class="lede">Fill this in, create the agreement, then send the link to the client. The client reviews the terms and signs on their phone or computer. A signed copy goes to the client and to the events team. <a href="/admin/agreements" style="color:var(--ivy);font-weight:600">See all agreements</a></p>
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

      <fieldset style="margin-top:36px">
        <legend>Confirm a deposit</legend>
        <p class="fine" style="margin:0 0 14px">When a deposit arrives, paste the signed agreement link (it is in the "Agreement Signed" email and in the calendar entry). One click emails the client that their date is confirmed, turns the calendar entry green, and logs it to the events team.</p>
        <div class="fld"><label for="c-link">Signed agreement link</label><input id="c-link" placeholder="https://theivybk.com/contract/..."></div>
        <p style="margin:0 0 14px"><button type="button" class="btn plain" id="c-lookup" style="width:auto;padding:10px 20px">Look up</button></p>
        <div id="c-panel" hidden>
          <div class="callout" id="c-summary"></div>
          <div class="row three">
            <div class="fld"><label for="c-amount">Amount received ($)</label><input id="c-amount" type="number" min="0" step="0.01"><div class="help">Credit card payments include the 3% surcharge.</div></div>
            <div class="fld"><label for="c-date">Date received</label><input id="c-date" type="date"></div>
            <div class="fld"><label for="c-method">Paid by</label><select id="c-method"><option>Credit card</option><option>Cash</option><option>Check</option><option>Other</option></select></div>
          </div>
          <div class="fld"><label for="c-note">Internal note (optional, not shown to the client)</label><input id="c-note"></div>
          <button type="button" class="btn" id="c-confirm" style="max-width:340px">Deposit received: confirm the date</button>
        </div>
        <p class="err" id="c-msg" hidden></p>
      </fieldset>
    </div>`;
  const script = ADMIN_SCRIPT.replace('__CATALOG__', () => jsonForScript(CATALOG));
  return shell({ title: 'New Event Agreement | The Ivy', body, script }).replace('</style>', () => `${ADMIN_CSS}</style>`);
}

// ------------------------------------------------------------ agreements page

const AGREEMENTS_CSS = `
.sheet { max-width:1120px; }
.wrap { max-width:none; }
.topbar { display:flex; flex-wrap:wrap; gap:10px 14px; align-items:center; margin:0 0 14px; }
.topbar input[type=search] { flex:1 1 240px; min-width:0; padding:10px 12px; font:inherit; font-size:15px; background:#fff; color:var(--ink); border:1px solid var(--border); border-radius:2px; }
.chips { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 18px; }
.chip { font:500 13px 'Outfit',sans-serif; padding:7px 13px; border:1px solid var(--border); background:var(--cream-pure); color:var(--ink-soft); border-radius:2px; cursor:pointer; }
.chip[aria-pressed="true"] { background:var(--ivy); color:var(--cream); border-color:var(--ivy); }
.chip .n { margin-left:6px; opacity:.8; font-variant-numeric:tabular-nums; }
.group { margin:28px 0 0; }
.group h2 { margin-top:0; }
.tablewrap { overflow-x:auto; border:1px solid var(--border); border-radius:4px; background:var(--cream-pure); }
table.ag { width:100%; border-collapse:collapse; min-width:820px; }
table.ag th { text-align:left; font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--brass-deep); font-weight:600; padding:10px 12px; border-bottom:1px solid var(--border); }
table.ag td { vertical-align:top; padding:12px; border-bottom:1px solid var(--border); font-size:14px; }
table.ag tr:last-child td { border-bottom:0; }
table.ag .sub { display:block; font-size:12px; color:var(--ink-mute); margin-top:2px; }
table.ag .who { font-weight:600; color:var(--ivy); }
.pill { display:inline-block; padding:2px 9px; border-radius:2px; font-size:12px; font-weight:600; letter-spacing:.03em; }
.pill.awaiting { background:#E3E9F2; color:#2C4468; }
.pill.pending { background:#F3E6BF; color:#6B5316; }
.pill.confirmed { background:#DCEBDD; color:#1F5A34; }
.pill.cancelled, .pill.expired, .pill.void { background:#E7E5E0; color:#555; }
.acts { display:flex; flex-wrap:wrap; gap:6px; }
.acts .b { font:600 12px 'Outfit',sans-serif; letter-spacing:.03em; padding:7px 11px; border-radius:2px; border:1px solid var(--ivy); background:transparent; color:var(--ivy); cursor:pointer; text-decoration:none; white-space:nowrap; }
.acts .b.main { background:var(--ivy); color:var(--cream); }
.acts .b.danger { border-color:var(--brick); color:var(--brick); }
.acts .b[disabled] { opacity:.55; cursor:default; }
tr.detail td { background:var(--cream); }
.detail .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px 14px; align-items:end; }
.detail label { display:block; font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--ivy); font-weight:600; margin-bottom:4px; }
.detail input, .detail select { width:100%; padding:8px 10px; font:inherit; font-size:14px; background:#fff; border:1px solid var(--border); border-radius:2px; }
.detail .row2 { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; align-items:center; }
.msg { margin:0 0 14px; padding:10px 14px; border:1px solid var(--border); border-left:3px solid var(--ok); background:var(--cream-pure); border-radius:2px; font-size:14px; }
.msg.bad { border-left-color:var(--brick); color:var(--brick); }
.empty { padding:22px; text-align:center; color:var(--ink-mute); font-style:italic; }
@media (max-width:760px) { .detail .grid { grid-template-columns:1fr 1fr; } }
`;

const AGREEMENTS_SCRIPT = `
(function () {
  var rows = [], today = '', filter = 'all', query = '', openId = null, openMode = null;
  var $ = function (id) { return document.getElementById(id); };

  function money(n) {
    n = Math.round((Number(n) || 0) * 100) / 100;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function fmtDate(ymd) {
    return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  function fmtTime(hhmm) {
    var m = /^(\\d{1,2}):(\\d{2})$/.exec(hhmm || '');
    if (!m) return '';
    var h = parseInt(m[1], 10);
    return (h % 12 === 0 ? 12 : h % 12) + ':' + m[2] + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function tokenOf(link) {
    var m = /\\/contract\\/([A-Za-z0-9_-]+)/.exec(link || '');
    return m ? m[1] : '';
  }
  function say(text, bad) {
    var m = $('msg');
    m.textContent = text;
    m.className = bad ? 'msg bad' : 'msg';
    m.hidden = false;
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok && d.ok, d: d }; }); });
  }

  var STATUS = {
    awaiting: 'Awaiting signature', pending: 'Deposit pending', confirmed: 'Confirmed', cancelled: 'Cancelled', expired: 'Expired, not signed', void: 'Voided'
  };
  function inFilter(r) {
    if (filter === 'all') return true;
    if (filter === 'closed') return r.status === 'cancelled' || r.status === 'expired' || r.status === 'void';
    return r.status === filter;
  }
  function matches(r) {
    if (!query) return true;
    var hay = [r.name, r.email, r.phone, r.space, r.ref, r.date, fmtDate(r.date)].join(' ').toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function load() {
    $('refresh').disabled = true;
    fetch('/admin/agreements/data')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('refresh').disabled = false;
        if (!d.ok) { say(d.error || 'Could not load agreements.', true); return; }
        rows = d.rows; today = d.today;
        var w = $('warn');
        w.textContent = (d.warnings || []).join(' ');
        w.hidden = !(d.warnings && d.warnings.length);
        render();
      })
      .catch(function () { $('refresh').disabled = false; say('Network error. Please try again.', true); });
  }

  function count(status) {
    return rows.filter(function (r) {
      if (status === 'all') return true;
      if (status === 'closed') return r.status === 'cancelled' || r.status === 'expired' || r.status === 'void';
      return r.status === status;
    }).length;
  }

  function buildChips() {
    var defs = [['all', 'All'], ['awaiting', 'Awaiting signature'], ['pending', 'Deposit pending'], ['confirmed', 'Confirmed'], ['closed', 'Cancelled, voided or expired']];
    var box = $('chips');
    box.textContent = '';
    defs.forEach(function (d) {
      var b = el('button', 'chip', d[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', filter === d[0] ? 'true' : 'false');
      var n = el('span', 'n', String(count(d[0])));
      b.appendChild(n);
      b.addEventListener('click', function () { filter = d[0]; render(); });
      box.appendChild(b);
    });
  }

  function actionButton(label, cls, fn) {
    var b = el('button', 'b ' + (cls || ''), label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function detailRow(r, cols) {
    var tr = el('tr', 'detail');
    var td = el('td');
    td.colSpan = cols;
    if (openMode === 'confirm') {
      var dep = parseFloat(String(r.deposit).replace(/[^0-9.]/g, '')) || 0;
      var grid = el('div', 'grid');
      function field(labelText, node) { var d = el('div'); var l = el('label', null, labelText); d.appendChild(l); d.appendChild(node); grid.appendChild(d); return node; }
      var amount = el('input'); amount.type = 'number'; amount.step = '0.01'; amount.min = '0';
      var when = el('input'); when.type = 'date'; when.value = today;
      var method = el('select');
      ['Credit card', 'Cash', 'Check', 'Other'].forEach(function (m) { var o = el('option', null, m); method.appendChild(o); });
      var note = el('input'); note.type = 'text'; note.placeholder = 'Optional, internal';
      var touched = false;
      function suggest() { if (!touched) amount.value = (Math.round(dep * (method.value === 'Credit card' ? 1.03 : 1) * 100) / 100).toFixed(2); }
      amount.addEventListener('input', function () { touched = true; });
      method.addEventListener('change', suggest);
      suggest();
      field('Amount received ($)', amount); field('Date received', when); field('Paid by', method); field('Note', note);
      td.appendChild(grid);
      var row2 = el('div', 'row2');
      var go = actionButton('Deposit received: confirm the date', 'main', function () {
        if (!window.confirm('Mark the deposit received and email ' + (r.email || 'the client') + ' that the date is confirmed?')) return;
        go.disabled = true; go.textContent = 'Confirming...';
        post('/admin/contracts/confirm-deposit', { link: r.link, amount: parseFloat(amount.value), receivedOn: when.value, method: method.value, note: note.value })
          .then(function (res) {
            if (res.ok) { say('Confirmed. Emailed ' + res.d.emailed + '. Calendar: ' + res.d.calendar + '.'); openId = null; load(); }
            else { go.disabled = false; go.textContent = 'Deposit received: confirm the date'; say(res.d.error || 'Could not confirm the deposit.', true); }
          })
          .catch(function () { go.disabled = false; go.textContent = 'Deposit received: confirm the date'; say('Network error. Please try again.', true); });
      });
      row2.appendChild(go);
      row2.appendChild(actionButton('Close', '', function () { openId = null; render(); }));
      td.appendChild(row2);
    } else if (openMode === 'void') {
      var pv = el('p', null, 'Void this agreement? The link stops working right away and the client can no longer sign it. Use this for a mistake, or a booking that fell through before it was signed.');
      pv.style.margin = '0 0 10px';
      td.appendChild(pv);
      var whyv = el('input'); whyv.type = 'text'; whyv.placeholder = 'Reason (optional, internal)'; whyv.style.maxWidth = '420px';
      td.appendChild(whyv);
      var rowv = el('div', 'row2');
      var yesv = actionButton('Yes, void it', 'danger', function () {
        yesv.disabled = true; yesv.textContent = 'Voiding...';
        post('/admin/contracts/void', { link: r.link, note: whyv.value })
          .then(function (res) {
            if (res.ok) { say('Voided. The link no longer works.'); openId = null; load(); }
            else { yesv.disabled = false; yesv.textContent = 'Yes, void it'; say(res.d.error || 'Could not void.', true); }
          })
          .catch(function () { yesv.disabled = false; yesv.textContent = 'Yes, void it'; say('Network error. Please try again.', true); });
      });
      rowv.appendChild(yesv);
      rowv.appendChild(actionButton('Keep it', '', function () { openId = null; render(); }));
      td.appendChild(rowv);
    } else if (openMode === 'cancel') {
      var p = el('p', null, 'Mark this event cancelled? The calendar entry turns gray and reads CANCELLED, and the events team gets a record. Any deposit paid is forfeited and nothing more is owed.');
      p.style.margin = '0 0 10px';
      td.appendChild(p);
      var why = el('input'); why.type = 'text'; why.placeholder = 'Reason (optional, internal)'; why.style.maxWidth = '420px';
      td.appendChild(why);
      var row3 = el('div', 'row2');
      var yes = actionButton('Yes, mark cancelled', 'danger', function () {
        yes.disabled = true; yes.textContent = 'Cancelling...';
        post('/admin/contracts/cancel', { link: r.link, note: why.value })
          .then(function (res) {
            if (res.ok) { say('Marked cancelled. Calendar: ' + res.d.calendar + '.'); openId = null; load(); }
            else { yes.disabled = false; yes.textContent = 'Yes, mark cancelled'; say(res.d.error || 'Could not cancel.', true); }
          })
          .catch(function () { yes.disabled = false; yes.textContent = 'Yes, mark cancelled'; say('Network error. Please try again.', true); });
      });
      row3.appendChild(yes);
      row3.appendChild(actionButton('Keep it', '', function () { openId = null; render(); }));
      td.appendChild(row3);
    }
    tr.appendChild(td);
    return tr;
  }

  function buildTable(list) {
    var wrap = el('div', 'tablewrap');
    var t = el('table', 'ag');
    var head = el('tr');
    ['Event', 'Client', 'Status', 'Deposit', ''].forEach(function (h) { head.appendChild(el('th', null, h)); });
    var thead = el('thead'); thead.appendChild(head); t.appendChild(thead);
    var tb = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr');
      var c1 = el('td');
      c1.appendChild(el('span', 'who', fmtDate(r.date)));
      var times = fmtTime(r.start) + (r.end ? ' to ' + fmtTime(r.end) : '');
      c1.appendChild(el('span', 'sub', times));
      c1.appendChild(el('span', 'sub', r.space));
      var c2 = el('td');
      c2.appendChild(el('span', 'who', r.name));
      c2.appendChild(el('span', 'sub', [r.phone, r.email].filter(Boolean).join(' / ')));
      c2.appendChild(el('span', 'sub', (r.guests != null ? r.guests + ' guests. ' : '') + r.ref));
      var c3 = el('td');
      c3.appendChild(el('span', 'pill ' + r.status, STATUS[r.status] || r.status));
      if (r.status === 'awaiting') c3.appendChild(el('span', 'sub', 'Hold through ' + r.holdThrough));
      if (r.status === 'pending') c3.appendChild(el('span', 'sub', 'Hold through ' + r.holdThrough));
      if (r.status === 'expired') c3.appendChild(el('span', 'sub', 'Hold ended ' + r.holdThrough));
      var c4 = el('td', null, r.deposit || '');
      var c5 = el('td');
      var acts = el('div', 'acts');
      var link = r.link;
      if (link) {
        var a = el('a', 'b', r.status === 'awaiting' || r.status === 'expired' || r.status === 'void' ? 'Open link' : 'Open agreement');
        a.href = link; a.target = '_blank'; a.rel = 'noopener';
        acts.appendChild(a);
      }
      if (r.status === 'awaiting') {
        acts.appendChild(actionButton('Copy link', '', function () {
          try { navigator.clipboard.writeText(link); say('Link copied.'); } catch (e) { say('Copy failed. Use Open link and copy from the address bar.', true); }
        }));
        acts.appendChild(actionButton('Email link again', 'main', function () {
          if (!window.confirm('Email the agreement link to ' + (r.email || 'the client') + ' again?')) return;
          post('/admin/contracts/email', { token: tokenOf(link) }).then(function (res) {
            if (res.ok) say('Sent to ' + r.email + '.'); else say(res.d.error || 'Could not send the email.', true);
          }).catch(function () { say('Network error. Please try again.', true); });
        }));
      }
      if (r.status === 'awaiting') {
        acts.appendChild(actionButton('Void', 'danger', function () { openId = r.ref; openMode = 'void'; render(); }));
      }
      if (r.status === 'pending') {
        acts.appendChild(actionButton('Confirm deposit', 'main', function () { openId = r.ref; openMode = 'confirm'; render(); }));
      }
      if (r.status === 'pending' || r.status === 'confirmed') {
        acts.appendChild(actionButton('Cancel', 'danger', function () { openId = r.ref; openMode = 'cancel'; render(); }));
      }
      c5.appendChild(acts);
      [c1, c2, c3, c4, c5].forEach(function (c) { tr.appendChild(c); });
      tb.appendChild(tr);
      if (openId === r.ref) tb.appendChild(detailRow(r, 5));
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  function render() {
    buildChips();
    var box = $('list');
    box.textContent = '';
    var list = rows.filter(function (r) { return inFilter(r) && matches(r); });
    if (!list.length) {
      box.appendChild(el('p', 'empty', rows.length ? 'Nothing matches that filter.' : 'No agreements yet. Create one to get started.'));
      return;
    }
    var upcoming = list.filter(function (r) { return r.date >= today; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var past = list.filter(function (r) { return r.date < today; }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    [['Upcoming events', upcoming], ['Past events', past]].forEach(function (g) {
      if (!g[1].length) return;
      var section = el('div', 'group');
      section.appendChild(el('h2', null, g[0]));
      section.appendChild(buildTable(g[1]));
      box.appendChild(section);
    });
  }

  $('q').addEventListener('input', function () { query = $('q').value.trim().toLowerCase(); render(); });
  $('refresh').addEventListener('click', load);
  load();
})();
`;

function agreementsPageHtml() {
  const body = `
    <div class="wrap">
      <span class="eyebrow">Private Events</span>
      <h1>Agreements</h1>
      <p class="lede">Every agreement that has gone out, and where each one stands. <a href="/admin/contracts" style="color:var(--ivy);font-weight:600">Create a new agreement</a></p>
      <div class="topbar">
        <input type="search" id="q" placeholder="Search by name, email, phone, date, or reference" aria-label="Search agreements">
        <button type="button" class="chip" id="refresh">Refresh</button>
      </div>
      <div class="chips" id="chips"></div>
      <p class="msg" id="msg" hidden></p>
      <p class="msg bad" id="warn" hidden></p>
      <div id="list"><p class="empty">Loading agreements...</p></div>
    </div>`;
  return shell({ title: 'Agreements | The Ivy', body, script: AGREEMENTS_SCRIPT })
    .replace('</style>', () => `${ADMIN_CSS}${AGREEMENTS_CSS}</style>`);
}

// ------------------------------------------------------------------ emails
//
// Every email the agreement system sends. Emails to clients come from, and
// reply to, events@. Internal notices go to events@ only. Each builder returns
// { subject, text, html }, in the same branded layout as the rest of the site.

const E = require('./emails.cjs');
const AGREEMENTS_URL = `${VENUE.origin}/admin/agreements`;

const rowsToText = (rows) => rows
  .filter((r) => r && r[1] != null && String(r[1]).trim() !== '')
  .map(([k, v]) => `${k}: ${v}`)
  .join('\n');

const eventRows = (c) => [
  ['Event', c.type],
  ['Date', fmtDate(c.date)],
  ['Time', `${fmtTime(c.start)} to ${fmtTime(c.end)}`],
  ['Space', c.space],
  ['Estimated guests', String(c.guests)],
];

const clientRows = (c, cl) => [
  ['Client', c.name + (cl.company ? ` (${cl.company})` : '')],
  ['Phone', cl.phone, 'tel'],
  ['Email', cl.email, 'mailto'],
  ['Day-of contact', cl.dayName ? `${cl.dayName}${cl.dayPhone ? `, ${cl.dayPhone}` : ''}` : ''],
];

const clientSignoff = `Questions? Call ${VENUE.phone} or reply to this email.\n\n${VENUE.name}\n${VENUE.address}`;

const AGREEMENT_EMAILS = {
  // To the client: the link to review and sign.
  clientLink(c, url) {
    const t = computeTotals(c);
    const rows = [...eventRows(c), ['Deposit to secure the date', fmtMoney(t.deposit)], ['Date held through', fmtDateShort(c.exp)]];
    return {
      subject: 'Your event agreement | The Ivy Bar and Kitchen',
      text: `Hi ${c.name},\n\nThanks for choosing The Ivy for your ${c.type.toLowerCase()} on ${fmtDate(c.date)}. Your event agreement is ready to review and sign:\n\n${url}\n\n${rowsToText(rows)}\n\nWe're holding the date through ${fmtDateShort(c.exp)}. To keep it, please sign and we'll follow up to collect the deposit. Credit card payments carry a 3% surcharge.\n\n${clientSignoff}`,
      html: E.emailTemplate({
        heading: 'Your event agreement',
        bodyHtml: E.emailPara(`Hi ${c.name},`)
          + E.emailPara(`Thanks for choosing The Ivy for your ${c.type.toLowerCase()} on ${fmtDate(c.date)}. Your agreement is ready to review and sign.`)
          + E.emailDetails(rows, 170)
          + E.emailButton('Review & Sign Agreement', url)
          + E.emailPara(`We're holding the date through ${fmtDateShort(c.exp)}. To keep it, sign the agreement and we'll follow up to collect the deposit. Credit card payments carry a 3% surcharge.`)
          + E.emailContact(),
      }),
    };
  },

  // To the client, right after they sign.
  signedClient(c, sd, signedLink) {
    const t = computeTotals(c);
    const rows = [...eventRows(c), ['Deposit to secure the date', fmtMoney(t.deposit)], ['Date held through', fmtDateShort(c.exp)], ['Reference', refOf(c)]];
    return {
      subject: 'Your signed agreement | The Ivy Bar and Kitchen',
      text: `Hi ${c.name},\n\nThank you for signing your private event agreement with The Ivy Bar and Kitchen. A copy is attached, and you can view it any time here:\n${signedLink}\n\n${rowsToText(rows)}\n\nNext, we'll contact you to collect the deposit. Credit card payments carry a 3% surcharge. Your date is confirmed once we receive it.\n\n${clientSignoff}`,
      html: E.emailTemplate({
        heading: 'Thank you for signing',
        bodyHtml: E.emailPara(`Hi ${c.name},`)
          + E.emailPara('Thank you for signing your private event agreement. A copy is attached, and you can view it any time with the button below.')
          + E.emailDetails(rows, 170)
          + E.emailButton('View signed agreement', signedLink)
          + E.emailCallout('What happens next', `We'll contact you to collect the ${fmtMoney(t.deposit)} deposit. Credit card payments carry a 3% surcharge. Your date is confirmed once we receive it.`)
          + E.emailContact(),
      }),
    };
  },

  // To the client when their deposit is confirmed.
  depositClient(c, sd, conf, signedLink, deadline) {
    const t = computeTotals(c);
    const rows = [
      ['Event', c.type],
      ['Date', fmtDate(c.date)],
      ['Time', `${fmtTime(c.start)} to ${fmtTime(c.end)} (setup begins 30 minutes earlier)`],
      ['Space', c.space],
      ['Estimated guests', String(c.guests)],
      ['Deposit received', `${fmtMoney(conf.amount)} on ${fmtDateShort(conf.receivedOn)} (${conf.method.toLowerCase()})`],
      ['Remaining balance', `About ${fmtMoney(t.remaining)} plus tax and service charge, due on the day of the event`],
    ];
    return {
      subject: 'Your date is confirmed | The Ivy Bar and Kitchen',
      text: `Hi ${c.name},\n\nWe've received your deposit, and your ${c.type.toLowerCase()} on ${fmtDate(c.date)} is confirmed. Your agreement is now in effect.\n\n${rowsToText(rows)}\n\nTo do next: send us your final guaranteed guest count, menu selections, dietary needs, and the number of beverage-package wristbands by ${deadline}.\n\nYour signed agreement: ${signedLink}\n\n${clientSignoff}`,
      html: E.emailTemplate({
        heading: 'Your date is confirmed',
        bodyHtml: E.emailPara(`Hi ${c.name},`)
          + E.emailPara(`We've received your deposit, and your ${c.type.toLowerCase()} on ${fmtDate(c.date)} is confirmed. Your agreement is now in effect.`)
          + E.emailDetails(rows, 170)
          + E.emailCallout('To do next', `Send us your final guaranteed guest count, menu selections, dietary needs, and the number of beverage-package wristbands by ${deadline}.`)
          + E.emailButton('View your signed agreement', signedLink)
          + E.emailContact(),
      }),
    };
  },

  // To us: an agreement was created.
  created(c, url) {
    const t = computeTotals(c);
    const rows = [
      ['Client', c.name + (c.company ? ` (${c.company})` : '')],
      ['Phone', c.phone, 'tel'],
      ['Email', c.email, 'mailto'],
      ...eventRows(c),
      ['Estimated food & beverage', fmtMoney(t.est)],
      ['Food & beverage minimum', t.min > 0 ? fmtMoney(t.min) : ''],
      ['Deposit', fmtMoney(t.deposit)],
      ['Date held through', fmtDateShort(c.exp)],
      ['Issued by', c.rep],
      ['Reference', refOf(c)],
    ];
    return {
      subject: `Agreement Created: ${c.name}, ${c.date} (${refOf(c)})`,
      text: `${c.rep} created an agreement for ${c.name}.\n\n${rowsToText(rows)}\n\nClient link:\n${url}\n\nThis is a record copy. The client has not been emailed unless "Email to client" was used.`,
      html: E.emailTemplate({
        heading: 'Agreement created',
        bodyHtml: E.emailPara(`${c.rep} created an agreement for ${c.name}. The client has not been emailed unless "Email to client" was used.`)
          + E.emailDetails(rows, 170)
          + E.emailButton('Open the client link', url)
          + E.emailLink('See all agreements', AGREEMENTS_URL),
      }),
    };
  },

  // To us: the client signed.
  signedVenue(c, sd, signedLink) {
    const t = computeTotals(c);
    const rows = [
      ...clientRows(c, sd.cl),
      ...eventRows(c),
      ['Deposit due', `${fmtMoney(t.deposit)} (date held through ${fmtDateShort(c.exp)})`],
      ['Signed', fmtStamp(sd.sig.at)],
      ['Reference', refOf(c)],
    ];
    return {
      subject: `Agreement Signed: ${c.name}, ${c.date} (${refOf(c)})`,
      text: `${sd.sig.name} signed the agreement for ${c.name}'s ${c.type.toLowerCase()} on ${fmtStamp(sd.sig.at)}.\n\n${rowsToText(rows)}\n\nSigned agreement: ${signedLink}\n\nThe signed copy is attached. Next: collect the ${fmtMoney(t.deposit)} deposit, then confirm it on the Agreements page: ${AGREEMENTS_URL}`,
      html: E.emailTemplate({
        heading: 'Agreement signed',
        bodyHtml: E.emailPara(`${sd.sig.name} signed the agreement for ${c.name}'s ${c.type.toLowerCase()} on ${fmtStamp(sd.sig.at)}.`)
          + E.emailCallout('Next step', `Collect the ${fmtMoney(t.deposit)} deposit, then confirm it on the Agreements page so the client gets their confirmation.`)
          + E.emailDetails(rows, 170)
          + E.emailButton('View signed agreement', signedLink)
          + E.emailLink('Open the Agreements page', AGREEMENTS_URL)
          + E.emailFine('The signed copy is attached.'),
      }),
    };
  },

  // To us: a deposit was confirmed.
  depositRecord(c, sd, conf, note, calendar, signedLink) {
    const rows = [
      ...clientRows(c, sd.cl),
      ...eventRows(c),
      ['Amount received', fmtMoney(conf.amount)],
      ['Paid by', conf.method],
      ['Date received', fmtDateShort(conf.receivedOn)],
      ['Note', note],
      ['Confirmation sent to', sd.cl.email],
      ['Calendar', calendar],
      ['Reference', refOf(c)],
    ];
    return {
      subject: `Deposit Received: ${c.name}, ${c.date} (${refOf(c)})`,
      text: `Deposit marked received for ${c.name} (${refOf(c)}).\n\n${rowsToText(rows)}\n\nSigned agreement: ${signedLink}`,
      html: E.emailTemplate({
        heading: 'Deposit received',
        bodyHtml: E.emailPara(`${fmtMoney(conf.amount)} received from ${c.name} on ${fmtDateShort(conf.receivedOn)}. The date is confirmed, and the client has been emailed.`)
          + E.emailDetails(rows, 170)
          + E.emailButton('View signed agreement', signedLink)
          + E.emailLink('Open the Agreements page', AGREEMENTS_URL),
      }),
    };
  },

  // To us: a signed agreement was cancelled.
  cancelled(c, sd, conf, calendar, signedLink) {
    const rows = [
      ...clientRows(c, sd.cl),
      ...eventRows(c),
      ['Cancelled on', fmtDateShort(conf.cancelledOn)],
      ['Reason', conf.note],
      ['Calendar', calendar],
      ['Reference', refOf(c)],
    ];
    return {
      subject: `Agreement Cancelled: ${c.name}, ${c.date} (${refOf(c)})`,
      text: `${c.name} (${refOf(c)}) was marked cancelled on ${fmtDateShort(conf.cancelledOn)}.\n\n${rowsToText(rows)}\n\nAny deposit paid is forfeited and nothing further is owed under the agreement.\n\nSigned agreement: ${signedLink}`,
      html: E.emailTemplate({
        heading: 'Agreement cancelled',
        bodyHtml: E.emailPara(`${c.name}'s ${c.type.toLowerCase()} was marked cancelled. Any deposit paid is forfeited and nothing further is owed under the agreement.`)
          + E.emailDetails(rows, 170)
          + E.emailButton('View signed agreement', signedLink)
          + E.emailLink('Open the Agreements page', AGREEMENTS_URL),
      }),
    };
  },

  // To us: an unsigned agreement was voided.
  voided(c, note) {
    const rows = [
      ['Client', c.name + (c.company ? ` (${c.company})` : '')],
      ['Email', c.email, 'mailto'],
      ...eventRows(c),
      ['Voided on', fmtDateShort(chicagoToday())],
      ['Reason', note],
      ['Reference', refOf(c)],
    ];
    return {
      subject: `Agreement Voided: ${c.name}, ${c.date} (${refOf(c)})`,
      text: `The unsigned agreement for ${c.name} (${refOf(c)}) was voided on ${fmtDateShort(chicagoToday())}. Its link no longer works.\n\n${rowsToText(rows)}`,
      html: E.emailTemplate({
        heading: 'Agreement voided',
        bodyHtml: E.emailPara(`The unsigned agreement for ${c.name} was voided. Its link no longer works.`)
          + E.emailDetails(rows, 170)
          + E.emailLink('Open the Agreements page', AGREEMENTS_URL),
      }),
    };
  },

  // To us: the calendar step failed after a signing.
  calendarAlert(c, signedLink, errMsg) {
    const rows = [...eventRows(c), ['Client', c.name], ['Reference', refOf(c)]];
    return {
      subject: `Add to calendar by hand: ${c.name}, ${c.date} (${refOf(c)})`,
      text: `${c.name} signed the private event agreement, but the party could not be added to the events calendar automatically.\n\nPlease add it by hand:\n${rowsToText(rows)}\n\nSigned agreement: ${signedLink}\n\nError: ${errMsg}`,
      html: E.emailTemplate({
        heading: 'Add this party to the calendar',
        bodyHtml: E.emailCallout('Action needed', `${c.name} signed, but the party could not be added to the events calendar automatically. Please add it by hand.`, 'action')
          + E.emailDetails(rows, 170)
          + E.emailButton('View signed agreement', signedLink)
          + E.emailFine(`Error: ${errMsg}`),
      }),
    };
  },

  // To us: the signed copy could not be emailed to the client.
  copyFailed(c, cl, signedLink, errMsg) {
    const rows = [...clientRows(c, cl), ['Event', `${c.type}, ${fmtDate(c.date)}`], ['Reference', refOf(c)]];
    return {
      subject: `Signed copy did NOT reach the client: ${c.name} (${refOf(c)})`,
      text: `${c.name} signed the agreement, but the signed copy could not be emailed to ${cl.email}. The address may be mistyped.\n\nPlease contact them at ${cl.phone} and send them this link:\n${signedLink}\n\nReason: ${errMsg}`,
      html: E.emailTemplate({
        heading: 'Signed copy did not reach the client',
        bodyHtml: E.emailCallout('Action needed', `${c.name} signed, but the signed copy could not be emailed to ${cl.email}. The address may be mistyped. Please call them and send them the link below.`, 'action')
          + E.emailDetails(rows, 170)
          + E.emailButton('View signed agreement', signedLink)
          + E.emailFine(`Reason: ${errMsg}`),
      }),
    };
  },
};

// Sample data for the admin email preview page.
function previewEmails() {
  const c = {
    v: 1, tv: 1, id: 'a1b2c3d4e5', iat: '2026-09-23T15:00:00.000Z', exp: '2026-10-07', rep: 'Events Team',
    name: 'Sample Client', company: 'Sample Company LLC', phone: '(312) 555-0100', email: 'client@example.com',
    date: '2026-10-24', type: 'Birthday', start: '18:00', end: '22:00', arrive: '18:30', guests: 40,
    space: 'The Ivy Bundle (Rooftop + Ivy Room)',
    lines: [['Classic Buffet, 2 hours (per guest)', 40, 30, 'food'], ['The Classic open bar, 2 hours: beer, wine & seltzers', 30, 35, 'bev']],
    min: 3000, dep: 0, sel: '', notes: '',
  };
  c.dep = r2(computeTotals(c).base * DEPOSIT_RATE);
  const sd = {
    k: 'signed', c,
    cl: { company: 'Sample Company LLC', phone: '(312) 555-0100', email: 'client@example.com', dayName: 'Sample Day-of Contact', dayPhone: '(312) 555-0111' },
    sig: { name: 'Sample Client', at: '2026-09-24T16:30:00.000Z', ip: '203.0.113.10', fp: '0123456789abcdef' },
  };
  const url = `${VENUE.origin}/contract/SAMPLELINK`;
  const signedLink = `${url}?signed=1`;
  const conf = { amount: r2(c.dep * 1.03), receivedOn: '2026-09-25', method: 'Credit card' };
  const to = VENUE.notifyTo.join(', ');
  const item = (group, title, toWhom, mail) => ({ group, title, from: VENUE.from, to: toWhom, mail });
  return [
    item('Clients', 'Agreement link', 'the client', AGREEMENT_EMAILS.clientLink(c, url)),
    item('Clients', 'Signed agreement', 'the client', AGREEMENT_EMAILS.signedClient(c, sd, signedLink)),
    item('Clients', 'Date confirmed (deposit received)', 'the client', AGREEMENT_EMAILS.depositClient(c, sd, conf, signedLink, 'Saturday, October 17, 2026')),
    item('Our team', 'Agreement created', to, AGREEMENT_EMAILS.created(c, url)),
    item('Our team', 'Agreement signed', to, AGREEMENT_EMAILS.signedVenue(c, sd, signedLink)),
    item('Our team', 'Deposit received', to, AGREEMENT_EMAILS.depositRecord(c, sd, conf, 'Paid over the phone', 'updated to CONFIRMED', signedLink)),
    item('Our team', 'Agreement cancelled', to, AGREEMENT_EMAILS.cancelled(c, sd, { cancelledOn: '2026-09-26', note: 'Client changed plans' }, 'updated to CANCELLED', signedLink)),
    item('Our team', 'Agreement voided', to, AGREEMENT_EMAILS.voided(c, 'Wrong date entered')),
    item('Our team', 'Alert: add to calendar by hand', to, AGREEMENT_EMAILS.calendarAlert(c, signedLink, 'Calendar insert failed: 403')),
    item('Our team', 'Alert: signed copy did not reach the client', to, AGREEMENT_EMAILS.copyFailed(c, sd.cl, signedLink, 'Resend status 422: Invalid to address')),
  ];
}

// ------------------------------------------------------- tokens & handlers

function createContractHandlers(deps) {
  const { resendSendEmail, emailTemplate, checkBasicAuth, readJsonBody, getClientIp, createCalendarEvent, updateCalendarEvent, listCalendarEvents, db, secret, hasResend } = deps;
  const sendEmail = (opts) => resendSendEmail({ from: VENUE.from, ...opts });

  // ---- agreements database
  //
  // Every agreement is saved here when it is created, and updated as it is
  // emailed, signed, paid and cancelled. The database lives on the Railway
  // volume, so it survives deploys.
  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agreements (
        id TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting',
        name TEXT, company TEXT, phone TEXT, email TEXT,
        event_date TEXT, start_time TEXT, end_time TEXT, event_type TEXT, space TEXT, guests INTEGER,
        deposit REAL, est_total REAL, fb_min REAL,
        hold_through TEXT,
        issued_by TEXT, issued_at TEXT,
        link TEXT, emailed_at TEXT,
        signed_at TEXT, signed_by TEXT, signed_link TEXT,
        day_of_name TEXT, day_of_phone TEXT,
        deposit_received REAL, deposit_received_on TEXT, deposit_method TEXT, deposit_note TEXT, confirmed_at TEXT,
        cancelled_at TEXT, cancel_note TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agreements_event_date ON agreements (event_date);
    `);
  }
  const AGREEMENT_COLUMNS = new Set([
    'status', 'company', 'phone', 'email', 'link', 'emailed_at', 'signed_at', 'signed_by', 'signed_link',
    'day_of_name', 'day_of_phone', 'deposit_received', 'deposit_received_on', 'deposit_method', 'deposit_note',
    'confirmed_at', 'cancelled_at', 'cancel_note',
  ]);

  // Makes sure the agreement has a row (built from the agreement data itself,
  // so an agreement issued before the database existed is added on first use),
  // then applies the changes. A database problem never breaks the request.
  function saveAgreement(c, patch) {
    if (!db) return;
    try {
      const t = computeTotals(c);
      db.prepare(
        `INSERT OR IGNORE INTO agreements (id, ref, status, name, company, phone, email, event_date, start_time, end_time, event_type, space, guests, deposit, est_total, fb_min, hold_through, issued_by, issued_at)
         VALUES (?, ?, 'awaiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(c.id, refOf(c), c.name, c.company || '', c.phone, c.email, c.date, c.start, c.end, c.type, c.space, c.guests, t.deposit, t.est, t.min, c.exp, c.rep, c.iat);
      const keys = Object.keys(patch || {}).filter((k) => AGREEMENT_COLUMNS.has(k));
      if (keys.length) {
        db.prepare(`UPDATE agreements SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...keys.map((k) => (patch[k] === undefined ? null : patch[k])), new Date().toISOString(), c.id);
      }
    } catch (err) {
      console.error('Agreement database error:', err.message);
    }
  }

  // The stored status of one agreement, or null if it is not in the database.
  function getAgreementRow(id) {
    if (!db) return null;
    try {
      return db.prepare('SELECT status, signed_link FROM agreements WHERE id = ?').get(id) || null;
    } catch (err) {
      console.error('Agreement lookup error:', err.message);
      return null;
    }
  }


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
    const stored = getAgreementRow(data.c.id);
    if (stored && stored.status === 'void') {
      return sendHtml(res, 410, statusPage('This agreement was withdrawn', `The Ivy withdrew this agreement. Please contact our events team at ${esc(VENUE.eventsEmail)} or ${esc(VENUE.phone)}.`));
    }
    if (stored && stored.signed_link && stored.status !== 'awaiting') {
      res.writeHead(302, { Location: `/contract/${tokenFromLink(stored.signed_link)}`, 'Cache-Control': 'no-store' });
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
    const storedRow = getAgreementRow(c.id);
    if (storedRow && storedRow.status === 'void') return sendJson(res, 410, { ok: false, error: 'This agreement has been withdrawn. Please contact our events team.' });
    if (storedRow && storedRow.signed_link && storedRow.status !== 'awaiting') return sendJson(res, 200, { ok: true, signedUrl: `/contract/${tokenFromLink(storedRow.signed_link)}?signed=1` });
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
    const venueMail = AGREEMENT_EMAILS.signedVenue(c, signedData, signedLink);
    const clientMail = AGREEMENT_EMAILS.signedClient(c, signedData, signedLink);

    // The email to The Ivy is the permanent record, so the signature only
    // counts once that email has actually gone out.
    try {
      const venueResult = await sendEmail({
        to: VENUE.notifyTo,
        subject: venueMail.subject,
        text: venueMail.text,
        html: venueMail.html,
        replyTo: signedData.cl.email,
        attachments: [attachment],
      });
      if (venueResult.status < 200 || venueResult.status >= 300) throw new Error(`Resend status ${venueResult.status}`);
    } catch (err) {
      console.error('Agreement signed-notification email failed:', err.message);
      return sendJson(res, 502, { ok: false, error: 'We could not record your signature just now. Please try again in a minute, or call us.' });
    }

    signedById.set(c.id, signedToken);
    saveAgreement(c, {
      status: 'pending',
      signed_at: signedData.sig.at,
      signed_by: signedData.sig.name,
      signed_link: signedLink,
      company: signedData.cl.company || '',
      phone: signedData.cl.phone,
      email: signedData.cl.email,
      day_of_name: signedData.cl.dayName || null,
      day_of_phone: signedData.cl.dayPhone || null,
    });
    sendJson(res, 200, { ok: true, signedUrl: `/contract/${signedToken}?signed=1` });

    addToCalendar(c, signedData, signedLink);

    sendEmail({
      to: signedData.cl.email,
      subject: clientMail.subject,
      text: clientMail.text,
      html: clientMail.html,
      replyTo: VENUE.eventsEmail,
      attachments: [attachment],
    }).then((result) => {
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Resend status ${result.status}${result.body && result.body.message ? `: ${result.body.message}` : ''}`);
      }
    }).catch((err) => {
      console.error('Agreement client copy email error:', err.message);
      const alertMail = AGREEMENT_EMAILS.copyFailed(c, signedData.cl, signedLink, err.message);
      sendEmail({ to: VENUE.notifyTo, subject: alertMail.subject, text: alertMail.text, html: alertMail.html }).catch((mailErr) => console.error('Agreement client copy alert email error:', mailErr.message));
    });
  }

  // Builds the events-calendar entry for a signed agreement. `conf` is null
  // while the deposit is pending, { amount, receivedOn, method } once it has
  // been received (green, CONFIRMED), or { cancelledOn, note } when the event
  // is cancelled (gray, CANCELLED).
  function buildCalendarEvent(c, signedData, signedLink, conf) {
    const cancelled = !!(conf && conf.cancelledOn);
    const confirmed = !!(conf && !cancelled);
    const cl = signedData.cl;
    const t = computeTotals(c);
    const nextDay = (ymd) => new Date(Date.parse(ymd + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const endDay = c.end <= c.start ? nextDay(c.date) : c.date;
    const [sh, sm] = c.start.split(':').map((n) => parseInt(n, 10));
    const setupMins = (sh * 60 + sm - 30 + 1440) % 1440;
    const setupTime = fmtTime(`${String(Math.floor(setupMins / 60)).padStart(2, '0')}:${String(setupMins % 60).padStart(2, '0')}`);

    const statusLine = cancelled
      ? `CANCELLED ${fmtDateShort(conf.cancelledOn)}: any deposit paid is forfeited and nothing further is owed under the agreement.${conf.note ? ` Note: ${conf.note}` : ''}`
      : confirmed
        ? `CONFIRMED: deposit received ${fmtDateShort(conf.receivedOn)} (${fmtMoney(conf.amount)} by ${conf.method.toLowerCase()}). The agreement is in effect.`
        : `DEPOSIT PENDING: the date is not confirmed until the ${fmtMoney(t.deposit)} deposit is received (held through ${fmtDateShort(c.exp)}).`;

    const description = [
      statusLine,
      '',
      'EVENT',
      `${c.type}`,
      `${fmtDate(c.date)}`,
      `Setup: ${setupTime}  |  Start: ${fmtTime(c.start)}  |  End: ${fmtTime(c.end)}`,
      c.arrive ? `Guest arrival: ${fmtTime(c.arrive)}` : null,
      `Space: ${c.space}`,
      `Estimated guests: ${c.guests} (final guaranteed count due 7 days before)`,
      '',
      'CLIENT',
      `${c.name}${cl.company ? ` (${cl.company})` : ''}`,
      `Phone: ${cl.phone}`,
      `Email: ${cl.email}`,
      `Day-of contact: ${cl.dayName ? `${cl.dayName}${cl.dayPhone ? `, ${cl.dayPhone}` : ''}` : `same as client${cl.dayPhone ? `, ${cl.dayPhone}` : ''}`}`,
      '',
      'SELECTIONS',
      ...(c.lines.length
        ? c.lines.map((l) => `- ${l[1]} x ${l[0]} @ ${fmtMoney(l[2])} = ${fmtMoney(l[1] * l[2])}`)
        : ['- To be confirmed with the final guest count']),
      c.sel ? `Menu selections: ${c.sel}` : null,
      '',
      'PRICING',
      `Estimated food & beverage: ${fmtMoney(t.est)}`,
      t.min > 0 ? `Food & beverage minimum: ${fmtMoney(t.min)}` : null,
      `Deposit: ${fmtMoney(t.deposit)} (${cancelled ? 'cancelled' : confirmed ? `received ${fmtDateShort(conf.receivedOn)}` : 'pending'})`,
      `Estimated remaining balance: ${fmtMoney(t.remaining)} (before tax and service charge)`,
      `Estimated 20% service charge: ${fmtMoney(t.service)}`,
      'Tax and the 3% credit card surcharge are extra.',
      c.notes ? '' : null,
      c.notes ? 'NOTES & SPECIAL ARRANGEMENTS' : null,
      c.notes ? c.notes : null,
      '',
      'AGREEMENT',
      `${refOf(c)}, signed by ${signedData.sig.name} on ${fmtStamp(signedData.sig.at)}`,
      `Issued by: ${c.rep}`,
      `Signed agreement: ${signedLink}`,
    ].filter((line) => line !== null).join('\n');

    return {
      summary: `Private Event: ${c.name} (${c.guests} guests) [${cancelled ? 'CANCELLED' : confirmed ? 'CONFIRMED' : 'deposit pending'}]`,
      description,
      location: `${VENUE.name}, ${VENUE.address} (${c.space})`,
      colorId: cancelled ? '8' : confirmed ? '10' : '5',
      start: { dateTime: `${c.date}T${c.start}:00`, timeZone: 'America/Chicago' },
      end: { dateTime: `${endDay}T${c.end}:00`, timeZone: 'America/Chicago' },
      extendedProperties: { private: { agreementRef: refOf(c), agreementId: c.id, status: cancelled ? 'cancelled' : confirmed ? 'confirmed' : 'deposit-pending' } },
    };
  }

  // Puts the signed party on the events calendar. The event id is derived from
  // the agreement id, so signing twice can never create a duplicate. It is
  // titled "deposit pending" because the date is not confirmed until the
  // deposit arrives. A calendar failure never affects the signature; it just
  // emails the events team so they can add the party by hand.
  async function addToCalendar(c, signedData, signedLink) {
    if (!createCalendarEvent) return;
    try {
      await createCalendarEvent({ id: 'agr' + c.id, ...buildCalendarEvent(c, signedData, signedLink, null) });
    } catch (err) {
      console.error('Agreement calendar event error:', err.message);
      try {
        const alertMail = AGREEMENT_EMAILS.calendarAlert(c, signedLink, err.message);
        await sendEmail({ to: VENUE.notifyTo, subject: alertMail.subject, text: alertMail.text, html: alertMail.html });
      } catch (mailErr) {
        console.error('Agreement calendar alert email error:', mailErr.message);
      }
    }
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

    const createdMail = AGREEMENT_EMAILS.created(c, url);

    let recorded = true;
    try {
      const result = await sendEmail({
        to: VENUE.notifyTo,
        subject: createdMail.subject,
        text: createdMail.text,
        html: createdMail.html,
      });
      if (result.status < 200 || result.status >= 300) recorded = false;
    } catch (err) {
      console.error('Agreement record email error:', err.message);
      recorded = false;
    }
    saveAgreement(c, { status: 'awaiting', link: url });
    sendJson(res, 200, { ok: true, token, url, recorded });
  }

  async function handleAdminEmail(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }
    const data = open(body.token);
    if (!data || data.k !== 'offer') return sendJson(res, 400, { ok: false, error: 'That agreement link is not valid.' });
    const emailRow = getAgreementRow(data.c.id);
    if (emailRow && emailRow.status !== 'awaiting') return sendJson(res, 409, { ok: false, error: emailRow.status === 'void' ? 'This agreement was voided, so its link no longer works.' : 'This agreement has already been signed.' });
    const c = data.c;
    const url = urlFor(body.token);
    const mail = AGREEMENT_EMAILS.clientLink(c, url);
    try {
      const result = await sendEmail({
        to: c.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        replyTo: VENUE.eventsEmail,
      });
      if (result.status < 200 || result.status >= 300) return sendJson(res, 502, { ok: false, error: 'The email service rejected the message.' });
      saveAgreement(c, { emailed_at: new Date().toISOString() });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error('Agreement client email error:', err.message);
      sendJson(res, 502, { ok: false, error: 'Could not reach the email service.' });
    }
  }

  // ---- deposit confirmation (admin)

  // Accepts a full signed-agreement link or the bare token.
  function tokenFromLink(input) {
    const s = String(input || '').trim();
    const m = /\/contract\/([A-Za-z0-9_-]+)/.exec(s);
    return m ? m[1] : s.replace(/[?#].*$/, '');
  }

  // Best effort, resets on deploy: stops a double click from emailing the
  // client twice. Marking a deposit received is otherwise safe to repeat.
  const confirmedIds = new Set();

  async function handleAdminLookup(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }
    const data = open(tokenFromLink(body.link));
    if (!data) return sendJson(res, 400, { ok: false, error: 'That link is not valid. Paste the signed agreement link from the "Agreement Signed" email.' });
    if (data.k !== 'signed') return sendJson(res, 400, { ok: false, error: 'That agreement has not been signed yet.' });
    const c = data.c;
    const t = computeTotals(c);
    sendJson(res, 200, {
      ok: true,
      ref: refOf(c),
      name: c.name,
      email: data.cl.email,
      type: c.type,
      date: fmtDate(c.date),
      guests: c.guests,
      deposit: t.deposit,
      signedAt: fmtStamp(data.sig.at),
      alreadyConfirmed: confirmedIds.has(c.id),
    });
  }

  async function handleAdminConfirmDeposit(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    if (!hasResend()) return sendJson(res, 503, { ok: false, error: 'Email is not configured on the server.' });
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }

    const link = String(body.link || '').trim();
    const token = tokenFromLink(link);
    const data = open(token);
    if (!data || data.k !== 'signed') return sendJson(res, 400, { ok: false, error: 'That is not a valid signed agreement link.' });
    const c = data.c;
    const confirmRow = getAgreementRow(c.id);
    if (confirmedIds.has(c.id) || (confirmRow && confirmRow.status === 'confirmed')) return sendJson(res, 409, { ok: false, error: 'This deposit was already marked received. Check the calendar entry and the confirmation email.' });
    if (confirmRow && confirmRow.status === 'cancelled') return sendJson(res, 409, { ok: false, error: 'This agreement was cancelled, so a deposit cannot be confirmed.' });

    const amount = r2(body.amount);
    if (!(amount > 0 && amount <= 1000000)) return sendJson(res, 400, { ok: false, error: 'Enter the amount received.' });
    const receivedOn = cleanLine(body.receivedOn, 10);
    if (!validYmd(receivedOn) || receivedOn > chicagoToday()) return sendJson(res, 400, { ok: false, error: 'Enter the date the deposit was received (today or earlier).' });
    const methods = { 'credit card': 'Credit card', cash: 'Cash', check: 'Check', other: 'Other' };
    const method = methods[cleanLine(body.method, 20).toLowerCase()];
    if (!method) return sendJson(res, 400, { ok: false, error: 'Choose how the deposit was paid.' });
    const note = cleanText(body.note, 300);

    const conf = { amount, receivedOn, method };
    const t = computeTotals(c);
    const signedLink = urlFor(token);
    const deadline = fmtDate(new Date(Date.parse(c.date + 'T12:00:00Z') - 7 * 86400000).toISOString().slice(0, 10));

    const clientMail = AGREEMENT_EMAILS.depositClient(c, data, conf, signedLink, deadline);

    // Client confirmation first, so a failure here changes nothing else.
    try {
      const mail = await sendEmail({
        to: data.cl.email,
        subject: clientMail.subject,
        text: clientMail.text,
        html: clientMail.html,
        replyTo: VENUE.eventsEmail,
      });
      if (mail.status < 200 || mail.status >= 300) {
        throw new Error(`Resend status ${mail.status}${mail.body && mail.body.message ? `: ${mail.body.message}` : ''}`);
      }
    } catch (err) {
      console.error('Deposit confirmation email failed:', err.message);
      return sendJson(res, 502, { ok: false, error: `The confirmation email to ${data.cl.email} did not send, so nothing was changed. Check that the address is correct. (${err.message})` });
    }
    confirmedIds.add(c.id);
    saveAgreement(c, {
      status: 'confirmed',
      signed_link: signedLink,
      deposit_received: amount,
      deposit_received_on: receivedOn,
      deposit_method: method,
      deposit_note: note || null,
      confirmed_at: new Date().toISOString(),
    });

    // Calendar: update the pending entry; if it is missing, create the
    // confirmed one. Never fails the request, but reports what happened.
    let calendar = 'not configured';
    if (createCalendarEvent) {
      try {
        const event = buildCalendarEvent(c, data, signedLink, conf);
        const patched = updateCalendarEvent ? await updateCalendarEvent('agr' + c.id, event) : null;
        if (patched && patched.missing) {
          await createCalendarEvent(patched.missing === 404 ? { id: 'agr' + c.id, ...event } : event);
          calendar = 'created (no pending entry was found)';
        } else {
          calendar = 'updated to CONFIRMED';
        }
      } catch (err) {
        console.error('Deposit calendar update error:', err.message);
        calendar = `FAILED (${err.message.slice(0, 120)}). Please update the entry by hand.`;
      }
    }

    // Record email to the events team: the durable log of the confirmation.
    try {
      const recordMail = AGREEMENT_EMAILS.depositRecord(c, data, conf, note, calendar, signedLink);
      await sendEmail({ to: VENUE.notifyTo, subject: recordMail.subject, text: recordMail.text, html: recordMail.html });
    } catch (err) {
      console.error('Deposit record email error:', err.message);
    }

    sendJson(res, 200, { ok: true, emailed: data.cl.email, calendar });
  }

  // ---- agreements list (admin)
  //
  // The list is read from the agreements database. Signed parties that are on
  // the events calendar but missing from the database are added to it. Test
  // agreements (name contains "please ignore") are left out.

  function parseCalendarAgreement(e) {
    const p = (e.extendedProperties && e.extendedProperties.private) || {};
    if (!p.agreementRef || !e.start || !e.start.dateTime) return null;
    const desc = e.description || '';
    const pick = (re) => { const m = re.exec(desc); return m ? m[1].trim() : ''; };
    const sm = /^Private Event: (.+) \((\d+) guests\) \[/.exec(e.summary || '');
    const hold = /held through ([A-Za-z]+ \d{1,2}, \d{4})/.exec((desc.split('\n')[0]) || '');
    return {
      source: 'calendar',
      ref: p.agreementRef,
      status: p.status === 'confirmed' ? 'confirmed' : p.status === 'cancelled' ? 'cancelled' : 'pending',
      name: sm ? sm[1] : (e.summary || ''),
      guests: sm ? parseInt(sm[2], 10) : null,
      space: (e.location || '').replace(/^.*?\d{5} \(/, '').replace(/\)$/, ''),
      date: e.start.dateTime.slice(0, 10),
      start: e.start.dateTime.slice(11, 16),
      end: e.end && e.end.dateTime ? e.end.dateTime.slice(11, 16) : '',
      email: pick(/^Email: (.+)$/m),
      phone: pick(/^Phone: (.+)$/m),
      deposit: pick(/^Deposit: (\$[\d,.]+)/m),
      holdThrough: hold ? hold[1] : '',
      link: pick(/^Signed agreement: (\S+)/m),
    };
  }

  function handleAdminAgreementsPage(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    sendHtml(res, 200, agreementsPageHtml());
  }

  async function handleAdminAgreementsData(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    const warnings = [];
    const today = chicagoToday();

    let dbRows = [];
    if (db) {
      try {
        dbRows = db.prepare('SELECT * FROM agreements ORDER BY event_date, start_time').all().map((r) => ({
          source: 'database',
          ref: r.ref,
          status: r.status === 'awaiting' && r.hold_through && r.hold_through < today ? 'expired' : r.status,
          name: r.name || '',
          guests: r.guests,
          space: r.space || '',
          date: r.event_date,
          start: r.start_time || '',
          end: r.end_time || '',
          email: r.email || '',
          phone: r.phone || '',
          deposit: r.deposit != null ? fmtMoney(r.deposit) : '',
          holdThrough: r.hold_through ? fmtDateShort(r.hold_through) : '',
          link: r.signed_link || r.link || '',
        }));
      } catch (err) {
        console.error('Agreements list database error:', err.message);
        warnings.push('Could not read the agreements database.');
      }
    }

    // Signed parties on the calendar that are not in the database (for
    // example agreements signed before the database existed) are listed too.
    const known = new Set(dbRows.map((r) => r.ref));
    const calendarOnly = [];
    if (listCalendarEvents) {
      try {
        for (const status of ['deposit-pending', 'confirmed', 'cancelled']) {
          const items = await listCalendarEvents(`privateExtendedProperty=${encodeURIComponent(`status=${status}`)}&singleEvents=true&orderBy=startTime&maxResults=250`);
          for (const e of items) {
            const row = parseCalendarAgreement(e);
            if (row && !known.has(row.ref)) calendarOnly.push(row);
          }
        }
      } catch (err) {
        console.error('Agreements list calendar error:', err.message);
        warnings.push('Could not read the events calendar, so older signed agreements may be missing from this list.');
      }
    }

    const rows = dbRows.concat(calendarOnly).filter((r) => !/please ignore/i.test(r.name));
    sendJson(res, 200, { ok: true, today, rows, warnings });
  }

  async function handleAdminCancel(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }
    const token = tokenFromLink(body.link);
    const data = open(token);
    if (!data || data.k !== 'signed') return sendJson(res, 400, { ok: false, error: 'Only a signed agreement can be marked cancelled.' });
    const c = data.c;
    const cancelRow = getAgreementRow(c.id);
    if (cancelRow && cancelRow.status === 'cancelled') return sendJson(res, 409, { ok: false, error: 'This agreement is already marked cancelled.' });
    const conf = { cancelledOn: chicagoToday(), note: cleanText(body.note, 300) };
    const signedLink = urlFor(token);

    let calendar = 'not configured';
    if (createCalendarEvent) {
      try {
        const event = buildCalendarEvent(c, data, signedLink, conf);
        const patched = updateCalendarEvent ? await updateCalendarEvent('agr' + c.id, event) : null;
        if (patched && patched.missing) {
          await createCalendarEvent(patched.missing === 404 ? { id: 'agr' + c.id, ...event } : event);
          calendar = 'created as cancelled (no entry was found)';
        } else {
          calendar = 'updated to CANCELLED';
        }
      } catch (err) {
        console.error('Cancel calendar update error:', err.message);
        return sendJson(res, 502, { ok: false, error: `The calendar entry could not be updated, so nothing was changed. (${err.message.slice(0, 120)})` });
      }
    }
    saveAgreement(c, { status: 'cancelled', signed_link: signedLink, cancelled_at: new Date().toISOString(), cancel_note: conf.note || null });

    try {
      const cancelMail = AGREEMENT_EMAILS.cancelled(c, data, conf, calendar, signedLink);
      await sendEmail({ to: VENUE.notifyTo, subject: cancelMail.subject, text: cancelMail.text, html: cancelMail.html });
    } catch (err) {
      console.error('Cancel record email error:', err.message);
    }
    sendJson(res, 200, { ok: true, calendar });
  }

  // ---- void an unsigned agreement (admin)
  //
  // Marks an agreement that has not been signed as withdrawn. Its link stops
  // working immediately, which finally makes an issued agreement revocable.
  async function handleAdminVoid(req, res) {
    if (!checkBasicAuth(req)) return denyAdmin(res);
    let body;
    try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { ok: false, error: 'Invalid request.' }); }
    const data = open(tokenFromLink(body.link));
    if (!data || data.k !== 'offer') return sendJson(res, 400, { ok: false, error: 'Only an agreement that has not been signed can be voided. For a signed one, use Cancel.' });
    const c = data.c;
    const row = getAgreementRow(c.id);
    if (signedById.has(c.id) || (row && row.status !== 'awaiting')) {
      return sendJson(res, 409, { ok: false, error: row && row.status === 'void' ? 'This agreement is already voided.' : 'This agreement has already been signed, so it cannot be voided. Use Cancel instead.' });
    }
    const note = cleanText(body.note, 300);
    saveAgreement(c, { status: 'void', cancelled_at: new Date().toISOString(), cancel_note: note || null });
    try {
      const voidMail = AGREEMENT_EMAILS.voided(c, note);
      await sendEmail({ to: VENUE.notifyTo, subject: voidMail.subject, text: voidMail.text, html: voidMail.html });
    } catch (err) {
      console.error('Void record email error:', err.message);
    }
    sendJson(res, 200, { ok: true });
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

  return { handleView, handleSign, handleAdminPage, handleAdminCreate, handleAdminEmail, handleAdminLookup, handleAdminConfirmDeposit, handleAdminAgreementsPage, handleAdminAgreementsData, handleAdminCancel, handleAdminVoid, previewEmails, _buildCalendarEvent: buildCalendarEvent };
}

module.exports = {
  createContractHandlers,
  // Exposed so the rendering can be exercised without a server.
  _test: { documentHtml, offerPage, signedPage, adminPageHtml, agreementsPageHtml, computeTotals, termsFor, standaloneSignedHtml },
};
