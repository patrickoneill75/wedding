/**
 * The wedding website, coded here instead of copied from Zola. Its pages are written in
 * the control panel's Website page (public/admin/website.html) and kept in D1
 * (web_pages); the gallery's photos are uploaded there too, each resized in the browser
 * to a JPEG and a thumbnail (web_photos), and served from /_site/photo/<id>.
 *
 * Guests keep the Zola copy (src/site.js) until the Website page switches them over
 * (settings.web_live). Until then the coded site is a preview at /_new/ for anyone
 * signed in with the Website page. RSVP, the call page and the control panel are
 * unchanged either way.
 *
 * A page is one of:
 *   home     the cover photo, the date, a countdown, then its text (one, slug "")
 *   text     a title and its text
 *   gallery  a title, its text, then the photos
 *   guide    our Things to Do guide (src/guide.js) at /things-to-do (one)
 *   link     a menu item that goes to another site (the registry); no page of its own
 *
 * Control panel routes under /api/admin/website/* (the Website page):
 *   GET    website                  pages, photos (no image data), live, cover; the
 *                                   first call sets the pages up from the Zola copy's menu
 *   POST   website/pages            { title, slug, kind: text|gallery|link, url, in_menu }
 *   PUT    website/pages/:id        { title, slug, body, url, in_menu, visible }
 *   DELETE website/pages/:id        not the home page or the guide
 *   POST   website/pages/order      { ids } the menu order
 *   GET    website/copy?path=/x     the stored Zola copy of that page, for "Fill from the
 *                                   Zola page" (the browser picks out its words)
 *   POST   website/photos           multipart: photo, thumb (JPEG, PNG or WebP), width,
 *                                   height, caption
 *   PUT    website/photos/:id       { caption } / DELETE website/photos/:id
 *   POST   website/photos/order     { ids }
 *   PUT    website/settings         { live, cover, home: { header, first, second, place } }
 */

import { currentUser, json } from "./auth.js";
import { all, first, run, setSetting } from "./db.js";
import { loadSettings } from "./store.js";
import { countdownEnd, RESERVED, RSVP_COLOR, siteSlug } from "./site.js";
import { decodeEntities, sanitizeHtml } from "./email_html.js";
import { GUIDE_CSS, guideBody } from "./guide.js";
import { sqlValue } from "./importer.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const PREVIEW_BASE = "/_new";
const NEW_KINDS = ["text", "gallery", "link"];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PHOTO = 1_800_000; // D1 keeps a value up to 2 MB
const MAX_THUMB = 400_000;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/* -------------------------------------------------------------------- pages ---- */

function cleanSlug(raw, kind) {
  const slug = String(raw ?? "").trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!SLUG.test(slug) || slug.length > 60) throw new Error("A web address takes lowercase letters, numbers and dashes, like wedding-party.");
  if (RESERVED.has(slug) && !(kind === "guide" && slug === "things-to-do")) throw new Error(`/${slug} is taken by another part of the site. Pick another address.`);
  return slug;
}

function cleanUrl(raw) {
  const url = String(raw ?? "").trim();
  if (!/^https?:\/\/[^\s"<>]+$/i.test(url)) throw new Error("A menu link needs a web address that starts with https://.");
  return url.slice(0, 500);
}

const bool = (v) => (v === true || v === 1 || v === "1" || v === "true" || v === "on" ? 1 : 0);

/** The registry: Settings' link, else the Zola site's registry page (as src/public_api.js does). */
function registryUrl(env, s) {
  if (s.registry_url) return s.registry_url;
  const slug = siteSlug(s.zola_url || env.ZOLA_URL);
  return slug ? `https://www.zola.com/wedding/${slug}/registry` : "";
}

/**
 * The first pages: the Zola copy's menu, in its order (our phone menu in the stored home
 * page lists it), plus the guide. With no copy, Home, Gallery, Travel, FAQs, Things to Do
 * and the registry. Their words come from "Fill from the Zola page" in the editor.
 */
async function seedPages(env, s) {
  const home = (await first(env, "SELECT html FROM site_pages WHERE path = '/'"))?.html || "";
  const menu = /<nav id="wm-menu"[^>]*>([\s\S]*?)<\/nav>/.exec(home)?.[1] || "";
  const items = [...menu.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: decodeEntities(m[1]), label: decodeEntities(m[2].replace(/<[^>]*>/g, "")).trim() }));
  const rows = [];
  const add = (row) => { if (!rows.some((r) => r.slug === row.slug)) rows.push({ body: "", url: "", in_menu: 1, visible: 1, ...row }); };
  add({ slug: "", title: "Home", kind: "home" });
  for (const { href, label } of items) {
    if (!label) continue;
    if (href === "/") continue;
    if (/^https?:/.test(href)) {
      add({ slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "link", title: label, kind: "link", url: href });
      continue;
    }
    const slug = href.replace(/^\//, "");
    if (!SLUG.test(slug) || RESERVED.has(slug)) continue;
    add({ slug, title: label, kind: /gallery|photo/i.test(slug) ? "gallery" : "text" });
  }
  if (rows.length === 1) {
    add({ slug: "gallery", title: "Gallery", kind: "gallery" });
    add({ slug: "travel", title: "Travel", kind: "text", body: "<h3>Where to stay</h3><p>[Your hotel block.]</p><h3>Getting here</h3><p>[The airport and parking.]</p>" });
    add({ slug: "faqs", title: "FAQs", kind: "text", body: "<h3>[A question guests ask]</h3><p>[Your answer.]</p>" });
  }
  add({ slug: "things-to-do", title: "Things to Do", kind: "guide", visible: s.things_to_do_published ? 1 : 0 });
  const registry = registryUrl(env, s);
  if (registry && !rows.some((r) => r.kind === "link")) add({ slug: "registry", title: "Registry", kind: "link", url: registry });
  const cols = ["slug", "title", "kind", "body", "url", "in_menu", "visible", "sort_order"];
  await run(env, `INSERT OR IGNORE INTO web_pages (${cols.join(", ")}) VALUES ${rows.map((r, i) => `(${cols.map((c) => sqlValue(c === "sort_order" ? i : r[c])).join(", ")})`).join(", ")}`);
}

async function overview(env) {
  const s = await loadSettings(env);
  let pages = await all(env, "SELECT * FROM web_pages ORDER BY sort_order, id");
  if (!pages.length) {
    await seedPages(env, s);
    pages = await all(env, "SELECT * FROM web_pages ORDER BY sort_order, id");
  }
  const photos = await all(env, "SELECT id, caption, sort_order, width, height FROM web_photos ORDER BY sort_order, id");
  const copies = await all(env, "SELECT path FROM site_pages WHERE path LIKE '/%'");
  return {
    pages, photos, live: Boolean(s.web_live), cover: s.web_cover_photo ?? null, copies: copies.map((c) => c.path), preview: `${PREVIEW_BASE}/`,
    home: { header: "", first: "", second: "", place: "", ...(s.web_home || {}) }, defaults: topOf({ ...s, web_home: {} }),
  };
}

async function body(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

async function setOrder(env, table, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger).slice(0, 500);
  if (!list.length) throw new Error("Nothing to order.");
  await run(env, `UPDATE ${table} SET sort_order = CASE id ${list.map((id, i) => `WHEN ${id} THEN ${i}`).join(" ")} ELSE sort_order END WHERE id IN (${list.join(",")})`);
}

/* ------------------------------------------------------------------- photos ---- */

/** A D1 BLOB as bytes (D1 hands them back as an array or an ArrayBuffer). */
const bytesOf = (value) => (value instanceof Uint8Array ? value : new Uint8Array(value || []));

async function addPhoto(env, request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new Error("Send the photo as a form upload.");
  }
  const photo = form.get("photo");
  const thumb = form.get("thumb");
  if (!photo || typeof photo === "string" || !thumb || typeof thumb === "string") throw new Error("A photo needs its picture and its thumbnail.");
  if (!PHOTO_TYPES.includes(photo.type) || !PHOTO_TYPES.includes(thumb.type)) throw new Error("Photos go up as JPEG, PNG or WebP.");
  if (photo.size > MAX_PHOTO || thumb.size > MAX_THUMB) throw new Error("That photo is too big even after resizing. Try a smaller one.");
  const size = (v) => Math.max(0, Math.min(20000, Math.round(Number(v) || 0)));
  const result = await run(
    env,
    "INSERT INTO web_photos (caption, sort_order, width, height, mime, data, thumb) VALUES (?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM web_photos), ?, ?, ?, ?, ?)",
    String(form.get("caption") || "").trim().slice(0, 300),
    size(form.get("width")),
    size(form.get("height")),
    photo.type,
    new Uint8Array(await photo.arrayBuffer()),
    new Uint8Array(await thumb.arrayBuffer())
  );
  return result.meta.last_row_id;
}

/** GET /_site/photo/<id> or /_site/photo/<id>/thumb: a gallery photo. */
export async function servePhoto(env, pathname) {
  const m = /^\/_site\/photo\/(\d+)(\/thumb)?$/.exec(pathname);
  if (!m) return new Response("Not found", { status: 404 });
  const row = await first(env, `SELECT mime, ${m[2] ? "thumb" : "data"} AS bytes FROM web_photos WHERE id = ?`, Number(m[1]));
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(bytesOf(row.bytes), { headers: { "content-type": row.mime, "cache-control": "public, max-age=86400" } });
}

/* ------------------------------------------------------------------- routes ---- */

export async function handleWebsite(parts, method, request, env) {
  const [, section, rawId] = parts;
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;

  if (!section && method === "GET") return json(await overview(env));

  if (section === "copy" && method === "GET") {
    const path = new URL(request.url).searchParams.get("path") || "/";
    if (!/^\/[a-z0-9-]*$/.test(path)) throw new Error("Not a page of the site.");
    const page = await first(env, "SELECT html FROM site_pages WHERE path = ?", path);
    if (!page) return json({ error: "There's no Zola copy of that page. Refresh from Zola in Settings, or write it here." }, 404);
    return json({ html: page.html });
  }

  if (section === "settings" && method === "PUT") {
    const input = await body(request);
    if (has(input, "live")) await setSetting(env, "web_live", Boolean(bool(input.live)));
    if (has(input, "home")) {
      const home = input.home && typeof input.home === "object" ? input.home : {};
      const text = (key) => (has(home, key) ? String(home[key] ?? "").replace(/\s+/g, " ").trim().slice(0, 80) : "");
      await setSetting(env, "web_home", { header: text("header"), first: text("first"), second: text("second"), place: text("place") });
    }
    if (has(input, "cover")) {
      const cover = input.cover === null || input.cover === "" ? null : Number(input.cover);
      if (cover !== null && !(await first(env, "SELECT id FROM web_photos WHERE id = ?", cover))) throw new Error("That photo isn't in the gallery.");
      await setSetting(env, "web_cover_photo", cover);
    }
    return json(await overview(env));
  }

  if (section === "pages") {
    if (rawId === "order" && method === "POST") {
      await setOrder(env, "web_pages", (await body(request)).ids);
      return json(await overview(env));
    }
    if (!id && method === "POST") {
      const input = await body(request);
      const kind = NEW_KINDS.includes(input.kind) ? input.kind : "text";
      const title = String(input.title ?? "").trim().slice(0, 80);
      if (!title) throw new Error("Give the page a title.");
      const slug = cleanSlug(input.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), kind);
      if (await first(env, "SELECT id FROM web_pages WHERE slug = ?", slug)) throw new Error(`There's already a page at /${slug}.`);
      const result = await run(
        env,
        "INSERT INTO web_pages (slug, title, kind, url, in_menu, visible, sort_order) VALUES (?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM web_pages))",
        slug, title, kind, kind === "link" ? cleanUrl(input.url) : "", has(input, "in_menu") ? bool(input.in_menu) : 1
      );
      return json({ id: result.meta.last_row_id, ...(await overview(env)) }, 201);
    }
    const page = id ? await first(env, "SELECT * FROM web_pages WHERE id = ?", id) : null;
    if (!page) return json({ error: "No such page." }, 404);
    if (method === "PUT") {
      const input = await body(request);
      const patch = Object.create(null);
      if (has(input, "title")) {
        patch.title = String(input.title ?? "").trim().slice(0, 80);
        if (!patch.title) throw new Error("Give the page a title.");
      }
      if (has(input, "slug") && page.kind !== "home" && page.kind !== "guide") {
        patch.slug = cleanSlug(input.slug, page.kind);
        const taken = await first(env, "SELECT id FROM web_pages WHERE slug = ? AND id <> ?", patch.slug, id);
        if (taken) throw new Error(`There's already a page at /${patch.slug}.`);
      }
      if (has(input, "body")) patch.body = sanitizeHtml(String(input.body ?? "").slice(0, 200_000), { page: true });
      if (has(input, "url") && page.kind === "link") patch.url = cleanUrl(input.url);
      if (has(input, "in_menu")) patch.in_menu = bool(input.in_menu);
      // The home page is always there; the rest can be hidden from guests.
      if (has(input, "visible") && page.kind !== "home") patch.visible = bool(input.visible);
      const cols = Object.keys(patch);
      if (cols.length) await run(env, `UPDATE web_pages SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...cols.map((c) => patch[c]), id);
      return json(await overview(env));
    }
    if (method === "DELETE") {
      if (page.kind === "home" || page.kind === "guide") throw new Error("This page can be hidden from guests, not deleted.");
      await run(env, "DELETE FROM web_pages WHERE id = ?", id);
      return json(await overview(env));
    }
  }

  if (section === "photos") {
    if (rawId === "order" && method === "POST") {
      await setOrder(env, "web_photos", (await body(request)).ids);
      return json(await overview(env));
    }
    if (!id && method === "POST") {
      const newId = await addPhoto(env, request);
      return json({ id: newId, ...(await overview(env)) }, 201);
    }
    if (id && method === "PUT") {
      const input = await body(request);
      await run(env, "UPDATE web_photos SET caption = ? WHERE id = ?", String(input.caption ?? "").trim().slice(0, 300), id);
      return json(await overview(env));
    }
    if (id && method === "DELETE") {
      await run(env, "DELETE FROM web_photos WHERE id = ?", id);
      // Pages showing it lose it, rather than show a broken picture.
      const using = await all(env, "SELECT id, body FROM web_pages WHERE body LIKE ?", `%/_site/photo/${id}%`);
      const gone = new RegExp(`<p>\\s*<img src="/_site/photo/${id}(?:/thumb)?"[^>]*>\\s*</p>|<img src="/_site/photo/${id}(?:/thumb)?"[^>]*>`, "g");
      const fixed = using.map((p) => [p.id, p.body.replace(gone, "")]).filter(([, b], i) => b !== using[i].body);
      if (fixed.length) {
        await run(env, `UPDATE web_pages SET body = CASE id ${fixed.map(([pid, b]) => `WHEN ${pid} THEN ${sqlValue(b)}`).join(" ")} END WHERE id IN (${fixed.map(([pid]) => pid).join(",")})`);
      }
      const s = await loadSettings(env);
      if (s.web_cover_photo === id) await setSetting(env, "web_cover_photo", null);
      return json(await overview(env));
    }
  }

  return json({ error: "Not found." }, 404);
}

/* ---------------------------------------------------------------- the pages ---- */

// The look, from the Zola site: cream ground, warm brown type, the RSVP pill's rose.
// Also served at /_site/web.css for the editor, so what's written there looks like this.
export const SITE_CSS = `
:root{--bg:#F5EFE8;--ink:#6E5550;--head:#8C665D;--link:#7A5850;--muted:#86675E;--line:#E2D3C9;--wash:#E7DCD2;--accent:${RSVP_COLOR};
--display:'Cormorant Garamond','Libre Baskerville',Georgia,serif;--serif:'Libre Baskerville',Georgia,serif;--sans:'Lato','Helvetica Neue',Arial,sans-serif}
*{box-sizing:border-box}
body.web{margin:0;background:var(--bg);color:var(--ink);font:17px/1.7 var(--sans)}
.web a{color:var(--link)}.web a:hover{color:#5E423C}
.skip{position:absolute;left:-999px;top:8px;background:#fff;padding:8px 12px;border-radius:6px}.skip:focus{left:8px;z-index:10}
.preview-note{background:#FFF4D6;color:#5A4300;border-bottom:1px solid #F0D27A;padding:10px max(16px,env(safe-area-inset-left,0px));font:14px var(--sans);text-align:center}
.site-head{max-width:1120px;margin:0 auto;padding:36px max(16px,env(safe-area-inset-left,0px)) 0;display:flex;flex-direction:column;align-items:center;gap:28px;text-align:center}
.names{margin:0;font:500 clamp(30px,3.8vw,48px)/1.1 var(--display);letter-spacing:.12em;text-transform:uppercase}
.names a{color:var(--head);text-decoration:none}
.site-nav{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:12px 36px;font:400 20px var(--serif)}
.site-nav a{color:var(--link);text-decoration:none;padding-bottom:6px;border-bottom:3px solid transparent}
.site-nav a:hover{border-bottom-color:#D9C3B8}
.site-nav a[aria-current="page"]{border-bottom-color:var(--head)}
.rsvp{display:inline-flex;align-items:center;min-height:44px;padding:0 28px;border-radius:999px;background:var(--accent);color:#fff !important;text-decoration:none;font:700 14px var(--sans);letter-spacing:.14em;text-transform:uppercase;box-shadow:0 2px 10px rgba(0,0,0,.12)}
.rsvp:hover{filter:brightness(.95)}
.site-nav .rsvp{border-bottom:0;padding:0 28px}
.phone-bar{display:none;width:100%;justify-content:space-between;align-items:center}
.menu summary{list-style:none;cursor:pointer;min-height:44px;display:inline-flex;align-items:center;padding:0 18px;border:1px solid #C9AFA4;border-radius:999px;font:15px var(--serif);color:var(--link)}
.menu summary::-webkit-details-marker{display:none}
.menu[open] summary{background:#EFE4DA}
.menu nav{position:absolute;left:0;right:0;margin-top:8px;background:var(--bg);border-bottom:1px solid var(--line);box-shadow:0 12px 24px rgba(60,40,35,.10);padding:4px 16px 12px;display:flex;flex-direction:column;text-align:left;z-index:5}
.menu nav a{padding:14px 4px;border-bottom:1px solid #EADDD4;text-decoration:none;font:18px var(--serif)}
.menu nav a:last-child{border-bottom:0}.menu nav a[aria-current="page"]{font-weight:700}
.site-main{max-width:1120px;margin:0 auto;padding:44px max(16px,env(safe-area-inset-left,0px)) 0;display:flex;flex-direction:column;align-items:center;gap:48px}
.page-title{margin:0;font:400 clamp(32px,4.5vw,42px)/1.15 var(--serif);color:var(--head);text-align:center;text-wrap:balance}
.cover{width:100%;max-height:640px;object-fit:cover;border-radius:4px;display:block}
.cover-empty{width:100%;aspect-ratio:16/7;border-radius:4px;background:var(--wash)}
.hero{width:100%;display:flex;flex-direction:column;align-items:center;gap:14px;padding:clamp(48px,10vw,150px) 0 clamp(24px,5vw,60px);text-align:center;color:var(--head)}
.couple{margin:0;font:inherit;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:clamp(20px,5vw,64px);width:100%}
.who{margin:0;font:500 clamp(40px,7.2vw,86px)/1.12 var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--head)}
.who{display:block}.who span{display:block}
.who.left{text-align:right}.who.right{text-align:left}
.and{font:400 clamp(18px,2vw,26px) var(--serif);color:var(--head)}
.date{margin:clamp(40px,8vw,110px) 0 0;font:500 clamp(28px,3.4vw,42px)/1.2 var(--display);letter-spacing:.14em;color:var(--head);font-variant-numeric:lining-nums}
.place{margin:0;font:400 clamp(18px,1.8vw,24px)/1.4 var(--serif);color:var(--head)}
.countdown{display:flex;gap:clamp(14px,4vw,36px);justify-content:center}
.countdown div{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:64px}
.countdown b{font:400 clamp(32px,5vw,44px)/1 var(--serif);color:var(--head);font-variant-numeric:tabular-nums}
.countdown span{font:700 12px var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.prose{width:100%;max-width:680px}
.prose h2{font:400 30px/1.25 var(--serif);color:var(--head);margin:34px 0 12px;text-wrap:balance}
.prose h3{font:700 13px var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:30px 0 8px}
.prose p{margin:0 0 16px}.prose ul,.prose ol{margin:0 0 16px;padding-left:22px}.prose li{margin:0 0 6px}
.prose blockquote{margin:20px 0;padding:4px 0 4px 20px;border-left:3px solid var(--line);font:italic 18px/1.7 var(--serif);color:var(--head)}
.prose hr{border:0;border-top:1px solid var(--line);margin:28px 0}
.prose img{max-width:100%;height:auto;border-radius:3px;display:block;margin:12px auto}
.prose a.button{display:inline-flex;align-items:center;min-height:44px;padding:0 26px;border-radius:999px;background:var(--accent);color:#fff;text-decoration:none;font:700 13.5px var(--sans);letter-spacing:.12em;text-transform:uppercase}
.prose > :first-child{margin-top:0}
.home .prose{text-align:center}
.cta{display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center}
.cta h2{margin:0;font:400 28px var(--serif);color:var(--head)}
.grid{width:100%;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.tile{display:block;width:100%;padding:0;border:0;background:var(--wash);border-radius:3px;cursor:zoom-in;overflow:hidden}
.tile img{display:block;width:100%;height:auto}
.tile:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.grid figure{margin:0;display:flex;flex-direction:column;gap:8px}
.grid figcaption{font:italic 14px var(--serif);color:var(--muted);text-align:center}
.lightbox{border:0;padding:0;background:transparent;max-width:none;max-height:none;width:100%;height:100%}
.lightbox::backdrop{background:rgba(40,28,25,.9)}
.lightbox .box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px}
.lightbox img{max-width:min(1100px,100%);max-height:78vh;object-fit:contain;border-radius:3px}
.lightbox p{margin:0;color:#F5EFE8;font:italic 16px var(--serif);text-align:center}
.lightbox .row{display:flex;gap:12px}
.lightbox button{min-height:44px;padding:0 20px;border:1px solid #E2D3C9;border-radius:999px;background:transparent;color:#F5EFE8;font:15px var(--sans);cursor:pointer}
.lightbox button.close{background:#F5EFE8;color:#5E423C;font-weight:700}
.empty{color:var(--muted);font:italic 16px var(--serif);text-align:center}
.site-foot{margin-top:72px;padding:40px max(16px,env(safe-area-inset-left,0px)) 64px;border-top:1px solid var(--line);text-align:center;display:flex;flex-direction:column;gap:12px}
.site-foot p{margin:0;font:400 18px var(--serif);letter-spacing:.04em;color:var(--head)}
.site-foot a{font:700 14px var(--sans);letter-spacing:.12em;text-transform:uppercase}
@media (max-width:760px){.site-nav{display:none}.phone-bar{display:flex}.site-head{padding-top:12px;gap:18px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.couple{grid-template-columns:minmax(0,1fr);gap:10px}.who.left,.who.right{text-align:center}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto !important}}`;

const FONTS = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Lato:wght@400;700&display=swap";

const longDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))
  ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  : "");

const PAGE_SCRIPT = `(function(){
var c=document.querySelector(".countdown[data-end]");
if(c){var end=Number(c.getAttribute("data-end")),b=c.querySelectorAll("b");
var tick=function(){var l=Math.max(0,Math.floor((end-Date.now())/1000)),v=[Math.floor(l/86400),Math.floor(l%86400/3600),Math.floor(l%3600/60),l%60];
for(var i=0;i<4&&i<b.length;i++)b[i].textContent=v[i]};tick();setInterval(tick,1000)}
var box=document.querySelector(".lightbox"),tiles=[].slice.call(document.querySelectorAll(".tile")),at=0;
if(box&&tiles.length){var img=box.querySelector("img"),cap=box.querySelector("p");
var show=function(i){at=(i+tiles.length)%tiles.length;var t=tiles[at];img.src=t.getAttribute("data-full");img.alt=t.querySelector("img").alt;cap.textContent=t.getAttribute("data-caption")||""};
tiles.forEach(function(t,i){t.addEventListener("click",function(){show(i);box.showModal()})});
box.querySelector(".prev").addEventListener("click",function(){show(at-1)});
box.querySelector(".next").addEventListener("click",function(){show(at+1)});
box.querySelector(".close").addEventListener("click",function(){box.close()});
box.addEventListener("keydown",function(e){if(e.key==="ArrowLeft")show(at-1);if(e.key==="ArrowRight")show(at+1)})}
})();`;

/** A page's address on the site (`base` "/_new" in the preview). */
const hrefFor = (page, base) => (page.kind === "link" ? page.url : `${base}/${page.slug}`.replace(/\/$/, "") || "/");

function menuLinks(pages, current, base) {
  return pages.filter((p) => p.in_menu && p.visible).map((p) => {
    const external = p.kind === "link";
    const here = current && p.id === current.id;
    return `<a href="${escapeHtml(hrefFor(p, base) || "/")}"${here ? ' aria-current="page"' : ""}${external ? ' target="_blank" rel="noopener"' : ""}>${escapeHtml(p.title)}</a>`;
  }).join("");
}

/** The top of the site: the names over the menu, and the home page's two names and place. */
export function topOf(s) {
  const home = s.web_home || {};
  const couple = String(s.couple_names || "").split(/\s+(?:&|and)\s+/i).map((n) => n.trim()).filter(Boolean);
  return {
    header: String(home.header || "").trim() || s.couple_names || "Our wedding",
    first: String(home.first || "").trim() || couple[0] || "",
    second: String(home.second || "").trim() || couple[1] || "",
    place: String(home.place || "").trim() || s.venue || "",
  };
}

/** A name in big capitals, a line per word after the first ("Patrick" / "O'Neill"). */
const nameLines = (name) => {
  const [firstWord, ...rest] = String(name).trim().split(/\s+/);
  return [firstWord, rest.join(" ")].filter(Boolean).map((line) => `<span>${escapeHtml(line)}</span>`).join("");
};

function homeBody(page, s, photos) {
  const cover = photos.find((p) => p.id === s.web_cover_photo) || photos[0];
  const end = countdownEnd(s);
  const top = topOf(s);
  const units = ["Days", "Hours", "Minutes", "Seconds"];
  const couple = top.first && top.second
    ? `<h1 class="couple"><span class="who left">${nameLines(top.first)}</span><span class="and">and</span><span class="who right">${nameLines(top.second)}</span></h1>`
    : `<h1 class="who">${escapeHtml(top.first || top.header)}</h1>`;
  return `<section class="hero">${couple}`
    + (s.wedding_date ? `<p class="date">${escapeHtml(longDate(s.wedding_date))}</p>` : "")
    + (top.place ? `<p class="place">${escapeHtml(top.place)}</p>` : "")
    + `</section>`
    + (end && end > Date.now() ? `<div class="countdown" data-end="${end}" role="timer" aria-label="Time until the wedding">${units.map((u) => `<div><b>0</b><span>${u}</span></div>`).join("")}</div>` : "")
    + (cover ? `<img class="cover" src="/_site/photo/${cover.id}" alt="${escapeHtml(cover.caption || "")}" width="${cover.width || ""}" height="${cover.height || ""}">` : "")
    + (page.body ? `<div class="prose">${page.body}</div>` : "")
    + (s.rsvp_open ? `<div class="cta"><h2>Will you be there?</h2><a class="rsvp" href="/rsvp/">RSVP${s.rsvp_deadline ? ` by ${escapeHtml(longDate(s.rsvp_deadline).replace(/, \d{4}$/, ""))}` : ""}</a></div>` : "");
}

function galleryBody(page, photos) {
  const tiles = photos.map((p, i) => `<figure><button type="button" class="tile" data-full="/_site/photo/${p.id}" data-caption="${escapeHtml(p.caption)}">`
    + `<img src="/_site/photo/${p.id}/thumb" alt="${escapeHtml(p.caption || `Photo ${i + 1}`)}" loading="lazy"${p.width && p.height ? ` width="${p.width}" height="${p.height}"` : ""}></button>`
    + (p.caption ? `<figcaption>${escapeHtml(p.caption)}</figcaption>` : "") + `</figure>`).join("");
  return `<h1 class="page-title">${escapeHtml(page.title)}</h1>`
    + (page.body ? `<div class="prose" style="text-align:center">${page.body}</div>` : "")
    + (photos.length ? `<div class="grid">${tiles}</div>` : `<p class="empty">Photos are on their way.</p>`)
    + `<dialog class="lightbox" aria-label="Photo"><div class="box"><img alt=""><p></p><div class="row">`
    + `<button type="button" class="prev">Previous</button><button type="button" class="close">Close</button><button type="button" class="next">Next</button></div></div></dialog>`;
}

/**
 * One page of the coded site. `pages` is every page (for the menu), `photos` the gallery
 * (no image data), `base` "" live or PREVIEW_BASE in the preview.
 */
export function renderWebPage({ page, pages, photos, s, base = "", preview = false, missing = false }) {
  const names = topOf(s).header;
  const accent = /^#[0-9a-f]{6}$/i.test(s.rsvp_button_color) ? s.rsvp_button_color : RSVP_COLOR;
  const rsvp = s.rsvp_open ? `<a class="rsvp" href="/rsvp/">RSVP</a>` : "";
  let main;
  if (missing) main = `<h1 class="page-title">This page isn't here</h1><p class="empty"><a href="${base || "/"}">Go to the home page</a></p>`;
  else if (page.kind === "home") main = homeBody(page, s, photos);
  else if (page.kind === "gallery") main = galleryBody(page, photos);
  else if (page.kind === "guide") {
    main = `<div style="width:100%;--wm-text:var(--link);--wm-font:var(--serif);--wm-accent:${accent};--wm-bg:var(--bg)"><main class="wm-guide">${guideBody({ weddingDate: s.wedding_date })}</main></div>`;
  } else main = `<h1 class="page-title">${escapeHtml(page.title)}</h1><div class="prose">${page.body || ""}</div>`;
  const title = missing ? "Not found" : page.kind === "home" ? names : page.title;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}${page && page.kind !== "home" ? ` · ${escapeHtml(names)}` : ""}</title>
<link rel="icon" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>${SITE_CSS}:root{--accent:${accent}}${page && page.kind === "guide" ? GUIDE_CSS : ""}</style>
</head><body class="web">
<a class="skip" href="#main">Skip to the page</a>
${preview ? `<div class="preview-note"><b>Preview of the new website.</b> ${s.web_live ? "Guests see it too." : "Guests still see the Zola copy until you switch them in the control panel's Website page."}${page && !page.visible ? " This page is hidden from guests." : ""}</div>` : ""}
<header class="site-head">
<div class="phone-bar"><details class="menu"><summary>Menu</summary><nav aria-label="Site">${menuLinks(pages, page, base)}</nav></details>${rsvp}</div>
<p class="names"><a href="${base || "/"}">${escapeHtml(names)}</a></p>
<nav class="site-nav" aria-label="Site">${menuLinks(pages, page, base)}${rsvp}</nav>
</header>
<div class="site-main${page && page.kind === "home" ? " home" : ""}" id="main">${main}</div>
<footer class="site-foot"><p>${escapeHtml(names)}</p>${s.contact_email ? `<a href="mailto:${escapeHtml(s.contact_email)}">Contact us</a>` : ""}</footer>
<script>${PAGE_SCRIPT}</script>
</body></html>`;
}

/**
 * A page of the coded site, or null to let the request fall through (live mode only).
 * Live: anyone, visible pages only. Preview (/_new/...): signed in with the Website page.
 */
export async function serveWebsite(env, request, { preview = false } = {}) {
  const url = new URL(request.url);
  let path = preview ? url.pathname.slice(PREVIEW_BASE.length) : url.pathname;
  path = path.replace(/\/index\.html$/, "/").replace(/\/+$/, "").replace(/^\//, "");
  if (preview) {
    const user = await currentUser(request, env);
    if (!user || !(user.role === "admin" || user.pages.includes("website"))) return notFound();
  }
  // Our own paths (the RSVP page, the control panel...) are never pages of the site.
  if (path && (!SLUG.test(path) || (RESERVED.has(path) && path !== "things-to-do"))) return preview ? notFound() : null;
  const s = await loadSettings(env);
  const pages = await all(env, "SELECT id, slug, title, kind, body, url, in_menu, visible FROM web_pages ORDER BY sort_order, id");
  if (!pages.length) return preview ? notFound() : null;
  const page = pages.find((p) => p.slug === path);
  const base = preview ? PREVIEW_BASE : "";
  const headers = { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": preview ? "private, no-store" : "public, max-age=60" };
  if (!page || (!page.visible && !preview)) {
    // Live, the guide's address still works with no guide page (src/guide.js serves it).
    if (!preview && !page && path === "things-to-do") return null;
    return new Response(renderWebPage({ page: null, pages, photos: [], s, base, preview, missing: true }), { status: 404, headers });
  }
  if (page.kind === "link") return Response.redirect(page.url, 302);
  const photos = page.kind === "home" || page.kind === "gallery"
    ? await all(env, "SELECT id, caption, width, height FROM web_photos ORDER BY sort_order, id")
    : [];
  const html = renderWebPage({ page, pages, photos, s, base, preview });
  return new Response(request.method.toUpperCase() === "HEAD" ? null : html, { headers });
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
