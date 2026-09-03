#!/usr/bin/env node
/**
 * Regression test — "No em-dash (—) in user-visible text".
 *
 * Staff (Hanna the cashier especially) read everything at a glance under
 * pressure, and the owner's rule is plain: user-facing text must read human —
 * "→" for flows, "•" or a comma for lists — never the em-dash divider "—".
 * Code COMMENTS may keep em-dashes (the owner never sees them), so this guard
 * does NOT text-grep raw files (that would flag every comment). It parses each
 * file with the TypeScript parser and inspects ONLY the nodes that reach a
 * human:
 *   • string literals (double/single-quoted, incl. template-literal text)
 *   • JSX text nodes
 * in src/ and public/sw.js — plus every string value in .json / .webmanifest.
 *
 * If an em-dash ever creeps back into UI copy, push bodies, notification
 * texts, the service worker or the PWA manifest, this test fails and prints
 * the exact location.
 *
 * Run with: node scripts/verify-no-em-dash.mjs  (wired into `npm test`)
 */
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = "—";
const SCAN_DIRS = ["src", "public"];

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".next")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?|json|webmanifest|mjs)$/.test(name)) files.push(p);
  }
}
SCAN_DIRS.forEach((d) => walk(join(root, d)));

const failures = [];

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!src.includes(DASH)) continue;

  const rel = file.replace(root + "/", "");

  if (file.endsWith(".json") || file.endsWith(".webmanifest")) {
    // JSON: every string is a user-visible candidate.
    const hits = [];
    const walkJson = (node) => {
      if (typeof node === "string" && node.includes(DASH)) hits.push(node);
      else if (Array.isArray(node)) node.forEach(walkJson);
      else if (node && typeof node === "object") Object.values(node).forEach(walkJson);
    };
    try {
      walkJson(JSON.parse(src));
    } catch {
      /* invalid JSON — not our concern here */
    }
    for (const text of hits) {
      failures.push(`${rel}: em-dash in JSON string: "${text.slice(0, 100)}"`);
    }
    continue;
  }

  const kind = file.endsWith(".tsx") || file.endsWith(".jsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);

  const check = (node, text) => {
    if (typeof text === "string" && text.includes(DASH)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      failures.push(`${rel}:${line + 1}: em-dash in user-visible text: "${text.replace(/\s+/g, " ").slice(0, 120).trim()}"`);
    }
  };

  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node, node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      check(node, node.text);
    } else if (ts.isJsxText(node)) {
      check(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (failures.length > 0) {
  console.error("\n❌ EM-DASH REGRESSION TEST FAILED\n");
  console.error("  User-visible strings must not contain “—”. Use “→” for flows,\n  “•” or a comma for lists. (Code comments are fine.)\n");
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}
console.log("\n✅ No em-dashes in user-visible text (src + public)");
