// Google's folder picker, on a page of its own so Google's script never runs next to
// the finance numbers. Picking a folder grants this app access to that folder only.

const $ = (id) => document.getElementById(id);
const msg = (text, kind = "") => {
  $("msg").textContent = text;
  $("msg").className = `msg ${kind}`;
};
const post = async (path, body) => {
  const r = await fetch(path, { method: "POST", headers: { "x-wedding": "1", "content-type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) location.href = "/admin/login.html?next=%2Fadmin%2Fpersonal%2F";
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status}).`);
  return data;
};
const back = () => location.replace("/admin/personal/?drive=folder#drive");

$("fallback").addEventListener("click", async () => {
  try {
    msg("Making the folder…");
    await post("/api/personal/drive/folder/new");
    back();
  } catch (error) {
    msg(error.message, "err");
  }
});

let config;
try {
  const r = await fetch("/api/personal/drive/picker", { headers: { "x-wedding": "1" }, credentials: "same-origin" });
  config = await r.json();
  if (r.status === 401) location.href = "/admin/login.html?next=%2Fadmin%2Fpersonal%2F";
  if (!r.ok) throw new Error(config.error || `Request failed (${r.status}).`);
  $("who").textContent = `Google's folder picker opens for ${config.email}. Pick a folder, then click Select.`;
} catch (error) {
  msg(`${error.message} You can use the other button to make a folder instead.`, "err");
}

function loadGoogle() {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://apis.google.com/js/api.js";
    s.onload = () => window.gapi.load("picker", { callback: resolve, onerror: reject });
    s.onerror = () => reject(new Error("Google's picker didn't load."));
    document.head.append(s);
  });
}

function openPicker() {
  const google = window.google;
  const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true)
    .setMimeTypes("application/vnd.google-apps.folder");
  const picker = new google.picker.PickerBuilder()
    .setTitle("Choose a folder for your finance file")
    .addView(view)
    .setOAuthToken(config.token)
    .setDeveloperKey(config.apiKey)
    .setAppId(config.appId)
    .setCallback(async (data) => {
      if (data.action === google.picker.Action.PICKED) {
        const folder = data.docs?.[0];
        if (!folder) return;
        try {
          msg(`Using "${folder.name}"…`);
          await post("/api/personal/drive/folder", { id: folder.id, name: folder.name });
          back();
        } catch (error) {
          msg(`${error.message} If Google won't let the app use that folder, make a "Finances" folder instead and move it where you like in Drive.`, "err");
        }
      } else if (data.action === google.picker.Action.CANCEL) {
        msg("No folder picked.");
      }
    })
    .build();
  picker.setVisible(true);
}

if (config?.token) {
  try {
    await loadGoogle();
    $("open").disabled = false;
    $("open").addEventListener("click", openPicker);
    openPicker();
  } catch (error) {
    msg(`${error.message} You can make a "Finances" folder instead.`, "err");
  }
}
