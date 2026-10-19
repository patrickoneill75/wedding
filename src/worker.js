import { ensureSchema } from "./db.js";
import { currentUser, handleOAuthCallback, json, logoutResponse, sameSecret, startOAuth } from "./auth.js";
import { handleAdminApi } from "./admin_api.js";
import { handlePublicApi } from "./public_api.js";
import { saveDriveTokens } from "./google.js";
import { saveGmailTokens } from "./gmail.js";
import { processComms } from "./comms.js";
import { scheduledSync } from "./sync.js";
import { ingestSite, recordSiteError, serveFont, servePage } from "./site.js";
import { loadSettings } from "./store.js";
import { handleDayOf } from "./runofshow.js";

/**
 * Worker entry point. Every request comes here first (run_worker_first in
 * wrangler.jsonc): /api/* is handled below, "/" and the copied Zola pages ("/travel",
 * ...) come from D1 (src/site.js), /_site/fonts/* proxies the theme's fonts, and
 * everything else is a static file from public/ -- the RSVP page at /rsvp/, the expense
 * form at /submit/, the control panel at /admin/.
 *
 *   /api/auth/login      start Google sign-in for the control panel
 *   /api/auth/callback   Google's redirect target (sign-in, and connecting Drive or Gmail)
 *   /api/auth/me         who's signed in (401 if nobody)
 *   /api/auth/logout
 *   /api/admin/*         control panel (src/admin_api.js): admins, or users with the
 *                        page a route belongs to (ROUTE_PAGES)
 *   /api/public/*        RSVP and the unlisted expense form (src/public_api.js)
 *   /api/dayof/*         the coordinator's run of show for /dayof/ (src/runofshow.js):
 *                        the day-of link's key, or a sign-in with Run of show
 *   /api/site/config     GET, and /api/site/ingest POST: for the GitHub Action that
 *                        copies the Zola site (scripts/zola_refresh.mjs). Both need
 *                        "Authorization: Bearer <ZOLA_INGEST_SECRET>".
 *   /api/config-check    which secrets are set -- never their values. Unauthenticated
 *                        on purpose: you can't sign in to diagnose a broken sign-in.
 *
 * CONFIGURATION (see SETUP.md)
 *   GOOGLE_CLIENT_ID      (secret)  OAuth client from Google Cloud
 *   GOOGLE_CLIENT_SECRET  (secret)
 *   ADMIN_EMAILS          (secret)  comma-separated Google accounts allowed into the
 *                                   control panel. A secret rather than a var because
 *                                   this repo is public.
 *   DB                    (D1 binding, wrangler.jsonc)
 *
 *   ZOLA_URL              (var)     the Zola wedding website to copy onto the home page;
 *                                   Settings can override it.
 *   ZOLA_INGEST_SECRET    (secret)  shared with the GitHub Action that copies the site.
 *   GH_DISPATCH_TOKEN     (secret)  lets "Refresh from Zola" start that Action; with
 *   GITHUB_REPO           (var)     the repo it lives in.
 *   PUBLIC_URL            (var)     the site's address (https://www.patrickandkaitlyn.com):
 *                                   the expense form link uses it, and the bare domain
 *                                   redirects to it.
 *   ANTHROPIC_API_KEY     (secret)  Claude, for the expense form's conversation.
 *
 * The cron (every five minutes) sends guest emails that are due (src/comms.js), then
 * pushes CSV exports to Google Drive when something changed since the last sync. The Zola copy is refreshed by the GitHub Action, daily.
 */

const SECRETS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_EMAILS"];
const OPTIONAL_SECRETS = ["ZOLA_INGEST_SECRET", "GH_DISPATCH_TOKEN", "ANTHROPIC_API_KEY"];

async function handleSiteApi(route, request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!env.ZOLA_INGEST_SECRET) return json({ error: "ZOLA_INGEST_SECRET isn't set on the Worker. See SETUP.md." }, 503);
  if (!sameSecret(auth.replace(/^Bearer\s+/i, ""), env.ZOLA_INGEST_SECRET)) return json({ error: "Wrong or missing secret." }, 401);
  const method = request.method.toUpperCase();
  if (route === "site/config" && method === "GET") {
    const s = await loadSettings(env);
    return json({ zola_url: s.zola_url || env.ZOLA_URL || "", rsvp_button_color: s.rsvp_button_color || "" });
  }
  if (route === "site/ingest" && method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Expected JSON." }, 400);
    }
    try {
      return json({ ok: true, status: await ingestSite(env, payload) });
    } catch (error) {
      // Settings shows it: otherwise a refused copy looks like nothing happened.
      await recordSiteError(env, `GitHub's copy was refused: ${error.message}`, { source: "github" }).catch(() => {});
      return json({ error: error.message }, 400);
    }
  }
  return json({ error: "Not found." }, 404);
}

async function handleApi(route, request, env) {
  const method = request.method.toUpperCase();

  if (route === "config-check" && method === "GET") {
    const present = Object.fromEntries([...SECRETS, ...OPTIONAL_SECRETS].map((name) => [name, Boolean(env[name])]));
    return json({ present, d1_bound: Boolean(env.DB), ready: Boolean(env.DB) && SECRETS.every((n) => present[n]) });
  }
  if (!env.DB) return json({ error: "The D1 database isn't bound to this Worker. See SETUP.md." }, 500);
  await ensureSchema(env);

  if (route === "auth/login" && method === "GET") {
    return startOAuth(request, env, "login", { next: new URL(request.url).searchParams.get("next") });
  }
  if (route === "auth/callback" && method === "GET") return handleOAuthCallback(request, env, { drive: saveDriveTokens, gmail: saveGmailTokens });
  if (route === "auth/logout" && method === "POST") return logoutResponse();
  if (route === "auth/me" && method === "GET") {
    const user = await currentUser(request, env);
    return user ? json({ user }) : json({ error: "Not signed in." }, 401);
  }
  if (route.startsWith("admin/")) return handleAdminApi(route.slice("admin/".length), request, env);
  if (route.startsWith("public/")) return handlePublicApi(route.slice("public/".length), request, env);
  if (route.startsWith("site/")) return handleSiteApi(route, request, env);
  if (route === "dayof" || route.startsWith("dayof/")) return handleDayOf(route, request, env);
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // One address: the bare domain goes to the www one (PUBLIC_URL), so sign-in cookies
    // and links all live on one host.
    const canonical = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : null;
    if (canonical && url.hostname !== canonical.hostname && `www.${url.hostname}` === canonical.hostname) {
      return Response.redirect(`${canonical.origin}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(url.pathname.slice("/api/".length).replace(/\/+$/, ""), request, env);
      } catch (error) {
        return json({ error: error.message || String(error) }, 500);
      }
    }
    if (url.pathname.startsWith("/_site/fonts/")) return serveFont(url.pathname);
    const method = request.method.toUpperCase();
    const pageLike = url.pathname === "/index.html" || !url.pathname.includes(".", url.pathname.lastIndexOf("/"));
    if ((method === "GET" || method === "HEAD") && env.DB && pageLike) {
      try {
        await ensureSchema(env);
        const page = await servePage(env, url.pathname);
        if (page) return page;
      } catch (error) {
        console.error("Serving the website copy failed:", error.message);
      }
      // No copy of the Zola site yet: the RSVP page is the home page.
      if (url.pathname === "/" || url.pathname === "/index.html") return Response.redirect(`${url.origin}/rsvp/`, 302);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    // Emails first: they're time-sensitive. A run that sent emails leaves the Drive sync
    // to the next run, five minutes later, so one run stays under the Workers Free limits
    // (50 D1 queries and 50 subrequests).
    ctx.waitUntil(
      ensureSchema(env)
        .then(() => processComms(env))
        .catch((error) => {
          console.error("Sending emails failed:", error.message);
          return null;
        })
        .then((comms) => (comms?.sent || comms?.failed ? null : scheduledSync(env)))
        .catch((error) => console.error("Drive sync failed:", error.message))
    );
  },
};
