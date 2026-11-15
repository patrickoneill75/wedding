/**
 * The wedding website, coded here instead of copied from Zola. It remakes the Zola site
 * (zola.com/wedding/patrickandkaitlyn2027) page for page, at the same sizes: the words
 * and photos are in src/website_content.js, the look below.
 *
 * Guests keep the Zola copy (src/site.js) until the Website page switches them over
 * (settings.web_live). Until then the coded site is a preview at /_new/ for anyone
 * signed in with the Website page. RSVP, the call page and the control panel are the
 * same either way.
 *
 * Pages: / (the names, date, place and countdown), /photo (the gallery), /travel (the
 * hotels), /faq, and /things-to-do (our guide, src/guide.js) while Settings publishes it.
 *
 * Control panel routes under /api/admin/website/* (the Website page):
 *   GET    website            whether guests see it, and its pages for the preview links
 *   PUT    website/settings   { live }
 */

import { currentUser, json } from "./auth.js";
import { setSetting } from "./db.js";
import { loadSettings } from "./store.js";
import { countdownEnd, RESERVED, RSVP_COLOR } from "./site.js";
import { GUIDE_CSS, guideBody } from "./guide.js";
import { FAQS, GALLERY, MENU, SITE, TRAVEL } from "./website_content.js";

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const PREVIEW_BASE = "/_new";

/* ------------------------------------------------------------------- routes ---- */

async function overview(env) {
  const s = await loadSettings(env);
  return {
    live: Boolean(s.web_live),
    preview: `${PREVIEW_BASE}/`,
    pages: MENU.map((m) => ({ path: `/${m.path}`, label: m.label, shown: !m.guide || Boolean(s.things_to_do_published) })),
  };
}

export async function handleWebsite(parts, method, request, env) {
  const [, section] = parts;
  if (!section && method === "GET") return json(await overview(env));
  if (section === "settings" && method === "PUT") {
    let input = {};
    try {
      input = (await request.json()) || {};
    } catch {}
    if (Object.prototype.hasOwnProperty.call(input, "live")) await setSetting(env, "web_live", input.live === true);
    return json(await overview(env));
  }
  return json({ error: "Not found." }, 404);
}

/* ---------------------------------------------------------------- the look ---- */

// Measured from the Zola site at 1440 px and 390 px wide. Radiograph comes from Zola's
// font server through /_site/fonts (src/site.js serveFont), as on the copy; Libre
// Baskerville from Google Fonts. The three lines down each side are drawn here.
const CSS = `
@font-face{font-family:'Radiograph';font-weight:400;font-style:normal;font-display:swap;src:url('/_site/fonts/Radiograph-Regular.otf') format('opentype')}
:root{--bg:#F5EFE8;--ink:#89645C;--line:#DBBBAA;--button:#89645C;--accent:${RSVP_COLOR};
--display:'Radiograph','Cormorant Garamond',Georgia,serif;--serif:'Libre Baskerville',Georgia,serif;--sans:system-ui,-apple-system,'Segoe UI',sans-serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body.web{margin:0;background:var(--bg);color:var(--ink);font:400 16px/1.6 var(--serif)}
.web a{color:inherit}
.skip{position:absolute;left:-999px;top:8px;background:#fff;color:#000;padding:8px 12px;border-radius:6px;z-index:50}.skip:focus{left:8px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.preview-note{background:#FFF4D6;color:#5A4300;border-bottom:1px solid #F0D27A;padding:10px 16px;font:14px/1.4 var(--sans);text-align:center}
.top{padding:20px 16px 0;text-align:center}
.names{margin:0;font:400 34px/1.6 var(--display);letter-spacing:4px;text-transform:uppercase}
.names a{text-decoration:none}
.menu{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px 24px;margin:29px 0 0;padding:0 0 3px}
.menu a{font:400 16px/1.6 var(--serif);text-decoration:none;padding:0 0 6px;border-bottom:3px solid transparent}
.menu a[aria-current="page"]{border-bottom-color:var(--ink)}
.menu a:hover{border-bottom-color:rgba(137,100,92,.35)}
.rsvp{display:inline-flex;align-items:center;justify-content:center;padding:11px 30px;border-radius:999px;background:var(--accent);color:#fff !important;text-decoration:none;font:600 15px/1 var(--sans);letter-spacing:1.8px;text-transform:uppercase}
.menu .rsvp{margin-left:16px;border-bottom:0;padding:11px 30px;font:600 15px/1 var(--sans)}
.frame{position:relative;min-height:calc(100vh - 154px)}
.frame::before,.frame::after{content:"";position:absolute;top:0;bottom:0;width:10%;pointer-events:none}
.frame::before{left:0;background:linear-gradient(to right,transparent 53.6%,var(--line) 53.6% 56.8%,transparent 56.8% 71.2%,var(--line) 71.2% 74.4%,transparent 74.4% 90.4%,var(--line) 90.4% 93.6%,transparent 93.6%)}
.frame::after{right:0;background:linear-gradient(to right,transparent 6.4%,var(--line) 6.4% 9.6%,transparent 9.6% 25.6%,var(--line) 25.6% 28.8%,transparent 28.8% 43.2%,var(--line) 43.2% 46.4%,transparent 46.4%)}
.inner{position:relative;z-index:1;width:min(956px,calc(80% - 32px));margin:0 auto}
.page-title{display:none;margin:0;text-align:center;font:400 24px/1.6 var(--display);letter-spacing:4px;text-transform:uppercase}
.hero{padding:155px 0 0;text-align:center}
.couple{margin:0;font:inherit;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:32px}
.couple .who{display:block;font:400 50px/1.6 var(--display);letter-spacing:4px;text-transform:uppercase}
.couple .who span{display:block}
.couple .left{text-align:right}.couple .right{text-align:left}
.couple .and{font:400 16px/1.6 var(--serif)}
.date{margin:160px 0 0;font:400 25px/1.6 var(--display);letter-spacing:4px}
.place{margin:24px 0 0}
.countdown{margin:38px 0 0;display:flex;justify-content:center;flex-wrap:wrap;gap:4px 16px}
.countdown .short{display:none}
.gallery{list-style:none;margin:0;padding:145px 0 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:27px 20px}
.gallery li{min-width:0;align-self:start}
.gallery button{display:block;width:100%;aspect-ratio:1;padding:0;border:0;border-radius:20px;overflow:hidden;background:#E9DDD3;cursor:zoom-in}
.gallery img{display:block;width:100%;height:100%;object-fit:cover}
.gallery button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.gallery .g1{grid-column:1/4;grid-row:1/4}
.gallery .g2{grid-column:4;grid-row:1}.gallery .g3{grid-column:4;grid-row:2}.gallery .g4{grid-column:4;grid-row:3}
.gallery .g5{grid-column:1;grid-row:4}.gallery .g6{grid-column:2;grid-row:4}
.gallery .g7{grid-column:1;grid-row:5}.gallery .g8{grid-column:2;grid-row:5}
.gallery .g9{grid-column:3/5;grid-row:4/6}
.lightbox{border:0;padding:0;background:transparent;width:100%;height:100%;max-width:none;max-height:none}
.lightbox::backdrop{background:rgba(40,28,25,.9)}
.lightbox .box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px}
.lightbox img{max-width:min(900px,100%);max-height:80vh;border-radius:12px}
.lightbox .row{display:flex;gap:12px}
.lightbox button{min-height:44px;padding:0 20px;border:1px solid #E2D3C9;border-radius:999px;background:transparent;color:#F5EFE8;font:15px var(--serif);cursor:pointer}
.lightbox button.close{position:fixed;top:max(16px,env(safe-area-inset-top,0px));right:max(16px,env(safe-area-inset-right,0px));width:48px;height:48px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center}
.lightbox button.close:hover{background:rgba(245,239,232,.14)}
.intro{width:min(699px,100%);margin:0 auto;padding:67px 0 0;text-align:center}
.hotels{list-style:none;margin:83px 0 0;padding:0}
.hotel{display:grid;grid-template-columns:minmax(0,430px) 1px minmax(0,430px);justify-content:center;align-items:center;column-gap:24px;margin:0 0 104px}
.hotel .rule{align-self:stretch;background:var(--ink)}
.hotel .what,.hotel .where{text-align:center;display:flex;flex-direction:column;align-items:center}
.hotel svg{display:block;width:64px;height:64px}
.hotel .kind{margin:55px 0 0}
.hotel h2{margin:11px 0 0;font:400 20px/1.6 var(--display);letter-spacing:4px;text-transform:uppercase}
.hotel address{font-style:italic}
.hotel .note{margin:27px 0 0}
.view{display:inline-flex;align-items:center;justify-content:center;width:200px;height:48px;margin:23px 0 0;border-radius:4px;background:var(--button);color:#fff !important;text-decoration:none;font:600 16px/1 var(--serif)}
.view:hover{filter:brightness(1.08)}
.faqs{padding:145px 0 0;text-align:center}
.faq{margin:0 0 59px}
.faq h2{margin:0;font:400 20px/1.6 var(--display);letter-spacing:4px;text-transform:uppercase}
.faq p{margin:12px 0 0}
.guide-wrap{padding:60px 0 0;--wm-text:var(--ink);--wm-font:var(--display);--wm-accent:var(--accent);--wm-bg:var(--bg)}
.guide-wrap .wm-guide{font-family:var(--serif);font-size:16px}
.guide-wrap .wm-guide h1{text-transform:uppercase;letter-spacing:4px;font-size:clamp(28px,4vw,40px)}
.foot{position:relative;z-index:1;padding:110px 16px 64px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:10px}
.foot p{margin:0;font:400 18px/1.4 var(--serif);letter-spacing:.72px}
.foot a{font:400 15px/1.4 var(--serif);letter-spacing:1.2px;text-transform:uppercase;text-underline-offset:4px}
.burger{position:fixed;top:12px;right:max(12px,env(safe-area-inset-right,0px));z-index:30;width:44px;height:44px;border:0;border-radius:50%;background:#fff;color:#21201F;box-shadow:0 2px 8px rgba(0,0,0,.15);display:none;align-items:center;justify-content:center;cursor:pointer}
.phone-rsvp{position:fixed;top:15px;left:max(12px,env(safe-area-inset-left,0px));z-index:30;padding:10px 18px;font-size:13px;display:none}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(300px,85vw);z-index:40;background:#fff;color:#21201F;padding:28px 40px;transform:translateX(100%);visibility:hidden;transition:transform .25s ease,visibility .25s;box-shadow:-8px 0 24px rgba(0,0,0,.12);overflow-y:auto}
.drawer.open{transform:none;visibility:visible}
.drawer .who{font:600 16px/1.5 var(--sans)}
.drawer .when{font:400 16px/1.5 var(--sans);color:#767676}
.drawer nav{display:flex;flex-direction:column;margin:48px 0 24px}
.drawer nav a{font:600 24px/1.5 var(--sans);text-decoration:none;color:#21201F;padding:12px 0}
.drawer nav a[aria-current="page"]{text-decoration:underline;text-underline-offset:6px}
.drawer .close{position:absolute;top:12px;right:12px;width:44px;height:44px;border:0;background:none;font-size:28px;line-height:1;cursor:pointer;color:#21201F}
.shade{position:fixed;inset:0;z-index:35;background:rgba(0,0,0,.25);display:none}
.shade.open{display:block}
@media (max-width:767px){
  .top{display:none}
  .burger,.phone-rsvp{display:inline-flex}
  .frame{min-height:100vh}
  .frame::before,.frame::after{width:5%}
  .inner{width:calc(100% - 78px)}
  .page-title{display:block;padding:91px 0 0}
  .hero{padding:72px 0 0}
  .couple{grid-template-columns:minmax(0,1fr);row-gap:6px}
  .couple .who{font-size:clamp(26px,8.2vw,34px);line-height:1.35;letter-spacing:3px}
  .couple .left,.couple .right{text-align:center}
  .couple .and{font-size:15px}
  .date{margin:44px 0 0;font-size:19px;letter-spacing:3px}
  .place{margin:12px 0 0}
  .countdown{margin:28px 0 0}
  .countdown .long{display:none}.countdown .short{display:inline}
  .gallery{padding:61px 0 0;grid-template-columns:minmax(0,1fr);gap:22px}
  .gallery li{grid-column:auto !important;grid-row:auto !important}
  .intro{padding:13px 0 0}
  .hotels{margin:32px 0 0}
  .hotel{grid-template-columns:minmax(0,1fr);margin:0 0 57px}
  .hotel .rule{display:none}
  .hotel h2{font-size:16px}
  .hotel .where address{margin:26px 0 0}
  .faqs{padding:61px 0 0}
  .faq{margin:0 0 60px}
  .faq h2{font-size:16px}
  .guide-wrap{padding:24px 0 0}
}
@media (prefers-reduced-motion:reduce){.drawer{transition:none}}`;

const FONTS = "https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Cormorant+Garamond:wght@400;500&display=swap";

const SCRIPT = `(function(){
var c=document.querySelector(".countdown[data-end]");
if(c){var end=Number(c.getAttribute("data-end")),L=c.querySelectorAll(".long"),S=c.querySelectorAll(".short"),u=[["day","d"],["hour","h"],["minute","min"],["second","s"]];
var tick=function(){var l=Math.max(0,Math.floor((end-Date.now())/1000)),v=[Math.floor(l/86400),Math.floor(l%86400/3600),Math.floor(l%3600/60),l%60];
for(var i=0;i<4;i++){if(L[i])L[i].textContent=v[i]+" "+u[i][0]+(v[i]===1?"":"s");if(S[i])S[i].textContent=v[i]+" "+u[i][1]}};tick();setInterval(tick,1000)}
var d=document.querySelector(".drawer"),sh=document.querySelector(".shade"),b=document.querySelector(".burger");
if(d&&b){var set=function(o){d.classList.toggle("open",o);sh.classList.toggle("open",o);b.setAttribute("aria-expanded",String(o));d.setAttribute("aria-hidden",String(!o));if(o)d.querySelector("nav a").focus()};
b.addEventListener("click",function(){set(true)});sh.addEventListener("click",function(){set(false)});d.querySelector(".close").addEventListener("click",function(){set(false);b.focus()});
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&d.classList.contains("open")){set(false);b.focus()}})}
var box=document.querySelector(".lightbox"),tiles=[].slice.call(document.querySelectorAll(".gallery button")),at=0;
if(box&&tiles.length){var img=box.querySelector("img");
var show=function(i){at=(i+tiles.length)%tiles.length;var t=tiles[at].querySelector("img");img.src=t.src;img.alt=t.alt};
tiles.forEach(function(t,i){t.addEventListener("click",function(){show(i);box.showModal()})});
box.querySelector(".prev").addEventListener("click",function(){show(at-1)});
box.querySelector(".next").addEventListener("click",function(){show(at+1)});
box.querySelector(".close").addEventListener("click",function(){box.close()});
box.addEventListener("keydown",function(e){if(e.key==="ArrowLeft")show(at-1);if(e.key==="ArrowRight")show(at+1)})}
})();`;

// A luggage cart under an arch, for each hotel (drawn here, in the site's brown).
const HOTEL_ICON = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
  + `<path d="M32 9v3"/><path d="M19 49V25a13 13 0 0 1 26 0v24"/><path d="M15 49h34"/><circle cx="21" cy="53" r="2.5"/><circle cx="43" cy="53" r="2.5"/>`
  + `<rect x="23" y="32" width="9" height="17" rx="1"/><path d="M25.5 32v-3h4v3"/><rect x="33.5" y="39" width="8" height="10" rx="1"/><path d="M36 39v-2h3v2"/></svg>`;

/* ---------------------------------------------------------------- the pages ---- */

const nameLines = (parts) => parts.map((p) => `<span>${escapeHtml(p)}</span>`).join("");

function home(s) {
  const end = countdownEnd(s);
  const units = ["day", "hour", "minute", "second"];
  return `<section class="hero"><h1 class="couple"><span class="who left">${nameLines(SITE.first)}</span><span class="and">and</span><span class="who right">${nameLines(SITE.second)}</span></h1>`
    + `<p class="date">${escapeHtml(SITE.date)}</p><p class="place">${escapeHtml(SITE.place)}</p>`
    + (end && end > Date.now()
      ? `<p class="countdown" data-end="${end}" role="timer" aria-label="Time until the wedding">${units.map((u) => `<span><span class="long">0 ${u}s</span><span class="short">0</span></span>`).join("")}</p>`
      : "")
    + `</section>`;
}

function gallery() {
  return `<h1 class="page-title">Gallery</h1><ul class="gallery">`
    + GALLERY.map((p, i) => `<li class="g${i + 1}"><button type="button" aria-label="Open photo ${i + 1}"><img src="${p.src}" alt="${escapeHtml(p.alt)}" width="1000" height="1000"${i > 0 ? ' loading="lazy"' : ""}></button></li>`).join("")
    + `</ul><dialog class="lightbox" aria-label="Photo"><div class="box"><img alt=""><div class="row">`
    + `<button type="button" class="prev">Previous</button><button type="button" class="next">Next</button></div></div>`
    + `<button type="button" class="close" aria-label="Close the photo"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></dialog>`;
}

function travel() {
  return `<h1 class="page-title">Travel</h1><p class="intro">${escapeHtml(TRAVEL.intro)}</p><ul class="hotels">`
    + TRAVEL.hotels.map((h) => `<li class="hotel"><div class="what">${HOTEL_ICON}<p class="kind">Hotel</p><h2>${escapeHtml(h.name)}</h2></div>`
      + `<span class="rule" aria-hidden="true"></span>`
      + `<div class="where"><address>${[...h.address, ...(h.phone ? [h.phone] : [])].map(escapeHtml).join("<br>")}</address>`
      + (h.note ? `<p class="note">${escapeHtml(h.note)}</p>` : "")
      + `<a class="view" href="${escapeHtml(h.url)}" target="_blank" rel="noopener">View<span class="sr"> ${escapeHtml(h.name)}</span></a></div></li>`).join("")
    + `</ul>`;
}

function faq() {
  return `<h1 class="page-title">FAQs</h1><div class="faqs">${FAQS.map((f) => `<div class="faq"><h2>${escapeHtml(f.q)}</h2><p>${escapeHtml(f.a)}</p></div>`).join("")}</div>`;
}

function guide(s) {
  return `<div class="guide-wrap"><main class="wm-guide">${guideBody({ weddingDate: s.wedding_date })}</main></div>`;
}

const PAGES = { "": home, photo: gallery, travel, faq, "things-to-do": guide };

/**
 * One page of the coded site (`path` one of PAGES' keys, or null for not found). `base`
 * is "" live or PREVIEW_BASE in the preview.
 */
export function renderWebPage({ path, s, base = "", preview = false, guideHidden = false }) {
  const found = path !== null && Object.prototype.hasOwnProperty.call(PAGES, path);
  const menu = MENU.filter((m) => !m.guide || s.things_to_do_published || (guideHidden && path === m.path));
  const href = (p) => `${base}/${p}`;
  const links = menu.map((m) => `<a href="${href(m.path)}"${found && m.path === path ? ' aria-current="page"' : ""}>${escapeHtml(m.label)}</a>`).join("");
  const rsvp = s.rsvp_open ? `<a class="rsvp" href="/rsvp/">RSVP</a>` : "";
  const label = found ? MENU.find((m) => m.path === path)?.label : "Not found";
  const main = found ? PAGES[path](s) : `<div class="faqs"><div class="faq"><h1 style="margin:0;font:400 20px/1.6 var(--display);letter-spacing:4px;text-transform:uppercase">This page isn't here</h1><p><a href="${href("")}">Go to the home page</a></p></div></div>`;
  const accent = /^#[0-9a-f]{6}$/i.test(s.rsvp_button_color) ? s.rsvp_button_color : RSVP_COLOR;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${path === "" ? "" : `${escapeHtml(label)} · `}${escapeHtml(SITE.header)}</title>
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${CSS}:root{--accent:${accent}}${path === "things-to-do" ? GUIDE_CSS : ""}</style>
</head><body class="web">
<a class="skip" href="#main">Skip to the page</a>
${preview ? `<div class="preview-note"><b>Preview of the new website.</b> ${s.web_live ? "Guests see it too." : "Guests still see the Zola copy until you switch them in the control panel's Website page."}${guideHidden ? " Things to Do is hidden from guests until Settings publishes it." : ""}</div>` : ""}
<header class="top"><p class="names"><a href="${href("")}">${escapeHtml(SITE.header)}</a></p><nav class="menu" aria-label="Site">${links}${rsvp}</nav></header>
<button type="button" class="burger" aria-label="Menu" aria-expanded="false" aria-controls="drawer"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
${rsvp ? rsvp.replace('class="rsvp"', 'class="rsvp phone-rsvp"') : ""}
<div class="shade"></div>
<aside class="drawer" id="drawer" aria-hidden="true" aria-label="Menu"><button type="button" class="close" aria-label="Close the menu">×</button>
<div class="who">${escapeHtml(SITE.header)}</div><div class="when">${escapeHtml(SITE.date)}</div><div class="when">${escapeHtml(SITE.place)}</div>
<nav aria-label="Site">${links}</nav>${rsvp}</aside>
<div class="frame"><div class="inner" id="main">${main}</div>
<footer class="foot"><p>${escapeHtml(SITE.footer)}</p>${s.contact_email ? `<a href="mailto:${escapeHtml(s.contact_email)}">Contact us</a>` : ""}</footer></div>
<script>${SCRIPT}</script>
</body></html>`;
}

/**
 * A page of the coded site, or null to let the request fall through (live mode, for our
 * own paths like /rsvp/). Live: anyone. Preview (/_new/...): signed in with the Website page.
 */
export async function serveWebsite(env, request, { preview = false } = {}) {
  const url = new URL(request.url);
  let path = preview ? url.pathname.slice(PREVIEW_BASE.length) : url.pathname;
  path = path.replace(/\/index\.html$/, "/").replace(/^\/+|\/+$/g, "");
  let admin = false;
  if (preview) {
    const user = await currentUser(request, env);
    if (!user || !(user.role === "admin" || user.pages.includes("website"))) return notFound();
    admin = true;
  }
  // Our own paths (the RSVP page, the control panel...) are never pages of the site.
  if (!preview && path && ((RESERVED.has(path) && path !== "things-to-do") || !/^[a-z0-9-]+$/.test(path))) return null;
  const s = await loadSettings(env);
  let known = Object.prototype.hasOwnProperty.call(PAGES, path);
  let guideHidden = false;
  if (path === "things-to-do" && !s.things_to_do_published) {
    // Hidden: a signed-in admin still previews it, as on the Zola copy (src/guide.js).
    if (!admin) admin = (await currentUser(request, env))?.role === "admin";
    if (admin) guideHidden = true;
    else known = false;
  }
  const html = renderWebPage({ path: known ? path : null, s, base: preview ? PREVIEW_BASE : "", preview: preview || guideHidden, guideHidden });
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "x-robots-tag": "noindex",
    "cache-control": preview || guideHidden ? "private, no-store" : "public, max-age=60",
  };
  return new Response(request.method.toUpperCase() === "HEAD" ? null : html, { status: known ? 200 : 404, headers });
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
