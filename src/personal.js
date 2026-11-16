/**
 * The private finance tool at /admin/personal/: the page gate and its API.
 *
 * Who: only emails in the PERSONAL_EMAILS secret (see personalEmails in src/auth.js),
 * checked here on the server for the page, its files and every API call. Being a
 * wedding admin is not enough.
 *
 * Where the numbers live: one JSON file in a Google Drive folder, linked with the
 * narrow drive.file permission (the app sees only files it made or that someone picked
 * for it in Google's picker). D1 keeps only the link: tokens, the folder and the file
 * id (setting `_personal_drive`), never the numbers. All the math runs in the browser
 * (public/admin/personal/engine.js); the Worker only stores and returns the file.
 *
 * Privacy: numbers travel only in request and response bodies, never in a URL. Nothing
 * here logs a body, and Drive's error replies are reduced to their status code.
 * Responses are no-store and noindex; the page gets a content policy that allows no
 * script or connection outside this site.
 *
 *   GET  model            { linked, drive, model, version }
 *   PUT  model            { model, base, force } -> { version }; 409 if the file
 *                         changed since `base` (someone else saved), with theirs
 *   GET  drive/link       start Google's consent (drive.file, offline)
 *   GET  drive/picker     { token, apiKey, appId } for the folder picker page
 *   POST drive/folder     { id, name } use a picked folder (moves the file there)
 *   POST drive/folder/new make a "Finances" folder in My Drive and use it
 *   POST drive/unlink     forget the link (the file stays in Drive)
 */

import { currentUser, GOOGLE_TOKEN_URL, json, startOAuth } from "./auth.js";
import { deleteSetting, getSetting, setSetting } from "./db.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const KEY = "_personal_drive";
export const FILE_NAME = "lifetime-finances.json";
export const MAX_BYTES = 4 * 1024 * 1024;
const NO_STORE = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };

/** The page's content policy: nothing from outside this site, no framing. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// The folder picker page runs Google's picker script, so it gets a looser policy. It
// shows no numbers: it only asks Google for a folder.
const PICKER_PATH = "/admin/personal/picker.html";

const reply = (body, status = 200) => json(body, status, NO_STORE);

/** [user, null] or [null, response]: signed in, on PERSONAL_EMAILS, and the CSRF header for writes. */
export async function requirePersonal(request, env) {
  const user = await currentUser(request, env);
  if (!user) return [null, reply({ error: "Not signed in." }, 401)];
  if (!user.personal) return [null, reply({ error: "This page is private." }, 403)];
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && request.headers.get("x-wedding") !== "1") {
    return [null, reply({ error: "Missing X-Wedding header." }, 403)];
  }
  return [user, null];
}

/**
 * Whether a request path is the finance tool's, however it's spelled: percent-encoded
 * letters, doubled slashes and capitals all count, so no spelling slips past the gate
 * to the static files.
 */
export function isPersonalPath(pathname) {
  let p = String(pathname || "");
  for (let n = 0; n < 3; n++) {
    try {
      const next = decodeURIComponent(p);
      if (next === p) break;
      p = next;
    } catch {
      break;
    }
  }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  return p === "/admin/personal" || p.startsWith("/admin/personal/") || p.startsWith("/admin/personal.");
}

/**
 * The page and its files (/admin/personal/...): the server-side gate. Not signed in
 * -> the login page, and back here after. Signed in but not on the list -> 403.
 */
export async function servePersonalPage(request, env) {
  const url = new URL(request.url);
  const user = await currentUser(request, env);
  const html = url.pathname.endsWith("/") || url.pathname.endsWith(".html") || !url.pathname.slice(url.pathname.lastIndexOf("/")).includes(".");
  if (!user) {
    if (html) return new Response(null, { status: 302, headers: { location: "/admin/login.html?next=%2Fadmin%2Fpersonal%2F", ...NO_STORE } });
    return new Response("Not signed in.", { status: 401, headers: NO_STORE });
  }
  if (!user.personal) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Private</title><link rel="stylesheet" href="/admin/admin.css"><div class="wrap"><div class="card"><h2>This page is private</h2><p class="desc">You're signed in, but this account isn't on the list for this page.</p><p><a class="btn" href="/admin/index.html">Back to the control panel</a></p></div></div>`,
      { status: 403, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } }
    );
  }
  const asset = await env.ASSETS.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [k, v] of Object.entries(NO_STORE)) response.headers.set(k, v);
  // The picker page tells Google which site it's on (the origin only), so the picker's
  // API key can be locked to this website. It shows no numbers; every other page sends
  // no referrer at all.
  response.headers.set("referrer-policy", url.pathname === PICKER_PATH ? "strict-origin" : "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  if (url.pathname !== PICKER_PATH) response.headers.set("content-security-policy", PAGE_CSP);
  else response.headers.set("content-security-policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
  return response;
}

/* ------------------------------------------------------------------ the Drive link -- */

export async function savePersonalTokens(env, tokens, who) {
  const old = (await getSetting(env, KEY)) || {};
  await setSetting(env, KEY, {
    // A relink with another account starts without a folder or file: those belong to
    // the old account's Drive.
    ...(old.email === who.email ? { folder: old.folder, file_id: old.file_id } : {}),
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    email: who.email,
    linked_by: who.connected_by,
    linked_at: new Date().toISOString(),
  });
}

class DriveError extends Error {
  constructor(status, what) {
    super(`Google Drive refused to ${what} (${status}).`);
    this.status = status;
  }
}

async function accessToken(env, link) {
  if (link.access_token && link.expires_at - Date.now() > 120000) return link.access_token;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: link.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new DriveError(response.status, "renew the link; unlink and link Drive again in Settings");
  const body = await response.json();
  link.access_token = body.access_token;
  link.expires_at = Date.now() + (Number(body.expires_in) || 3600) * 1000;
  if (body.refresh_token) link.refresh_token = body.refresh_token;
  await setSetting(env, KEY, link);
  return link.access_token;
}

async function drive(env, link, url, init, what) {
  const token = await accessToken(env, link);
  const response = await fetch(url, { ...init, headers: { ...(init?.headers || {}), authorization: `Bearer ${token}` } });
  // Only the status: Drive's reply never reaches a log or the browser.
  if (!response.ok) throw new DriveError(response.status, what);
  return response;
}

const folderUrl = (id) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;

function publicLink(link) {
  if (!link?.refresh_token) return { linked: false };
  return {
    linked: true,
    email: link.email,
    linked_by: link.linked_by,
    folder: link.folder ? { ...link.folder, url: folderUrl(link.folder.id) } : null,
    has_file: Boolean(link.file_id),
  };
}

async function fileMeta(env, link) {
  if (!link.file_id) return null;
  try {
    const r = await drive(env, link, `${DRIVE_API}/files/${encodeURIComponent(link.file_id)}?fields=id,version,trashed,parents`, {}, "find the file");
    const meta = await r.json();
    return meta.trashed ? null : meta;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function readModel(env, link) {
  const meta = await fileMeta(env, link);
  if (!meta) return { model: null, version: null };
  const r = await drive(env, link, `${DRIVE_API}/files/${encodeURIComponent(link.file_id)}?alt=media`, {}, "read the file");
  let model = null;
  try {
    model = JSON.parse(await r.text());
  } catch {
    throw new Error("The finance file in Drive isn't valid JSON. Import a backup to replace it.");
  }
  return { model, version: String(meta.version) };
}

async function createFile(env, link, text) {
  const boundary = `b${crypto.randomUUID().replace(/-/g, "")}`;
  const metadata = { name: FILE_NAME, mimeType: "application/json", parents: [link.folder.id] };
  const body = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\ncontent-type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  const r = await drive(env, link, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,version`, {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
  }, "save a file in that folder");
  return r.json();
}

/* ------------------------------------------------------------------------ routes -- */

export async function handlePersonalApi(route, request, env) {
  const [user, denied] = await requirePersonal(request, env);
  if (denied) return denied;
  const method = request.method.toUpperCase();
  try {
    return await routes(route, method, request, env, user);
  } catch (error) {
    // DriveError messages carry only a status; anything else is our own message.
    return reply({ error: error instanceof DriveError || error instanceof Error ? error.message : "Something went wrong." }, error.status === 404 ? 404 : 502);
  }
}

async function routes(route, method, request, env, user) {
  const link = await getSetting(env, KEY);

  if (route === "drive/link" && method === "GET") return startOAuth(request, env, "personal", { loginHint: user.email });

  if (route === "model" && method === "GET") {
    const status = publicLink(link);
    if (!status.linked || !link.folder) return reply({ ...status, model: null, version: null });
    const { model, version } = await readModel(env, link);
    return reply({ ...status, model, version });
  }

  if (!link?.refresh_token) return reply({ error: "Link Google Drive first, in Settings." }, 409);

  if (route === "model" && method === "PUT") {
    if (!link.folder) return reply({ error: "Pick a Drive folder first, in Settings." }, 409);
    const text = await request.text();
    if (text.length > MAX_BYTES) return reply({ error: "That's too big to save (over 4 MB)." }, 413);
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      return reply({ error: "That isn't valid JSON." }, 400);
    }
    if (!input || typeof input !== "object" || !input.model || typeof input.model !== "object" || Array.isArray(input.model)) {
      return reply({ error: "Send { model: {...} }." }, 400);
    }
    const body = JSON.stringify(input.model);
    const meta = await fileMeta(env, link);
    if (meta && !input.force && String(meta.version) !== String(input.base ?? "")) {
      // Someone saved since this browser loaded: hand back theirs so the page can ask.
      const theirs = await readModel(env, link);
      return reply({ error: "The file changed since you opened it.", conflict: true, ...theirs }, 409);
    }
    if (!meta) {
      const created = await createFile(env, link, body);
      link.file_id = created.id;
      await setSetting(env, KEY, link);
      return reply({ version: String(created.version), saved_at: new Date().toISOString() });
    }
    const r = await drive(env, link, `${DRIVE_UPLOAD}/files/${encodeURIComponent(link.file_id)}?uploadType=media&fields=id,version`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }, "save the file");
    const saved = await r.json();
    return reply({ version: String(saved.version), saved_at: new Date().toISOString() });
  }

  if (route === "drive/picker" && method === "GET") {
    if (!env.GOOGLE_PICKER_API_KEY) return reply({ error: "GOOGLE_PICKER_API_KEY isn't set on the Worker. See SETUP.md, \"Finance tool\"." }, 409);
    const token = await accessToken(env, link);
    // The app (project) number is the part of the OAuth client ID before the first dash.
    return reply({ token, apiKey: env.GOOGLE_PICKER_API_KEY, appId: String(env.GOOGLE_CLIENT_ID || "").split("-")[0], email: link.email });
  }

  if (route === "drive/folder" && method === "POST") {
    let input;
    try {
      input = await request.json();
    } catch {
      return reply({ error: "That isn't valid JSON." }, 400);
    }
    const id = typeof input?.id === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(input.id) ? input.id : "";
    if (!id) return reply({ error: "Pick a folder." }, 400);
    const r = await drive(env, link, `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType`, {}, "open that folder");
    const folder = await r.json();
    if (folder.mimeType !== FOLDER_MIME) return reply({ error: "That's a file, not a folder." }, 400);
    return reply(await useFolder(env, link, { id: folder.id, name: folder.name }));
  }

  if (route === "drive/folder/new" && method === "POST") {
    const r = await drive(env, link, `${DRIVE_API}/files?fields=id,name`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Finances", mimeType: FOLDER_MIME }),
    }, "make a folder");
    const folder = await r.json();
    return reply(await useFolder(env, link, { id: folder.id, name: folder.name }));
  }

  if (route === "drive/unlink" && method === "POST") {
    if (link.refresh_token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(link.refresh_token)}`, { method: "POST" }).catch(() => {});
    }
    await deleteSetting(env, KEY);
    return reply({ linked: false });
  }

  return reply({ error: "Not found." }, 404);
}

/** Point the link at `folder`, moving the file there if there is one (never a fresh empty file). */
async function useFolder(env, link, folder) {
  const meta = await fileMeta(env, link);
  if (meta && !(meta.parents || []).includes(folder.id)) {
    const params = new URLSearchParams({ addParents: folder.id, fields: "id,parents" });
    if (meta.parents?.length) params.set("removeParents", meta.parents.join(","));
    await drive(env, link, `${DRIVE_API}/files/${encodeURIComponent(link.file_id)}?${params}`, { method: "PATCH" }, "move the file to that folder");
  }
  if (!meta) delete link.file_id;
  link.folder = folder;
  await setSetting(env, KEY, link);
  return publicLink(link);
}

