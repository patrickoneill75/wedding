/**
 * Google Drive: the connection, the folder picker, and file upserts.
 *
 * Storage (settings table, internal keys):
 *   _google_drive  { refresh_token, access_token, expires_at, email, connected_by,
 *                    connected_at } -- the account whose Drive receives the files.
 *   _drive_folder  { id, name } -- the folder picked in the control panel. CSV
 *                    exports land directly in it; receipts and contracts go in a
 *                    "Receipts" subfolder created on first upload.
 *
 * Uploads upsert by name: look the file up first and upload a new revision if it
 * exists, so a sync updates guests.csv instead of piling up copies of it.
 */

import { GOOGLE_TOKEN_URL } from "./auth.js";
import { deleteSetting, getSetting, setSetting } from "./db.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const RECEIPTS_FOLDER = "Receipts";
const ALL_DRIVES = "supportsAllDrives=true&includeItemsFromAllDrives=true";

export async function saveDriveTokens(env, tokens, who) {
  await setSetting(env, "_google_drive", {
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    email: who.email,
    connected_by: who.connected_by,
    connected_at: new Date().toISOString(),
  });
}

export async function disconnectDrive(env) {
  const stored = await getSetting(env, "_google_drive");
  await deleteSetting(env, "_google_drive");
  if (stored?.refresh_token) {
    // Best effort: revoke so the grant disappears from the Google account too.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.refresh_token)}`, {
      method: "POST",
    }).catch(() => {});
  }
}

export async function driveStatus(env) {
  const stored = await getSetting(env, "_google_drive");
  const folder = await getSetting(env, "_drive_folder");
  const lastSync = await getSetting(env, "_sync_last");
  const dirtyAt = await getSetting(env, "_sync_dirty_at");
  return {
    client_configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    connected: Boolean(stored?.refresh_token),
    email: stored?.email || null,
    connected_at: stored?.connected_at || null,
    folder,
    last_sync: lastSync,
    pending_changes: Boolean(dirtyAt && (!lastSync?.ok_at || dirtyAt > lastSync.ok_at)),
  };
}

/** A valid access token, refreshing it if it's within two minutes of expiring. */
export async function driveAccessToken(env) {
  const stored = await getSetting(env, "_google_drive");
  if (!stored?.refresh_token) throw new Error("Google Drive isn't connected. Connect it in Settings.");
  if (stored.access_token && stored.expires_at - Date.now() > 120000) return stored.access_token;
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
    const text = (await response.text()).slice(0, 300);
    throw new Error(`Google Drive token refresh failed (${response.status}). Reconnect Drive in Settings. ${text}`);
  }
  const body = await response.json();
  const fresh = {
    ...stored,
    access_token: body.access_token,
    expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000,
  };
  if (body.refresh_token) fresh.refresh_token = body.refresh_token;
  await setSetting(env, "_google_drive", fresh);
  return fresh.access_token;
}

async function driveFetch(env, url, init = {}) {
  const token = await driveAccessToken(env);
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Google Drive error (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

const quote = (text) => `'${String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export async function listFolders(env, parentId = "root") {
  const q = `${quote(parentId)} in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const url = `${DRIVE_API}/files?${new URLSearchParams({
    q,
    fields: "files(id,name)",
    orderBy: "name",
    pageSize: "200",
  })}&${ALL_DRIVES}`;
  const body = await driveFetch(env, url);
  return body.files || [];
}

export async function folderInfo(env, folderId) {
  return driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`);
}

export async function createFolder(env, name, parentId = "root") {
  return driveFetch(env, `${DRIVE_API}/files?fields=id,name&supportsAllDrives=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
}

async function findByName(env, parentId, name, mimeType = null) {
  let q = `${quote(parentId)} in parents and name = ${quote(name)} and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;
  const url = `${DRIVE_API}/files?${new URLSearchParams({ q, fields: "files(id,name,webViewLink)", pageSize: "10" })}&${ALL_DRIVES}`;
  const body = await driveFetch(env, url);
  return (body.files || [])[0] || null;
}

function multipartBody(metadata, content, contentType) {
  const boundary = `wedding${crypto.randomUUID().replace(/-/g, "")}`;
  const body = new Blob([
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function createFile(env, parentId, name, content, contentType) {
  const { body, contentType: type } = multipartBody({ name, parents: [parentId] }, content, contentType);
  return driveFetch(env, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true`, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

/** Create the file, or upload a new revision of the one already there with that name. */
export async function upsertFile(env, parentId, name, content, contentType) {
  const existing = await findByName(env, parentId, name);
  if (!existing) return createFile(env, parentId, name, content, contentType);
  return driveFetch(
    env,
    `${DRIVE_UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=media&fields=id,name,webViewLink&supportsAllDrives=true`,
    { method: "PATCH", headers: { "content-type": contentType }, body: content }
  );
}

export async function requireFolder(env) {
  const folder = await getSetting(env, "_drive_folder");
  if (!folder?.id) throw new Error("Pick a Google Drive folder in Settings first.");
  return folder;
}

/** Upload a receipt/contract into <folder>/Receipts. Never overwrites: names are made unique. */
export async function uploadReceipt(env, file, label) {
  const folder = await requireFolder(env);
  let receipts = await findByName(env, folder.id, RECEIPTS_FOLDER, FOLDER_MIME);
  if (!receipts) receipts = await createFolder(env, RECEIPTS_FOLDER, folder.id);
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
  const safeLabel = String(label || "").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80);
  const name = `${stamp} ${safeLabel ? `${safeLabel} - ` : ""}${file.name || "upload"}`;
  return createFile(env, receipts.id, name, file, file.type || "application/octet-stream");
}
