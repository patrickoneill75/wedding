// A type-ahead list under a text input, like the RSVP page's name search, for picking
// from a list the page already has: items, categories, vendors. No dependencies, so
// the public expense form can load it too.

const fold = (text) => String(text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const wordsOf = (text) => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

/** True when every word typed starts some word of `text` ("flo dec" finds "Florals › Decor"). */
export function matches(text, typed) {
  const want = wordsOf(typed);
  const have = wordsOf(text);
  return want.every((w) => have.some((word) => word.startsWith(w)));
}

/** `text` as nodes, with the start of each word the typing matched in bold. */
function highlighted(text, typed) {
  const want = wordsOf(typed);
  return String(text).split(/([^A-Za-z0-9À-ɏ]+)/).map((part) => {
    const hit = want.find((w) => w && fold(part).startsWith(w));
    if (!hit) return document.createTextNode(part);
    const span = document.createElement("span");
    const b = document.createElement("b");
    b.textContent = part.slice(0, hit.length);
    span.append(b, part.slice(hit.length));
    return span;
  });
}

let nextId = 0;

/**
 * Attach a suggestion list to `input`. Returns the wrapper to put in the page (the
 * input is moved inside it; if the input is already in the page, the wrapper takes its
 * place).
 *   options()       [{ label, detail?, search?, ...anything }] to choose from; `search`
 *                   is the text matched against (defaults to the label)
 *   onPick(option)  called with the option chosen
 *   create(typed)   optional: an extra option for what was typed ("＋ New vendor …"),
 *                   or null for none
 *   showAll         list the first options on focus, before anything is typed
 *   max             how many options to show at most
 */
export function combobox(input, { options, onPick, create = null, showAll = false, max = 8, empty = "Nothing matches." }) {
  const listId = `combo-${++nextId}`;
  const wrap = document.createElement("div");
  wrap.className = "combo";
  const list = document.createElement("ul");
  list.className = "suggest";
  list.id = listId;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  if (input.parentNode) input.replaceWith(wrap);
  wrap.append(input, list);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);

  let shown = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };

  function render() {
    const typed = input.value.trim();
    if (!typed && !showAll) {
      shown = [];
      return close();
    }
    const all = options();
    const lead = fold(typed);
    // Options whose label starts with what was typed come first.
    const hits = typed ? all.filter((o) => matches(o.search ?? o.label, typed)) : all;
    hits.sort((a, b) => Number(fold(b.label).startsWith(lead)) - Number(fold(a.label).startsWith(lead)));
    shown = hits.slice(0, max);
    const extra = typed && create ? create(typed) : null;
    if (extra) shown.push({ ...extra, create: true });
    active = shown.length ? 0 : -1;
    list.replaceChildren(
      ...(shown.length
        ? shown.map((o, i) => {
            const li = document.createElement("li");
            li.id = `${listId}-${i}`;
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", i === active ? "true" : "false");
            if (o.create) li.className = "create";
            li.append(...(o.create ? [document.createTextNode(o.label)] : highlighted(o.label, typed)));
            if (o.detail) {
              const d = document.createElement("span");
              d.className = "detail";
              d.textContent = o.detail;
              li.append(d);
            }
            // mousedown, not click, so the input keeps focus and the list doesn't close first.
            li.addEventListener("mousedown", (e) => {
              e.preventDefault();
              pick(i);
            });
            return li;
          })
        : [Object.assign(document.createElement("li"), { className: "note", textContent: empty })])
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    mark();
  }

  function mark() {
    [...list.children].forEach((li, i) => li.setAttribute("aria-selected", i === active ? "true" : "false"));
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      list.children[active]?.scrollIntoView({ block: "nearest" });
    }
  }

  function pick(i) {
    const option = shown[i];
    if (!option) return;
    close();
    onPick(option);
  }

  input.addEventListener("input", render);
  input.addEventListener("focus", () => {
    if (showAll || input.value.trim()) render();
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (list.hidden) return render();
      if (!shown.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      mark();
    } else if (e.key === "Enter" && !list.hidden && active >= 0) {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape" && !list.hidden) {
      // Closes the list only, not the dialog it sits in (which would lose the edits).
      e.preventDefault();
      close();
    }
  });
  return wrap;
}

/** "Florals › Decor" (or "Florals > Decor") as [category, subcategory]. */
export function splitCategory(text) {
  const [category = "", ...rest] = String(text || "").split(/\s*[›>]\s*/);
  return [category.trim(), rest.join(" ").trim()];
}
