/**
 * "Things to Do": our guide to Indy, a page on the public website at /things-to-do.
 *
 * It stays hidden until Settings publishes it (settings.things_to_do_published). While
 * it's hidden, guests get a 404 and a signed-in admin gets a preview with a banner.
 * Once it's published, servePage (src/site.js) adds it to the copied site's menu.
 *
 * The page takes the website's look (background, text color, font) from the stored
 * copy of the Zola home page. The copy is below: in each line, [Name](key) links the
 * name to that place on Google Maps (PLACES); `short` is a section's name in the row of
 * links at the top.
 */

import { currentUser } from "./auth.js";
import { first } from "./db.js";
import { loadSettings } from "./store.js";
import { RSVP_COLOR, siteFooter, themeColors, themeFont, THINGS_TO_DO } from "./site.js";

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

/**
 * The page. `theme` is { text, background, font, fontCss, accent } from the website;
 * `preview` adds the banner an admin sees while the page is hidden.
 */
export function renderGuide({ theme, coupleNames = "", contactEmail = "", weddingDate = "", preview = false }) {
  const font = theme.font ? `'${theme.font.replace(/'/g, "")}', ` : "";
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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg">
<title>${escapeHtml(GUIDE_TITLE)}${coupleNames ? ` · ${escapeHtml(coupleNames)}` : ""}</title>
${theme.fontCss ? `<style>${theme.fontCss}</style>` : ""}
<style>
:root{--bg:${theme.background};--ink:${theme.text};--accent:${theme.accent};--line:${theme.text}26;--wash:${theme.text}0d;--head:${font}Georgia,serif;--wm-text:${theme.text};--wm-font:${font}Georgia,serif}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--ink);font:16.5px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:680px;margin:0 auto;padding:28px 16px 40px}
.home{display:inline-block;color:inherit;opacity:.75;font-size:14px;text-decoration:none}
.home:hover{opacity:1;text-decoration:underline}
header{text-align:center;margin:36px 0 28px}
.eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;opacity:.7}
h1{font:400 clamp(38px,9vw,56px)/1.08 var(--head);margin:12px 0 10px}
.sub{font:italic 400 19px/1.4 var(--head);margin:0;opacity:.85}
.tip{font-size:14px;opacity:.7;margin:14px 0 0}
.jump{position:sticky;top:0;z-index:2;display:flex;gap:8px;overflow-x:auto;padding:10px 16px;margin:0 -16px 8px;background:var(--bg);border-bottom:1px solid var(--line);scrollbar-width:none}
.jump::-webkit-scrollbar{display:none}
.jump a{flex:none;color:inherit;text-decoration:none;font-size:14px;padding:6px 14px;border:1px solid var(--line);border-radius:999px;white-space:nowrap}
.jump a:hover{background:var(--wash)}
section{padding:28px 0 4px}
h2{font:400 30px/1.2 var(--head);margin:0 0 10px}
h3{font-size:12.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;margin:24px 0 6px;opacity:.75}
.lead{margin:0 0 10px;opacity:.85}
ul{list-style:none;margin:0;padding:0}
li{padding:11px 0;border-bottom:1px solid var(--line)}
li:last-child{border-bottom:0}
a.place{color:inherit;font-weight:650;text-decoration:underline;text-decoration-color:var(--accent);text-decoration-thickness:2px;text-underline-offset:3px}
a.place:hover{color:var(--accent)}
.start{background:var(--wash);border-radius:14px;padding:4px 18px 6px;margin:18px 0 6px}
.start h3{margin-top:16px}
.preview{background:#fff4d6;color:#5a4300;border:1px solid #f0d27a;border-radius:12px;padding:12px 16px;margin:16px 0 0;font-size:14px}
.top{display:inline-block;margin:28px 0 0;color:inherit;opacity:.7;font-size:14px}
</style></head><body><main>
<a class="home" href="/">← Our wedding website</a>
${preview ? `<div class="preview"><b>Preview.</b> Guests can't see this page yet. Publish it in the control panel: Settings, Things to Do page.</div>` : ""}
<header id="top"><div class="eyebrow">${escapeHtml(when)}</div><h1>${escapeHtml(GUIDE_TITLE)}</h1>
<p class="sub">${escapeHtml(SUBTITLE)}</p><p class="tip">Tap any name to open it in Google Maps.</p></header>
<nav class="jump" aria-label="Sections">${jump}</nav>
${sections}
<a class="top" href="#top">↑ Back to the top</a>
</main>${siteFooter({ coupleNames, contactEmail })}</body></html>`;
}

/**
 * GET /things-to-do. Hidden: a 404 for guests, a preview for a signed-in admin. The
 * look comes from the stored home page; with no copy yet, plain defaults.
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
  const home = (await first(env, "SELECT html FROM site_pages WHERE path = '/'"))?.html || "";
  const colors = home ? themeColors(home) : { text: "#3d3833", background: "#fbf8f3" };
  const fontCss = home.match(/<style data-wm="fonts">([\s\S]*?)<\/style>/)?.[1] || "";
  const accent = /^#[0-9a-f]{6}$/i.test(s.rsvp_button_color) ? s.rsvp_button_color : RSVP_COLOR;
  const html = renderGuide({
    theme: { ...colors, font: home ? themeFont(home) : null, fontCss, accent },
    coupleNames: s.couple_names,
    contactEmail: s.contact_email,
    weddingDate: s.wedding_date,
    preview,
  });
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
      "This is a joint list of the places the two of us actually go, plus a few honest warnings. We agree on almost everything, and where we don't, we'll tell you.",
      "Most of our favorites are clustered in a handful of walkable neighborhoods near downtown, so it's easy to pick an area and wander.",
    ],
    groups: [
      {
        title: "Short on time? Start here",
        items: [
          "Coffee at [Commissary](commissary) for the best espresso in the city",
          "Breakfast at [Love Handle](love-handle) on Mass Ave for a big Southern breakfast",
          "Dinner at [Bodhi](bodhi) for Thai and great cocktails, or [Bluebeard](bluebeard) for modern American",
          "A nightcap at [Commodore](commodore) for the best cocktails in town",
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
          "[Fountain Square](fountain-square) is the hipster hub, with several of our favorite coffee, bakery and dinner spots within a few blocks of each other.",
          "[Mass Ave](mass-ave) is where the yuppies go, lined with bars, restaurants and shops just northeast of downtown.",
          "[Broad Ripple](broad-ripple) is where hipsters and yuppies end up once they have kids. It sits right on the Monon Trail.",
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
          "[Provider](provider) in the Old Northside and its downtown sibling [Coat Check](coat-check) make the best lattes in Indy.",
          "[Amberson](amberson) in Fountain Square does exceptional pour over and AeroPress, and their barista won a US AeroPress championship. It's also where we went on our second date.",
          "[Blue Mind](blue-mind) is a local roaster with a bright, vibey cafe in Midtown.",
          "[Kaffeine](kaffeine) near Mass Ave is a super cool, bohemian cafe. The coffee can be hit or miss.",
          "[Commissary Coffee](commissary) downtown pulls the best espresso in the city, using beans from Sey in New York.",
          "[Rabble](rabble) is our neighborhood shop on the Near Eastside, with a dope lever espresso machine. Don't count on food, though.",
          "[Helm](helm) is just south of Fountain Square in Garfield Park, and it's worth the trip. Their head barista, Justin, won the US Brewers Cup and placed 6th at the World Brewers Cup, so get the pour over. We think they're the best roaster in the city too.",
        ],
      },
      {
        title: "Bakeries",
        items: [
          "[Amelia's](amelias) is a newer Indy institution, with locations in Fountain Square, the Stutz and the Near Eastside. Every pastry is naturally fermented with sourdough starter.",
          "[Leviathan](leviathan), just north of Mass Ave, is a great cafe with amazing breakfast sandwiches. They supply pastries to a lot of the coffee shops around town, so you really can't go wrong.",
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
          "[Love Handle](love-handle) on Mass Ave is our top pick for breakfast. It's a Southern spot that's guaranteed to put meat on your bones.",
          "[Sidedoor Bagels](sidedoor-bagels) on the Near Eastside has the best bagels in Indy. It's closed Mondays.",
          "[Cafe Patachou](cafe-patachou) has locations all over the city and is a brunch staple.",
          "[Lincoln Square](lincoln-square) is a local chain with spots around the city, and a classic Greek-owned breakfast joint.",
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
          "[Kismetic](kismetic) on the Near Eastside is our favorite. They have very few misses.",
          "[Taxman at City Way](taxman-at-city-way), tucked between downtown and Fountain Square near Gainbridge Fieldhouse, is known for great Belgian-style and dark beers. It has the best food of any brewery in town, too.",
          "[Mashcraft](mashcraft) gets no complaints from us.",
          "[Daredevil](daredevil) is the most technically sound brewery in Indy. Their beers slap.",
          "[Guggman Haus](guggman-haus), near the 16 Tech Innovation District, does a lot of experimental beers. If you're lactose intolerant, ask which ones contain milk sugars.",
          "[St. Joseph](st-joseph) is a church turned brewery just off Mass Ave, with a really nice patio and solid food. The beer is good, not great.",
          "[Metazoa](metazoa) is the one for dog lovers.",
        ],
      },
      {
        title: "Dive bars",
        items: [
          "[Turner's](turners) is a newer dive bar with a taco hole next door, and it's where we had our first date.",
          "[Dorman Street](dorman-street) is one of the oldest bars in Indy.",
          "[Sam's Silver Circle](sams-silver-circle) is a place that inspires inebriation.",
          "[Mass Ave Pub](mass-ave-pub) is one of the two dives on Mass Ave.",
          "[The Chatterbox](the-chatterbox) is the other one. There's awesome live music every night, mostly jazz, and it may be the last original bar left on Mass Ave.",
          "[The Great Divide](the-great-divide) has been around for decades and has a great outdoor area.",
          "[Bowhaus](bowhaus) is an adventure.",
          "[J. Clyde's](j-clydes) needs no explanation. If you know, you know.",
        ],
      },
      {
        title: "Cocktail bars",
        items: [
          "[Commodore](commodore) has the best cocktails in town.",
          "[The Inferno Room](the-inferno-room) is a tiki bar and one of our favorites.",
          "[Ball and Biscuit](ball-and-biscuit) is an Indy classic.",
          "[Parlor](parlor) is a coffee-til-cocktails spot. The coffee is meh, but it's very Instagrammable.",
          "[Snug](snug) is an Irish pub with an unmatched Irish whiskey selection.",
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
          "[King Dough](king-dough) does Neapolitan style and is our favorite.",
          "[Futuro](futuro) and [Sam's Square Pie](sams-square-pie) both do Detroit style.",
        ],
      },
      {
        title: "The continent of Asia",
        items: [
          "[Bodhi](bodhi) is maybe our favorite restaurant in the city. Great Thai food and bomb cocktails.",
          "[Strange Bird](strange-bird) does fusion with tropical cocktails.",
          "[Kyuramen](kyuramen) is a Japanese chain, but it's the best Japanese in Indy, and the beehive seating is very cool.",
          "[India Sizzling II](india-sizzling-ii) is the one to go to. Don't you dare think about going to India Sizzling I.",
          "[Saraga](saraga) (the one near Castleton and 82nd Street) is a grocery store with a diverse Asian food court.",
        ],
      },
      {
        title: "Modern American",
        items: [
          "[Livery](livery) serves Latin American food and has a great atmosphere. Kaitlyn loves it, while Patrick is lukewarm on the food.",
          "[Oakmont](oakmont) has upbeat, fun vibes and great food.",
          "[Bluebeard](bluebeard) in Fountain Square is a James Beard nominee and our favorite in this category.",
          "[Taxman at City Way](taxman-at-city-way) does elevated pub grub. If we're craving a good meal and a beer, this is where you'll find us.",
          "[The Fountain Room](the-fountain-room) is steakhouse-focused fine dining.",
          "[Mesh on Mass](mesh-on-mass) is fine dining with a more modern focus.",
          "[Vida](vida) is the highest-end fine dining in Indy and the place for a truly celebratory meal.",
        ],
      },
      {
        title: "Pub grub",
        items: [
          "[Kuma's](kumas) is rock and roll and burgers.",
          "[Bru Burger](bru-burger) has the best burger in Indy, in our humble opinion.",
          "[Half Liter](half-liter) has solid barbecue and German-style beers, right on the Monon Trail in Broad Ripple. It's the best outdoor space in Indy and perfect for a summer day.",
          "[Upland Fountain Square](upland) has a solid food menu, and there's a [SoBro location](sobro) too.",
          "[Twenty Tap](twenty-tap) is what pub grub should be. Reliable, right over the plate, and you can't go wrong.",
          "[St. Joseph](st-joseph) is worth it for the fried brussels sprouts alone.",
          "[Broad Ripple Brew Pub](broad-ripple-brew-pub) and [Mayfair Taproom](mayfair-taproom) are classic British pubs with the same owner, one in Broad Ripple and one on the Near Eastside.",
        ],
      },
      {
        title: "Mexican",
        items: [
          "[Julieta](julieta) has the best tacos in town, and it's the taco hole next to Turner's.",
          "[El Puerto de San Blas](el-puerto-de-san-blas) does phenomenal coastal Mexican seafood.",
          "[La Parada](la-parada) is the best near downtown.",
          "[Yolis](yolis) is a bit of a drive from downtown, but worth it. It's a Mexican grocery store with a griddle in the back serving tacos, tortas y burritos.",
        ],
      },
      {
        title: "Italian",
        items: [
          "[Maialina](maialina) is the best Italian in the city. If you're lucky, you might spot Caitlin Clark there.",
          "[Monti](monti) has outstanding service and truly authentic Italian food.",
          "[Vicino](vicino) is only on this list so we can tell you it's overrated. Go to Maialina instead.",
          "[Iaria's](iarias) is old-school American Italian.",
          "[Bocca](bocca) is a cute little spot with a speakeasy underneath called Verita. If you want a slightly fancy night out that still feels relaxed, this is it.",
        ],
      },
      {
        title: "Everything else",
        items: [
          "[Shapiro's Delicatessen](shapiros-delicatessen) is the Katz's of Indianapolis, with great pastrami. It's a regular stop for presidential candidates.",
          "[Yats](yats) is a Cajun spot that was featured on Diners, Drive-Ins and Dives. Get the chili cheese étouffée. They're also catering our wedding, so you'll get a taste at the reception. (Patrick will tell you his homemade étouffée is even better.)",
          "[Abyssinia](abyssinia) is our pick for Ethiopian.",
          "[Al Rayan](al-rayan) serves Yemeni meat platters and some of the best rice we've ever had.",
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
          "[State Street Pub](state-street-pub) is a low-key bar on the Near Eastside that books everything from punk to hip-hop to experimental, so you never quite know what you'll get.",
          "[HI-FI](hi-fi) in Fountain Square holds about 400 people, so you can see great touring bands without it feeling like an arena.",
        ],
      },
      {
        title: "Indoor fun",
        intro: "If the weather doesn't cooperate or you're feeling a little competitive, these are a fun way to spend an afternoon.",
        items: [
          "[Duckpin bowling](duckpin-bowling) in the Fountain Square Theatre Building is bowling with smaller balls and pins, on lanes restored with original 1930s equipment.",
          "[Fowling](fowling) is a mashup of football and bowling that was actually invented at the Indy 500, and the Fowling Warehouse on the Near Eastside has 33 lanes and two bars.",
          "[Speedway Indoor Karting](speedway-indoor-karting), a couple of blocks from the Indianapolis Motor Speedway, has gas-powered karts on a multilevel road course and an oval.",
        ],
      },
      {
        title: "Parks",
        intro: "May is a great time to get outside in Indy, and these are our favorite places to do it.",
        items: [
          "[Garfield Park](garfield-park) has a conservatory and sunken gardens, and it pairs perfectly with a coffee from Helm.",
          "[The Canal Walk](the-canal-walk) and [White River State Park](white-river-state-park) make for downtown's best walk along the water, and a couple of the museums below are right there.",
          "[Highland Park](highland-park) sits on one of the highest points in the city and has one of the best views of the downtown skyline, especially at sunset.",
          "[Fort Harrison State Park](fort-harrison-state-park), which locals call Fort Ben, has wooded trails along Fall Creek if you want real nature without leaving town.",
        ],
      },
      {
        title: "Museums",
        intro: "If you have a free afternoon, these are all worth a visit, though the Speedway will be packed on the 15th for the IndyCar Grand Prix.",
        items: [
          "[Newfields](newfields) is the city's art museum, plus gardens and a 100-acre art and nature park.",
          "[The Eiteljorg](the-eiteljorg) focuses on Native American and Western art and sits right on the canal.",
          "[The Indianapolis Motor Speedway Museum](the-indianapolis-motor-speedway-museum) is packed with historic race cars and is a must if you're a racing fan.",
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
  "kaffeine": "https://www.google.com/maps/search/?api=1&query=Kaffeine+Coffee+Company+Indianapolis&query_place_id=ChIJXeBZYS9Xa4gR4jyuwGdeD9U",
  "rabble": "https://www.google.com/maps/search/?api=1&query=Rabble+Coffee+Indianapolis&query_place_id=ChIJOy5WLUVQa4gR1xMLac-Ts2M",
  "helm": "https://www.google.com/maps/search/?api=1&query=Helm+Coffee+Indianapolis&query_place_id=ChIJW8vksoJba4gROgh6ZeiwjPM",
  "amelias": "https://www.google.com/maps/search/?api=1&query=Amelia%27s+Bakery+Indianapolis",
  "leviathan": "https://www.google.com/maps/search/?api=1&query=Leviathan+Bakehouse+Indianapolis&query_place_id=ChIJf6bEB4JRa4gRRlevI-3bkAU",
  "sidedoor-bagels": "https://www.google.com/maps/search/?api=1&query=Sidedoor+Bagel+Indianapolis&query_place_id=ChIJO52NtNdRa4gRG3gPEFFkAzI",
  "cafe-patachou": "https://www.google.com/maps/search/?api=1&query=Cafe+Patachou+Indianapolis",
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
  "the-great-divide": "https://www.google.com/maps/search/?api=1&query=The+Great+Divide+Indianapolis&query_place_id=ChIJc7hynY1Qa4gRHbM92XPPGM4",
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
  "the-fountain-room": "https://www.google.com/maps/search/?api=1&query=The+Fountain+Room+Indianapolis&query_place_id=ChIJhddzMlhRa4gRa5j7RpJrgto",
  "mesh-on-mass": "https://www.google.com/maps/search/?api=1&query=Mesh+Indianapolis&query_place_id=ChIJF7ujvO1Qa4gRvr9-aFMpudc",
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
  "fort-harrison-state-park": "https://www.google.com/maps/search/?api=1&query=Fort+Harrison+State+Park&query_place_id=ChIJs8q1OHxMa4gRpSsjBCQXEwE",
  "newfields": "https://www.google.com/maps/search/?api=1&query=Newfields+Indianapolis&query_place_id=ChIJvcr7Ua5Wa4gR6pjfPZL9o9g",
  "the-eiteljorg": "https://www.google.com/maps/search/?api=1&query=Eiteljorg+Museum+Indianapolis&query_place_id=ChIJR21I4rBQa4gRqO49IzDADJo",
  "the-indianapolis-motor-speedway-museum": "https://www.google.com/maps/search/?api=1&query=Indianapolis+Motor+Speedway+Museum&query_place_id=ChIJlz9DX7ZXa4gRAKvjczaK3EQ",
  "the-ncaa-hall-of-champions": "https://www.google.com/maps/search/?api=1&query=NCAA+Hall+of+Champions+Indianapolis&query_place_id=ChIJqZGMNrJQa4gR5hWPWscdEvI",
};
