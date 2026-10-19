/**
 * Control-panel sign-in with Google, plus the signing helpers everything else uses.
 *
 * Who may sign in: the owners in the comma-separated ADMIN_EMAILS secret, who are always
 * admins, and anyone an admin adds in Settings > Users (the users table, src/users.js),
 * each an admin or a user limited to some pages. Google proves the email; these lists
 * decide whether it gets in, and both are re-checked on every request, so removing
 * someone locks them out at once.
 *
 * Page access is checked per API route (requirePage), matching the control panel's
 * pages. A user sees only their pages' data; Settings, Drive, the import and Users are
 * admin-only.
 *
 * Sessions are a signed cookie (HMAC-SHA256), HttpOnly and SameSite=Lax, valid for 30
 * days. The signing key is generated on first use and kept in D1 (_session_secret), so
 * there is no secret to set for it -- deleting that row signs everyone out.
 *
 * CSRF: every state-changing admin request must carry the X-Wedding header. A
 * cross-site form can't set a custom header, and a cross-site fetch() that does gets
 * stopped at the CORS preflight, which this Worker never answers.
 *
 * One OAuth callback serves two purposes, told apart by the signed `state`:
 *   login  scopes openid/email/profile; sets the session cookie.
 *   drive  adds the Drive scope with offline access; stores the refresh token (see
 *          src/google.js). Requires an existing admin session.
 * The state also carries a nonce matched against a short-lived cookie, so a callback
 * URL can't be replayed into someone else's browser.
 */

import { first, getSetting, setSetting } from "./db.js";

const encoder = new TextEncoder();
const SESSION_COOKIE = "wedding_session";
const STATE_COOKIE = "wedding_oauth";
const SESSION_TTL = 60 * 60 * 24 * 30;
const STATE_TTL = 60 * 10;

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Constant-time comparison, so a wrong secret can't be guessed a character at a time. */
export function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

export function randomToken(bytes = 24) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function signingKey(env) {
  let secret = await getSetting(env, "_session_secret");
  if (!secret) {
    secret = randomToken(32);
    await setSetting(env, "_session_secret", secret);
  }
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** A tamper-proof, expiring token: base64url(JSON).base64url(HMAC). */
export async function sign(env, payload, ttlSeconds) {
  const body = b64url(encoder.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const mac = await crypto.subtle.sign("HMAC", await signingKey(env), encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(mac))}`;
}

export async function verify(env, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  let macBytes;
  try {
    macBytes = b64urlDecode(mac);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify("HMAC", await signingKey(env), macBytes, encoder.encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** The control panel's pages a user can be given. Settings and Users are admin-only. */
export const PAGES = ["dashboard", "expenses", "vendors", "guests", "seating", "runofshow", "reports"];

/**
 * Who this email is: { role: "admin" | "user", pages, owner } or null if they may not
 * sign in. Owners (ADMIN_EMAILS) are always admins and can't be locked out from
 * Settings > Users.
 */
export async function accessFor(env, email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return null;
  if (adminEmails(env).includes(clean)) return { role: "admin", pages: [...PAGES], owner: true };
  const row = await first(env, "SELECT role, pages FROM users WHERE email = ?", clean);
  if (!row) return null;
  if (row.role === "admin") return { role: "admin", pages: [...PAGES], owner: false };
  let pages = [];
  try {
    pages = JSON.parse(row.pages);
  } catch {}
  return { role: "user", pages: (Array.isArray(pages) ? pages : []).filter((p) => PAGES.includes(p)), owner: false };
}

/** The signed-in person, or null. Re-checks access on every request, so removing someone locks them out. */
export async function currentUser(request, env) {
  const payload = await verify(env, readCookie(request, SESSION_COOKIE));
  if (!payload || payload.kind !== "session") return null;
  const access = await accessFor(env, payload.email);
  if (!access) return null;
  return { email: payload.email, name: payload.name || payload.email, ...access };
}

/**
 * Returns [user, null] or [null, errorResponse]. With `page`, a user needs that page;
 * with page "admin", only an admin gets through. Admins get through everything.
 */
export async function requirePage(request, env, page) {
  const [user, denied] = await requireAdmin(request, env, { anyone: true });
  if (denied) return [null, denied];
  if (user.role === "admin") return [user, null];
  if (page === "admin" || !user.pages.includes(page)) {
    return [null, json({ error: "You don't have access to this. Ask Patrick or Kaitlyn to add it in Settings > Users." }, 403)];
  }
  return [user, null];
}

/** Returns [user, null] or [null, errorResponse]: an admin, unless `anyone` lets a user through. */
export async function requireAdmin(request, env, { anyone = false } = {}) {
  const user = await currentUser(request, env);
  if (!user) return [null, json({ error: "Not signed in." }, 401)];
  if (!anyone && user.role !== "admin") return [null, json({ error: "Only an admin can do that." }, 403)];
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && request.headers.get("x-wedding") !== "1") {
    return [null, json({ error: "Missing X-Wedding header." }, 403)];
  }
  return [user, null];
}

/** A page on this site to return to after signing in ("/submit"), or "" for anything else. */
export function safeNext(next) {
  const path = String(next || "");
  return /^\/(?!\/)[A-Za-z0-9/_.#-]*$/.test(path) && !path.includes("\\") ? path : "";
}

function redirectUri(request) {
  return `${new URL(request.url).origin}/api/auth/callback`;
}

/** Start a Google OAuth round trip: redirect to Google with a signed state. */
export async function startOAuth(request, env, purpose, extra = {}) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on this Worker. See SETUP.md." }, 500);
  }
  const nonce = randomToken(16);
  const state = await sign(env, { kind: "oauth", purpose, nonce, next: safeNext(extra.next) }, STATE_TTL);
  const scopes = ["openid", "email", "profile"];
  const params = {
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: "code",
    state,
    prompt: "select_account",
  };
  if (purpose === "drive") {
    scopes.push(DRIVE_SCOPE);
    params.access_type = "offline";
    // consent forces Google to issue a refresh token even if one was issued before.
    params.prompt = "consent select_account";
    if (extra.loginHint) params.login_hint = extra.loginHint;
  }
  params.scope = scopes.join(" ");
  return new Response(null, {
    status: 302,
    headers: {
      location: `${GOOGLE_AUTH_URL}?${new URLSearchParams(params)}`,
      "set-cookie": cookie(STATE_COOKIE, nonce, STATE_TTL),
      "cache-control": "no-store",
    },
  });
}

async function exchangeCode(request, env, code) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

async function fetchUserInfo(accessToken) {
  const response = await fetch(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google userinfo failed (${response.status})`);
  return response.json();
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/**
 * Google sends the browser here after consent. `onDriveTokens(env, tokens, userinfo)`
 * is supplied by src/google.js so this module doesn't import Drive code.
 */
export async function handleOAuthCallback(request, env, onDriveTokens) {
  const url = new URL(request.url);
  const clearState = cookie(STATE_COOKIE, "", 0);
  const fail = (page, msg) => redirect(`${page}?error=${encodeURIComponent(msg)}`, [clearState]);

  const state = await verify(env, url.searchParams.get("state"));
  if (!state || state.kind !== "oauth" || state.nonce !== readCookie(request, STATE_COOKIE)) {
    return fail("/admin/login.html", "That sign-in link expired or was already used. Try again.");
  }
  const page = state.purpose === "drive" ? "/admin/settings.html" : "/admin/login.html";
  if (url.searchParams.get("error")) return fail(page, `Google said: ${url.searchParams.get("error")}`);
  const code = url.searchParams.get("code");
  if (!code) return fail(page, "Google didn't return a sign-in code.");

  let tokens;
  let info;
  try {
    tokens = await exchangeCode(request, env, code);
    info = await fetchUserInfo(tokens.access_token);
  } catch (error) {
    return fail(page, error.message);
  }
  const email = String(info.email || "").toLowerCase();

  if (state.purpose === "drive") {
    const user = await currentUser(request, env);
    if (!user) return fail("/admin/login.html", "Sign in before connecting Google Drive.");
    if (!tokens.refresh_token) {
      return fail(page, "Google didn't grant offline access. Remove the app at myaccount.google.com/permissions and try again.");
    }
    if (!String(tokens.scope || "").split(" ").includes(DRIVE_SCOPE)) {
      return fail(page, "Drive access wasn't granted. Tick the Google Drive box on the consent screen.");
    }
    await onDriveTokens(env, tokens, { email, connected_by: user.email });
    return redirect("/admin/settings.html?drive=connected#drive", [clearState]);
  }

  if (!info.email_verified || !(await accessFor(env, email))) {
    return fail("/admin/login.html", `${email || "That account"} isn't on the control panel's list of people who can sign in.`);
  }
  const session = await sign(env, { kind: "session", email, name: info.name || email }, SESSION_TTL);
  return redirect(safeNext(state.next) || "/admin/index.html", [clearState, cookie(SESSION_COOKIE, session, SESSION_TTL)]);
}

export function logoutResponse() {
  return json({ ok: true }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
}
