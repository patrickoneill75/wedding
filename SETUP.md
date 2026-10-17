# Setup

One-time steps to get the Worker live on `workers.dev`, signed in with Google, and
saving to Google Drive. Plan on about 30 minutes. Nothing here costs money: the Workers
Free plan, D1 and a Google Cloud project with the Drive API are all free at this size.

## 1. Create the D1 database (Cloudflare)

1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database → Create**.
2. Name it `wedding`, leave the location on automatic, and create it.
3. Copy its **Database ID** and paste it into `wrangler.jsonc`, replacing
   `REPLACE_WITH_D1_DATABASE_ID`. Commit that change.

You don't need to create any tables. The Worker creates them on its first request.

(With Wrangler on your own machine, `npx wrangler d1 create wedding` does the same thing
and prints the ID.)

## 2. Create the Worker and connect it to this repo

1. **Workers & Pages → Create → Import a repository** and pick `patrickoneill75/wedding`.
2. Project name: `wedding`. This must match `"name"` in `wrangler.jsonc`.
3. Build command: leave empty. Deploy command: `npx wrangler deploy`.
4. Deploy. Every push to `main` deploys again from now on.
5. Note the URL it gives you, something like `https://wedding.<your-subdomain>.workers.dev`.
   It's `YOUR_URL` in the steps below.

## 3. Google Cloud: sign-in and Drive

1. Go to <https://console.cloud.google.com/>, create a project (for example "Wedding planner")
   and select it.
2. **APIs & Services → Library**: search for **Google Drive API** and enable it.
3. **APIs & Services → OAuth consent screen** (now called **Google Auth Platform**):
   - User type: **External**. Fill in the app name, your email as support and developer
     contact, and save.
   - **Audience**: click **Publish app** to move it from *Testing* to *In production*.
     This matters. In Testing mode, Google expires the Drive connection every 7 days
     and syncing silently stops. You don't need to submit for verification. Because
     it's unverified, Google shows a "Google hasn't verified this app" screen the first
     time each of you signs in: click **Advanced → Go to … (unsafe)**. That's expected
     for a personal app.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs:
     - `YOUR_URL/api/auth/callback`
     - `http://localhost:8787/api/auth/callback` (only if you'll run it locally)
   - Create, then copy the **Client ID** and **Client secret**.

## 4. Add the secrets in GitHub and send them to Cloudflare

The secrets live in GitHub, and a workflow hands them to the Worker. No terminal is
needed.

1. **Make a Cloudflare API token:** Cloudflare → **My Profile → API Tokens → Create Token**.
   Use the **Edit Cloudflare Workers** template, pick your account, and create it. Copy
   the token: Cloudflare only shows it once.
2. **Find your Account ID:** it's on the **Workers & Pages** overview, under **Account
   details**.
3. **Add five repository secrets** on GitHub: repo → **Settings → Secrets and variables →
   Actions → New repository secret**:

   | Name | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | the ID from step 2 |
   | `GOOGLE_CLIENT_ID` | from section 3 |
   | `GOOGLE_CLIENT_SECRET` | from section 3 |
   | `ADMIN_EMAILS` | both of your Google addresses, comma-separated, e.g. `you@gmail.com, partner@gmail.com` |

4. **Run the workflow:** repo → **Actions → Set Cloudflare secrets → Run workflow**. Each
   secret is sent to the `wedding` Worker and deployed straight away. Run it again any
   time you change one of the values.

Check it worked: open `YOUR_URL/api/config-check`. It should say `"ready": true`. It
reports whether each secret is set, never its value.

## 5. First run

1. Open `YOUR_URL/admin/` and **Sign in with Google**.
2. **Settings → Import the planning spreadsheet**: upload `Wedding_Data.xlsx` with all three
   boxes ticked. This brings in 82 households / 133 guests (the spreadsheet's 14 "Guest Guest …" rows become
   nameless plus-ones on their hosts), all 53 budget lines, and the
   weights and drink assumptions. Guest names and addresses go straight into the database,
   never into this repo.
3. **Settings → Google Drive → Log in with Google to connect Drive**, then **Pick a folder**
   (or create one). The first sync runs right away. After that it runs every five
   minutes whenever something changed, and **Sync now** forces one.
4. **Settings → Wedding details**: names, date, venue and RSVP deadline for the public page.
5. **Settings → Expense form link**: copy it and save it on both of your phones.
6. **Settings → Website (copied from Zola)**: check the Zola address and click
   **Refresh from Zola**. The home page becomes your Zola site, without Zola's branding and
   with an RSVP button at the top. After that it re-checks Zola once a day; click the
   button again whenever you've just edited your Zola site.

The website is `YOUR_URL/` and the RSVP page is `YOUR_URL/rsvp/`. Until the first copy
is made, `YOUR_URL/` sends visitors to the RSVP page.

## Running it locally

```sh
npm install
printf 'GOOGLE_CLIENT_ID=...\nGOOGLE_CLIENT_SECRET=...\nADMIN_EMAILS=you@gmail.com\n' > .dev.vars
npx wrangler dev        # http://localhost:8787, with a local D1 database
npm test                # the test suite (Node 22.5+)
```

`.dev.vars` is git-ignored.

## Troubleshooting

- **"isn't on the control panel's list of admins"**: the Google account you picked isn't in
  `ADMIN_EMAILS`. Check the spelling, then redeploy or wait a minute after editing secrets.
- **Drive sync says "token refresh failed"**: the app is probably still in Testing mode
  (step 3). Publish it, then disconnect and reconnect Drive in Settings.
- **Settings says the Zola refresh failed**: the last good copy stays up. If it keeps
  failing with a 403 or 429, Zola is refusing requests from Cloudflare; tell me and we'll
  look at another way in.
- **`redirect_uri_mismatch` from Google**: the redirect URI in step 3 must match
  `YOUR_URL/api/auth/callback` exactly, including `https://` and with no trailing slash.
- **Secrets set but `config-check` says false**: check that the **Set Cloudflare secrets**
  run finished green and didn't skip any steps (a skipped secret shows a yellow warning).
  The Worker's name in the Cloudflare dashboard must match `"name"` in `wrangler.jsonc`.
  Secrets added under the dashboard's **Settings → Build** section are only for builds,
  and the running Worker never sees them.
