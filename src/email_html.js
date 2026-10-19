/**
 * Guest emails as HTML (src/comms.js sends them): the rich-text body from the
 * Communications editor, cleaned to a short list of tags; its plain-text twin for mail
 * apps that don't show HTML; and the two designs an email can go out in.
 *
 *   plain    the words on a white page, like a personal email
 *   wedding  a card in the wedding website's colors and font, with your names, the date
 *            and venue up top, an optional header photo, and a footer with links back
 *
 * Every style is inline: Gmail, Outlook and phone mail apps ignore most stylesheets.
 */

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (text) => String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
  if (code[0] === "#") {
    const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
  }
  return ENTITIES[code.toLowerCase()] ?? whole;
});

/* ------------------------------------------------------------------ cleaning ---- */

// What the editor makes. Anything else keeps its words and loses its tag.
const KEEP = new Set(["p", "br", "b", "strong", "i", "em", "u", "h2", "h3", "ul", "ol", "li", "a", "blockquote", "hr"]);
const EMPTY = new Set(["br", "hr"]);
// Tags whose insides are never words: dropped whole.
const DROP = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "template", "svg", "math", "noscript", "textarea", "select", "button"]);
const BLOCK = new Set(["p", "h2", "h3", "ul", "ol", "blockquote", "hr"]);
const INLINE = new Set(["b", "strong", "i", "em", "u", "a"]);
const RENAME = { div: "p", h1: "h2", h4: "h3", h5: "h3", h6: "h3" };
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** A link the email may carry: the web, an email address, or a fill-in like {rsvp_link}. */
export function safeHref(raw) {
  const href = decodeEntities(String(raw || "")).trim();
  if (/^\{[a-z_]+\}$/.test(href)) return href;
  if (/^(https?:\/\/|mailto:)[^\s"<>]+$/i.test(href)) return href;
  return null;
}

/**
 * The editor's HTML with only the tags above, no styles or scripts, links only to safe
 * places, and every tag closed. Text keeps its entities; a stray < or & is escaped.
 */
export function sanitizeHtml(html) {
  const out = [];
  const open = [];
  let dropping = null;
  let depth = 0;
  let last = 0;
  const text = (chunk) => chunk.replace(/<|>/g, (c) => (c === "<" ? "&lt;" : "&gt;")).replace(/&(?!(#x[0-9a-f]+|#\d+|[a-z]+);)/gi, "&amp;");
  const source = String(html || "");
  for (const m of source.matchAll(TAG)) {
    if (!dropping) out.push(text(source.slice(last, m.index)));
    last = m.index + m[0].length;
    if (!m[2]) continue; // a comment
    const closing = m[1] === "/";
    const raw = m[2].toLowerCase();
    if (dropping) {
      if (raw === dropping) depth += closing ? -1 : 1;
      if (depth === 0) dropping = null;
      continue;
    }
    if (DROP.has(raw)) {
      if (!closing && !/\/\s*$/.test(m[3])) {
        dropping = raw;
        depth = 1;
      }
      continue;
    }
    const name = RENAME[raw] || raw;
    if (!KEEP.has(name)) continue;
    if (closing) {
      const at = open.lastIndexOf(name);
      if (at < 0) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    // A block inside a paragraph ends the paragraph, as a browser reads it (the editor
    // can make <p><ul>...</ul></p>, which some mail apps draw oddly).
    if (BLOCK.has(name)) {
      const at = open.lastIndexOf("p");
      if (at >= 0 && open.slice(at + 1).every((t) => INLINE.has(t))) while (open.length > at) out.push(`</${open.pop()}>`);
    }
    if (EMPTY.has(name)) {
      out.push(`<${name}>`);
      continue;
    }
    if (name === "a") {
      const hrefMatch = m[3].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const href = hrefMatch ? safeHref(hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3]) : null;
      if (!href) continue; // no safe link: keep the words only
      const classMatch = m[3].match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const button = /\bbutton\b/.test(classMatch ? classMatch[1] ?? classMatch[2] ?? classMatch[3] : "");
      out.push(`<a href="${escapeHtml(href)}"${button ? ' class="button"' : ""}>`);
    } else {
      out.push(`<${name}>`);
    }
    open.push(name);
  }
  if (!dropping) out.push(text(source.slice(last)));
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("").replace(/<p><\/p>/g, "").trim();
}

/* -------------------------------------------------------------- conversions ---- */

/** Plain text as editor HTML: paragraphs, line breaks and clickable links. */
export function textToContent(text) {
  const linked = (line) => escapeHtml(line).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
  return String(text).trim().split(/\n{2,}/).filter(Boolean).map((p) => `<p>${p.split("\n").map(linked).join("<br>")}</p>`).join("\n");
}

/** Cleaned HTML as plain text: bullets and numbers for lists, links written out. */
export function htmlToText(html) {
  const out = [];
  const lists = [];
  let link = null;
  let last = 0;
  const source = String(html || "");
  const words = (chunk) => decodeEntities(chunk.replace(/\s+/g, " "));
  for (const m of source.matchAll(TAG)) {
    out.push(words(source.slice(last, m.index)));
    last = m.index + m[0].length;
    if (!m[2]) continue;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (name === "br") out.push("\n");
    else if (name === "hr") out.push("\n\n————\n\n");
    else if (["p", "h2", "h3", "blockquote"].includes(name)) out.push("\n\n");
    else if (name === "ul" || name === "ol") {
      if (closing) lists.pop();
      else lists.push({ ordered: name === "ol", n: 0 });
      out.push("\n");
    } else if (name === "li" && !closing) {
      const list = lists[lists.length - 1];
      out.push(`\n${"  ".repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${++list.n}.` : "•"} `);
    } else if (name === "a") {
      if (!closing) {
        const href = m[3].match(/\bhref="([^"]*)"/i);
        link = { href: href ? decodeEntities(href[1]) : "", at: out.length };
      } else if (link) {
        const label = out.slice(link.at).join("").trim();
        if (link.href && label !== link.href && !link.href.startsWith("mailto:")) out.push(` (${link.href})`);
        link = null;
      }
    }
  }
  out.push(words(source.slice(last)));
  return out.join("").split("\n").map((l) => l.replace(/[ \t]+$/g, "").replace(/^ (?=\S)/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ------------------------------------------------------------------ designs ---- */

export const DESIGNS = ["wedding", "plain"];
export const DEFAULT_THEME = { background: "#f7f4ee", text: "#4a443d", accent: "#A4727E", font: null };

const hex = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : null);
const luminance = (color) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * The wedding website's look, read from the copy of its home page (src/site.js adds
 * its colors and font to the page it stores): background, text color and font, with
 * the RSVP button's color as the accent.
 */
export function themeFrom(pageHtml, accent) {
  const html = String(pageHtml || "");
  const background = hex(html.match(/html,body\{background:(#[0-9a-f]{6})\}/i)?.[1]);
  const text = hex(html.match(/--wm-text:(#[0-9a-f]{6})/i)?.[1]);
  const font = html.match(/--wm-font:'([^']{1,60})',/)?.[1] || null;
  const theme = {
    background: background || DEFAULT_THEME.background,
    text: text || DEFAULT_THEME.text,
    accent: hex(accent) || DEFAULT_THEME.accent,
    font,
  };
  // A dark website keeps its accent but the email stays light, so it reads in every mail app.
  if (luminance(theme.background) < 0.35) theme.background = DEFAULT_THEME.background;
  if (luminance(theme.text) > 0.4) theme.text = DEFAULT_THEME.text;
  return theme;
}

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

/** Inline styles on the cleaned tags, for the wedding design. */
function styleContent(html, theme, heading) {
  const s = {
    p: `margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.65;color:${theme.text}`,
    h2: `margin:28px 0 12px;font-family:${heading};font-size:24px;line-height:1.25;font-weight:400;color:${theme.text}`,
    h3: `margin:24px 0 8px;font-family:${SANS};font-size:13px;line-height:1.4;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${theme.accent}`,
    ul: `margin:0 0 16px;padding:0 0 0 22px;font-family:${SANS};font-size:16px;line-height:1.65;color:${theme.text}`,
    ol: `margin:0 0 16px;padding:0 0 0 22px;font-family:${SANS};font-size:16px;line-height:1.65;color:${theme.text}`,
    li: "margin:0 0 6px",
    blockquote: `margin:0 0 16px;padding:4px 0 4px 18px;border-left:3px solid ${theme.accent};font-family:${heading};font-style:italic;font-size:18px;line-height:1.55;color:${theme.text}`,
    hr: `border:0;border-top:1px solid ${theme.text}26;margin:28px 0`,
  };
  return html
    .replace(/<(p|h2|h3|ul|ol|li|blockquote|hr)>/g, (whole, name) => `<${name} style="${s[name]}">`)
    .replace(/<a href="([^"]*)" class="button">/g, (whole, href) => `<a href="${href}" class="button" style="display:inline-block;margin:6px 0;padding:13px 30px;border-radius:999px;background:${theme.accent};color:#ffffff;font-family:${SANS};font-size:15px;font-weight:600;letter-spacing:.3px;text-decoration:none">`)
    .replace(/<a href="([^"]*)">/g, (whole, href) => `<a href="${href}" style="color:${theme.accent};text-decoration:underline">`)
    // The first and last blocks sit flush with the card's padding.
    .replace(/^<(p|h2|h3) style="margin:[^;]+;/, (whole, name) => `<${name} style="margin:0 0 ${name === "p" ? 16 : 12}px;`);
}

/**
 * The whole email as an HTML page. `content` is cleaned HTML with the fill-ins done;
 * `details` is { couple, date, venue, site, rsvp, headerImage, footerNote, calendar }.
 */
export function renderEmail({ design = "plain", subject = "", content, theme = DEFAULT_THEME, details = {} }) {
  if (design !== "wedding") {
    const plain = String(content)
      .replace(/<a href="([^"]*)" class="button">/g, '<a href="$1" style="display:inline-block;padding:10px 22px;border-radius:999px;background:#333;color:#fff;text-decoration:none">');
    return `<!doctype html><html><body style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.55;color:#222;max-width:600px">${plain}</body></html>`;
  }
  const heading = theme.font ? `'${theme.font.replace(/['"\\]/g, "")}', ${SERIF}` : SERIF;
  const e = (v) => escapeHtml(v ?? "");
  const preheader = htmlToText(content).replace(/\s+/g, " ").slice(0, 140);
  const when = [details.date, details.venue].filter(Boolean).map(e).join(" &nbsp;·&nbsp; ");
  const footerLinks = [
    details.site ? `<a href="${e(details.site)}" style="color:${theme.text};text-decoration:underline">Our wedding website</a>` : "",
    details.rsvp ? `<a href="${e(details.rsvp)}" style="color:${theme.text};text-decoration:underline">RSVP</a>` : "",
  ].filter(Boolean).join(" &nbsp;&nbsp;·&nbsp;&nbsp; ");
  const image = safeHref(details.headerImage)?.startsWith("https://")
    ? `<tr><td style="padding:0 0 24px"><img src="${e(details.headerImage)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:14px"></td></tr>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${e(subject)}</title>
<style>@media (max-width:620px){.wm-card{padding:28px 22px !important}.wm-names{font-size:34px !important}}</style></head>
<body style="margin:0;padding:0;background:${theme.background};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${e(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.background}"><tr><td align="center" style="padding:36px 12px 44px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td align="center" style="padding:0 16px 26px">
${when ? `<div style="font-family:${SANS};font-size:12px;letter-spacing:3px;text-transform:uppercase;color:${theme.text};opacity:.8">${when}</div>` : ""}
<div class="wm-names" style="margin:12px 0 0;font-family:${heading};font-size:44px;line-height:1.1;font-weight:400;color:${theme.text}">${e(details.couple || "")}</div>
<div style="width:56px;height:2px;margin:20px auto 0;background:${theme.accent};line-height:2px;font-size:0">&nbsp;</div>
</td></tr>
${image}
<tr><td class="wm-card" style="background:#ffffff;border-radius:16px;padding:44px 48px;border:1px solid ${theme.text}1a">
${styleContent(content, theme, heading)}
${details.calendar ? `<p style="margin:24px 0 0;padding:14px 16px;border-radius:10px;background:${theme.background};font-family:${SANS};font-size:14px;line-height:1.5;color:${theme.text}">Your calendar invite is attached. Open it to add the day to your calendar.</p>` : ""}
</td></tr>
<tr><td align="center" style="padding:30px 16px 0;font-family:${SANS};font-size:13px;line-height:1.7;color:${theme.text}">
<div style="font-family:${heading};font-size:20px;color:${theme.text};margin:0 0 8px">${e(details.couple || "")}</div>
${footerLinks ? `<div style="margin:0 0 10px">${footerLinks}</div>` : ""}
<div style="opacity:.75">${e(details.footerNote || "You're getting this because you're on our guest list.")}</div>
</td></tr>
</table></td></tr></table>
</body></html>`;
}
