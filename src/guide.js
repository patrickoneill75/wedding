/**
 * "Things to Do": our guide to Indy, a page on the public website at /things-to-do.
 *
 * It stays hidden until Settings publishes it (settings.things_to_do_published). While
 * it's hidden, guests get a 404 and a signed-in admin gets a preview with a banner.
 * Once it's published, the site's menu gets a link to it (addGuideLink, src/site.js).
 *
 * The page sits inside the website itself: the shell saved with each copy of the Zola
 * site (an inner page's header and menu, SHELL_PATH) with our content where the marker
 * is, dressed like any copied page (RSVP pill, phone menu, footer). Before the first copy
 * that saves a shell, it stands alone in the site's colors with a link back home.
 *
 * The copy is below: in each line, [Name](key) links the name to that place on Google
 * Maps (PLACES); `short` is a section's name in the row of links at the top.
 */

import { currentUser } from "./auth.js";
import { first } from "./db.js";
import { loadSettings } from "./store.js";
import { dressPage, GUIDE_MARK, RSVP_COLOR, SHELL_PATH, siteFooter, themeColors, themeFont, THINGS_TO_DO } from "./site.js";

const GUIDE_TITLE = THINGS_TO_DO.label;
const SUBTITLE = "Kaitlyn and Patrick's guide to Indy";
const CITY = "Indianapolis";

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const anchor = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** One line of the guide as HTML: text escaped, [Name](key) a link to the place's map. */
export function guideLine(line) {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(/\[([^\]]+)\]\(([a-z0-9-]+)\)/g)) {
    out += escapeHtml(line.slice(last, m.index));
    const url = Object.hasOwn(PLACES, m[2]) ? PLACES[m[2]] : null;
    out += url ? `<a class="place" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(m[1])}</a>` : escapeHtml(m[1]);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

const longDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))
  ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  : "");

// Every rule is under .wm-guide, so nothing here restyles the website around it. Colors
// and the heading font come from the site (--wm-text, --wm-font, set by the copy); the
// script keeps the section links clear of our top bar and gives them the page's background.
const GUIDE_CSS = `
html{scroll-behavior:smooth;scroll-padding-top:calc(var(--wm-bar,0px) + 64px)}
.wm-guide{max-width:680px;margin:0 auto;padding:8px 16px 40px;color:var(--wm-text,#3d3833);font:16.5px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;text-align:left}
.wm-guide *{box-sizing:border-box}
.wm-guide .g-head{text-align:center;margin:28px 0 24px}
.wm-guide .eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;opacity:.7}
.wm-guide h1{font:400 clamp(38px,9vw,56px)/1.08 var(--wm-font,Georgia,serif);margin:12px 0 10px;color:inherit;letter-spacing:normal;text-transform:none}
.wm-guide .sub{font:italic 400 19px/1.4 var(--wm-font,Georgia,serif);margin:0;opacity:.85}
.wm-guide .tip{font-size:14px;opacity:.7;margin:14px 0 0}
.wm-guide .jump{position:sticky;top:var(--wm-bar,0px);z-index:2;display:flex;gap:8px;overflow-x:auto;padding:10px 16px;margin:0 -16px 8px;background:var(--wm-bg,#fff);border-bottom:1px solid rgba(127,127,127,.25);scrollbar-width:none}
.wm-guide .jump::-webkit-scrollbar{display:none}
@media (min-width:840px){.wm-guide .jump{flex-wrap:wrap;justify-content:center;overflow:visible;gap:6px;margin:0 -60px 8px}.wm-guide .jump a{font-size:13.5px;padding:5px 11px}}
.wm-guide .jump a{flex:none;color:inherit;text-decoration:none;font-size:14px;padding:6px 14px;border:1px solid rgba(127,127,127,.3);border-radius:999px;white-space:nowrap}
.wm-guide .jump a:hover{background:rgba(127,127,127,.1)}
.wm-guide section{padding:28px 0 4px}
.wm-guide h2{font:400 30px/1.2 var(--wm-font,Georgia,serif);margin:0 0 10px;color:inherit;letter-spacing:normal;text-transform:none}
.wm-guide h3{font:600 12.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.16em;text-transform:uppercase;margin:24px 0 6px;opacity:.75;color:inherit}
.wm-guide p,.wm-guide li{color:inherit}
.wm-guide p{margin:0 0 10px}
.wm-guide .lead{opacity:.85}
.wm-guide ul{list-style:none;margin:0;padding:0}
.wm-guide li{padding:11px 0;margin:0;border-bottom:1px solid rgba(127,127,127,.2)}
.wm-guide li:last-child{border-bottom:0}
.wm-guide a.place{color:inherit;font-weight:650;text-decoration:underline;text-decoration-color:var(--wm-accent);text-decoration-thickness:2px;text-underline-offset:3px}
.wm-guide a.place:hover{color:var(--wm-accent)}
.wm-guide .start{background:rgba(127,127,127,.08);border-radius:14px;padding:4px 18px 6px;margin:18px 0 6px}
.wm-guide .start h3{margin-top:16px}
.wm-guide .preview{background:#fff4d6;color:#5a4300;border:1px solid #f0d27a;border-radius:12px;padding:12px 16px;margin:16px 0 0;font-size:14px}
.wm-guide .top{display:inline-block;margin:28px 0 0;color:inherit;opacity:.7;font-size:14px}`;
const GUIDE_SCRIPT = `(function(){var r=document.documentElement,b=document.querySelector(".wm-rsvp-bar");
function fit(){r.style.setProperty("--wm-bg",getComputedStyle(document.body).backgroundColor);
r.style.setProperty("--wm-bar",(b&&getComputedStyle(b).display!=="none"?b.offsetHeight:0)+"px")}
fit();addEventListener("resize",fit);addEventListener("load",fit)})();`;

/** The page's content (inside .wm-guide). `preview` adds the banner an admin sees while it's hidden. */
function guideBody({ weddingDate = "", preview = false }) {
  const when = [longDate(weddingDate), CITY].filter(Boolean).join(" · ");
  const jump = SECTIONS.map((s) => `<a href="#${anchor(s.title)}">${escapeHtml(s.short || s.title)}</a>`).join("");
  const sections = SECTIONS.map((s) => {
    const groups = s.groups.map((g) => {
      const start = /^Short on time/.test(g.title || "");
      return `<div class="group${start ? " start" : ""}">`
        + (g.title ? `<h3>${escapeHtml(g.title)}</h3>` : "")
        + (g.intro ? `<p class="lead">${guideLine(g.intro)}</p>` : "")
        + `<ul>${g.items.map((item) => `<li>${guideLine(item)}</li>`).join("")}</ul></div>`;
    }).join("");
    return `<section id="${anchor(s.title)}"><h2>${escapeHtml(s.title)}</h2>`
      + (s.intro || []).map((p) => `<p class="lead">${guideLine(p)}</p>`).join("")
      + groups + `</section>`;
  }).join("");
  return (preview ? `<div class="preview"><b>Preview.</b> Guests can't see this page yet. Publish it in the control panel: Settings, Things to Do page.</div>` : "")
    + `<header class="g-head" id="top"><div class="eyebrow">${escapeHtml(when)}</div><h1>${escapeHtml(GUIDE_TITLE)}</h1>`
    + `<p class="sub">${escapeHtml(SUBTITLE)}</p><p class="tip">Tap any name to open it in Google Maps.</p></header>`
    + `<nav class="jump" aria-label="Sections">${jump}</nav>${sections}`
    + `<a class="top" href="#top">↑ Back to the top</a>`;
}

/** The page inside the website's shell (from the copy), dressed like any copied page. */
export function guideInShell(shell, s, { preview = false } = {}) {
  const accent = /^#[0-9a-f]{6}$/i.test(s.rsvp_button_color) ? s.rsvp_button_color : RSVP_COLOR;
  let html = shell
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(GUIDE_TITLE)}${s.couple_names ? ` · ${escapeHtml(s.couple_names)}` : ""}</title>`)
    // The shell came from another page: nothing in it is the current page.
    .replace(/\saria-current="page"/g, "");
  const head = html.indexOf("</head>");
  const css = `<style data-wm="guide">:root{--wm-accent:${accent}}${GUIDE_CSS}</style>`;
  if (head !== -1) html = html.slice(0, head) + css + html.slice(head);
  html = html.replace(GUIDE_MARK, () => `<main class="wm-guide">${guideBody({ weddingDate: s.wedding_date, preview })}</main><script>${GUIDE_SCRIPT}</script>`);
  return dressPage(html, s, { guide: true });
}

/**
 * The page on its own, before any copy of the site has saved a shell: the site's colors
 * and fonts (`theme`, from the stored home page), with a link back home.
 */
export function renderGuide({ theme, coupleNames = "", contactEmail = "", weddingDate = "", preview = false }) {
  const font = theme.font ? `'${theme.font.replace(/'/g, "")}', ` : "";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg">
<title>${escapeHtml(GUIDE_TITLE)}${coupleNames ? ` · ${escapeHtml(coupleNames)}` : ""}</title>
${theme.fontCss ? `<style>${theme.fontCss}</style>` : ""}
<style>:root{--wm-text:${theme.text};--wm-font:${font}Georgia,serif;--wm-accent:${theme.accent};--wm-bg:${theme.background}}
body{margin:0;background:${theme.background}}
.home{display:block;max-width:680px;margin:0 auto;padding:28px 16px 0;color:${theme.text};opacity:.75;font:14px system-ui,sans-serif;text-decoration:none}
${GUIDE_CSS}</style></head><body>
<a class="home" href="/">← Our wedding website</a>
<main class="wm-guide">${guideBody({ weddingDate, preview })}</main>
${siteFooter({ coupleNames, contactEmail })}</body></html>`;
}

/**
 * GET /things-to-do. Hidden: a 404 for guests, a preview for a signed-in admin. Inside
 * the website's shell once a copy has saved one; on its own before that.
 */
export async function serveGuide(env, request) {
  const s = await loadSettings(env);
  const published = Boolean(s.things_to_do_published);
  const preview = !published && (await currentUser(request, env))?.role === "admin";
  if (!published && !preview) {
    return new Response(`<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title>`
      + `<p style="font:16px system-ui,sans-serif;text-align:center;margin:80px 16px">This page isn't here. <a href="/">Go to our wedding website</a>.</p>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const shell = (await first(env, "SELECT html FROM site_pages WHERE path = ?", SHELL_PATH))?.html || "";
  let html;
  if (shell.includes(GUIDE_MARK)) {
    html = guideInShell(shell, s, { preview });
  } else {
    const home = (await first(env, "SELECT html FROM site_pages WHERE path = '/'"))?.html || "";
    const colors = home ? themeColors(home) : { text: "#3d3833", background: "#fbf8f3" };
    const fontCss = home.match(/<style data-wm="fonts">([\s\S]*?)<\/style>/)?.[1] || "";
    const accent = /^#[0-9a-f]{6}$/i.test(s.rsvp_button_color) ? s.rsvp_button_color : RSVP_COLOR;
    html = renderGuide({
      theme: { ...colors, font: home ? themeFont(home) : null, fontCss, accent },
      coupleNames: s.couple_names,
      contactEmail: s.contact_email,
      weddingDate: s.wedding_date,
      preview,
    });
  }
  return new Response(request.method.toUpperCase() === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // An admin's preview is never cached; the published page is, like the site's pages.
      "cache-control": published ? "public, max-age=300" : "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}

/* ------------------------------------------------------------------- the copy ---- */

export const SECTIONS = [
  {
    title: "Welcome to Indy",
    short: "Welcome",
    intro: [
      "This is a joint list of the places the two of us actually go, plus a few honest warnings. We agree on almost everything, and where we don’t, we’ll tell you.",
      "Most of our favorites are clustered in a handful of walkable neighborhoods near downtown, so it’s easy to pick an area and wander.",
    ],
    groups: [
      {
        title: "Short on time? Start here",
        items: [
          "Coffee at [Commissary](commissary) for the best espresso in the city or at [Helm](helm) for the best pour over.",
          "Breakfast at [Love Handle](love-handle) on Mass Ave for a big Southern breakfast",
          "Dinner at [Bodhi](bodhi) for Thai and great cocktails, or [Bluebeard](bluebeard) for modern American",
          "A nightcap at [Commodore](commodore) or [Ball and Biscuit](ball-and-biscuit) for the best cocktails in town",
          "A beer at [Kismetic](kismetic), our favorite brewery",
        ],
      },
    ],
  },
  {
    title: "Neighborhoods worth wandering",
    short: "Neighborhoods",
    intro: [
      "If you want to park once and walk between food and drinks, start with one of these.",
    ],
    groups: [
      {
        items: [
          "[Fountain Square](fountain-square) has a laid-back, artsy feel, and several of our favorite coffee, bakery and dinner spots are within a few blocks of each other.",
          "[Mass Ave](mass-ave) is a lively, walkable strip just northeast of downtown, lined with bars, restaurants and shops.",
          "[Broad Ripple](broad-ripple) is a more relaxed neighborhood a few miles north of downtown, with plenty of places to eat and drink and easy access to the Monon Trail.",
        ],
      },
    ],
  },
  {
    title: "Coffee and bakeries",
    short: "Coffee",
    intro: [
      "Patrick is a bit of a coffee nerd, so this section runs long.",
    ],
    groups: [
      {
        title: "Coffee",
        items: [
          "[Provider](provider) in the Old Northside and its downtown sibling [Coat Check](coat-check) make the best lattes in Indy. Kaitlyn’s favorite is the Brown Sugar Cinnamon.",
          "[Amberson](amberson) in Fountain Square does exceptional pour over and AeroPress, and their barista won a US AeroPress championship. It’s also where we went on our second date.",
          "[Blue Mind](blue-mind) is a local roaster with a bright, vibey cafe in Midtown.",
          "[Commissary Coffee](commissary) downtown pulls the best espresso in the city, using beans from Sey in New York.",
          "[Rabble](rabble) is our neighborhood shop on the Near Eastside, with a dope lever espresso machine. Don’t count on food, though.",
          "[Helm](helm) is just south of Fountain Square in Garfield Park, and it’s worth the trip. Their head barista, Justin, won the US Brewers Cup and placed 6th at the World Brewers Cup, so get the pour over. We think they’re the best roaster in the city too.",
        ],
      },
      {
        title: "Bakeries",
        items: [
          "[Amelia’s](amelias) is a newer Indy institution, with locations in Fountain Square, the Stutz and the Near Eastside. Every pastry is naturally fermented with sourdough starter.",
          "[Leviathan](leviathan), just north of Mass Ave, is a great cafe with amazing breakfast sandwiches. They supply pastries to a lot of the coffee shops around town, so you really can’t go wrong.",
        ],
      },
    ],
  },
  {
    title: "Breakfast and brunch",
    short: "Breakfast",
    groups: [
      {
        items: [
          "[Love Handle](love-handle) on Mass Ave is our top pick for breakfast. It’s a Southern spot that’s guaranteed to put meat on your bones. We recommend the shrimp n grits, biscuits n gravy, or chicken n waffle.",
          "[Sidedoor Bagels](sidedoor-bagels) on the Near Eastside has the best bagels and bagel sandwiches in Indy. It’s closed Mondays.",
          "[Lincoln Square](lincoln-square) is a local chain with spots around the city, and a classic Greek-owned breakfast joint.",
          "[Borage](borage) in Speedway is a cafe, sourdough bakery and little market all in one, run by two former Milktooth chefs. Come for brunch and leave with a loaf of bread. It’s a short walk from the Indianapolis Motor Speedway, so it pairs nicely with the museum. It’s closed Mondays.",
        ],
      },
    ],
  },
  {
    title: "Drinks",
    short: "Drinks",
    groups: [
      {
        title: "Breweries",
        items: [
          "[Upland](upland) is known for its sours, with locations in Fountain Square and [SoBro](sobro).",
          "[Kismetic](kismetic) on the Near Eastside is our faaavorite. They have a super cool mid-century modern vibe and no bad beers.",
          "[Taxman at City Way](taxman-at-city-way), tucked between downtown and Fountain Square near Gainbridge Fieldhouse, is known for great Belgian-style and dark beers. It has the best food (and highest prices) of any brewery in town, too.",
          "[Mashcraft](mashcraft) gets no complaints from us.",
          "[Daredevil](daredevil) is the most technically sound brewery in Indy. Their beers slap.",
          "[Guggman Haus](guggman-haus), near the 16 Tech Innovation District and Patrick’s work, does the most experimental beers in the city. If you’re lactose intolerant, ask which ones contain milk sugars.",
          "[St. Joseph](st-joseph) is a church turned brewery just off Mass Ave, with a really nice patio and solid food. The beer is…fine.",
          "[Metazoa](metazoa) is the one for dog lovers. The beer is…also fine.",
        ],
      },
      {
        title: "Dive bars",
        items: [
          "[Turner’s](turners) at the Stutz is a newer dive bar with a taco hole next door, and it’s where we had our first date.",
          "[Dorman Street](dorman-street) is one of the oldest bars in Indy and Kaitlyn’s favorite. Order a tequila shot and Miller High Life for the Kaitlyn Wright Experience.",
          "[Sam’s Silver Circle](sams-silver-circle) in Fountain Square is a place that inspires inebriation.",
          "[Mass Ave Pub](mass-ave-pub) is one of the two dives on Mass Ave.",
          "[The Chatterbox](the-chatterbox) is the other one. There’s awesome live music every night, mostly jazz, and it may be the last original bar left on Mass Ave.",
          "[Bowhaus](bowhaus) down in the Bates-Hendricks neighborhood is an adventure. Don’t be surprised when the bartender Mark asks to take your picture - it’ll end up on their Facebook stories the next day with a charming GIF of Mark’s choosing.",
          "[J. Clyde’s](j-clydes) on the Near Eastside needs no explanation. If you know, you know (and you should).",
          "[Plump’s Last Shot](plumps-last-shot) in Broad Ripple is named for Bobby Plump, who hit the winning shot for tiny Milan High in the 1954 state championship. That’s the story behind the movie Hoosiers. The walls are covered in basketball memorabilia and the breaded tenderloin hangs way off the bun, which is exactly how it should be.",
          "[The Rooftop Garden](the-rooftop-garden) sits on the fifth floor of the Fountain Square Theatre Building (same building as the duckpin bowling) and has some of the best skyline views in town. It’s seasonal, so save it for a warm night.",
        ],
      },
      {
        title: "Cocktail bars",
        items: [
          "[Commodore](commodore) has the best cocktails in town. It’s technically a speakeasy so good luck finding it. (Hint: it’s near the women’s bathroom on the ground level of the building it’s in.)",
          "[The Inferno Room](the-inferno-room) is a tiki bar and one of our favorites. Very Instagrammable.",
          "[Ball and Biscuit](ball-and-biscuit) is an Indy classic. Have you heard of it?",
          "[Parlor](parlor) is a coffee-til-cocktails spot. The drinks are meh, but it’s also very Instagrammable.",
          "[Snug](snug) is an Irish pub with an unmatched Irish whiskey selection and a truly cozy vibe. Fun fact: it’s named after “the snug”, a semi-secluded area in Irish and British pubs where respectable women could drink away from the working class men at the main counter. For questions about this, ask our officiant Connor Moore who lived several years across the pond.",
        ],
      },
    ],
  },
  {
    title: "Where to eat",
    short: "Where to eat",
    groups: [
      {
        title: "Pizza",
        items: [
          "[King Dough](king-dough) does Neapolitan style and is our favorite. Highland Park, just a block away, has great views of the skyline and is where Patrick proposed.",
          "[Futuro](futuro) and [Sam’s Square Pie](sams-square-pie) both do Detroit style very, very well.",
        ],
      },
      {
        title: "The continent of Asia",
        items: [
          "[Bodhi](bodhi) is maybe our favorite restaurant in the city. Great Thai food and bomb cocktails. Expect a wait on the weekend, though.",
          "[Strange Bird](strange-bird) does ramen and Asian fusion with tropical cocktails.",
          "[Kyuramen](kyuramen) is a Japanese chain, but it’s the best Japanese in Indy, and the beehive seating is very cool.",
          "[India Sizzling II](india-sizzling-ii) is the one to go to. Don’t you dare think about going to India Sizzling I.",
          "[Saraga](saraga) (the one near Castleton and 82nd Street) is a grocery store with a diverse Asian food court.",
        ],
      },
      {
        title: "Modern American",
        items: [
          "[Livery](livery) serves Latin American food and has a great atmosphere. Kaitlyn loves it, while Patrick is lukewarm on the food.",
          "[Oakmont](oakmont) has upbeat, fun vibes and great food. Patrick loves it, while Kaitlyn is lukewarm on the everything.",
          "[Bluebeard](bluebeard) in Fountain Square is a James Beard nominee and our favorite in this category.",
          "[Taxman at City Way](taxman-at-city-way) does elevated pub grub. If we’re craving a really good meal and a beer, this is where you’ll find us.",
          "[Daisy Bar](daisy-bar) has the most innovative menu in the city right now. It’s a modern spin on the classic American diner at the far end of Mass Ave in Windsor Park. It does breakfast, lunch and dinner, the cocktails are excellent, and the patio is a great hang on a nice day.",
          "[Vida](vida) is the highest-end fine dining in Indy and the place for a truly celebratory meal.",
        ],
      },
      {
        title: "Pub grub",
        items: [
          "[Kuma’s](kumas) is rock and roll and burgers. As a Chicago-based establishment, it’s encouraged to get a shot of Malort while you’re there.",
          "[Bru Burger](bru-burger) has the best burger in Indy, in Patrick’s humble opinion.",
          "[Half Liter](half-liter) has solid barbecue and German-style beers, right on the Monon Trail in Broad Ripple. It’s the best outdoor space in Indy and perfect for a summer (or warm mid-spring) day.",
          "[Upland Fountain Square](upland) has a solid food menu, and there’s a [SoBro location](sobro) too.",
          "[Twenty Tap](twenty-tap) is what pub grub should be. Reliable, right over the plate, and you can’t go wrong.",
          "[St. Joseph](st-joseph) is worth it for the fried brussels sprouts alone.",
          "[Broad Ripple Brew Pub](broad-ripple-brew-pub) and [Mayfair Taproom](mayfair-taproom) are classic British pubs with the same owner, one in Broad Ripple and one on the Near Eastside.",
        ],
      },
      {
        title: "Mexican",
        items: [
          "[Julieta](julieta) has the best tacos in town, and it’s the taco hole next to Turner’s.",
          "[El Puerto de San Blas](el-puerto-de-san-blas) does phenomenal coastal Mexican seafood, according to Patrick.",
          "[La Parada](la-parada) is the best near downtown, also according to Patrick.",
          "[La Piedad](la-piedad) is a family-owned spot in Broad Ripple named after the owners’ hometown in Michoacán. It’s steps from the Monon Trail and a block from Plump’s Last Shot, with a patio and big portions. Get the chile rellenos.",
          "[Yolis](yolis) is a bit of a drive from downtown, but worth it. It’s a Mexican grocery store with a griddle in the back serving tacos, tortas y burritos.",
        ],
      },
      {
        title: "Italian",
        items: [
          "[Maialina](maialina) is the best Italian in the city. If you’re lucky, you might spot Caitlin Clark there.",
          "[Monti](monti) has outstanding service and truly authentic Italian food. Literally the best service experience we’ve had in the city.",
          "[Vicino](vicino) is only on this list so we can tell you it’s overrated. Go to Maialina instead.",
          "[Iaria’s](iarias) is old-school American Italian with a truly retro vibe.",
          "[Bocca](bocca) is a cute little spot with a speakeasy underneath called Verita. If you want a slightly fancy night out that still feels relaxed, this is it.",
        ],
      },
      {
        title: "Everything else",
        items: [
          "[Shapiro’s Delicatessen](shapiros-delicatessen) is the Katz’s of Indianapolis, with great pastrami. It’s a regular stop for presidential candidates.",
          "[Yats](yats) is a Cajun spot that was featured on Diners, Drive-Ins and Dives. Get the chili cheese étouffée. They’re also catering our wedding, so you’ll get a taste at the reception. (Patrick will tell you his homemade étouffée is even better.) (Kaitlyn will tell you Patrick’s étouffée recipe almost killed her with spiciness.)",
          "[Abyssinia](abyssinia) is Patrick’s pick for Ethiopian.",
          "[Al Rayan](al-rayan) serves Yemeni meat platters and some of the best rice Patrick’s ever had.",
        ],
      },
    ],
  },
  {
    title: "Beyond eating",
    short: "Beyond eating",
    groups: [
      {
        title: "Small live music venues",
        intro: "For live music in a room small enough to actually see the band, these are our go-tos.",
        items: [
          "[The Chatterbox](the-chatterbox) on Mass Ave is a tiny, packed room with live music every night, mostly jazz.",
          "[State Street Pub](state-street-pub) is a low-key bar on the Near Eastside that books everything from punk to hip-hop to experimental to green-screen karaoke, so you never quite know what you’ll get.",
          "[HI-FI](hi-fi) in Fountain Square holds about 400 people, so you can see great touring bands without it feeling like an arena.",
        ],
      },
      {
        title: "Indoor fun",
        intro: "If the weather doesn’t cooperate or you’re feeling a little competitive, these are a fun way to spend an afternoon.",
        items: [
          "[Duckpin bowling](duckpin-bowling) in the Fountain Square Theatre Building is bowling with smaller balls and pins, on lanes restored with original 1930s equipment.",
          "[Fowling](fowling) is a mashup of football and bowling that was actually invented at the Indy 500, and the Fowling Warehouse on the Near Eastside has 33 lanes and two bars.",
          "[Speedway Indoor Karting](speedway-indoor-karting), a couple of blocks from the Indianapolis Motor Speedway, has gas-powered karts on a multilevel road course and an oval.",
          "[Midland Arts & Antiques Market](midland-arts-antiques-market), just east of downtown, has two floors of antique and vintage booths packed into an old sash and door factory. Plan to lose an afternoon there.",
        ],
      },
      {
        title: "Parks",
        intro: "May is a great time to get outside in Indy, and these are our favorite places to do it.",
        items: [
          "[Garfield Park](garfield-park) has a beautiful conservatory and sunken gardens, and it pairs perfectly with a coffee from Helm.",
          "[The Canal Walk](the-canal-walk) and [White River State Park](white-river-state-park) make for downtown’s best walk along the water, and a couple of the museums below are right there. This is Kaitlyn’s favorite spot to play Pokemon Go.",
          "[Highland Park](highland-park) sits on one of the highest points in the city and has one of the best views of the downtown skyline, especially at sunset. This is where Patrick proposed!",
        ],
      },
      {
        title: "Museums",
        intro: "If you have a free afternoon, these are all worth a visit, though the Speedway will be packed on the 15th for the IndyCar Grand Prix.",
        items: [
          "[Newfields](newfields) is the city’s art museum, plus gardens and a 100-acre art and nature park.",
          "[The Eiteljorg](the-eiteljorg) focuses on Native American and Western art and sits right on the canal.",
          "[The Indianapolis Motor Speedway Museum](the-indianapolis-motor-speedway-museum) is packed with historic race cars and is a must if you’re a racing fan.",
          "[The NCAA Hall of Champions](the-ncaa-hall-of-champions) is an interactive college sports museum in White River State Park.",
        ],
      },
    ],
  },
];

// Each place's Google Maps link, from the guide.
export const PLACES = {
  "commissary": "https://www.google.com/maps/search/?api=1&query=Commissary+Barber+%26+Barista+Indianapolis&query_place_id=ChIJWaLjj6JRa4gRY8Nad-pJseI",
  "love-handle": "https://www.google.com/maps/search/?api=1&query=Love+Handle+Indianapolis&query_place_id=ChIJZWKKvkdQa4gRTCwAJrPhi_M",
  "bodhi": "https://www.google.com/maps/search/?api=1&query=Bodhi+Indianapolis&query_place_id=ChIJ39rjikdRa4gRp6U-rzc0UiE",
  "bluebeard": "https://www.google.com/maps/search/?api=1&query=Bluebeard+Indianapolis&query_place_id=ChIJ1b2Xo5xQa4gR5sXiiaBDwpM",
  "commodore": "https://www.google.com/maps/search/?api=1&query=The+Commodore+Indianapolis&query_place_id=ChIJvZTOKARba4gRKZlTeed75tM",
  "kismetic": "https://www.google.com/maps/search/?api=1&query=Kismetic+Beer+Company+Indianapolis&query_place_id=ChIJE5XLnytRa4gRd4GhynBQO_M",
  "fountain-square": "https://www.google.com/maps/search/?api=1&query=Fountain+Square%2C+Indianapolis%2C+IN",
  "mass-ave": "https://www.google.com/maps/search/?api=1&query=Mass+Ave+Cultural+District%2C+Indianapolis%2C+IN",
  "broad-ripple": "https://www.google.com/maps/search/?api=1&query=Broad+Ripple%2C+Indianapolis%2C+IN",
  "provider": "https://www.google.com/maps/search/?api=1&query=Provider+Cafe+Indianapolis&query_place_id=ChIJr_brg_xRa4gRiN7N-kE05sE",
  "coat-check": "https://www.google.com/maps/search/?api=1&query=Coat+Check+Coffee+Indianapolis&query_place_id=ChIJVRDBUutQa4gRH-yS4DSl5iM",
  "amberson": "https://www.google.com/maps/search/?api=1&query=Amberson+Coffee+%26+Grocer+Indianapolis&query_place_id=ChIJsxleWQlRa4gRVd5Z7jNKtMU",
  "blue-mind": "https://www.google.com/maps/search/?api=1&query=Blue+Mind+Coffee+Indianapolis&query_place_id=ChIJF4LGK11Ra4gRA7gX5CZilx0",
  "rabble": "https://www.google.com/maps/search/?api=1&query=Rabble+Coffee+Indianapolis&query_place_id=ChIJOy5WLUVQa4gR1xMLac-Ts2M",
  "helm": "https://www.google.com/maps/search/?api=1&query=Helm+Coffee+Indianapolis&query_place_id=ChIJW8vksoJba4gROgh6ZeiwjPM",
  "amelias": "https://www.google.com/maps/search/?api=1&query=Amelia%27s+Bakery+Indianapolis",
  "leviathan": "https://www.google.com/maps/search/?api=1&query=Leviathan+Bakehouse+Indianapolis&query_place_id=ChIJf6bEB4JRa4gRRlevI-3bkAU",
  "sidedoor-bagels": "https://www.google.com/maps/search/?api=1&query=Sidedoor+Bagel+Indianapolis&query_place_id=ChIJO52NtNdRa4gRG3gPEFFkAzI",
  "lincoln-square": "https://www.google.com/maps/search/?api=1&query=Lincoln+Square+Pancake+House+Indianapolis",
  "upland": "https://www.google.com/maps/search/?api=1&query=Upland+FSQ+Brewery+Indianapolis&query_place_id=ChIJX0Gml4dba4gRCzqXLL-Ur78",
  "sobro": "https://www.google.com/maps/search/?api=1&query=Upland+College+Ave+Tasting+Room+Indianapolis&query_place_id=ChIJiTszYdpTa4gR1U-HmMJC784",
  "taxman-at-city-way": "https://www.google.com/maps/search/?api=1&query=Taxman+CityWay+Indianapolis&query_place_id=ChIJ8W689MNRa4gRbASlPgHevn0",
  "mashcraft": "https://www.google.com/maps/search/?api=1&query=MashCraft+on+Delaware+Indianapolis&query_place_id=ChIJHXKfEB9Ra4gRTEyRUeR69jk",
  "daredevil": "https://www.google.com/maps/search/?api=1&query=Daredevil+Brewing+Co+Speedway&query_place_id=ChIJEb3ApsZXa4gRDfcyUiFBgWY",
  "guggman-haus": "https://www.google.com/maps/search/?api=1&query=Guggman+Haus+Brewing+Co+Indianapolis&query_place_id=ChIJhU-sLSlXa4gRzn954vzcgUI",
  "st-joseph": "https://www.google.com/maps/search/?api=1&query=St.+Joseph+Brewery+Indianapolis&query_place_id=ChIJCcioRu1Qa4gRxLW5URcMDTI",
  "metazoa": "https://www.google.com/maps/search/?api=1&query=Metazoa+Brewing+Company+Indianapolis&query_place_id=ChIJyS1abJBQa4gRy9AJf5dZQno",
  "turners": "https://www.google.com/maps/search/?api=1&query=Turner%27s+Bar+Indianapolis&query_place_id=ChIJqaM8JbVba4gRpK4LQl84Z1c",
  "dorman-street": "https://www.google.com/maps/search/?api=1&query=Dorman+Street+Indianapolis&query_place_id=ChIJRy3NuvZQa4gRpLgOwoN4u4s",
  "sams-silver-circle": "https://www.google.com/maps/search/?api=1&query=Sam%27s+Silver+Circle+Indianapolis&query_place_id=ChIJU-rNAYRQa4gRcS5yLezNQTI",
  "mass-ave-pub": "https://www.google.com/maps/search/?api=1&query=Mass+Avenue+Pub+Indianapolis&query_place_id=ChIJl4Znlu1Qa4gRpCSTKYQsw24",
  "the-chatterbox": "https://www.google.com/maps/search/?api=1&query=Chatterbox+Jazz+Club+Indianapolis&query_place_id=ChIJ8f3_yJRQa4gRclyOS6JICUk",
  "bowhaus": "https://www.google.com/maps/search/?api=1&query=Bowhaus+Tap+Indianapolis&query_place_id=ChIJ9Rl-83Faa4gRble4k4Ugutk",
  "j-clydes": "https://www.google.com/maps/search/?api=1&query=J.+Clyde%27s+Pub+Indianapolis&query_place_id=ChIJAYG-19lPa4gRrl_4MIytGxc",
  "the-inferno-room": "https://www.google.com/maps/search/?api=1&query=The+Inferno+Room+Indianapolis&query_place_id=ChIJJSgx94JQa4gRa9JH39TKWKU",
  "ball-and-biscuit": "https://www.google.com/maps/search/?api=1&query=Ball+%26+Biscuit+Indianapolis&query_place_id=ChIJqUdNdJVQa4gR6rHbgE6yhUA",
  "parlor": "https://www.google.com/maps/search/?api=1&query=Parlor+Public+House+Indianapolis&query_place_id=ChIJ5aV3Hw1Ra4gRQ6skjHsmgHs",
  "snug": "https://www.google.com/maps/search/?api=1&query=SNUG+Indianapolis&query_place_id=ChIJrzT-c6RPa4gRTKkL0jvcBUg",
  "king-dough": "https://www.google.com/maps/search/?api=1&query=King+Dough+Indianapolis&query_place_id=ChIJTabQw9ZRa4gReasygKK4ps8",
  "futuro": "https://www.google.com/maps/search/?api=1&query=Futuro+Indianapolis&query_place_id=ChIJP0tLpqtRa4gR1JnmJdWOmEw",
  "sams-square-pie": "https://www.google.com/maps/search/?api=1&query=Sam%27s+Square+Pie+Indianapolis&query_place_id=ChIJl9CTPwBRa4gRVJMicPcFmBU",
  "strange-bird": "https://www.google.com/maps/search/?api=1&query=Strange+Bird+Indianapolis&query_place_id=ChIJJx9xonFPa4gREQbY3SveYjE",
  "kyuramen": "https://www.google.com/maps/search/?api=1&query=Kyuramen+Indianapolis&query_place_id=ChIJ1V6-gg1Ra4gRNza6-6pjEYk",
  "india-sizzling-ii": "https://www.google.com/maps/search/?api=1&query=India+Sizzling+II+Indianapolis",
  "saraga": "https://www.google.com/maps/search/?api=1&query=Saraga+International+Grocery+Indianapolis&query_place_id=ChIJrTC8JuRNa4gRu5Fymuf-31M",
  "livery": "https://www.google.com/maps/search/?api=1&query=Livery+Indianapolis&query_place_id=ChIJwZH4me1Qa4gRZggPtsX015Q",
  "oakmont": "https://www.google.com/maps/search/?api=1&query=The+Oakmont+Indianapolis&query_place_id=ChIJw51D_INRa4gRUqRKJTccgik",
  "vida": "https://www.google.com/maps/search/?api=1&query=Vida+Indianapolis&query_place_id=ChIJCwQGVZJQa4gRXy83ilC2MXY",
  "kumas": "https://www.google.com/maps/search/?api=1&query=Kuma%27s+Corner+Indianapolis&query_place_id=ChIJ5-HjWn9aa4gRndJScIm-TUo",
  "bru-burger": "https://www.google.com/maps/search/?api=1&query=BRU+Burger+Bar+Indianapolis&query_place_id=ChIJEc2YIJVQa4gRGeKM71Blwm0",
  "half-liter": "https://www.google.com/maps/search/?api=1&query=Half+Liter+BBQ+Indianapolis&query_place_id=ChIJ3a9pD1xTa4gRZGLjHLX4kCk",
  "twenty-tap": "https://www.google.com/maps/search/?api=1&query=Twenty+Tap+Indianapolis&query_place_id=ChIJaaZgbcZTa4gRIyiBimv4xcE",
  "broad-ripple-brew-pub": "https://www.google.com/maps/search/?api=1&query=Broad+Ripple+Brewpub+Indianapolis&query_place_id=ChIJv99c9qhTa4gRSkzRQRWtORM",
  "mayfair-taproom": "https://www.google.com/maps/search/?api=1&query=Mayfair+Taproom+Indianapolis&query_place_id=ChIJj4-Mw1pQa4gRtAgN4fPeFb8",
  "julieta": "https://www.google.com/maps/search/?api=1&query=Julieta+Taco+Shop+Indianapolis&query_place_id=ChIJxaHlGI5Ra4gRLXyZO1mv1_E",
  "el-puerto-de-san-blas": "https://www.google.com/maps/search/?api=1&query=El+Puerto+De+San+Blas+Indianapolis&query_place_id=ChIJBwpu0b0bcEAR2vFOt72jfHU",
  "la-parada": "https://www.google.com/maps/search/?api=1&query=La+Parada+Indianapolis&query_place_id=ChIJjx4u7mBQa4gR_mxHUz1_FCk",
  "yolis": "https://www.google.com/maps/search/?api=1&query=Yolis+Supermarket+Indianapolis&query_place_id=ChIJu2D_I8lba4gRrgWs837kMew",
  "maialina": "https://www.google.com/maps/search/?api=1&query=Maialina+Italian+Kitchen+Indianapolis&query_place_id=ChIJLU-KlrRba4gRl6BH1t6Nnf8",
  "monti": "https://www.google.com/maps/search/?api=1&query=Monti+Aperitivo+%26+Cucina+Indianapolis&query_place_id=ChIJq6oasXhaa4gRTjYakE2pjv8",
  "vicino": "https://www.google.com/maps/search/?api=1&query=Vicino+Indianapolis&query_place_id=ChIJZ8KXVQVRa4gRJdxtSvLPfHA",
  "iarias": "https://www.google.com/maps/search/?api=1&query=Iaria%27s+Italian+Restaurant+Indianapolis&query_place_id=ChIJKec1x5pQa4gREZSfW_rpWp4",
  "bocca": "https://www.google.com/maps/search/?api=1&query=Bocca+Indianapolis&query_place_id=ChIJz3_FmJxRa4gR4r2TOKCjKfQ",
  "shapiros-delicatessen": "https://www.google.com/maps/search/?api=1&query=Shapiro%27s+Delicatessen+Indianapolis&query_place_id=ChIJv0dTL6FQa4gRa7_BqZFb5bo",
  "yats": "https://www.google.com/maps/search/?api=1&query=Yats+Indianapolis",
  "abyssinia": "https://www.google.com/maps/search/?api=1&query=Abyssinia+Indianapolis&query_place_id=ChIJL3PiLRxWa4gRFc8DgGp38LE",
  "al-rayan": "https://www.google.com/maps/search/?api=1&query=Al-Rayan+restaurant+Indianapolis&query_place_id=ChIJ5-DIWBFWa4gReVDi2bkAkFA",
  "state-street-pub": "https://www.google.com/maps/search/?api=1&query=State+Street+Pub+Indianapolis&query_place_id=ChIJt03YJmFQa4gRMDvzNMPM_gI",
  "hi-fi": "https://www.google.com/maps/search/?api=1&query=HI-FI+Indy+Indianapolis&query_place_id=ChIJm-6zn3haa4gRQ-3clbAmAIA",
  "duckpin-bowling": "https://www.google.com/maps/search/?api=1&query=Atomic+Bowl+Duckpin+Indianapolis&query_place_id=ChIJ47HUU39aa4gRY8NW_TUE8_o",
  "fowling": "https://www.google.com/maps/search/?api=1&query=The+Fowling+Warehouse+Indianapolis&query_place_id=ChIJlzqR0xtRa4gRzP2N80L7FLU",
  "speedway-indoor-karting": "https://www.google.com/maps/search/?api=1&query=Speedway+Indoor+Karting&query_place_id=ChIJU6mkVsFXa4gRkoqG3fcp1SY",
  "garfield-park": "https://www.google.com/maps/search/?api=1&query=Garfield+Park+Indianapolis&query_place_id=ChIJxeXDEmhaa4gRGN2-NTGZSK0",
  "the-canal-walk": "https://www.google.com/maps/search/?api=1&query=Canal+Walk+Indianapolis&query_place_id=ChIJm7K8cshQa4gRmwU2b61bGJ0",
  "white-river-state-park": "https://www.google.com/maps/search/?api=1&query=White+River+State+Park+Indianapolis&query_place_id=ChIJZ4y_MrJQa4gR12PogzDop5s",
  "highland-park": "https://www.google.com/maps/search/?api=1&query=Highland+Park+Indianapolis&query_place_id=ChIJ7x1PCotQa4gRy_f0VmJgRy0",
  "newfields": "https://www.google.com/maps/search/?api=1&query=Newfields+Indianapolis&query_place_id=ChIJvcr7Ua5Wa4gR6pjfPZL9o9g",
  "the-eiteljorg": "https://www.google.com/maps/search/?api=1&query=Eiteljorg+Museum+Indianapolis&query_place_id=ChIJR21I4rBQa4gRqO49IzDADJo",
  "the-indianapolis-motor-speedway-museum": "https://www.google.com/maps/search/?api=1&query=Indianapolis+Motor+Speedway+Museum&query_place_id=ChIJlz9DX7ZXa4gRAKvjczaK3EQ",
  "the-ncaa-hall-of-champions": "https://www.google.com/maps/search/?api=1&query=NCAA+Hall+of+Champions+Indianapolis&query_place_id=ChIJqZGMNrJQa4gR5hWPWscdEvI",
  "borage": "https://www.google.com/maps/search/?api=1&query=Borage+Speedway+IN",
  "plumps-last-shot": "https://www.google.com/maps/search/?api=1&query=Plump%27s+Last+Shot+Indianapolis",
  "the-rooftop-garden": "https://www.google.com/maps/search/?api=1&query=Rooftop+Garden+Fountain+Square+Theatre+Building+Indianapolis",
  "daisy-bar": "https://www.google.com/maps/search/?api=1&query=Daisy+Bar+Indianapolis",
  "la-piedad": "https://www.google.com/maps/search/?api=1&query=La+Piedad+Broad+Ripple+Indianapolis",
  "midland-arts-antiques-market": "https://www.google.com/maps/search/?api=1&query=Midland+Arts+%26+Antiques+Market+Indianapolis",
};
