# Working notes

## Standing decisions

1. **This repo is public.** Guest names, addresses, emails and the planning spreadsheet
   never get committed. Real data reaches D1 only through the control panel's import.
   Test data is made up (`scripts/make_test_fixture.py`). `ADMIN_EMAILS` is a secret for
   the same reason.
2. **Zero npm runtime dependencies in `src/`.** Build on platform APIs (`fetch`,
   `crypto.subtle`, `DecompressionStream`, `FormData`). Wrangler is the only dev dependency.
3. **D1 for everything**, one binding (`DB`). The schema migrates itself
   (`src/db.js`). To change it, append a new entry to `MIGRATIONS`; never edit one that
   has shipped.
4. **Workers Free limits**: 50 D1 queries and 50 subrequests per request. Bulk writes use
   multi-row INSERTs with escaped literals (`sqlValue` in `src/importer.js`), not one
   statement per row. D1 also allows only 100 bound parameters a statement: put lists of
   integer ids into the SQL as literals, not one `?` each.
5. Look up keys from request bodies with own-property checks or `Object.create(null)`.
   A plain `{}` inherits `constructor`, `toString` and friends.
6. Drive uploads **upsert by name** (find, then update), so syncs update files instead of
   piling up copies. Receipts are the exception: they get unique, timestamped names.
7. The budget math lives in `src/calc.js` and is mirrored for live previews in
   `public/admin/expenses.html` and `public/admin/settings.html`. Change both together.
8. Guests never see budget data. `GET /api/public/info`, the RSVP name search and the
   lookup return only what the RSVP page needs; tests check for leaks. The search
   returns names and signed picks only (2+ letters, 8 results), and a household opens
   from a pick, never from a raw guest id. The lookup shows email addresses masked
   (`maskEmail`), and a blank email on submit keeps the one on file. While RSVPs are closed, the RSVP routes answer only a
   signed-in admin, as a preview: submit runs every check but saves nothing and sends no email. The coordinator's day-of view (`/api/dayof`,
   a key in the link instead of a sign-in) gets steps, names, tables and vendor contacts
   only: no budgets, addresses or RSVP details, also checked by a test. The post-wedding
   call page (`/call/`, a signed link from `{call_link}`) gets the names of that one
   household's guests who said no and the registry link, and only tags that household.

9. The home page copies the Zola site (`src/site.js`). Zola's class names are generated
   and change on every Zola deploy, so the clean-up never relies on them: it finds the
   footer by its text, the countdown by `data-testid`, and its own phone menu shows
   whenever the site's menu links are hidden in the browser. When something can't be
   found, the page is still copied and Settings shows a warning. Never copy real Zola
   pages into the repo; tests use a made-up page. Zola answers 403 to Cloudflare's
   servers, so the fetching and cleaning run on GitHub (`scripts/zola_refresh.mjs`) and
   the Worker only stores what `/api/site/ingest` receives. Keep `buildSite()` free of
   database and Worker-only APIs so it keeps running in plain Node. Each copy also saves
   a shell (an inner page cut off after its menu, site_pages `_shell`) that frames our
   Things to Do page; it's never served as a page of its own.

10. **Who signs in**: the owners in `ADMIN_EMAILS` (always admins), plus the `users` table
    (admin, or user with a list of pages). Every `/api/admin/*` route belongs to a page in
    `ROUTE_PAGES` (`src/admin_api.js`); a route left out of it is admin-only, so add new
    routes there. Page access is a convenience, not a wall: a page's API returns what
    that page shows.

11. **Guest emails** (`src/comms.js`) go one per household, recorded in `comm_sends`
    (unique per email and household), so a retry, the cron and an automatic send after
    an RSVP can never send the same email twice. Sends go in batches of `SEND_BATCH` with
    one Gmail token read per batch and batched status updates, to stay under the D1
    query limit; the cron leaves the Drive sync to the next run when it sent email.
    A run claims its rows first (queued -> sending in one UPDATE ... RETURNING), so two
    overlapping runs never send the same row; a row stuck in sending is marked failed,
    never re-queued.
    Rich-text bodies are cleaned on save by `sanitizeHtml` (`src/email_html.js`), a short
    allowlist of tags; fill-ins are escaped into HTML. Calendar invites attach as
    `application/ics` and go only to guests who haven't declined (`eventsFor`). An email's `title` is a name for
    admins on the Communications page; it never goes into an email (a test checks).

12. **The coded website** (`src/website.js`) remakes the Zola site page for page, at the
    sizes measured from it; it replaces the Zola copy once `settings.web_live` is on (the
    Website page's switch), and until then previews at `/_new/` for the Website page only.
    Its words are in `src/website_content.js` and its photos in `public/_site/gallery/`:
    the couple asked for it all in code, no editor, and these are on their public site
    anyway. Guest data still never goes there. Radiograph loads from Zola's font server
    through `/_site/fonts` (its license may not allow a copy in a public repo). The
    `web_pages` and `web_photos` tables (migration 22) are no longer used.

13. **The finance tool** (`/admin/personal/`, `src/personal.js`) is for `PERSONAL_EMAILS`
    only, checked in the Worker for the page, its files and every `/api/personal/` route.
    Wedding admins don't get it automatically, and it isn't in `ROUTE_PAGES`. Its numbers live in one
    JSON file in a Drive folder linked with `drive.file`. D1 keeps only the link (setting
    `_personal_drive`), never the numbers. Numbers travel only in request bodies and are
    never logged; Drive's error replies are reduced to their status. The page's content
    policy allows no outside script or connection. The folder picker page is the one
    exception: it shows no numbers. The math is plain functions in
    `public/admin/personal/engine.js`, run in the browser and in
    `tests/finance_test.mjs` (hand-checked numbers). Default amounts there are
    placeholders, never real figures.

## Workflow

When a piece of work is finished (tests green, pushed), open a pull request for it
without waiting to be asked. If the branch's last PR already merged, open a new one.

## Tests

`npm test` (`node tests/worker_test.mjs`, then `node tests/finance_test.mjs` for the finance engine; Node 22.5+) drives the real Worker `fetch()`
against an in-memory SQLite D1 stub and a stubbed `fetch` for Google. Keep it green, and
name the bug in each regression test.
