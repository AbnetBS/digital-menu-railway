#!/usr/bin/env tsx
/**
 * Regression guard: EVERY SCREEN, EVERY FONT SIZE (owner's decision, 30 Sept
 * 2026).
 *
 * THE COMPLAINT, in his words: "the owner phone font is big and like the role
 * choice parts all roles arent vissible this happen beacuse the system isnt
 * made for all senariouse so like this case when he try to scrol upa nd clcik
 * admin he cant beacuse the fonts in his phone are to big and the admin page is
 * cut make the system ready for all senarious".
 *
 * The cause is a CSS one, and it is the same everywhere: a `position: fixed`
 * layer does not scroll unless it says so, and `align-items: center` on an
 * overflowing flex box pushes the overflow out of BOTH ends, so the last role
 * in the list (Admin / Owner) fell off the bottom of the screen with no way to
 * reach it. Two rules fix it for every pop-up at once, and this guard keeps
 * them in place:
 *
 *   1. `.fana-fit-screen` on any full-screen staff overlay (it scrolls, and it
 *      centres with `safe center`, which falls back to the start edge when the
 *      card is taller than the phone);
 *   2. the staff & owner portal itself is a scroll region — the card no longer
 *      carries `overflow-hidden`.
 *
 * Run with: npx tsx scripts/verify-fit-any-screen.ts   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const css = read("src/app/globals.css");
const portal = read("src/components/StaffAuthModal.tsx");
const waiter = read("src/components/rms/WaiterApp.tsx");

/* ── 1. the shared helper exists and says what makes it work ────────────── */
pass("the overlay helper is defined once, in the global stylesheet",
  /\.fana-fit-screen \{/.test(css) && /overflow-y: auto;/.test(css));
pass("a tall card keeps its TOP reachable (safe centring, not plain centring)",
  /align-items: safe center;/.test(css) && /justify-content: safe center;/.test(css));
pass("the scroll stays inside the pop-up (no scroll chaining to the page under it)",
  /overscroll-behavior: contain;/.test(css));
pass("fixed bottom bars clear the phone's gesture bar / home indicator",
  /\.fana-safe-bottom \{/.test(css) && /env\(safe-area-inset-bottom\)/.test(css));
pass("a card can cap itself to the screen and scroll inside",
  /\.fana-fit-card \{/.test(css) && /100dvh/.test(css));

/* ── 2. THE REPORTED BUG: the staff & owner portal ─────────────────────── */
pass("the portal is a scroll region, so the LAST role is always reachable",
  /fixed inset-0 z-50 overflow-y-auto overscroll-contain/.test(portal));
pass("the portal card no longer clips what does not fit (overflow-hidden is gone)",
  !/rounded-3xl p-\d[^"]*overflow-hidden/.test(portal) && !portal.includes("shadow-2xl overflow-hidden"));
pass("the card is centred by a min-height wrapper (centres when it fits, scrolls when it does not)",
  /min-h-full flex items-center justify-center/.test(portal));
pass("all seven roles render in the same scrollable list (Admin / Owner included)",
  /roles\.map\(\(r\) =>/.test(portal) && /id: "admin" as const/.test(portal));
pass("the portal respects the bottom inset on notched phones",
  /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/.test(portal));

/* ── 3. every full-screen staff overlay either scrolls or caps itself ──── */
const OVERLAYS: [string, string][] = [
  ["src/components/rms/UrgentAlertOverlay.tsx", "the guest alert that takes over the screen"],
  ["src/components/rms/CashierDashboard.tsx", "the cashier's pop-ups"],
  ["src/components/rms/ReportsTab.tsx", "the reports' pop-ups"],
  ["src/components/rms/DailyBoardTab.tsx", "the daily board's pop-up"],
  ["src/components/rms/OrderHistoryTab.tsx", "the order history's receipt"],
  ["src/components/rms/ShiftReport.tsx", "the shift report"],
  ["src/components/AdminPanel.tsx", "the owner's editors"],
];
for (const [rel, what] of OVERLAYS) {
  const src = read(rel);
  const offenders = src
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes("fixed inset-0"))
    .filter(({ line }) => !line.includes("fana-fit-screen") && !line.includes("overflow-y-auto"))
    .map(({ line, n }) => `${rel}:${n} ${line.trim().slice(0, 90)}`);
  pass(`${what} scroll at any font size`, offenders.length === 0, offenders.join("\n     "));
}

/* ── 4. the waiter's send sheet keeps its controls on screen ───────────── */
pass("the cart sheet is capped and scrolls, so the three controls stay reachable",
  /max-h-\[90dvh\] overflow-y-auto/.test(waiter) && /max-h-\[30dvh\] overflow-y-auto/.test(waiter));
pass("the sheet clears the gesture bar too",
  /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/.test(waiter));

if (failures > 0) {
  console.error(`\n❌ ${failures} fit-any-screen check(s) failed\n`);
  process.exit(1);
}
console.log("\n✅ Every pop-up survives a big system font, a small phone and a notch");
console.log("   • the portal scrolls: the Admin / Owner role is always reachable");
console.log("   • fixed overlays scroll and keep their top edge in reach (safe centring)");
console.log("   • the waiter's send sheet keeps its countdown, Send now and Cancel visible");
