#!/usr/bin/env node
/**
 * Regression guard: Google-powered translation layer stays SAFE for the live
 * ordering system, and the brand rules (AB Web / Town Square Building) stick.
 *
 *  1. NO Google Translate browser script anywhere — Google's engine runs
 *     server-side only (/api/translate), so it can never inject a banner over
 *     the menu or rewrite React-owned DOM nodes (the old crash/popup problem).
 *  2. The public translate route is language-whitelisted + rate-limited.
 *  3. Customer order payloads keep canonical English names (display Amharic is
 *     a separate, read-only layer).
 *  4. No "Abnet Gobezay" or "Golagul" text in any served component.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const failures = [];
const pass = (name, value) => {
  console.log(`${value ? "✅" : "❌"} ${name}`);
  if (!value) failures.push(name);
};

// ── 1. no Google Translate browser script / banner anywhere ────────────────
{
  const forbidden = /goog-translit|googtrans|google_translate_element|translate\.google\.com\/translate_a\/element\.js|googleTranslateElementInit|\.skiptranslate|goog-te-banner/i;
  const srcDir = join(root, "src");
  const walk = (dir) => {
    const out = [];
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
  };
  const offenders = [];
  for (const file of walk(srcDir)) {
    if (forbidden.test(readFileSync(file, "utf8"))) offenders.push(file.replace(root, ""));
  }
  pass("no Google Translate browser script in any component", offenders.length === 0);
  if (offenders.length) console.log("   offenders:", offenders.join(", "));
}

// ── 2. public translate route: whitelist + rate limit ──────────────────────
{
  const route = read("src/app/api/translate/route.ts");
  pass("translate route enforces a language whitelist", /SUPPORTED_TX_LANGS\.has/.test(route));
  pass("translate route is rate-limited", /checkRateLimit\(/.test(route));
  pass("translate route never fails the UI on error", /status: 200/.test(route) && /translations: \{\}/.test(route));
  const server = read("src/lib/translate-server.ts");
  pass("server translator caps request size", /MAX_TEXTS_PER_CHUNK/.test(server) && /MAX_TEXT_LEN/.test(server));
  pass("server translator is server-only (no browser global fetch of Google in components)", !/use client/.test(server));
}

// ── 3. order flow stays canonical ───────────────────────────────────────────
{
  const customer = read("src/components/rms/CustomerMenuApp.tsx");
  pass(
    "cart writes canonical English names (display Amharic is separate)",
    /menuItemId:\s*c\.menuItemId/.test(customer) &&
      /name:\s*c\.name/.test(customer) &&
      /price:\s*c\.price/.test(customer) &&
      /quantity:\s*c\.quantity/.test(customer) &&
      /notes:\s*c\.notes/.test(customer)
  );
  pass("menu display uses translated text without touching cart fields", /menuText\(m\.name\)/.test(customer));
}

// ── 4. brand & address rules ───────────────────────────────────────────────
{
  const srcDir = join(root, "src");
  const walk = (dir) => {
    const out = [];
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.(ts|tsx)$/.test(e)) out.push(p);
    }
    return out;
  };
  const offenders = [];
  // strip comments so explanatory comments (e.g. in the guard routes) don't trigger
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/([^:"'`])\/\/.*$/gm, "$1"); // trailing // comments (not URLs — those are in strings)
  for (const file of walk(srcDir)) {
    const rel = file.replace(root, "");
    // brand.ts intentionally contains these strings (it is the guard that fixes them)
    if (rel.endsWith("brand.ts") || rel.endsWith("migrate.ts")) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    if (/Abnet\s+Gobezay/i.test(src)) offenders.push(`${rel}: Abnet Gobezay`);
    if (/Golagul/i.test(src)) offenders.push(`${rel}: Golagul`);
  }
  pass("no 'Abnet Gobezay' or 'Golagul' text anywhere in src/", offenders.length === 0);
  if (offenders.length) console.log("   offenders:", offenders.join(", "));

  const brand = read("src/lib/brand.ts");
  pass("brand guard upgrades bare 'Fana Cafe' to 'Fana Cafe & Restaurant'", /BRAND_NAME = "Fana Cafe & Restaurant"/.test(brand));
  pass("address guard rewrites Golagul → Town Square", /Town Square Building/.test(brand));

  const footer = read("src/components/Footer.tsx");
  const menu = read("src/components/rms/CustomerMenuApp.tsx");
  pass("developer credit is AB Web", /AB Web/.test(footer) && /AB Web/.test(menu) && !/Abnet Gobezay/i.test(footer + menu));
}

if (failures.length) {
  console.error(`\n❌ Translation-safety regression guard FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\n✅ Translation-safety and brand regression guard passed");
