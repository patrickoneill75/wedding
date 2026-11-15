/**
 * The words and pictures of the coded website (src/website.js), as on the Zola site
 * (zola.com/wedding/patrickandkaitlyn2027). To change the site, change this file. The
 * gallery's photos are in public/_site/gallery/, square, 1000 px.
 */

export const SITE = {
  header: "Kaitlyn & Patrick",
  footer: "Patrick & Kaitlyn",
  first: ["Patrick", "O'Neill"],
  second: ["Kaitlyn", "Wright"],
  date: "May 15, 2027",
  place: "Indianapolis, IN",
};

// The menu, in order. `guide` shows only while Settings publishes Things to Do.
export const MENU = [
  { path: "", label: "Home" },
  { path: "photo", label: "Gallery" },
  { path: "travel", label: "Travel" },
  { path: "faq", label: "FAQs" },
  { path: "things-to-do", label: "Things to Do", guide: true },
];

export const GALLERY = Array.from({ length: 11 }, (_, i) => ({
  src: `/_site/gallery/${String(i + 1).padStart(2, "0")}.jpg`,
  alt: i === 0 ? "Patrick proposing to Kaitlyn in Highland Park, with the downtown skyline behind them" : `Patrick and Kaitlyn's engagement photo ${i + 1}`,
}));

export const TRAVEL = {
  intro: "Given that our wedding is in the marvelous month of May here in beautiful Indianapolis, we recommend securing your stay accommodations as early as possible to beat the Indy 500 crowd.",
  hotels: [
    { name: "Stone Soup Inn", address: ["1304 Central Ave", "Indianapolis, IN 46202"], note: "A cozy B&B a mere five blocks from the venue!", url: "https://www.stonesoupinn.com/rooms-overview" },
    { name: "Looking Glass Inn", address: ["1319 North New Jersey Street", "Indianapolis, IN 46202"], note: "Another sweet B&B within walking distance of the venue!", url: "http://www.thelookingglassinn.com/" },
    { name: "Mansion On The Mile B&B", address: ["228 North East Street", "Indianapolis, IN 46204"], note: "A little farther from the venue but another cute option just north of Downtown Indianapolis.", url: "http://www.mansiononthemile.com/" },
    { name: "Sheraton", address: ["31 W Ohio St", "Indianapolis, IN 46204"], phone: "(317) 225-7473", url: "https://www.marriott.com/en-us/hotels/indsc-sheraton-indianapolis-city-centre-hotel/overview/" },
    { name: "Aloft by Marriott Indianapolis Downtown", address: ["136 East Market Street", "Indianapolis, IN"], phone: "(317) 755-2399", url: "https://www.marriott.com/en-us/hotels/indal-aloft-indianapolis-downtown/overview/" },
    { name: "Conrad Indianapolis", address: ["50 West Washington St.", "Indianapolis, IN"], phone: "(317) 713-5000", url: "https://www.hilton.com/en/hotels/indcici-conrad-indianapolis/" },
    { name: "Indianapolis Marriott Downtown", address: ["350 West Maryland Street", "Indianapolis, IN 46225"], url: "https://www.marriott.com/en-us/hotels/indcc-indianapolis-marriott-downtown/overview/" },
    { name: "The Westin Indianapolis", address: ["241 West Washington Street", "Indianapolis, IN 46204"], url: "https://www.marriott.com/en-us/hotels/indwi-the-westin-indianapolis/overview/" },
    { name: "JW Marriott Indianapolis", address: ["10 South West Street", "Indianapolis, IN 46204"], url: "https://www.marriott.com/en-us/hotels/indjw-jw-marriott-indianapolis/overview/" },
  ],
};

export const FAQS = [
  { q: "Can I bring my kids?", a: "We're keeping the celebration adults only, and we hope it gives you a chance to enjoy a night out!" },
  { q: "How many nights should I plan to be in town?", a: "For our out-of-town guests, we will be hosting a rehearsal dinner on Friday, May 14th." },
];
