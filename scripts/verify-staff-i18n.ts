#!/usr/bin/env tsx
/**
 * Regression guard: the English ⇄ አማርኛ switch on the STAFF screens (admin
 * panel, reports, shift report, waiter, buna, cashier, kitchen, barista,
 * juice). Owner, Sept 2026: fixed labels come from a hand-written dictionary,
 * work offline, never machine-translate, and never touch names, order
 * numbers, prices or "ETB".
 *
 *   1. Dictionary quality: every Amharic value is really Amharic (Ethiopic
 *      letters), keeps the same {placeholders}, <tags>, digits, symbols,
 *      line breaks and edge spaces as its English key, keeps "ETB", and has
 *      no em dash.
 *   2. Source coverage: every phrase the screens ask for exists in the
 *      dictionary, no English sentence is left as raw JSX text or as a
 *      placeholder/title/aria-label, no toast/alert/confirm/error is handed a
 *      raw English sentence, and every staff screen shows the switch.
 *   3. Behaviour: per-device choice (localStorage, with an in-memory fallback
 *      when storage is blocked), the server render is always English (no
 *      hydration mismatch), templates keep the data untouched, dynamic server
 *      text is translated piece by piece, dates get Amharic month names.
 *
 * Run with: npx tsx scripts/verify-staff-i18n.ts   (wired into `npm test`)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { STAFF_AM } from "../src/lib/staff-dictionary";
import {
  STAFF_LANG_KEY,
  getStaffLang,
  setStaffLang,
  staffDate,
  staffRich,
  staffT,
  staffTd,
  tNow,
  useStaffT,
  type StaffPhrase,
} from "../src/lib/staff-i18n";

let failures = 0;
const pass = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && extra ? `\n     ${extra}` : ""}`);
  if (!cond) failures++;
};
const list = (items: string[], max = 12) => items.slice(0, max).join("\n     ") + (items.length > max ? `\n     …and ${items.length - max} more` : "");

const ROOT = path.resolve(__dirname, "..");
const DICT = STAFF_AM as Record<string, string>;
const ETHIOPIC = /[\u1200-\u139F]/;

/* ───────────────────────── 1. dictionary quality ───────────────────────── */

// Values that are deliberately NOT Amharic.
const LATIN_ON_PURPOSE = new Set([
  "English", // the switch names the other language in that language
  "Fana Cafe and Restaurant PLC", // registered company name on printed papers
]);
const isBulkImportExample = (en: string) => en.startsWith("Fresh Mango Juice | juices | ");

const entries = Object.entries(DICT);
pass(`dictionary has entries (${entries.length})`, entries.length > 900);

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const tags = (s: string) => [...s.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort().join(",");
const digitRuns = (s: string) => s.replace(/\{\w+\}/g, "").match(/\d+/g) || [];
const symbols = (s: string) => [...s.matchAll(/\p{Extended_Pictographic}|[✓✗✎•→×]/gu)].map((m) => m[0]);
const lines = (s: string) => (s.match(/\n/g) || []).length;

const bad = {
  empty: [] as string[],
  notAmharic: [] as string[],
  placeholders: [] as string[],
  tags: [] as string[],
  etb: [] as string[],
  digits: [] as string[],
  symbols: [] as string[],
  lines: [] as string[],
  spaces: [] as string[],
  emDash: [] as string[],
};
for (const [en, am] of entries) {
  const key = JSON.stringify(en).slice(0, 90);
  if (!am.trim()) bad.empty.push(key);
  if (!ETHIOPIC.test(am) && !LATIN_ON_PURPOSE.has(en) && !isBulkImportExample(en)) bad.notAmharic.push(`${key} → ${JSON.stringify(am)}`);
  if (placeholders(en) !== placeholders(am)) bad.placeholders.push(`${key}: {${placeholders(en)}} vs {${placeholders(am)}}`);
  if (tags(en) !== tags(am)) bad.tags.push(`${key}: ${tags(en)} vs ${tags(am)}`);
  if (/\bETB\b/.test(en) && !/ETB/.test(am)) bad.etb.push(key);
  const lost = digitRuns(en).filter((d) => !am.includes(d));
  if (lost.length) bad.digits.push(`${key}: lost ${lost.join(",")}`);
  const amSymbols = symbols(am);
  const lostSym = symbols(en).filter((s) => !amSymbols.includes(s));
  if (lostSym.length) bad.symbols.push(`${key}: lost ${lostSym.join(" ")}`);
  if (lines(en) !== lines(am)) bad.lines.push(key);
  if (en.startsWith(" ") !== am.startsWith(" ") || en.endsWith(" ") !== am.endsWith(" ")) bad.spaces.push(key);
  if (/\u2014/.test(en) || /\u2014/.test(am)) bad.emDash.push(key);
}
pass("no empty Amharic value", bad.empty.length === 0, list(bad.empty));
pass("every value is written in Amharic (Ethiopic letters), except the known Latin ones", bad.notAmharic.length === 0, list(bad.notAmharic));
pass("every value keeps exactly the same {placeholders} as its key", bad.placeholders.length === 0, list(bad.placeholders));
pass("every value keeps the same <tags> (styled words) as its key", bad.tags.length === 0, list(bad.tags));
pass('"ETB" is never translated away', bad.etb.length === 0, list(bad.etb));
pass("numbers written in a phrase (7 days, receipt #2, 4 characters) are kept", bad.digits.length === 0, list(bad.digits));
pass("status symbols (✓ ✗ 🔔 🧾 ⚠ • → ×) are kept", bad.symbols.length === 0, list(bad.symbols));
pass("line breaks match (confirm boxes keep their layout)", bad.lines.length === 0, list(bad.lines));
pass("leading/trailing spaces match (pieces that are glued to other text)", bad.spaces.length === 0, list(bad.spaces));
pass("no em dash in any key or value", bad.emDash.length === 0, list(bad.emDash));

// The words the owner named explicitly.
const OWNER_WORDS: StaffPhrase[] = ["Morning", "Afternoon", "Combined", "Need a look", "Total", "Print", "Shift Report", "Totals per person", "Prepared by", "Checked by"];
const missingOwner = OWNER_WORDS.filter((w) => !ETHIOPIC.test(DICT[w] || ""));
pass("the owner's named labels (Morning, Afternoon, Combined, Need a look, Total, Print…) are translated", missingOwner.length === 0, missingOwner.join(", "));
const byLabels = Object.keys(DICT).filter((k) => /^(Accepted by|Done by|Sent by)\b/.test(k));
pass('"Accepted by", "Done by" and "Sent by" are in the dictionary', ["Accepted by", "Done by", "Sent by"].every((w) => byLabels.some((k) => k.startsWith(w))), byLabels.join(" | "));

/* ───────────────────────── 2. source coverage ───────────────────────── */

const STAFF_FILES = [
  "src/components/AdminPanel.tsx",
  "src/components/StaffAuthModal.tsx",
  "src/app/(internal)/admin/page.tsx",
  "src/components/rms/ReportsTab.tsx",
  "src/components/rms/ShiftReport.tsx",
  "src/components/rms/WaiterApp.tsx",
  "src/components/rms/CashierDashboard.tsx",
  "src/components/rms/StationApp.tsx",
  "src/components/rms/StaffTab.tsx",
  "src/components/rms/StationsTab.tsx",
  "src/components/rms/TablesQrTab.tsx",
  "src/components/rms/DailyBoardTab.tsx",
  "src/components/rms/OrderHistoryTab.tsx",
  "src/components/rms/CoffeeNotePanel.tsx",
  "src/components/rms/GroupComposer.tsx",
  "src/components/rms/OutdoorOrderComposer.tsx",
  "src/components/rms/PocketAlertsChip.tsx",
  "src/components/rms/PocketAlertsHint.tsx",
  "src/components/rms/UrgentAlertOverlay.tsx",
  "src/components/rms/BillNotificationCard.tsx",
];
// Translation calls: the screens use L/Lr (hook), tNow (handlers), phrase
// (constant tables); the shift report passes its own `t`/`rich` around.
const CALLS = new Set(["L", "Lr", "tNow", "phrase", "t", "rich", "staffT", "staffRich"]);
// Raw JSX text that is fine in both languages.
const KEEP_TEXT = /^[\s•():#×+\-/0-9]*(ETB|PIN|QR|EFD)?[\s•():#×+\-/0-9]*$/;
// Sinks that show a message to staff: they must never get a raw English sentence.
const SINK = /^(showToast|toast|alert|confirm|prompt|set\w*(Error|Msg|Message|Toast|Notice|Info|Feedback|Warning|Hint))$/;
const prose = (s: string) => /[A-Za-z]{2,}/.test(s) && (/[a-z]{2,} /.test(s) || /^[A-Z][a-z]+/.test(s.trim()));

const asked: { key: string; where: string }[] = [];
const rawText: string[] = [];
const rawAttr: string[] = [];
const rawSink: string[] = [];
for (const rel of STAFF_FILES) {
  const file = path.join(ROOT, rel);
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const at = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const results = (e: ts.Expression, cb: (lit: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression) => void) => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) cb(e);
    else if (ts.isConditionalExpression(e)) {
      results(e.whenTrue, cb);
      results(e.whenFalse, cb);
    } else if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
      results(e.right, cb);
    } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      results(e.left, cb);
      results(e.right, cb);
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n) && ["style", "script"].includes(n.openingElement.tagName.getText(sf))) return;
    if (ts.isCallExpression(n) && n.arguments.length) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      if (CALLS.has(name)) {
        const arg = name === "staffT" || name === "staffRich" ? n.arguments[1] : n.arguments[0];
        if (arg) results(arg, (lit) => {
          if (!ts.isTemplateExpression(lit)) asked.push({ key: lit.text, where: at(lit) });
        });
      } else if (SINK.test(name)) {
        results(n.arguments[0], (lit) => {
          const text = ts.isTemplateExpression(lit) ? lit.head.text + lit.templateSpans.map((s) => " " + s.literal.text).join("") : lit.text;
          if (prose(text)) rawSink.push(`${at(lit)} ${name}(${JSON.stringify(text).slice(0, 70)})`);
        });
      }
    }
    if (ts.isJsxText(n)) {
      const text = n.text.replace(/\s+/g, " ").trim();
      if (/[A-Za-z]{2,}/.test(text) && !KEEP_TEXT.test(text)) rawText.push(`${at(n)} ${JSON.stringify(text).slice(0, 80)}`);
    }
    if (ts.isJsxAttribute(n) && ["placeholder", "title", "aria-label", "alt"].includes(n.name.getText(sf)) && n.initializer) {
      const init = n.initializer;
      const lit = ts.isStringLiteral(init) ? init : ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression)) ? init.expression : null;
      if (lit && /[A-Za-z]{2,}/.test(lit.text)) rawAttr.push(`${at(n)} ${n.name.getText(sf)}=${JSON.stringify(lit.text).slice(0, 70)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
const unknown = asked.filter((a) => !(a.key in DICT));
pass(`every phrase the staff screens ask for is in the dictionary (${new Set(asked.map((a) => a.key)).size} phrases)`, asked.length > 900 && unknown.length === 0, list(unknown.map((u) => `${u.where} ${JSON.stringify(u.key).slice(0, 80)}`)));
pass("no English sentence is left as raw JSX text on a staff screen", rawText.length === 0, list(rawText));
pass("no English placeholder/title/aria-label/alt is left on a staff screen", rawAttr.length === 0, list(rawAttr));
pass("no toast/alert/confirm/error message is handed a raw English sentence", rawSink.length === 0, list(rawSink));

const toggleCount = (rel: string) => (readFileSync(path.join(ROOT, rel), "utf8").match(/<StaffLangToggle\b/g) || []).length;
const TOGGLES: [string, number, string][] = [
  ["src/components/AdminPanel.tsx", 1, "admin header, next to Exit"],
  ["src/app/(internal)/admin/page.tsx", 1, "owner login"],
  ["src/components/rms/ShiftReport.tsx", 1, "shift report header"],
  ["src/components/rms/WaiterApp.tsx", 2, "waiter + buna login and top bar"],
  ["src/components/rms/CashierDashboard.tsx", 2, "cashier login and top bar"],
  ["src/components/rms/StationApp.tsx", 2, "kitchen/barista/juice login and top bar"],
  ["src/components/StaffAuthModal.tsx", 1, "staff & owner portal"],
];
for (const [rel, n, where] of TOGGLES) pass(`the language switch is on the ${where}`, toggleCount(rel) >= n, `${rel}: found ${toggleCount(rel)}`);

/* ───────────────────────── 3. behaviour ───────────────────────── */

// Server render (no window): English.
pass("server side: the staff language is English", getStaffLang() === "en");

// A fake browser: an EventTarget with a localStorage.
const store = new Map<string, string>();
let storageBlocked = false;
const fakeWindow = Object.assign(new EventTarget(), {
  localStorage: {
    getItem: (k: string) => {
      if (storageBlocked) throw new Error("SecurityError");
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if (storageBlocked) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
  },
});
(globalThis as unknown as { window: unknown }).window = fakeWindow;

let heard = 0;
fakeWindow.addEventListener("fana-staff-lang-change", () => heard++);
pass("a new device starts in English", getStaffLang() === "en");
setStaffLang("am");
pass("switching saves the choice on this device (localStorage fana_staff_lang)", store.get(STAFF_LANG_KEY) === "am" && getStaffLang() === "am");
pass("switching tells the open screens at once (same-tab event)", heard === 1);
pass("tNow() uses the language chosen right now", tNow("Close") === DICT["Close"] && ETHIOPIC.test(tNow("Close")));
setStaffLang("en");
pass("switching back gives English again", getStaffLang() === "en" && tNow("Close") === "Close");

// Hydration safety: even with Amharic saved, the server HTML is English.
setStaffLang("am");
function Probe() {
  const { t } = useStaffT();
  return createElement("span", null, t("Close"));
}
const html = renderToString(createElement(Probe));
pass("the server render stays English even when the device chose Amharic (no hydration mismatch)", html.includes(">Close<"), html);

// Storage blocked (private mode): the switch still works for this page.
store.clear();
storageBlocked = true;
setStaffLang("am");
pass("with storage blocked, the switch still works for this page (in-memory fallback)", getStaffLang() === "am");
storageBlocked = false;
store.set(STAFF_LANG_KEY, "en");
pass("a saved choice wins over the in-memory fallback", getStaffLang() === "en");

// Templates: data passes through untouched.
const qr = staffT("am", "{totalAmount} ETB • new QR order", { totalAmount: "1,250" });
pass('prices and "ETB" pass through a translated template unchanged', qr.startsWith("1,250 ETB • ") && ETHIOPIC.test(qr), qr);
const sent = staffT("am", "Sent by {name}" as StaffPhrase, { name: "yeshi" });
pass("staff names pass through unchanged (Sent by yeshi)", sent.includes("yeshi") && ETHIOPIC.test(sent), sent);
const order = staffT("am", "🧾 BILL REQUESTED • {tableName} • {totalAmount} ETB", { tableName: "Table 8", totalAmount: 430 });
pass("table names and totals stay as they are inside Amharic alerts", order.includes("Table 8") && order.includes("430 ETB") && order.startsWith("🧾"), order);
pass("English mode returns the English phrase itself", staffT("en", "Need a look") === "Need a look");
const rich = renderToString(
  createElement(
    "p",
    null,
    staffRich("am", "Tap <b>Share</b> → <b>Add to Home Screen</b>, then always open Fana from the home screen icon. Apple only allows pocket notifications for installed apps. (Android phones work automatically.)", {
      b: (s) => createElement("strong", null, s),
    }),
  ),
);
pass("styled sentences keep their styled words (in Amharic order)", rich.startsWith("<p><strong>Share</strong> → <strong>Add to Home Screen</strong>") && ETHIOPIC.test(rich), rich);

// Dynamic server text (order history audit lines, report flags).
const trAudit = (text: string) =>
  text
    .split(" • ")
    .map((part) => part.split(" → ").map((piece) => staffTd("am", piece)).join(" → "))
    .join(" • ");
const a1 = trAudit("Quantity changed • Cappuccino • yeshi");
pass("audit line: the event is translated, item and staff names are kept", a1.startsWith(DICT["Quantity changed"]) && a1.endsWith("• Cappuccino • yeshi"), a1);
const a2 = trAudit("pending waiter → confirmed");
pass("audit detail: both statuses are translated", !/[a-z]{3}/.test(a2) && a2.includes(" → "), a2);
for (const piece of ["Guest added items", "Waiter added items", "Cashier added items", "Printed", "Sent to stations", "Order created", "Status", "ready for payment", "empty", "item", "Edited & Printed", "Edited & Cancelled", "Cancelled", "Done"]) {
  if (!ETHIOPIC.test(staffTd("am", piece))) pass(`server word "${piece}" is translated`, false);
}
pass("unknown dynamic text stays English instead of turning into garbage", staffTd("am", "Chicken Shawarma") === "Chicken Shawarma");
pass("waiting time is translated (6 min → 6 ደቂቃ, just now → አሁን)", staffTd("am", "6 min") === "6 ደቂቃ" && staffTd("am", "just now") === DICT["just now"]);

// Dates.
pass("dates get Amharic month names in Amharic", staffDate("am", "24 Sep 2026") === "24 ሴፕቴምበር 2026");
pass("dates stay English in English", staffDate("en", "24 Sep 2026") === "24 Sep 2026");
pass('a staff member called "May" or "Jan" keeps the name', staffDate("am", "May") === "May" && staffT("am", "Sent by {name}" as StaffPhrase, { name: "Jan" }).includes("Jan"));
const covers = staffT("am", "Covers: {rangeText}" as StaffPhrase, { rangeText: "22 Sep 2026 – 24 Sep 2026" });
pass("dates inside templates are converted too", (covers.match(/ሴፕቴምበር/g) || []).length === 2, covers);

console.log(failures ? `\n❌ ${failures} staff language check(s) failed` : "\n✅ staff language checks passed");
process.exit(failures ? 1 : 0);
