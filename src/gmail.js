/**
 * Sending email through the Gmail account an admin connects in Settings (the scope is
 * GMAIL_SCOPE in src/auth.js).
 *
 * Storage (settings table, internal key):
 *   _gmail  { refresh_token, access_token, expires_at, email, connected_by, connected_at,
 *             last_error, last_error_at } -- the account the emails come from.
 *
 * The grant is the gmail.send scope only: this can send as that account, never read its
 * mail. Messages go to the Gmail API as raw MIME: a plain-text part, an HTML part with
 * the same words, and optionally the calendar invite as an .ics attachment.
 */

import { GOOGLE_TOKEN_URL } from "./auth.js";
import { deleteSetting, getSetting, setSetting } from "./db.js";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export async function saveGmailTokens(env, tokens, who) {
  await setSetting(env, "_gmail", {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    email: who.email,
    connected_by: who.connected_by,
    connected_at: new Date().toISOString(),
  });
}

export async function disconnectGmail(env) {
  const stored = await getSetting(env, "_gmail");
  await deleteSetting(env, "_gmail");
  // Revoking ends the whole Google grant, Drive's too when it's the same account.
  const drive = await getSetting(env, "_google_drive");
  if (stored?.refresh_token && !(drive?.refresh_token && drive.email && drive.email === stored.email)) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refresh_token)}`, { method: "POST" }).catch(() => {});
  }
}

export async function gmailStatus(env) {
  const stored = await getSetting(env, "_gmail");
  return {
    client_configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    connected: Boolean(stored?.refresh_token),
    email: stored?.email || null,
    connected_at: stored?.connected_at || null,
    last_error: stored?.last_error || null,
    last_error_at: stored?.last_error_at || null,
  };
}

/** Thrown when the connection itself is the problem, so a batch stops instead of failing every email. */
export class GmailConnectionError extends Error {}

/**
 * The connected account and a fresh access token, read once per batch of sends (each
 * D1 read counts against the Workers Free limit of 50 queries per request).
 */
export async function openGmail(env) {
  const stored = await getSetting(env, "_gmail");
  if (!stored?.refresh_token) throw new GmailConnectionError("Gmail isn't connected. Connect it in Settings.");
  if (stored.access_token && stored.expires_at - Date.now() > 120000) {
    return { email: stored.email, token: stored.access_token, last_error: stored.last_error || null, stored };
  }
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const message = `Gmail stopped accepting the connection (${response.status}). Reconnect Gmail in Settings.`;
    await setSetting(env, "_gmail", { ...stored, last_error: message, last_error_at: new Date().toISOString() });
    throw new GmailConnectionError(message);
  }
  const body = await response.json();
  const fresh = { ...stored, access_token: body.access_token, expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  if (body.refresh_token) fresh.refresh_token = body.refresh_token;
  await setSetting(env, "_gmail", fresh);
  return { email: fresh.email, token: fresh.access_token, last_error: fresh.last_error || null, stored: fresh };
}

/* -------------------------------------------------------------------- MIME ---- */

const utf8 = (text) => new TextEncoder().encode(text);
function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const base64Lines = (text) => base64(utf8(text)).replace(/.{76}/g, "$&\r\n");
const base64url = (text) => base64(utf8(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A header value: plain ASCII as is, anything else as an RFC 2047 encoded word. */
function headerText(text) {
  const clean = String(text).replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${base64(utf8(clean))}?=`;
}

/** `"Kaitlyn & Patrick" <us@gmail.com>`; the name is quoted so "&" and "," are safe. */
export function mailbox(name, email) {
  const address = String(email).replace(/[\r\n<>]/g, "");
  if (!name) return address;
  const encoded = headerText(name);
  return encoded.startsWith("=?") ? `${encoded} <${address}>` : `"${encoded.replace(/["\\]/g, "\\$&")}" <${address}>`;
}

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The plain text as simple HTML: paragraphs, line breaks, and clickable links. */
export function textToHtml(text) {
  const linked = (line) => escapeHtml(line).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
  const paragraphs = String(text).trim().split(/\n{2,}/).map((p) => `<p>${p.split("\n").map(linked).join("<br>")}</p>`);
  return `<!doctype html><html><body style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.55;color:#222;max-width:600px">${paragraphs.join("\n")}</body></html>`;
}

/** The whole message as MIME text. */
export function buildMime({ from, to, cc = [], subject, text, html = null, attachments = [] }) {
  const boundary = (tag) => `=_${tag}_${crypto.randomUUID().replace(/-/g, "")}`;
  const alt = boundary("alt");
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${headerText(subject)}`,
    "MIME-Version: 1.0",
  ];
  const alternative = [
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(text),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(html ?? textToHtml(text)),
    `--${alt}--`,
  ];
  if (!attachments.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, "", ...alternative, ""].join("\r\n");
  }
  const mixed = boundary("mixed");
  const parts = attachments.flatMap((a) => [
    `--${mixed}`,
    `Content-Type: ${a.type}; name="${a.filename}"`,
    `Content-Disposition: attachment; filename="${a.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(a.content),
  ]);
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    ...alternative,
    ...parts,
    `--${mixed}--`,
    "",
  ].join("\r\n");
}

/**
 * Send one email through a session from openGmail. `fromName` is the display name; the
 * address is the connected account's. Throws GmailConnectionError when the connection
 * or the daily limit is the problem (stop the batch), and a plain Error for a problem
 * with this one email.
 */
export async function sendGmail(env, session, { fromName, to, cc, subject, text, html, attachments }) {
  const raw = buildMime({ from: mailbox(fromName, session.email), to, cc, subject, text, html, attachments });
  const response = await fetch(SEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: base64url(raw) }),
  });
  if (response.ok) return response.json();
  const detail = (await response.text()).slice(0, 300);
  if (response.status === 401 || response.status === 403 || response.status === 429) {
    const message = response.status === 429
      ? "Gmail's sending limit was reached. The rest will go out later."
      : /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(detail)
        ? `Gmail refused to send (${response.status}): the Gmail API is turned off in Google Cloud. Turn it on in APIs & Services, Library (SETUP.md, section 3), wait a few minutes, and the waiting emails go out. ${detail}`
        : `Gmail refused to send (${response.status}). Reconnect Gmail in Settings. ${detail}`;
    const latest = (await getSetting(env, "_gmail")) || {};
    await setSetting(env, "_gmail", { ...latest, last_error: message, last_error_at: new Date().toISOString() });
    throw new GmailConnectionError(message);
  }
  throw new Error(`Gmail couldn't send this one (${response.status}): ${detail}`);
}
