#!/usr/bin/env node
/**
 * Regression guard — THE SPORT MENU (owner, 2026-11-07).
 *
 * On a match day the cold drink, hot drink and pastry prices go up. The owner's
 * plan, in his words: "the easiest way to add this is to use that group button,
 * rename the groups to sport, then when they click it there will be increased
 * price and they will click and send it like normal order."
 *
 * So there is a SECOND price list that only the waiter's ordering screen reads:
 *
 *   1. STORAGE: its own table (`sport_menus`: name, active, categories jsonb,
 *      prices jsonb). Nothing is written onto menu_items, so the published
 *      menu, the QR page and the customer checkout cannot change.
 *   2. THE OWNER'S EDITOR: he adds a category at a time, each item reads
 *      "from <menu price> to <match-day price>", and only he may write.
 *   3. THE WAITER: a "Sport menu" chip beside the categories, the top-corner
 *      button that used to say Groups, and "Use sport prices" switching his
 *      ordering screen onto those numbers. Categories he did not add keep the
 *      normal price.
 *   4. THE SERVER: the ticket route re-reads the sport row and stamps its
 *      prices on the lines (sportMenuId only travels up), so a stale or
 *      tampered phone can never choose a price. A switched-off list is ignored.
 *   5. THE CUSTOMER: no customer path names a sport list; the public menu API
 *      is untouched.
 *
 * Run with: node scripts/verify-sport-menu.mjs   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const lib = read("src/lib/sport-menu.ts");
const client = read("src/lib/sport-menu-client.ts");
const api = read("src/app/api/sport-menu/route.ts");
const route = read("src/app/api/tickets/route.ts");
const sheet = read("src/components/rms/SportMenuSheet.tsx");
const tab = read("src/components/rms/SportMenuTab.tsx");
const waiter = read("src/components/rms/WaiterApp.tsx");
const composer = read("src/components/rms/GroupComposer.tsx");
const admin = read("src/components/AdminPanel.tsx");
const migrate = read("src/db/migrate.ts");
const menuApi = read("src/app/api/menu/route.ts");
const dictionary = read("src/lib/staff-dictionary.ts");

const failures = [];
let count = 0;
const pass = (name, ok) => {
  count += 1;
  if (!ok) failures.push(name);
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name}`);
};

/* ── 1. storage: its own table, never on menu_items ───────────────────────── */
{
  pass("the sport list has its own table (sport_menus)", /CREATE TABLE IF NOT EXISTS sport_menus/.test(migrate));
  pass(
    "the table keeps the categories and the typed prices as jsonb",
    /categories jsonb NOT NULL DEFAULT '\[\]'::jsonb/.test(migrate) && /prices jsonb NOT NULL DEFAULT '\[\]'::jsonb/.test(migrate),
  );
  pass("the list can be switched on and off for a day (active flag)", /active boolean NOT NULL DEFAULT true/.test(migrate));
  pass(
    "an existing database gets the table too (column map in the migration)",
    /sport_menus: \{[\s\S]{0,300}?prices: \{ type: "jsonb"/.test(migrate),
  );
  pass(
    "the ordinary menu items table is never given a sport price column",
    !/menu_items[\s\S]{0,200}?sport_price/.test(migrate),
  );
  pass(
    "the public menu API does not mention the sport list at all",
    !/sport/i.test(menuApi),
  );
  pass(
    "the price rule is one pure function (sportPriceFor) with the 'not added = normal' rule",
    /export function sportPriceFor\(/.test(lib) && /return typed \? typed\.sportPrice : Math\.max\(0, Math\.round\(Number\(regularPrice\) \|\| 0\)\)/.test(lib),
  );
  pass(
    "a switched-off list answers nothing, so normal prices come back instantly",
    /if \(!menu \|\| !menu\.active\) return null;/.test(lib),
  );
  pass(
    "the typed prices are cleaned on the way in (numbers, one row per item)",
    /export function parseSportPrices\(/.test(lib) && /const byItem = new Map<number, SportPrice>\(\)/.test(lib),
  );
}

/* ── 2. the owner's editor ─────────────────────────────────────────────────── */
{
  pass("the API exists at /api/sport-menu", /export async function GET/.test(api) && /export async function POST/.test(api));
  pass("only the owner may write (requireAdmin on the POST)", /export async function POST\(request: Request\) \{\s*const auth = await requireAdmin\(\)/.test(api));
  pass("a waiter may read the list he charges from", /requireStaffOrAdmin\(\)/.test(api));
  pass(
    "adding a category is one action and it checks the category exists",
    /action === "add_category"/.test(api) && /SELECT 1 FROM categories WHERE slug=\$1/.test(api),
  );
  pass(
    "one item's price is set with the menu price copied beside it (from … to …)",
    /action === "set_price"/.test(api) && /regularPrice: Math\.max\(0, Math\.round\(Number\(item\.rows\[0\]\.price\) \|\| 0\)\)/.test(api),
  );
  pass(
    "a whole category saves in one go (the owner's add-category panel)",
    /action === "set_category_prices"/.test(api) && /const rows = Array\.isArray\(body\.rows\)/.test(api),
  );
  pass(
    "removing a category also drops its typed prices (normal price returns)",
    /action === "remove_category"/.test(api) && /prices = prices\.filter\(\(price\) => price\.category !== slug\)/.test(api),
  );
  pass("the list can be switched on/off for the day", /action === "set_active"/.test(api));
  pass(
    "an absurd or negative price is rejected before it reaches the table",
    /value < 0 \|\| value > 1_000_000/.test(api),
  );
  pass(
    "the editor lists every item as from <menu price> to <typed price>",
    /L\("from"\)/.test(sheet) && /L\("to"\)/.test(sheet) && /line-through/.test(sheet),
  );
  pass(
    "the editor says one category at a time and names the three the owner asked for",
    /L\("Add a category"\)/.test(sheet) && /cold drinks, hot drinks or pastry/.test(sheet),
  );
  pass(
    "the owner reaches it from his dashboard (a Sport menu tab, ?tab=sport)",
    /key: "sport", label: L\("Sport menu"\)/.test(admin) && /activeTab === "sport" && <SportMenuTab \/>/.test(admin),
  );
  pass("the dashboard tab is the same editor, embedded (no second copy)", /<SportMenuSheet open embedded/.test(tab));
  pass(
    "the waiter's phone is read-only (the server decides with canEdit)",
    /setCanEdit\(Boolean\(next\.canEdit\)\)/.test(sheet) && /canEdit: Boolean\(who\)/.test(api),
  );
  pass(
    "every new label is in the staff dictionary (English ⇄ አማርኛ)",
    /"Sport menu":/.test(dictionary) && /"Use sport prices":/.test(dictionary) && /"Add a category":/.test(dictionary),
  );
}

/* ── 3. the waiter's screen ───────────────────────────────────────────────── */
{
  pass(
    "the top-corner button that used to say Groups is now the Sport menu button",
    /onClick=\{\(\) => \{\s*setSportSheetOpen\(true\);/.test(waiter) && /sportMode \? L\("Sport ON"\) : L\("Sport menu"\)/.test(waiter),
  );
  pass("group bills stay one tap away (the Groups button is still there)", /onClick=\{\(\) => setGroupComposerOpen\(true\)\}/.test(waiter));
  pass(
    "a Sport menu chip sits beside the normal category chips",
    /\{categories\.map\(\(c\) => \([\s\S]{0,4000}?⚡ \{sportMode \? L\("Sport ON"\) : L\("Sport menu"\)\}/.test(waiter),
  );
  pass(
    "added categories are marked on the normal chips (⚡)",
    /isSportCategory\(sportCatalog, c\.slug\)/.test(waiter),
  );
  pass(
    "the cart price comes from the sport rule, not from the raw menu price",
    /const priceFor = \(item: MenuItem\) => chargePrice\(item, effectivePrice\(item\)\.price, sportMode, sportCatalog\)/.test(waiter),
  );
  pass(
    "a cart line keeps the price it was added at (switching mode never rewrites money)",
    /const existing = prev\.find\(\(c\) => c\.menuItemId === item\.id && c\.price === unitPrice\)/.test(waiter),
  );
  pass(
    "the food card reads from <normal> to <match-day> in sport mode",
    /if \(sportMode && charged !== live\.price\) \{/.test(waiter) && /\{live\.price\} <\/span>/.test(waiter),
  );
  pass(
    "the send carries the sport list id only (never a price of its own)",
    /\.\.\.\(sportMode && sportCatalog\?\.menu\?\.id && cart\.some\(\(line\) => line\.sportLine\)[\s\S]{0,80}?\{ sportMenuId: sportCatalog\.menu\.id \}/.test(waiter),
  );
  pass(
    "the saved (held) send keeps the sport list too",
    /sportMenuId\?: number;/.test(waiter) && /\.\.\.\(send\.sportMenuId \? \{ sportMenuId: send\.sportMenuId \} : \{\}\)/.test(waiter),
  );
  pass(
    "a group order placed on a match day is charged the sport prices as well",
    /sportMenuId=\{sportMode \? sportCatalog\?\.menu\?\.id : undefined\}/.test(waiter) && /sportMenuId\?: number;/.test(composer),
  );
  pass(
    "the phone's Back button closes the sport sheet first",
    /\{ at: \(\) => sportSheetOpen, close: \(\) => setSportSheetOpen\(false\) \}/.test(waiter),
  );
  pass(
    "switching on says so out loud, switching off says normal prices are back",
    /tNow\("⚡ Sport prices ON • the marked items are charged the match-day price"\)/.test(waiter) &&
      /tNow\("Normal menu prices are back"\)/.test(waiter),
  );
  pass(
    "a disabled list cannot leave sport mode on (it is switched off when inactive)",
    /if \(!next\.menu \|\| next\.menu\.active === false\) setSportMode\(false\)/.test(waiter),
  );
}

/* ── 4. the server's authority ─────────────────────────────────────────────── */
{
  pass("the ticket route reads the sport list itself", /SELECT id, active, prices FROM sport_menus WHERE id = \$\{requestedSportMenuId\}/.test(route));
  pass(
    "the price is resolved from the list BEFORE the lines are built",
    route.indexOf("sportPriceByPayloadIndex.set") > -1 &&
      route.indexOf("sportPriceByPayloadIndex.set") < route.indexOf("const ticketRows: Array<{ menuItemId: number"),
  );
  pass(
    "a customer submission is never priced from a sport list",
    /if \(!isCustomer && Number\.isInteger\(requestedSportMenuId\) && requestedSportMenuId > 0\)/.test(route),
  );
  pass(
    "switching the list off in the owner screen restores normal prices for the next order",
    /const sportActive = sport\.active !== false;/.test(route) && /if \(sportActive\) \{/.test(route),
  );
  pass(
    "PER LINE: only a line the waiter added in sport mode is charged the sport price",
    /const sportUnitPrice = sportPriceByPayloadIndex\.get\(payloadIndex\);/.test(route) &&
      /it\.price = sportUnitPrice !== undefined \? sportUnitPrice : regularPriceById\.get\(menuId\);/.test(route),
  );
  pass(
    "the ordinary price map is never mutated by the sport block (a normal Cola stays 50)",
    /const regularPriceById = new Map\(priceById\);/.test(route) && !/priceById\.set\(menuItemId, sportPrice\)/.test(route),
  );
  pass(
    "a payload with no per-line flags is still treated as a whole sport send (older phones)",
    /const sportLinesRequested = items\.some\(/.test(route) && /: true; \/\/ no per-line flag in this payload/.test(route),
  );
  pass(
    "a match-day line is stamped so the report can name it later",
    /notes: it\.sportLine \? sportLineNote\(it\.notes\) : it\.notes \|\| ""/.test(route),
  );
  pass(
    "a sport Cola never folds into an ordinary Cola row",
    /const sportFlagDiffers = \(row: \{ notes\?: string \| null \}\) =>/.test(route) && /!sportFlagDiffers\(row\) &&/.test(route),
  );
  pass(
    "the marker is written and read in ONE place (lib/order-lines)",
    /export const SPORT_NOTE_TAG = "SPORT PRICE";/.test(read("src/lib/order-lines.ts")) &&
      /export function sportLineNote\(/.test(read("src/lib/order-lines.ts")) &&
      /export function stripSportMarker\(/.test(read("src/lib/order-lines.ts")),
  );
  pass(
    "two sport Colas still merge (the marker is not part of the dish identity)",
    /notesForMatching\(line\.notes\)\.trim\(\)/.test(read("src/lib/order-lines.ts")),
  );
  pass(
    "the submission records which sport list priced it (explainable later)",
    /sport menu #\$\{requestedSportMenuId\}/.test(route),
  );
  pass(
    "the client helper resolves the same rule the server applies",
    /export function chargePrice\(/.test(client) && /export function sportPriceMap\(/.test(client),
  );
}

/* ── 4b. the report names the match-day money ────────────────────────────── */
{
  const reports = read("src/app/api/reports/route.ts");
  pass(
    "the report gives sport sales their own breakdown (already inside the totals)",
    /const sportSales = \{/.test(reports) && /sportSales,/.test(reports),
  );
  pass(
    "it reads the line marker, never the CURRENT sport list (last week never changes)",
    /if \(!isSportNote\(it\.notes\)\) continue;/.test(reports) && !/sport_menus/.test(reports),
  );
  pass(
    "it counts the sport bills and units, and the ETB those lines brought in",
    /sportTicketIds\.add\(it\.ticketId\)/.test(reports) && /sportRevenue \+= it\.price \* it\.quantity;/.test(reports),
  );
  pass(
    "revenue still comes from the STORED line price, so 150 was always counted",
    /cur\.revenue \+= it\.price \* it\.quantity;/.test(reports),
  );
  pass(
    "the Reports tab shows a sport card only when sport lines sold",
    /data\.sportSales && data\.sportSales\.quantity > 0/.test(read("src/components/rms/ReportsTab.tsx")),
  );
}

/* ── 5. the customer is untouched ─────────────────────────────────────────── */
{
  pass("the customer menu component never reads the sport list", !/sport/i.test(read("src/components/rms/CustomerMenuApp.tsx")));
  pass(
    "the public table/QR checkout never reads the sport list",
    !/sport/i.test(read("src/app/table/[id]/page.tsx")) && !/sport/i.test(read("src/app/menu/page.tsx")),
  );
  pass(
    "the sport API is not reachable by a guest (staff or owner session only)",
    /const auth = await requireStaffOrAdmin\(\);\s*if \(!auth\.ok\) return auth\.response;/.test(api),
  );
}

if (failures.length === 0) {
  console.log(`\n✅ Sport menu regression test PASSED (${count} assertions)`);
  process.exit(0);
}
console.log(`\n❌ ${failures.length} Sport menu assertion(s) FAILED:`);
for (const failure of failures) console.log(`   • ${failure}`);
process.exit(1);
