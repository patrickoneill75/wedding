# Wedding planner

A Cloudflare Worker with two sides:

- **Public**: an RSVP page at `/`, where guests look up their name and answer for their
  household, and an unlisted expense form at `/submit/?k=…` for the two of us to log
  expenses, payments and receipts from a phone.
- **Control panel** (`/admin/`, Google sign-in, admins only):
  - **Dashboard**: original estimate vs. current projection by category, money by stage,
    paid over time, upcoming payments and guest counts.
  - **Expenses**: every budget line moving through
    Estimate → Quote → Booked → Partially paid → Paid (stages can be skipped, or an item
    cancelled), with price history, payments, who paid, due dates, and contracts and
    receipts in Drive.
  - **Guests**: households and guests like a small CRM. Address, side, priority, invite
    type (ceremony or reception), family and wedding-party flags, plus-ones (named by the
    guest when they RSVP), save-the-date / invite / gift / thank-you tracking, RSVPs,
    dietary needs and tables. Bulk edits and filters, and a Reset RSVP to un-answer a
    household.
  - **Settings**: wedding details, 7% tax, budget, priority weights, the drinks
    calculator, the expense-form link, Google Drive, and the spreadsheet import.

Everything syncs to a Google Drive folder as CSV files (guests, expenses, payments,
price history, planning numbers).

## How costs work

Each expense is **fixed** (price × units) or **variable** (price × a quantity that follows
the guest list): the guest count, total invited, households, or one of the drinks
calculator's outputs (wine bottles, non-alcoholic drinks, …). Taxable items add the tax
rate, and any item can add a gratuity %.

The guest count starts as **weighted invites**: each invitee counts 0.9 / 0.6 / 0.4 by
High / Medium / Low priority, rounded up, as in the original spreadsheet. Once RSVPs are
in, **Convert all to confirmed RSVPs** on the dashboard re-prices everything on the real
yes count.

An item's **original estimate** is frozen the moment it leaves the Estimate stage, so the
dashboard can show how far each category drifted.

## Layout

```
src/worker.js      entry point and routing
src/auth.js        Google sign-in, signed session cookies, CSRF header check
src/admin_api.js   control panel API (/api/admin/*)
src/public_api.js  RSVP and expense form API (/api/public/*)
src/store.js       expense/payment writes with history and status moves
src/calc.js        the budget math (pure; most tests live here)
src/google.js      Google Drive: tokens, folder picker, uploads
src/sync.js        CSV exports and the Drive sync (cron every 5 minutes)
src/importer.js    one-time import of Wedding_Data.xlsx
src/xlsx.js        a minimal .xlsx reader (no dependencies)
src/db.js          D1 schema (self-migrating) and query helpers
public/            static pages: RSVP site, expense form, control panel
tests/             node tests/worker_test.mjs
```

See [SETUP.md](SETUP.md) to deploy.
