#!/usr/bin/env tsx
/**
 * Regression guard: every staff button that CHANGES something must answer.
 *
 * Owner, Sept 2026: "check also other buttons that i added recenlty if they
 * have other bugs". Auditing them found a pattern worth locking down: many
 * buttons sent their request and then said nothing at all when it failed.
 *
 * The two failures that hurt in a café are:
 *
 *   1. THE SERVER REFUSED (4xx/5xx) — `res.ok` was false, but the handler had
 *      no else branch, so the screen looked exactly like success. The worst
 *      case found was the Order History "Clean Old Receipts" button, which
 *      printed "Cleanup done. N receipt(s) removed." even when the request had
 *      failed and nothing was removed. A staff account that was not created and
 *      a table that was not added failed the same quiet way.
 *   2. THE REQUEST NEVER LANDED (offline, server restarting, timeout) — the
 *      handler had no `catch`, so the tap did nothing whatsoever. On the three
 *      login screens that reads as "your PIN is wrong", and on the waiter's
 *      SEND it left the button disabled forever.
 *
 * So: for every function in a staff screen that issues a POST/PUT/DELETE/PATCH
 * fetch, this guard requires an ok-check, a network guard, and a message the
 * person can actually see. The rules are mechanical, so a brand new button is
 * covered from the day it is written.
 *
 * A second, deliberate list pins the specific buttons audited today by the text
 * they now show — if one of those messages is deleted, the guard names it.
 *
 * Run with: npx tsx scripts/verify-button-feedback.ts   (wired into `npm test`)
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const problems: string[] = [];

/** The screens the crew and the owner press buttons on. */
const SCREEN_DIRS = ["src/components/rms"];
const SCREEN_FILES = ["src/components/AdminPanel.tsx"];

const screenFiles = (): string[] => {
  const out: string[] = [...SCREEN_FILES];
  for (const dir of SCREEN_DIRS) {
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (name.endsWith(".tsx")) out.push(join(dir, name));
    }
  }
  return out;
};

/** Anything that puts words in front of the person who pressed the button. */
const FEEDBACK_SINKS = [
  "showToast(", // crew toast (station, cashier, waiter)
  "flash(", // coffee-note panel's own inline strip
  "alert(",
  "say(", // staff tab inline line
  "fail(", // tables & QR tab inline line
  "setError(",
  "setErrorLine(",
  "setLoginError(",
  "setErrMsg(",
  "setMsg(",
  "setSettingsMsg(",
  "setPasswordMsg(",
  "setSavedMsg(",
  "setRevMsg(",
  "setSubmitFailed(",
  "setBillFailed(", // the guest's bill-request button
  "expireSession(", // a 401 sends the crew back to the login screen
];

/**
 * Handlers that are allowed to stay quiet, each with the reason why.
 * logout() clears the local session FIRST and fires the server call
 * best-effort (`.catch(() => {})`): logging out must keep working with no
 * internet, and there is nothing for the person to fix if it does not land.
 */
const EXEMPT: Array<{ name: string; because: string }> = [
  { name: "logout", because: "clears the local session first; the server call is best-effort" },
];

const isFunction = (n: ts.Node) =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

const visit = (node: ts.Node, fn: (n: ts.Node, parent: ts.Node | undefined) => void, parent?: ts.Node) => {
  fn(node, parent);
  node.forEachChild((c) => visit(c, fn, node));
};

/** `fetch(url, { method: "POST" | "PUT" | "PATCH" | "DELETE" })` */
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];

const isMutatingFetch = (n: ts.Node): boolean => {
  if (!ts.isCallExpression(n)) return false;
  // A `fetch(...).catch(() => null)` chain is covered too: the inner fetch call
  // is its own node and is visited separately.
  const callee = n.expression;
  if (!ts.isIdentifier(callee) || callee.text !== "fetch") return false;
  const opts = n.arguments.find((a) => ts.isObjectLiteralExpression(a)) as ts.ObjectLiteralExpression | undefined;
  if (!opts) return false;
  return opts.properties.some(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === "method") ||
        (ts.isStringLiteral(prop.name) && prop.name.text === "method")) &&
      ts.isStringLiteral(prop.initializer) &&
      MUTATING.includes(prop.initializer.text.toUpperCase())
  );
};

/** The name a person would recognise: `const save = async () => {}` → "save". */
const fnName = (n: ts.Node, parent: ts.Node | undefined): string => {
  if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isMethodDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isShorthandPropertyAssignment(parent)) return parent.name.text;
  return "(inline)";
};

type Handler = { file: string; name: string; body: string };

const mutatingHandlers = (): Handler[] => {
  const out: Handler[] = [];
  for (const file of screenFiles()) {
    const src = read(file);
    const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    // Collect every function that owns a mutating fetch, then keep only the
    // innermost one — an outer wrapper's text also contains the inner fetch.
    const owners: Array<{ node: ts.Node; name: string }> = [];
    visit(ast, (n, parent) => {
      if (!isFunction(n)) return;
      let found = false;
      visit(n, (c) => {
        if (!found && isMutatingFetch(c)) found = true;
      });
      if (found) owners.push({ node: n, name: fnName(n, parent) });
    });

    for (const o of owners) {
      const enclosed = owners.some((x) => x !== o && x.node.getStart(ast) >= o.node.getStart(ast) && x.node.getEnd() <= o.node.getEnd());
      if (enclosed) continue;
      out.push({ file, name: o.name, body: src.slice(o.node.getStart(ast), o.node.getEnd()) });
    }
  }
  return out;
};

const handlers = mutatingHandlers();
if (handlers.length < 30) {
  problems.push(
    `only ${handlers.length} mutating button handlers were found across the staff screens — the scanner is not seeing them, so this guard would pass on an empty repo`
  );
}

for (const h of handlers) {
  if (EXEMPT.some((x) => x.name === h.name)) continue;
  const where = `${h.file} → ${h.name}()`;
  const body = h.body;

  // 1. Did the server actually accept it?
  const checksOk = /\.ok\b/.test(body) || /\.status\s*===/.test(body) || /\.status\s*!==/.test(body);
  if (!checksOk) {
    problems.push(
      `${where} sends a request that changes data but never checks res.ok — a refusal looks exactly like success. Add an else branch that tells the person it failed.`
    );
  }

  // 2. Did the request land at all?
  const guardsNetwork = /\bcatch\b/.test(body);
  if (!guardsNetwork) {
    problems.push(
      `${where} has no catch: with no internet (or while the server restarts) the button does nothing whatsoever. Wrap the fetch so the tap still answers.`
    );
  }

  // 3. Is there anything to see?
  const sink = FEEDBACK_SINKS.find((s) => body.includes(s));
  if (!sink) {
    problems.push(
      `${where} shows no message the person can see. Use one of the known sinks (${FEEDBACK_SINKS.join(
        ", "
      )}) or add your new sink name to FEEDBACK_SINKS in this guard.`
    );
  }
}

// ── the buttons audited today, pinned by the words they now show ──
const PINNED: Array<{ file: string; needles: string[]; button: string }> = [
  {
    file: "src/components/AdminPanel.tsx",
    button: "menu Delete / gallery Delete / categories rename-add-delete / review Approve-Delete / bulk import / reset / website info / password",
    needles: [
      'L("Failed to delete menu item.")',
      'L("Failed to delete gallery photo.")',
      'L("Failed to rename the category.")',
      'L("Failed to add the category.")',
      'L("Failed to delete the category.")',
      'L("Failed to approve the review.")',
      'L("Failed to delete the review.")',
      'setPasswordMsg(d?.error || tNow("Failed to save. Try again."))',
      'setSettingsMsg(tNow("Network error. Try again."))',
    ],
  },
  {
    file: "src/components/rms/CashierDashboard.tsx",
    button: "cashier clear bill request / save payment / login",
    needles: [
      'tNow("Could not clear the bill request. Try again.")',
      'tNow("Could not save the payment status. Try again.")',
      'setLoginError(tNow("Network error. Try again."))',
    ],
  },
  {
    file: "src/components/rms/DailyBoardTab.tsx",
    button: "daily board Delete",
    needles: ['L("Failed to delete announcement.")'],
  },
  {
    file: "src/components/rms/OrderHistoryTab.tsx",
    button: "order history Clean Old Receipts / Delete",
    needles: ['L("Cleanup failed. Try again.")', 'L("Failed to delete this order from the history.")'],
  },
  {
    file: "src/components/rms/OrderStatus.tsx",
    button: "the guest's Request the bill button",
    needles: ["setBillFailed(true)", 't("os_bill_failed")'],
  },
  {
    file: "src/components/rms/ShiftReport.tsx",
    button: "shift change Save Change Hour",
    needles: ['"Could not save the shift change hour."'],
  },
  {
    file: "src/components/rms/StaffTab.tsx",
    button: "staff Add Staff / Edit / Remove",
    needles: [
      'L("✓ Staff account created")',
      'L("Failed to create the staff account.")',
      'L("✓ Staff account updated")',
      'L("Failed to update the staff account.")',
      'L("PIN must be at least 4 characters.")',
      'L("✓ Staff account removed")',
      'L("Failed to remove the staff account.")',
    ],
  },
  {
    file: "src/components/rms/StationApp.tsx",
    button: "station Accept / Done / login",
    needles: [
      'tNow("That tap did not go through. Try again.")',
      'setLoginError(tNow("Network error. Try again."))',
    ],
  },
  {
    file: "src/components/rms/StationsTab.tsx",
    button: "stations Save routing",
    needles: ['L("Network error. Try again.")', 'L("Failed to save routing.")'],
  },
  {
    file: "src/components/rms/TablesQrTab.tsx",
    button: "tables & QR save domain / add table / remove table",
    needles: [
      'L("Could not save the QR domain.")',
      'L("Failed to add the table.")',
      'L("Failed to remove the table.")',
    ],
  },
  {
    file: "src/components/rms/WaiterApp.tsx",
    button: "waiter Send / open bill / remove item / save edit / login",
    needles: [
      'showToast(tNow("Network error. Try again."))',
      'setLoginError(tNow("Network error. Try again."))',
      'tNow("Could not open the bill. Try again.")',
    ],
  },
  {
    file: "src/components/ReviewsSection.tsx",
    button: "website review form Submit",
    needles: ["setSubmitFailed(true)", 't("review_fail")'],
  },
  {
    file: "src/components/rms/CustomerMenuApp.tsx",
    button: "guest review Submit",
    needles: ['setRevMsg(t("review_fail"))'],
  },
];

for (const pin of PINNED) {
  const src = read(pin.file);
  for (const needle of pin.needles) {
    if (!src.includes(needle)) {
      problems.push(
        `${pin.file} lost the failure message ${needle} for: ${pin.button}. ` +
          `A button that changes data must tell the person when it did not work.`
      );
    }
  }
}

// The one bug that started this: cleanup used to report success unconditionally.
if (!read("src/components/rms/OrderHistoryTab.tsx").includes(
  'alert(r.ok ? d?.message || L("Cleanup done") : d?.error || L("Cleanup failed. Try again."))'
)) {
  problems.push(
    "OrderHistoryTab.cleanOldReceipts must only announce 'Cleanup done' for a request that actually succeeded — it used to print that for a failed cleanup too, so the owner believed storage had been freed."
  );
}

// An edit must never cost a person their login: an empty PIN box means "keep
// the PIN they have", so nothing is sent and the server keeps its hash.
if (!read("src/components/rms/StaffTab.tsx").includes("...(editPin ? { pin: editPin } : {})")) {
  problems.push(
    "StaffTab.saveEdit must send a pin ONLY when the owner typed one — sending an empty pin would rehash it and lock that waiter out of their own screen."
  );
}

// Two shapes that are easy to break by accident:
// 1. a failure message is worthless if the refresh that follows erases it
//    (ShiftReport's load() clears the error banner);
// 2. a form that clears itself on failure throws away what was typed.
if (!read("src/components/rms/ShiftReport.tsx").includes("if (failed) return setError(failed);")) {
  problems.push(
    "ShiftReport.saveSplit must return before reloading when the save failed — load() clears the error banner, so reloading would erase the very message telling the owner the hour stayed old."
  );
}
const adminSrc = read("src/components/AdminPanel.tsx");
if (!adminSrc.includes("// Keep what was typed so the owner can press Add again.")) {
  problems.push(
    "AdminPanel's add-category form must keep the typed name when the request fails, and the bulk menu import must keep the pasted menu — clearing them destroys the owner's typing."
  );
}

if (problems.length > 0) {
  console.error("❌ staff button feedback guard failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(
  `✅ button feedback guard passed: ${handlers.length} mutating button handlers across ` +
    `${screenFiles().length} staff screens all check res.ok, survive no internet, and say what happened`
);
