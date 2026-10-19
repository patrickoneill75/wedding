/**
 * Who can sign in, under /api/admin/users/* (admins only; see ROUTE_PAGES in
 * src/admin_api.js).
 *
 *   GET    users             the owners (from ADMIN_EMAILS, read-only here), everyone
 *                            added, and the pages a user can be given
 *   POST   users             { email, name, role: "admin" | "user", pages: [...] }
 *   PUT    users/:email      change name, role or pages
 *   DELETE users/:email      remove; they're signed out on their next request
 *
 * A user sees only the pages ticked for them: the page and its API routes. Page access
 * is convenience, not a security wall: a page's data includes what that page shows,
 * like the budget figures on Reports and Vendors.
 */

import { json, adminEmails, PAGES } from "./auth.js";
import { all, first, run } from "./db.js";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

export const PAGE_LABELS = {
  dashboard: "Dashboard",
  expenses: "Expenses (and the expense form)",
  vendors: "Vendors",
  guests: "Guests",
  seating: "Seating",
  runofshow: "Run of show (and the day-of view)",
  reports: "Reports",
};

function cleanUser(input) {
  const patch = Object.create(null);
  if (has(input, "name")) patch.name = String(input.name ?? "").trim().slice(0, 100) || null;
  if (has(input, "role")) {
    if (!["admin", "user"].includes(input.role)) throw new Error("Role must be admin or user.");
    patch.role = input.role;
  }
  if (has(input, "pages")) {
    if (!Array.isArray(input.pages)) throw new Error("Pages must be a list.");
    patch.pages = JSON.stringify([...new Set(input.pages.filter((p) => typeof p === "string" && PAGES.includes(p)))]);
  }
  return patch;
}

async function listUsers(env) {
  const rows = await all(env, "SELECT * FROM users ORDER BY email");
  const owners = adminEmails(env);
  return {
    owners,
    users: rows
      .filter((u) => !owners.includes(u.email.toLowerCase()))
      .map((u) => ({ email: u.email, name: u.name || "", role: u.role, pages: JSON.parse(u.pages || "[]"), created_by: u.created_by, created_at: u.created_at })),
    pages: PAGES.map((key) => ({ key, label: PAGE_LABELS[key] })),
  };
}

export async function handleUsers(parts, method, request, env, body, user) {
  const email = parts[1] ? decodeURIComponent(parts[1]).trim().toLowerCase() : null;

  if (!email && method === "GET") return json(await listUsers(env));

  if (!email && method === "POST") {
    const input = await body(request);
    const address = String(input.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(address)) throw new Error("Enter their Google account's email address.");
    if (adminEmails(env).includes(address)) throw new Error(`${address} is an owner already (ADMIN_EMAILS).`);
    if (await first(env, "SELECT email FROM users WHERE email = ?", address)) throw new Error(`${address} is already on the list.`);
    const patch = { role: "user", pages: "[]", ...cleanUser(input) };
    await run(
      env,
      "INSERT INTO users (email, name, role, pages, created_by) VALUES (?, ?, ?, ?, ?)",
      address,
      patch.name ?? null,
      patch.role,
      patch.pages,
      user.email
    );
    return json(await listUsers(env), 201);
  }

  if (email && (method === "PUT" || method === "DELETE")) {
    if (adminEmails(env).includes(email)) throw new Error("Owners come from the ADMIN_EMAILS secret and can't be changed here.");
    if (!(await first(env, "SELECT email FROM users WHERE email = ?", email))) return json({ error: "No such person." }, 404);
    if (method === "DELETE") {
      await run(env, "DELETE FROM users WHERE email = ?", email);
      return json(await listUsers(env));
    }
    const patch = cleanUser(await body(request));
    const columns = Object.keys(patch);
    if (columns.length) await run(env, `UPDATE users SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE email = ?`, ...columns.map((c) => patch[c]), email);
    return json(await listUsers(env));
  }

  return json({ error: "Not found." }, 404);
}
