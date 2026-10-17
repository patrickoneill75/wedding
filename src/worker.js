import { ensureSchema } from "./db.js";
import { currentUser, handleOAuthCallback, json, logoutResponse, startOAuth } from "./auth.js";
import { handleAdminApi } from "./admin_api.js";
import { handlePublicApi } from "./public_api.js";
import { saveDriveTokens } from "./google.js";
import { scheduledSync } from "./sync.js";

/**
 * Worker entry point. public/ is served by Cloudflare's asset layer; /api/* runs here.
 *
 *   /api/auth/login      start Google sign-in for the control panel
 *   /api/auth/callback   Google's redirect target (sign-in and Drive connection)
 *   /api/auth/me         who's signed in (401 if nobody)
 *   /api/auth/logout
 *   /api/admin/*         control panel (src/admin_api.js), admins only
 *   /api/public/*        RSVP and the unlisted expense form (src/public_api.js)
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
 * The cron (every five minutes) pushes CSV exports to Google Drive when something
 * changed since the last sync.
 */

const SECRETS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_EMAILS"];

async function handleApi(route, request, env) {
  const method = request.method.toUpperCase();

  if (route === "config-check" && method === "GET") {
    const present = Object.fromEntries(SECRETS.map((name) => [name, Boolean(env[name])]));
    return json({ present, d1_bound: Boolean(env.DB), ready: Boolean(env.DB) && SECRETS.every((n) => present[n]) });
  }
  if (!env.DB) return json({ error: "The D1 database isn't bound to this Worker. See SETUP.md." }, 500);
  await ensureSchema(env);

  if (route === "auth/login" && method === "GET") return startOAuth(request, env, "login");
  if (route === "auth/callback" && method === "GET") return handleOAuthCallback(request, env, saveDriveTokens);
  if (route === "auth/logout" && method === "POST") return logoutResponse();
  if (route === "auth/me" && method === "GET") {
    const user = await currentUser(request, env);
    return user ? json({ user }) : json({ error: "Not signed in." }, 401);
  }
  if (route.startsWith("admin/")) return handleAdminApi(route.slice("admin/".length), request, env);
  if (route.startsWith("public/")) return handlePublicApi(route.slice("public/".length), request, env);
  return json({ error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(url.pathname.slice("/api/".length).replace(/\/+$/, ""), request, env);
      } catch (error) {
        return json({ error: error.message || String(error) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(
      ensureSchema(env)
        .then(() => scheduledSync(env))
        .catch((error) => console.error("Drive sync failed:", error.message))
    );
  },
};
