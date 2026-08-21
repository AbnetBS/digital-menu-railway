#!/usr/bin/env node
/** Regression guard: language UI stays native and order fields stay canonical. */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const layout = read("src/app/layout.tsx");
const toggle = read("src/components/LanguageToggle.tsx");
const i18n = read("src/lib/i18n.ts");
const customer = read("src/components/rms/CustomerMenuApp.tsx");
const failures = [];
const pass = (name, value) => {
  console.log(`${value ? "✅" : "❌"} ${name}`);
  if (!value) failures.push(name);
};

const forbidden = /googtrans|google_translate_element|translate\.google\.com|googleTranslateElementInit/i;
pass("layout has no translator script or element", !forbidden.test(layout));
pass("language toggle does not reload or write cookies", !/location\.reload|document\.cookie/.test(toggle));
pass("native language state uses localStorage and tab sync", /localStorage\.setItem/.test(i18n) && /addEventListener\("storage"/.test(i18n));
pass("customer payload uses canonical cart fields", /menuItemId:\s*c\.menuItemId/.test(customer) && /name:\s*c\.name/.test(customer) && /price:\s*c\.price/.test(customer) && /quantity:\s*c\.quantity/.test(customer) && /notes:\s*c\.notes/.test(customer));
pass("display-only menu translations are separate from cart writes", /name:\s*m\.name, category:\s*m\.category, price:\s*unitPrice/.test(customer) && /menuText\(m\.name\)/.test(customer));
if (failures.length) process.exit(1);
console.log("\n✅ Native language and customer order-flow regression guard passed");
