# Wedding planner

A Cloudflare Worker with two sides:

- **Public**:
  - The home page (`/`, `/travel`, …) is a copy of our Zola wedding website, refreshed
    from Zola once a day (or with **Refresh from Zola** in Settings), with Zola's
    branding taken off, an RSVP button at the top, and our own footer with a Contact
    us link (the address is in Settings). Zola blocks Cloudflare's servers, so
    a GitHub Action (`.github/workflows/zola-refresh.yml`) does the copying.
  - The RSVP page at `/rsvp/`, where guests find their name and answer for their
    household.
  - The expense form at `/submit` (behind the same Google sign-in, for us and anyone
    given the Expenses page; it knows who is signed in) for logging expenses, payments
    and receipts from a phone: a conversation with Claude, who reads receipt photos,
    works out which item an expense belongs to, asks what it can't tell, and shows the
    entry to save. The plain form is at `/submit/form.html`.
- **Control panel** (`/admin/`, Google sign-in: the owners, plus anyone added in
  Settings → Users with the pages they're given):
  - **Dashboard**: guest counts, projected / paid / owed / overdue, upcoming payments,
    a pie of projected cost by category or subcategory, and an estimated vs. actual cost
    table by category, subcategory and item.
  - **Expenses**: every expense moving through
    Estimate → Quote → Booked → Partially paid → Paid (stages can be skipped, or an item
    cancelled), with price history, payments, who paid, due dates, and contracts and
    receipts in Drive. Anything with a deposit paid and more to pay is Partially paid.
    An item bought in pieces gets line items, each with its own price, vendor, stage
    and payments; the item adds them up. The item reads In
    progress while everything bought so far is paid and more is to come, and Paid once
    it's marked done buying.
  - **Guests**: households and guests like a small CRM. Address, side, priority, separate
    ceremony, reception and rehearsal dinner invitations, out-of-town and international
    tags, family and wedding-party flags, plus-ones (named by the
    guest when they RSVP), save-the-date / invite / gift / thank-you tracking, RSVPs,
    dietary needs and tables. Bulk edits and filters, and a Reset RSVP to un-answer a
    household.
  - **Vendors**: every vendor with optional primary and secondary contacts, day-of and
    key vendor flags (day-of vendors start out key), and the expenses with each.
  - **Seating**: rooms (ceremony, reception) drawn to size in feet, with round or
    rectangular tables, single chairs, text notes ("North end", "DJ booth") and shapes of
    any size with centered text (dance floor, bar) you drag into place. Table templates (size and seats) for the sizes you rent. At the reception
    each guest and plus-one gets a table number and a seat letter (A, B, C ...).
  - **Run of show**: the day step by step. Each step has a lead vendor, supporting
    vendors, guest cohorts (ceremony, reception, rehearsal dinner, each side, families,
    wedding party, out-of-town, international) and any other guests, groups or tables. The coordinator gets a private link to a day-of view at
    `/dayof/` for her iPad: now and next, tap to start and finish steps, who is in each
    and where they sit, and vendor phone numbers. It never shows budgets or addresses.
  - **Reports** ("Run a report" on the Guests and Vendors pages): head counts, meal counts, dietary needs, table cards, the seating
    chart board, ceremony-only / reception-only / both lists, the chase list, mailing
    labels, thank-yous, vendor contacts and more, plus custom reports you build and
    save. Each downloads as a CSV.
  - **Communications**: emails to guests through your Gmail, one per household (copied to
    any guest who gave their own email). Write them with fill-ins like {greeting}, pick
    who gets them with the guest tags, then send now, schedule, or send automatically
    after each RSVP. Also the calendar invite guests download after they RSVP (and
    emails can attach), and the RSVP page's wording.
  - **Settings**: wedding details, 7% tax, budget, priority weights, the drinks
    calculator, the expense-form link, Google Drive, the spreadsheet import, and Users:
    the owners in `ADMIN_EMAILS` plus anyone you add, each an admin (everything) or a
    user who sees only the pages ticked for them, such as a coordinator with Run of show
    and Seating.

Everything syncs to a Google Drive folder as CSV files (guests, expenses, payments,
price history, planning numbers).

## How costs work

Each expense is **fixed** (price × units) or **variable** (price × a quantity that follows
the guest list): the guest count, total invited, households, or one of the drinks
calculator's outputs (wine bottles, non-alcoholic drinks, …). Taxable items add the tax
rate, and any item can add a gratuity %.

The guest count starts as **weighted invites**: each invitee counts 0.9 / 0.6 / 0.4 by
High / Medium / Low priority, rounded up, as in the original spreadsheet. Once RSVPs are
in, **Convert all to confirmed RSVPs** in Settings (Guest count for costs) re-prices everything on the real
yes count.

On the Expenses page every item's cost sits in one of two columns: **Estimated** (an
estimate or a quote, not committed to yet) or **Incurred** (booked or paid). An item
with line items splits across both: its booked and paid line items are incurred, its
estimates and quotes are still estimated. **Owed** there is what's incurred and not
yet paid.

An item's **original estimate** is frozen the moment it leaves the Estimate stage, so the
dashboard can show how far each category drifted.

## Layout

```
src/worker.js      entry point and routing
src/auth.js        Google sign-in, signed session cookies, CSRF header check
src/admin_api.js   control panel API (/api/admin/*)
src/public_api.js  RSVP and expense form API (/api/public/*)
src/intake.js      the expense form's conversation with Claude
src/store.js       expense/payment writes with history and status moves
src/calc.js        the budget math (pure; most tests live here)
src/google.js      Google Drive: tokens, folder picker, uploads
src/seating.js     the seating chart: rooms, tables, shapes, templates, who sits where
src/vendors.js     vendors, their contacts, and what's spent with each
src/people.js      one row per guest and plus-one, for reports and the run of show
src/reports.js     built-in and custom reports, CSV export
src/runofshow.js   the run of show, guest groups, and the coordinator's day-of API
src/users.js       who can sign in besides the owners, and their pages
src/comms.js       guest emails: audiences, fill-ins, sending in batches, schedules
src/gmail.js       the Gmail connection and the email itself (MIME)
src/calendar.js    the calendar invite (.ics)
src/sync.js        CSV exports and the Drive sync (cron every 5 minutes)
src/site.js        the Zola website copy: fetch, clean, store, serve
scripts/zola_refresh.mjs  runs src/site.js on GitHub and sends the pages to the site
src/importer.js    one-time import of Wedding_Data.xlsx
src/xlsx.js        a minimal .xlsx reader (no dependencies)
src/db.js          D1 schema (self-migrating) and query helpers
public/            static pages: RSVP page (/rsvp/), expense form, control panel,
                   the coordinator's day-of view (/dayof/)
tests/             node tests/worker_test.mjs
```

See [SETUP.md](SETUP.md) to deploy.
