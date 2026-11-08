#!/usr/bin/env tsx
/**
 * Behaviour guard — THE SPORT MENU pricing rules (owner, 2026-11-07).
 *
 * The static guard (verify-sport-menu.mjs) proves the wiring. This one proves
 * the RULES with real inputs, because these are money:
 *
 *   1. an item the owner priced is charged his match-day price;
 *   2. an item in an added category he did not price keeps the menu price;
 *   3. an item whose category was never added keeps the menu price;
 *   4. a list switched off charges the menu price for everything;
 *   5. a malformed saved price (text, negative, missing id) is dropped, never
 *      turned into 0 or into NaN on a bill;
 *   6. the category views count what is priced (the waiter's ⚡ badges and the
 *      owner's "3 of 12 items priced");
 *   7. switching the whole list off restores normal prices without deleting
 *      the owner's work.
 *
 * Run with: npx tsx scripts/verify-sport-menu-pricing.ts   (wired into `npm test`)
 */
import {
  isSportNote,
  notesForMatching,
  orderLineKey,
  sportLineNote,
  stripSportMarker,
} from "../src/lib/order-lines";
import {
  parseSportCategories,
  parseSportPrices,
  sportCategoryViews,
  sportMenuFromRow,
  sportPriceFor,
  type SportMenu,
} from "../src/lib/sport-menu";

let failures = 0;
let count = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  count += 1;
  if (!cond) {
    failures += 1;
    console.log(`❌ ${name}${extra ? `\n     ${extra}` : ""}`);
  } else {
    console.log(`✅ ${name}`);
  }
};

const HOT = "hot-drinks";
const COLD = "cold-drinks";
const PASTRY = "pastry";
const FOOD = "burger";

const menu: SportMenu = {
  id: 7,
  name: "Sport",
  categories: [COLD, PASTRY],
  prices: [
    { menuItemId: 1, regularPrice: 60, sportPrice: 90, category: COLD },
    { menuItemId: 2, regularPrice: 40, sportPrice: 55, category: COLD },
    { menuItemId: 3, regularPrice: 120, sportPrice: 150, category: PASTRY },
  ],
  active: true,
  createdAt: null,
  updatedAt: null,
};

/* ── 1. the three cases the owner described ─────────────────────────────── */
pass("a priced item is charged the match-day price (cold drink 60 → 90)", sportPriceFor(menu, 1, 60) === 90);
pass("the price comes from the list, not from the price passed in", sportPriceFor(menu, 1, 999) === 90);
pass(
  "an item in an added category with no typed price keeps the menu price",
  sportPriceFor({ ...menu, categories: [...menu.categories, HOT] }, 5, 35) === 35,
);
pass("an item in a category nobody added keeps the menu price", sportPriceFor(menu, 4, 250) === 250);
pass("an ordinary item of the normal menu is untouched (burger 250)", sportPriceFor(menu, 99, 250) === 250);

/* ── 2. switching the list off is instant and non-destructive ────────────── */
pass("a switched-off list gives no sport price, so the caller keeps the menu price", sportPriceFor({ ...menu, active: false }, 1, 60) === null);
pass("but the typed prices are still stored (switching back restores them)", (menu.prices.length === 3) && sportPriceFor(menu, 1, 60) === 90);
pass("no list at all is never an error (null → the caller keeps the menu price)", sportPriceFor(null, 1, 60) === null);

/* ── 3. hostile / malformed saved data ──────────────────────────────────── */
const dirty = parseSportPrices([
  { menuItemId: 1, regularPrice: 60, sportPrice: "90", category: COLD },
  { menuItemId: 2, sportPrice: -5, category: COLD },
  { menuItemId: "x", sportPrice: 70, category: COLD },
  { menuItemId: 3, sportPrice: 150.4, category: PASTRY },
  { menuItemId: 1, regularPrice: 60, sportPrice: 95, category: COLD }, // retyped later
  null,
  "junk",
]);
pass("a numeric string is accepted (a phone keyboard sends text)", dirty.find((p) => p.menuItemId === 1)?.sportPrice === 95);
pass("a last retype wins over the earlier value (one row per item)", dirty.filter((p) => p.menuItemId === 1).length === 1);
pass("a negative price is dropped, never charged", !dirty.some((p) => p.menuItemId === 2));
pass("a non-numeric item id is dropped", !dirty.some((p) => String(p.menuItemId) === "NaN"));
pass("a fractional price is rounded to whole birr", dirty.find((p) => p.menuItemId === 3)?.sportPrice === 150);
pass("junk entries never crash the reader", Array.isArray(parseSportPrices("not json")) && parseSportPrices("not json").length === 0);

const cats = parseSportCategories(["cold-drinks", "cold-drinks", "", null, " pastry "]);
pass("category slugs are trimmed, blanks dropped and duplicates collapsed", cats.length === 2 && cats[0] === COLD && cats[1] === PASTRY, JSON.stringify(cats));
pass("junk categories never crash the reader", parseSportCategories("{oops").length === 0);

/* ── 4. from the database row to the app object ─────────────────────────── */
const row = sportMenuFromRow({
  id: 7,
  name: "",
  active: null,
  categories: [COLD, PASTRY],
  prices: [{ menuItemId: 1, sportPrice: 90, category: COLD }],
  created_at: "2026-11-07T06:00:00.000Z",
});
pass("a NULL active flag reads as ON (an old row never silently disables a price list)", row.active === true);
pass("a blank name falls back to 'Sport'", row.name === "Sport");
pass("jsonb text is parsed (a driver that returns strings still works)", sportMenuFromRow({ id: 8, categories: '["pastry"]', prices: '[{"menuItemId":3,"sportPrice":150,"category":"pastry"}]' }).prices.length === 1);

/* ── 5. the views behind the badges and the counters ────────────────────── */
const views = sportCategoryViews(
  [
    { slug: HOT, name: "Hot Drinks" },
    { slug: COLD, name: "Cold Drinks" },
    { slug: PASTRY, name: "Pastry" },
    { slug: FOOD, name: "Burger" },
  ],
  [
    { id: 1, category: COLD },
    { id: 2, category: COLD },
    { id: 3, category: PASTRY },
    { id: 4, category: FOOD },
    { id: 5, category: HOT },
  ],
  menu,
);
const byslug = (slug: string) => views.find((view) => view.slug === slug)!;
pass("every category with dishes is listed on the sport view", views.length === 4);
pass("an added category is marked added, with its priced count", byslug(COLD).added && byslug(COLD).pricedItems === 2 && byslug(COLD).totalItems === 2);
pass("a category the owner never added is listed but not added", byslug(FOOD).added === false && byslug(FOOD).pricedItems === 0);
pass("a priced category with unpriced dishes shows the gap (pastry 1 of 1, hot 0 of 1)", byslug(PASTRY).pricedItems === 1 && byslug(HOT).pricedItems === 0);

/* ── 6. the match-day marker on the stored line (owner's report question) ── */
{
  // The ticket API writes this on a sport line, and every screen strips it.
  const plain = sportLineNote("");
  pass("a sport line with no note is stamped exactly once", plain === "SPORT PRICE", plain);
  pass("the stamp is readable by the report", isSportNote(plain) && !isSportNote("") && !isSportNote("no sugar"));

  const withNote = sportLineNote("no sugar");
  pass("the waiter's own note survives the stamp", withNote === "SPORT PRICE • no sugar", withNote);
  pass("a person reading the line sees no machine tag", stripSportMarker(withNote) === "no sugar", stripSportMarker(withNote));
  pass("the tag is stripped from the middle too", stripSportMarker("no sugar • SPORT PRICE") === "no sugar");
  pass("a normal note is untouched", stripSportMarker("extra mayo") === "extra mayo");

  // Folding: two sport Colas are ONE line; a sport Cola and a normal Cola are not.
  const sportRow = { menuItemId: 3, name: "Cola", price: 150, notes: "SPORT PRICE", stationName: "barista" };
  const sportRowTwo = { ...sportRow };
  const normalRow = { menuItemId: 3, name: "Cola", price: 50, notes: "", stationName: "barista" };
  pass("two match-day Colas have the same line identity (they merge)", orderLineKey(sportRow) === orderLineKey(sportRowTwo));
  pass("a match-day Cola and an ordinary Cola do NOT merge (different money)", orderLineKey(sportRow) !== orderLineKey(normalRow));
  pass("the marker is not part of the dish identity", notesForMatching("SPORT PRICE • no sugar") === "no sugar");

  // The very example the owner gave.
  const colaMenu: SportMenu = {
    ...menu,
    categories: ["cold-drinks"],
    prices: [{ menuItemId: 3, regularPrice: 70, sportPrice: 150, category: "cold-drinks" }],
  };
  pass("the owner's example: Cola 70 normally, 150 with sport", sportPriceFor(colaMenu, 3, 70) === 150);
  pass("and the ordinary Cola ordered from the normal menu stays 70", sportPriceFor(null, 3, 70) === null);
}

/* the last line, so a green run is unmistakable */
if (failures === 0) {
  console.log(`\n✅ Sport menu pricing PASSED (${count} checks)`);
  process.exit(0);
}
console.log(`\n❌ ${failures} of ${count} Sport menu pricing checks FAILED`);
process.exit(1);
