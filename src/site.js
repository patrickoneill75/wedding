/**
 * The public home page: a copy of the couple's Zola wedding website, refreshed once a
 * day (and on demand from Settings), with Zola's branding stripped and an RSVP button
 * added. Mounted at "/" and at one path per Zola page ("/photo", "/travel", ...); the
 * RSVP page itself lives at /rsvp/.
 *
 * How a refresh works (refreshSite):
 *   1. Fetch the Zola home page, find its own menu links (/wedding/<slug>/<page>), and
 *      fetch each of those pages too. "rsvp" maps to our RSVP page and "registry"
 *      stays a link to Zola, so neither is copied.
 *   2. Clean each page (cleanPage): drop every script (no Zola app, no trackers), Zola's
 *      account bar (.unified-nav) and its footer, point the site's own links at the
 *      copies, turn Zola's script-driven "View" buttons into real links (to the place's
 *      website from Zola's page data, else to its address on Google Maps), keep Zola's
 *      stylesheets and images (they load from Zola's CDN), inline
 *      the @font-face rules for the fonts the page uses (served through /_site/fonts/),
 *      keep the countdown ticking with a few lines of our own script, and add a top bar
 *      with the RSVP pill. Zola's phone menu only opens through its app, so the bar also
 *      carries our own Menu button, shown whenever the site's own menu links are hidden
 *      (checked in the browser, not by guessing Zola's breakpoints).
 *   3. Store each page in D1 (site_pages). A page's changed_at only moves when its
 *      content actually changed; the countdown is left out of that comparison.
 *
 * Zola's class names are generated (css-1a2b3c) and change whenever Zola redeploys, so
 * nothing here depends on them. The footer is found by its text instead: the smallest
 * element holding both "Zola, Inc." and "About Zola". If that ever stops matching,
 * the page is still copied and Settings shows a warning.
 *
 * Status lives in settings._site_status: { checked_at, changed_at, error, error_at,
 * warnings, pages: [{ path, title, changed_at }] }.
 */

import { all, first, getSetting, run, setSetting } from "./db.js";
import { DEFAULT_SETTINGS } from "./calc.js";

const ZOLA_ORIGIN = "https://www.zola.com";
const ZOLA_CDN = "https://d1tntvpcrzvon2.cloudfront.net";
const FONTS_CSS = `${ZOLA_CDN}/static-assets/fonts/stylesheets/fonts.css`;
const MAX_PAGES = 15;
// Paths the copy can never take over.
const RESERVED = new Set(["admin", "api", "rsvp", "submit", "_site", "favicon.svg"]);
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/* ------------------------------------------------------------------ HTML tree --
 * A small, forgiving HTML parser. Zola's pages are server-rendered React, so the markup
 * is well formed; this only needs void elements, raw-text elements, comments and both
 * quote styles. Attribute values are kept exactly as written (entities and all).
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

export function parseHtml(html) {
  const root = { type: "el", tag: "#root", attrs: [], children: [], parent: null };
  let node = root;
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=\/>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m;
  const text = (t) => {
    if (t) node.children.push({ type: "text", text: t, parent: node });
  };
  while ((m = tagRe.exec(html))) {
    text(html.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      // Close up to the matching open element; ignore a stray close tag.
      let n = node;
      while (n !== root && n.tag !== tag) n = n.parent;
      if (n !== root) node = n.parent;
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const el = { type: "el", tag, attrs: parseAttrs(m[3] || ""), children: [], parent: node, selfClosing: Boolean(m[4]) };
      node.children.push(el);
      if (RAW_TEXT.has(tag) && !el.selfClosing) {
        const end = html.toLowerCase().indexOf(`</${tag}`, last);
        const stop = end < 0 ? html.length : end;
        if (stop > last) el.children.push({ type: "text", text: html.slice(last, stop), parent: el, raw: true });
        const close = end < 0 ? html.length : html.indexOf(">", end) + 1;
        last = tagRe.lastIndex = close;
      } else if (!VOID.has(tag) && !el.selfClosing) {
        node = el;
      }
    } else {
      node.children.push({ type: "raw", text: m[0], parent: node });
    }
  }
  text(html.slice(last));
  return root;
}

function parseAttrs(source) {
  const attrs = [];
  const re = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m;
  while ((m = re.exec(source))) attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
  return attrs;
}

export function serialize(node) {
  if (node.type === "text" || node.type === "raw") return node.text;
  const inner = node.children.map(serialize).join("");
  if (node.tag === "#root") return inner;
  const attrs = node.attrs
    .map(([k, v]) => (v === null ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, "&quot;")}"`))
    .join("");
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}/>`;
  if (node.selfClosing && !node.children.length) return `<${node.tag}${attrs}/>`;
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

export const attr = (el, name) => el.attrs.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
function setAttr(el, name, value) {
  const hit = el.attrs.find(([k]) => k.toLowerCase() === name);
  if (hit) hit[1] = value;
  else el.attrs.push([name, value]);
}
function removeAttr(el, name) {
  el.attrs = el.attrs.filter(([k]) => k.toLowerCase() !== name);
}

function* walk(node) {
  yield node;
  if (node.children) for (const child of [...node.children]) yield* walk(child);
}
function elements(root, test) {
  const out = [];
  for (const n of walk(root)) if (n.type === "el" && test(n)) out.push(n);
  return out;
}
function remove(node) {
  if (!node.parent) return;
  node.parent.children = node.parent.children.filter((c) => c !== node);
  node.parent = null;
}
export function textOf(node) {
  if (node.type === "text") return node.raw ? "" : node.text;
  if (node.type !== "el" || node.tag === "script" || node.tag === "style") return "";
  if (node.tag === "br") return "\n";
  return node.children.map(textOf).join("");
}
const decode = (t) =>
  t.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const el = (tag, attrs, children = []) => {
  const node = { type: "el", tag, attrs: Object.entries(attrs), children: [], parent: null };
  for (const c of children) append(node, typeof c === "string" ? { type: "text", text: c } : c);
  return node;
};
function append(parent, child, atStart = false) {
  child.parent = parent;
  if (atStart) parent.children.unshift(child);
  else parent.children.push(child);
}
const find = (root, tag) => elements(root, (n) => n.tag === tag)[0] || null;

/* --------------------------------------------------------------- page clean-up -- */

/** "/wedding/<slug>/travel" -> "travel"; the home page -> ""; anything else -> null. */
export function zolaPageKey(href, slug) {
  if (!href) return null;
  const m = /^(?:https?:\/\/(?:www\.)?zola\.com)?\/wedding\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#].*)?$/i.exec(href.trim());
  if (!m || m[1].toLowerCase() !== slug.toLowerCase()) return null;
  return (m[2] || "").toLowerCase();
}

/** Where a Zola page link should point on our site. */
export function localPathFor(key, slug) {
  if (key === "") return "/";
  if (key === "rsvp") return "/rsvp/";
  if (key === "registry" || RESERVED.has(key) || !/^[a-z0-9-]+$/.test(key)) return `${ZOLA_ORIGIN}/wedding/${slug}/${key}`;
  return `/${key}`;
}

/** The theme's most-used font, for our menu. */
function themeFont(html) {
  const tally = new Map();
  for (const m of html.matchAll(/font-family:\s*(?:&#x27;|')([^&']+)(?:&#x27;|')/gi)) tally.set(m[1], (tally.get(m[1]) || 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** The colors the theme leans on: its most-used text color and the page background. */
export function themeColors(html) {
  const count = (re) => {
    const tally = new Map();
    for (const m of html.matchAll(re)) tally.set(m[1].toLowerCase(), (tally.get(m[1].toLowerCase()) || 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  };
  const text = count(/[;"\s]color:\s*(#[0-9a-f]{6})\b/gi)[0] || "#5f5850";
  const background = count(/background-color:\s*(#[0-9a-f]{6})\b/gi).find((c) => c !== text) || "#ffffff";
  return { text, background };
}

const hexToHsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};

/**
 * The RSVP pill's color: the theme's text hue turned to the opposite side of the color
 * wheel, deep enough for white text. A warm mauve theme gets a deep teal pill.
 */
export function contrastingColor(themeText) {
  const [h, s] = hexToHsl(themeText);
  const hue = Math.round((h + 180) % 360);
  const sat = Math.round(Math.min(Math.max(s, 0.35), 0.55) * 100);
  return `hsl(${hue} ${sat}% 30%)`;
}

// Countdown ticking, our phone menu, and hiding Zola's dead menu icon.
const PAGE_SCRIPT = `(function(){var L=[["day","d"],["hour","h"],["minute","min"],["second","s"]];
function tick(){document.querySelectorAll("[data-wm-target]").forEach(function(box){
var left=Math.max(0,Math.floor((Number(box.getAttribute("data-wm-target"))-Date.now())/1000));
var v=[Math.floor(left/86400),Math.floor(left%86400/3600),Math.floor(left%3600/60),left%60];
var units=[];box.querySelectorAll("span").forEach(function(s){if(s.children.length>=2)units.push(s)});
units.slice(0,4).forEach(function(u,i){u.children[0].textContent=v[i]+" "+L[i][0]+(v[i]===1?"":"s");u.children[1].textContent=v[i]+" "+L[i][1]})})}
if(document.querySelector("[data-wm-target]")){tick();setInterval(tick,1000)}
var bar=document.querySelector(".wm-rsvp-bar"),btn=document.querySelector(".wm-menu-btn"),menu=document.getElementById("wm-menu");
function navShown(){return [].some.call(document.querySelectorAll("a[data-wm-nav]"),function(a){var r=a.getBoundingClientRect();return r.width>0&&r.height>0})}
var pill=document.querySelector(".wm-rsvp");
function menuRow(){var links=[].filter.call(document.querySelectorAll('a[data-wm-nav="menu"]'),function(a){var r=a.getBoundingClientRect();return r.width>0&&r.height>0});if(!links.length)return null;
var box=links[0].parentElement;while(box&&!links.every(function(a){return box.contains(a)}))box=box.parentElement;
while(box&&box.parentElement&&box.parentElement!==document.body&&box.getBoundingClientRect().width<document.documentElement.clientWidth*0.8)box=box.parentElement;
return box?{box:box,link:links[0]}:null}
function layout(){var phone=!navShown();bar.classList.toggle("wm-phone",phone);if(!phone)close();
var row=phone?null:menuRow();
if(row){if(getComputedStyle(row.box).position==="static")row.box.style.position="relative";
var lr=row.link.getBoundingClientRect(),br=row.box.getBoundingClientRect();pill.classList.add("wm-in-nav");pill.style.top=(lr.top+lr.height/2-br.top)+"px";row.box.appendChild(pill);bar.style.display="none"}
else{pill.classList.remove("wm-in-nav");pill.style.top="";bar.insertBefore(pill,menu);bar.style.display=""}}
function close(){menu.hidden=true;btn.setAttribute("aria-expanded","false")}
btn.addEventListener("click",function(){var open=menu.hidden;menu.hidden=!open;btn.setAttribute("aria-expanded",String(open))});
document.addEventListener("keydown",function(e){if(e.key==="Escape")close()});
document.querySelectorAll("svg path").forEach(function(p){if(/^M21\\.882 4a1\\.618/.test(p.getAttribute("d")||"")){var box=p.closest("svg").parentElement;if(box)box.style.display="none"}});
layout();addEventListener("resize",layout)})();`;

/**
 * Clean one Zola page. Returns { html, title, hashSource, warnings }; hashSource is the
 * page with the countdown blanked, for change detection.
 */
export function cleanPage(source, { slug, pages, fetchedAt = Date.now(), rsvpColor = "", fontCss = "", currentPath = "/" }) {
  const root = parseHtml(source);
  const warnings = [];
  const html = find(root, "html");
  const head = find(root, "head");
  const body = find(root, "body");
  if (!head || !body) throw new Error("That doesn't look like a Zola page (no <head> or <body>).");

  // Zola's page data, read before its <script> goes: names -> websites for "View" buttons.
  const links = linksFromPageData(root);

  // 1. No Zola app, analytics, preloads or Zola icons.
  for (const n of elements(root, (n) => ["script", "noscript", "iframe"].includes(n.tag) && !(n.tag === "iframe" && /google\.com\/maps|maps\.google/.test(attr(n, "src") || "")))) remove(n);
  const dropRel = /^(preload|prefetch|preconnect|dns-prefetch|modulepreload|manifest|icon|shortcut icon|apple-touch-icon|canonical|alternate)$/i;
  for (const n of elements(head, (n) => n.tag === "link" && dropRel.test(attr(n, "rel") || ""))) remove(n);
  for (const n of elements(head, (n) => n.tag === "meta" && /^(twitter:site|og:url|og:image|apple-itunes-app|al:|fb:)/i.test(attr(n, "name") || attr(n, "property") || ""))) remove(n);

  // 2. Zola's own account bar.
  for (const n of elements(body, (n) => (attr(n, "class") || "").split(/\s+/).includes("unified-nav"))) remove(n);

  // 3. Zola's footer: the smallest element holding both its copyright and "About Zola".
  const footer = findZolaFooter(body);
  if (footer) {
    let gone = footer;
    // Take wrappers that held nothing else with it, so no empty band is left behind.
    while (gone.parent && gone.parent !== body && isOnlyContent(gone.parent, gone)) gone = gone.parent;
    remove(gone);
  } else {
    warnings.push("Couldn't find Zola's footer to remove it. Zola may have changed its page layout.");
  }

  // 4. Links: the site's own pages point at our copies; anything else relative goes to Zola.
  for (const n of elements(body, (n) => n.tag === "a" && attr(n, "href"))) {
    const href = attr(n, "href");
    const key = zolaPageKey(href, slug);
    if (key !== null) {
      setAttr(n, "href", key === "" || key === "rsvp" || pages.has(key) ? localPathFor(key, slug) : `${ZOLA_ORIGIN}/wedding/${slug}/${key}`);
      removeAttr(n, "target");
    } else if (href.startsWith("/") && !href.startsWith("//")) {
      setAttr(n, "href", ZOLA_ORIGIN + href);
    }
  }
  for (const n of elements(root, (n) => n.tag !== "a")) {
    for (const name of ["src", "href", "poster"]) {
      const v = attr(n, name);
      if (v && v.startsWith("/") && !v.startsWith("//")) setAttr(n, name, ZOLA_ORIGIN + v);
    }
  }

  // The site's menu, in order, from its own links to its pages (for our phone menu).
  // A link inside a list (the menu) names a page better than, say, the site title
  // linking home ("Sam & Alex" vs "Home").
  const nav = [];
  const inList = (n) => { for (let p = n.parent; p; p = p.parent) if (p.tag === "ul" || p.tag === "nav") return true; return false; };
  for (const n of elements(body, (n) => n.tag === "a")) {
    const href = attr(n, "href") || "";
    const label = decode(textOf(n)).replace(/\s+/g, " ").trim();
    if (!label || !(href === "/" || /^\/[a-z0-9-]+$/.test(href))) continue;
    const listed = inList(n);
    // "menu" marks the links in the site's menu row, where the RSVP pill goes.
    setAttr(n, "data-wm-nav", listed ? "menu" : "");
    const seen = nav.find((x) => x.href === href);
    if (!seen) nav.push({ href, label, listed });
    else if (listed && !seen.listed) Object.assign(seen, { label, listed });
  }

  // 4b. "View" buttons only worked through Zola's app: make them links.
  for (const button of elements(body, (n) => n.tag === "button" && /^\s*view\s*$/i.test(decode(textOf(n))))) {
    const href = viewTarget(button, links);
    if (!href) {
      remove(button);
      continue;
    }
    const link = el("a", { class: attr(button, "class") || "", href, target: "_blank", rel: "noopener noreferrer",
      style: `${attr(button, "style") || ""};display:inline-block;text-decoration:none;cursor:pointer` });
    for (const c of button.children) append(link, c);
    const siblings = button.parent.children;
    siblings[siblings.indexOf(button)] = link;
    link.parent = button.parent;
  }

  // 5. Countdown: remember when it ends, so our script keeps it ticking.
  let countdown = elements(body, (n) => attr(n, "data-testid") === "WeddingCountdown")[0] || null;
  if (countdown) {
    const t = decode(textOf(countdown));
    const unit = (re) => Number((re.exec(t) || [0, 0])[1]);
    const seconds = unit(/(\d+)\s*days?/i) * 86400 + unit(/(\d+)\s*hours?/i) * 3600 + unit(/(\d+)\s*minutes?/i) * 60 + unit(/(\d+)\s*seconds?/i);
    if (seconds > 0) setAttr(countdown, "data-wm-target", String(fetchedAt + seconds * 1000));
    else countdown = null;
  }

  // 6. Our additions to <head>: our icon, the theme's fonts, the RSVP pill's style.
  const colors = themeColors(source);
  const pill = rsvpColor || contrastingColor(colors.text);
  append(head, el("link", { rel: "icon", href: "/favicon.svg" }));
  if (fontCss) append(head, el("style", { "data-wm": "fonts" }, [fontCss]));
  const font = themeFont(source);
  append(head, el("style", { "data-wm": "rsvp" }, [
    `html,body{background:${colors.background}}`
    // For the footer servePage adds: the theme's text color and font.
    + `:root{--wm-text:${colors.text};--wm-font:${font ? `'${font}',` : ""}Georgia,serif}`
    + `.wm-rsvp-bar{position:sticky;top:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 16px;background:${colors.background}}`
    + `.wm-menu-btn{display:none;align-items:center;gap:8px;margin-right:auto;padding:9px 14px;border:1px solid ${colors.text}55;border-radius:999px;background:transparent;color:${colors.text};`
    + `font:500 15px/1 ${font ? `'${font}',` : ""}Georgia,serif;cursor:pointer}`
    + `.wm-menu-btn svg{width:18px;height:18px}`
    + `.wm-phone .wm-menu-btn{display:inline-flex}`
    + `.wm-phone{justify-content:space-between}`
    + `#wm-menu{position:absolute;left:0;right:0;top:100%;background:${colors.background};border-bottom:1px solid ${colors.text}33;box-shadow:0 12px 24px rgba(0,0,0,.08);padding:6px 16px 14px}`
    + `#wm-menu a{display:block;padding:12px 4px;color:${colors.text};text-decoration:none;font:400 18px/1.3 ${font ? `'${font}',` : ""}Georgia,serif;border-bottom:1px solid ${colors.text}1f}`
    + `#wm-menu a:last-child{border-bottom:0}#wm-menu a[aria-current]{font-weight:700}`
    + `.wm-rsvp{display:inline-block;padding:11px 30px;border-radius:999px;background:${pill};color:#fff;`
    + `font:600 15px/1 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;`
    + `box-shadow:0 2px 10px rgba(0,0,0,.15);transition:transform .15s ease,box-shadow .15s ease}`
    + `.wm-rsvp:hover,.wm-rsvp:focus-visible{transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,.2);color:#fff}`
    + `.wm-rsvp:focus-visible{outline:3px solid ${pill};outline-offset:3px}`
    // On a wide screen the pill sits at the right end of the site's menu row.
    + `.wm-rsvp.wm-in-nav{position:absolute;right:24px;transform:translateY(-50%);z-index:5}`
    + `.wm-rsvp.wm-in-nav:hover,.wm-rsvp.wm-in-nav:focus-visible{transform:translateY(calc(-50% - 1px))}`,
  ]));

  // 7. The top bar, first thing on the page: our phone menu and the RSVP pill.
  const menuIcon = el("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round" },
    [el("path", { d: "M3 6h18M3 12h18M3 18h18" })]);
  append(body, el("div", { class: "wm-rsvp-bar" }, [
    el("button", { type: "button", class: "wm-menu-btn", "aria-expanded": "false", "aria-controls": "wm-menu" }, [menuIcon, "Menu"]),
    el("a", { class: "wm-rsvp", href: "/rsvp/" }, ["RSVP"]),
    el("nav", { id: "wm-menu", "aria-label": "Site", hidden: null }, nav.map((item) =>
      el("a", { href: item.href, ...(item.href === currentPath ? { "aria-current": "page" } : {}) }, [item.label]))),
  ]), true);
  append(body, el("script", {}, [PAGE_SCRIPT]));

  if (html) setAttr(html, "lang", attr(html, "lang") || "en");
  const leftover = (decode(textOf(body)).match(/zola/gi) || []).length;
  if (leftover) warnings.push(`The word "Zola" still appears ${leftover} time${leftover === 1 ? "" : "s"} on this page.`);

  // Change detection ignores the countdown, whose text moves every second.
  let hashSource;
  if (countdown) {
    const saved = countdown.children;
    const target = attr(countdown, "data-wm-target");
    countdown.children = [];
    removeAttr(countdown, "data-wm-target");
    hashSource = serialize(root);
    countdown.children = saved;
    setAttr(countdown, "data-wm-target", target);
  } else {
    hashSource = serialize(root);
  }
  const titleEl = find(root, "title");
  const title = titleEl ? decode(titleEl.children.map((c) => c.text || "").join("")).trim() : "";
  return { html: `<!DOCTYPE html>${serialize(root).replace(/^<!DOCTYPE[^>]*>/i, "")}`, title, hashSource, warnings };
}

/** Every { name, url } in Zola's __NEXT_DATA__ (hotels, places, registries...). */
function linksFromPageData(root) {
  const byName = new Map();
  const data = elements(root, (n) => n.tag === "script" && attr(n, "id") === "__NEXT_DATA__")[0];
  if (!data) return byName;
  let json;
  try {
    json = JSON.parse(data.children.map((c) => c.text).join(""));
  } catch {
    return byName;
  }
  const visit = (o, depth) => {
    if (!o || depth > 12) return;
    if (Array.isArray(o)) return o.forEach((v) => visit(v, depth + 1));
    if (typeof o !== "object") return;
    if (typeof o.name === "string" && typeof o.url === "string" && /^https?:\/\//i.test(o.url)) {
      byName.set(o.name.trim().toLowerCase(), o.url);
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(json?.props?.pageProps?.pageData, 0);
  return byName;
}

/**
 * Where a "View" button should go: the website of the place named in its card, else
 * the card's address on a map. The card is the largest box around the button that
 * holds no other "View" button, so a place without a website never borrows its
 * neighbor's. Names are tried first because the address sits in a smaller box.
 */
function viewTarget(button, links) {
  const isView = (n) => n.type === "el" && (n.tag === "button" || n.tag === "a") && /^\s*view\s*$/i.test(decode(textOf(n)));
  let address = null;
  let card = button.parent;
  for (let depth = 0; card && depth < 8; depth++, card = card.parent) {
    if (elements(card, isView).length > 1) break; // climbed out of this card
    const text = decode(textOf(card)).toLowerCase();
    const names = [...links.keys()].filter((name) => text.includes(name));
    if (names.length === 1) return links.get(names[0]);
    if (!address) address = elements(card, (n) => n.tag === "address")[0] || null;
  }
  if (!address) return null;
  const where = decode(textOf(address)).replace(/\s*\n\s*/g, ", ").replace(/\s+/g, " ").trim();
  return where ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}` : null;
}

function findZolaFooter(body) {
  const nodes = [...walk(body)];
  const copyright = nodes.find((n) => n.type === "text" && !n.raw && /Zola,\s*Inc\./i.test(n.text));
  const about = nodes.find((n) => n.type === "el" && n.tag === "a" && /^\s*About Zola\s*$/i.test(decode(textOf(n))));
  if (!copyright || !about) return null;
  const ancestors = new Set();
  for (let n = copyright; n; n = n.parent) ancestors.add(n);
  for (let n = about; n; n = n.parent) if (ancestors.has(n)) return n === body ? null : n;
  return null;
}

/** True when `parent` holds nothing visible besides `child`. */
function isOnlyContent(parent, child) {
  return parent.children.every((c) => c === child || (c.type === "text" && !c.text.trim()) || c.type === "raw");
}

/** The @font-face rules from Zola's font stylesheet for the families this page uses. */
export function fontFacesFor(fontsCss, pageHtml) {
  const used = new Set();
  for (const m of pageHtml.matchAll(/font-family:\s*(?:&#x27;|&#39;|'|&quot;|")([^&'";]+)/gi)) used.add(m[1].trim().toLowerCase());
  const rules = [];
  for (const m of fontsCss.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
    const family = /font-family:\s*['"]?([^'";]+)/i.exec(m[0]);
    if (family && used.has(family[1].trim().toLowerCase())) {
      rules.push(m[0].replace(/https:\/\/d1tntvpcrzvon2\.cloudfront\.net\/static-assets\/fonts\//g, "/_site/fonts/"));
    }
  }
  return rules.join("\n");
}

/* ------------------------------------------------------------------- refresh -- */

export function siteSlug(url) {
  const m = /^https:\/\/(?:www\.)?zola\.com\/wedding\/([a-z0-9-]+)\/?$/i.exec(String(url || "").trim());
  return m ? m[1] : null;
}

export async function fetchText(url) {
  const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!response.ok) throw new Error(`Zola returned ${response.status} for ${url}`);
  return response.text();
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch every page of the Zola site and clean it. Needs no database, so it runs both
 * in the Worker and in the GitHub Action (scripts/zola_refresh.mjs) -- Zola refuses
 * requests from Cloudflare's servers, so in production the Action does the fetching
 * and hands the result to ingestSite(). Returns { pages: [{ path, title, html, hash,
 * source_url }], failed: [path], warnings: [string] }; throws if the home page fails.
 */
export async function buildSite({ zolaUrl, rsvpColor = "", fetchPage = fetchText }) {
  const slug = siteSlug(zolaUrl);
  if (!slug) throw new Error("Set your Zola website address in Settings (https://www.zola.com/wedding/your-site).");
  const homeHtml = await fetchPage(`${ZOLA_ORIGIN}/wedding/${slug}`);

  // The site's own pages, from its menu, in menu order.
  const keys = [];
  for (const n of elements(parseHtml(homeHtml), (n) => n.tag === "a")) {
    const key = zolaPageKey(attr(n, "href"), slug);
    if (key && !keys.includes(key) && localPathFor(key, slug).startsWith("/") && key !== "rsvp") keys.push(key);
  }
  const pages = new Set(keys.slice(0, MAX_PAGES - 1));

  let fontsCss = "";
  try {
    fontsCss = await fetchPage(FONTS_CSS);
  } catch {
    /* fonts fall back to the browser's serif; not worth failing the refresh over */
  }

  const fetchedAt = Date.now();
  const warnings = [];
  const failed = [];
  const sources = [["", homeHtml]];
  for (const key of pages) {
    try {
      sources.push([key, await fetchPage(`${ZOLA_ORIGIN}/wedding/${slug}/${key}`)]);
    } catch (error) {
      // One broken page keeps its last copy; it shouldn't hold back the others.
      failed.push(localPathFor(key, slug));
      warnings.push(`${localPathFor(key, slug)}: couldn't fetch it this time (${error.message}), so the previous copy stays.`);
    }
  }

  const built = [];
  for (const [key, source] of sources) {
    const path = localPathFor(key, slug);
    const page = cleanPage(source, { slug, pages, fetchedAt, rsvpColor, currentPath: path, fontCss: fontFacesFor(fontsCss, source) });
    for (const w of page.warnings) warnings.push(`${path}: ${w}`);
    built.push({
      path,
      title: page.title,
      html: page.html,
      hash: await sha256(page.hashSource),
      source_url: `${ZOLA_ORIGIN}/wedding/${slug}${key ? `/${key}` : ""}`,
    });
  }
  return { pages: built, failed, warnings };
}

/** Store a built site, only moving changed_at for pages whose content changed. */
export async function storeSite(env, built, extra = {}) {
  const startedAt = new Date().toISOString();
  const previous = (await getSetting(env, "_site_status")) || {};
  const existing = new Map((await all(env, "SELECT path, content_hash, changed_at FROM site_pages")).map((r) => [r.path, r]));
  const stored = [];
  let anyChange = false;
  for (const page of built.pages) {
    const before = existing.get(page.path);
    const changed = !before || before.content_hash !== page.hash;
    if (changed) anyChange = true;
    const changedAt = changed ? startedAt : before.changed_at;
    await run(
      env,
      `INSERT INTO site_pages (path, title, html, source_url, content_hash, fetched_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET title = excluded.title, html = excluded.html, source_url = excluded.source_url,
         content_hash = excluded.content_hash, fetched_at = excluded.fetched_at, changed_at = excluded.changed_at`,
      page.path, page.title, page.html, page.source_url, page.hash, startedAt, changedAt
    );
    stored.push({ path: page.path, title: page.title, changed_at: changedAt });
  }
  // Pages Zola no longer has.
  const keep = new Set([...stored.map((p) => p.path), ...built.failed]);
  for (const path of existing.keys()) {
    if (!keep.has(path)) {
      await run(env, "DELETE FROM site_pages WHERE path = ?", path);
      anyChange = true;
    }
  }
  const status = {
    ...extra,
    checked_at: startedAt,
    changed_at: anyChange ? startedAt : previous.changed_at || startedAt,
    requested_at: previous.requested_at || null,
    error: null,
    error_at: null,
    warnings: built.warnings,
    pages: stored,
    changed: anyChange,
  };
  await setSetting(env, "_site_status", status);
  return status;
}

/** Record a failed refresh; the last good copy stays up. */
export async function recordSiteError(env, message, extra = {}) {
  const now = new Date().toISOString();
  const previous = (await getSetting(env, "_site_status")) || {};
  const status = { ...previous, ...extra, checked_at: now, error: String(message).slice(0, 500), error_at: now };
  await setSetting(env, "_site_status", status);
  return status;
}

/** Fetch, clean and store from inside the Worker (works where Zola allows it). */
export async function refreshSite(env, { zolaUrl, rsvpColor = "" }) {
  try {
    return await storeSite(env, await buildSite({ zolaUrl, rsvpColor }), { source: "worker" });
  } catch (error) {
    const blocked = /returned 403/.test(error.message)
      ? " Zola refuses requests from Cloudflare's servers; set up the GitHub refresh in SETUP.md so GitHub fetches it instead."
      : "";
    await recordSiteError(env, error.message + blocked, { source: "worker" });
    throw new Error(error.message + blocked);
  }
}

/**
 * A site built by the GitHub Action. Checked strictly, since it arrives over the
 * network: only page paths we'd make ourselves, bounded sizes, a hex hash.
 */
export async function ingestSite(env, payload) {
  if (payload && typeof payload.error === "string") return recordSiteError(env, `GitHub couldn't refresh it: ${payload.error}`, { source: "github" });
  const pages = Array.isArray(payload?.pages) ? payload.pages : null;
  if (!pages || !pages.length || pages.length > MAX_PAGES) throw new Error("Expected 1 to 15 pages.");
  const clean = pages.map((p) => {
    if (!p || typeof p.html !== "string" || p.html.length > 1_500_000) throw new Error("Each page needs its HTML (under 1.5 MB).");
    if (typeof p.path !== "string" || !(p.path === "/" || (/^\/[a-z0-9-]+$/.test(p.path) && !RESERVED.has(p.path.slice(1))))) {
      throw new Error(`Not a page path the site can serve: ${p.path}`);
    }
    if (typeof p.hash !== "string" || !/^[0-9a-f]{64}$/.test(p.hash)) throw new Error("Each page needs its content hash.");
    return { path: p.path, html: p.html, hash: p.hash, title: String(p.title || "").slice(0, 300), source_url: String(p.source_url || "").slice(0, 300) };
  });
  if (!clean.some((p) => p.path === "/")) throw new Error("The home page is missing.");
  const failed = (Array.isArray(payload.failed) ? payload.failed : []).filter((p) => typeof p === "string").slice(0, MAX_PAGES);
  const warnings = (Array.isArray(payload.warnings) ? payload.warnings : []).map((w) => String(w).slice(0, 500)).slice(0, 50);
  return storeSite(env, { pages: clean, failed, warnings }, { source: "github" });
}

/** Ask GitHub to run the refresh workflow now (the "Refresh from Zola" button). */
export async function requestGithubRefresh(env) {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/zola-refresh.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "wedding-planner-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (response.status !== 204) {
    const text = (await response.text()).slice(0, 300);
    throw new Error(`GitHub wouldn't start the refresh (${response.status}). Check PANEL_GITHUB_TOKEN in SETUP.md. ${text}`);
  }
  const previous = (await getSetting(env, "_site_status")) || {};
  const status = { ...previous, requested_at: new Date().toISOString() };
  await setSetting(env, "_site_status", status);
  return status;
}

/* ------------------------------------------------------------------- serving -- */

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Our footer, in place of Zola's: some room at the bottom of the page, and a Contact
 * us link, centered. Added as the page is served, so a new address in Settings shows at once.
 */
export function siteFooter({ coupleNames = "", contactEmail = "" }) {
  const links = contactEmail ? [`<a href="mailto:${escapeHtml(contactEmail)}">Contact us</a>`] : [];
  return `<footer class="wm-footer"><style>`
    + `.wm-footer{margin:56px 0 0;padding:40px 16px 64px;border-top:1px solid rgba(127,127,127,.25);text-align:center;color:var(--wm-text,inherit);font-family:var(--wm-font,inherit)}`
    + `.wm-footer p{margin:0 0 12px;font-size:18px;letter-spacing:.04em}`
    + `.wm-footer nav{display:flex;justify-content:center;gap:28px;flex-wrap:wrap;font-size:15px;letter-spacing:.08em;text-transform:uppercase}`
    + `.wm-footer a{color:inherit;text-decoration:underline;text-underline-offset:4px}`
    + `</style>${coupleNames ? `<p>${escapeHtml(coupleNames)}</p>` : ""}${links.length ? `<nav aria-label="Footer">${links.join("")}</nav>` : ""}</footer>`;
}

/** The stored copy of a page, or null. Only plain page paths are looked up. */
export async function servePage(env, pathname) {
  let path = pathname.replace(/\/index\.html$/, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path !== "/" && !/^\/[a-z0-9-]+$/.test(path)) return null;
  if (RESERVED.has(path.slice(1))) return null;
  const page = await first(env, "SELECT html FROM site_pages WHERE path = ?", path);
  if (!page) return null;
  const footer = siteFooter({
    coupleNames: await getSetting(env, "couple_names", ""),
    contactEmail: await getSetting(env, "contact_email", DEFAULT_SETTINGS.contact_email),
  });
  const at = page.html.lastIndexOf("</body>");
  const html = at === -1 ? page.html + footer : page.html.slice(0, at) + footer + page.html.slice(at);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "x-robots-tag": "noindex" },
  });
}

/** Zola's theme fonts, served from our domain so no browser has to trust Zola's CDN. */
export async function serveFont(pathname) {
  const file = pathname.slice("/_site/fonts/".length);
  if (!/^[A-Za-z0-9._-]+\.(ttf|otf|woff2?)$/.test(file)) return new Response("Not found", { status: 404 });
  const upstream = await fetch(`${ZOLA_CDN}/static-assets/fonts/${file}`, { cf: { cacheTtl: 604800, cacheEverything: true } });
  if (!upstream.ok) return new Response("Not found", { status: 404 });
  const type = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" }[file.split(".").pop()];
  return new Response(upstream.body, { headers: { "content-type": type, "cache-control": "public, max-age=604800, immutable" } });
}
