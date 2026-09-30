#!/usr/bin/env tsx
/**
 * Regression guard: ONE BACK PRESS = ONE STEP BACK (owner's decision, 30 Sept
 * 2026).
 *
 * THE COMPLAINT, in his words: "when they click back button to see the all
 * table it completely return them to chrome or browser this isnt good
 * programing ... when someone click back button when he is inside the table it
 * take them to the all tables then again to login page like i want it to be
 * like that in all parts of the system 1 back button clcik 1 step back not
 * completly take them to the start".
 *
 * Every staff screen keeps its screens in React state, so the browser's history
 * knew nothing about them and the phone's Back button left the app. Each screen
 * now installs ONE guard history entry and closes its top layer per press:
 *
 *   waiter   : guest alert / composer → payment → bill → tables → login → out
 *   cashier  : guest alert → receipt → item editor → composer → bill → out
 *   crew     : the Items sold sheet → out
 *   owner    : the dashboard walks back through the tabs (?tab=…) → out
 *   portal   : the role's login form → the role grid → the portal shut → out
 *
 * Run with: npx tsx scripts/verify-staff-back-navigation.ts  (wired into `npm test`)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import {
  closeTopBackLayer,
  installStaffBackNavigation,
  type BackLayer,
} from "../src/lib/staff-back-navigation";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

/* ── 1. the layer walker: one press closes ONE layer, top first ─────────── */
{
  const closed: string[] = [];
  const layer = (name: string, open: () => boolean): BackLayer => ({
    at: open,
    close: () => closed.push(name),
  });
  let modal = true;
  let sheet = true;
  const layers = [layer("alert", () => false), layer("modal", () => modal), layer("sheet", () => sheet)];

  pass("the first press closes the TOP open layer only", closeTopBackLayer(layers) === true && closed.join() === "modal");
  modal = false;
  closeTopBackLayer(layers);
  pass("the next press takes the layer under it", closed.join() === "modal,sheet");
  sheet = false;
  pass("with nothing left to close it says so (and the press may leave the app)", closeTopBackLayer(layers) === false);
  pass("a closed layer is never touched", closed.length === 2);
}

/* ── 2. the history guard, in a real (jsdom) browser history ────────────── */
async function guardWalksOneStepPerPress() {
  const dom = new JSDOM("", { url: "https://cafe.test/previous" });
  const win = dom.window as unknown as Window;
  // Next's router state must survive the guard (the app relies on it).
  const routerState = { __NA: true, tree: { page: "waiter" } };
  win.history.pushState(routerState, "", "/waiter");
  const url = win.location.href;

  // A fake waiter stack: order → tables → login → out.
  const stack = ["order", "tables", "login"];
  const stepBack = () => (stack.length > 1 ? (stack.pop(), true) : false);

  let cleanup = installStaffBackNavigation(win, stepBack);
  const length = win.history.length;
  cleanup(); // a React Strict Mode effect replay must not stack a second guard
  cleanup = installStaffBackNavigation(win, stepBack);
  pass("re-installing reuses the guard instead of stacking another entry", win.history.length === length);
  pass("the guard keeps Next's router state and the URL", win.history.state.__NA === true && win.location.href === url);

  const back = async () => {
    win.history.back();
    await new Promise((resolve) => setTimeout(resolve, 40));
  };

  await back();
  pass("press 1 steps back ONE screen (order → tables)", stack.join() === "order,tables" && win.location.href === url);
  await back();
  pass("press 2 steps back again (tables → login)", stack.join() === "order" && win.location.href === url);
  pass("the guard is still in place, so the app never loses the next press", win.history.length === length);
  await back();
  pass("only with nothing left inside the app does the press really leave it", win.location.pathname === "/previous");

  cleanup();
  dom.window.close();
}

/* ── 3. every staff screen installs it, in the right order ─────────────── */
function everyScreenOwnsTheRule() {
  const waiter = read("src/components/rms/WaiterApp.tsx");
  const cashier = read("src/components/rms/CashierDashboard.tsx");
  const station = read("src/components/rms/StationApp.tsx");
  const portal = read("src/components/StaffAuthModal.tsx");
  const panel = read("src/components/AdminPanel.tsx");

  const installs = (src: string) =>
    /installStaffBackNavigation\(window, \(\) => stepBackRef\.current\(\)\)/.test(src) &&
    /stepBackRef\.current = stepBack;/.test(src);

  pass("the waiter app owns the rule (one listener, installed once)", installs(waiter) && /useRef<\(\) => boolean>/.test(waiter));
  pass("the cashier and the crew screens own it too", installs(cashier) && installs(station));
  pass("the staff & owner portal owns it as well (its layers are its two steps)",
    /installStaffBackNavigation\(window, \(\) => \{/.test(portal) && /backStateRef\.current/.test(portal));

  // THE ORDER IS THE WHOLE FEATURE: the deepest layer must be tested first, or
  // one press would skip a screen (or close two).
  const order = (src: string) => {
    const body = (src.split("closeTopBackLayer([")[1] || "").split("]);")[0] || "";
    return [...body.matchAll(/at: \(\) => ([^\n,]+)/g)].map((m) => m[1].trim());
  };
  const waiterOrder = order(waiter).join(" | ");
  pass("waiter: guest alert → composers → payment → bill/order → tables → login",
    waiterOrder.startsWith("!!urgent")
    && waiterOrder.indexOf("outdoorPickerOpen") < waiterOrder.indexOf('view === "payment"')
    && waiterOrder.indexOf('view === "payment"') < waiterOrder.indexOf('view === "order" || view === "bill"')
    && waiterOrder.indexOf('view === "order" || view === "bill"') < waiterOrder.indexOf('view === "tables"')
    && /close: onGoBack/.test(waiter) && /close: logout/.test(waiter), waiterOrder);
  const cashierOrder = order(cashier).join(" | ");
  pass("cashier: guest alert → receipt → item editor → composers → bill → login",
    cashierOrder.startsWith("!!urgent")
    && cashierOrder.indexOf("!!receiptModal") < cashierOrder.indexOf("!!editTarget && canKeepEditing")
    && cashierOrder.indexOf("!!addToTicket") < cashierOrder.indexOf("!!billModal")
    && cashierOrder.indexOf("!!billModal") < cashierOrder.indexOf("!!staffName"), cashierOrder);
  const crewOrder = order(station).join(" | ");
  pass("crew: the Items sold sheet closes first, then the board steps back to login",
    crewOrder.startsWith("showSales") && crewOrder.indexOf("showSales") < crewOrder.indexOf("!!staffName")
    && /close: closeSales/.test(station) && /close: logout/.test(station), crewOrder);
  pass("portal: the role's form steps back to the role grid, then the portal shuts",
    /if \(!now\.isOpen\) return false;/.test(portal) && /setSelectedRole\(null\)/.test(portal) &&
      /closeRef\.current\(\)/.test(portal));

  // The owner's dashboard walks back through its TABS, in the address bar.
  pass("owner dashboard: a tab tap is one history entry, so Back walks the tabs",
    /const goTab = \(tab: Tab\) => \{/.test(panel) && /window\.history\.pushState\(\{ \.\.\.window\.history\.state \}/.test(panel) &&
      /onClick=\{\(\) => goTab\(t\.key\)\}/.test(panel) && /readTabFromUrl\(\) \|\| "reports"/.test(panel));

  // The customer menu keeps its OWN guard (double-back to leave, QR URL kept):
  // one mechanism per screen, never two guards fighting over one press.
  const menu = read("src/components/rms/CustomerMenuApp.tsx");
  pass("the guest menu keeps its own guard, untouched",
    /installMenuBackNavigation\(/.test(menu) && !/installStaffBackNavigation/.test(menu));
}

async function main() {
  await guardWalksOneStepPerPress();
  everyScreenOwnsTheRule();
  if (failures > 0) {
    console.error(`\n❌ ${failures} back-navigation check(s) failed\n`);
    process.exit(1);
  }
  console.log("\n✅ One back press = one step back, on every staff screen");
  console.log("   • waiter: order → tables → login → out (never straight to the browser)");
  console.log("   • cashier / crew: the top pop-up closes first");
  console.log("   • owner: Back walks the dashboard tabs; the portal steps back through its roles");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
