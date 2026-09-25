#!/usr/bin/env tsx
/**
 * Regression guard: the QR codes already printed and glued to 53 tables.
 *
 * Owner, Sept 2026: "the one currently are cant be change there links beacuse
 * that will be huge money loss for me and compny".
 *
 * A printed QR code is only ink: it holds one URL and nothing else. The URL it
 * holds is `${baseUrl}/menu?table=<the table's database id>`, built in
 * src/components/rms/TablesQrTab.tsx. api.qrserver.com is asked to DRAW the
 * picture of that URL — it never decides what the URL is, and a guest's phone
 * never talks to it. So this guard does not police the picture; it polices the
 * LINK, which is the thing that would cost money if it moved:
 *
 *   1. the link keeps its exact shape (`/menu?table=<id>`);
 *   2. it carries the table's DATABASE ID, never its name — renaming "Table 4"
 *      to "Garden 4" cannot orphan a single printed code;
 *   3. the owner's saved stable domain (qr_base_url) wins over wherever the app
 *      happens to be hosted, so a redeploy cannot change what gets printed;
 *   4. the picture request sends that link and ONLY that link to the outside
 *      service — no PIN, no guest data, nothing else leaves the building;
 *   5. the outside service is used on the owner's print screen ALONE: no guest
 *      screen ever calls a third party;
 *   6. table ids are never reused (serial primary key, POST never accepts an
 *      id), so a deleted table's code can never come to mean another table;
 *   7. the older `/table/<id>` shape still lands on the menu, so codes printed
 *      before this format keep working too;
 *   8. the link is printed as readable text beside the picture, so the owner
 *      can see with their own eyes what a sheet will encode.
 *
 * Run with: npx tsx scripts/verify-qr-links.ts   (wired into `npm test`)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const problems: string[] = [];
const want = (cond: boolean, msg: string) => {
  if (!cond) problems.push(msg);
};

const TAB = "src/components/rms/TablesQrTab.tsx";
const tab = read(TAB);

/* ── 1 + 2. the shape of the link, and the id inside it ───────────────────── */
want(
  tab.includes("const tableLink = (t: CafeTable) => `${baseUrl}/menu?table=${t.id}`;"),
  `the printed QR link must stay exactly \`\${baseUrl}/menu?table=\${t.id}\` — 53 codes are already on tables and point at that address. Found instead:\n    ${(tab.match(/const tableLink[\s\S]{0,120}/) || ["(no tableLink)"])[0].trim()}`
);
want(
  !/\$\{t\.name\}/.test(tab.slice(tab.indexOf("const tableLink"), tab.indexOf("const tableLink") + 200)),
  "the printed QR link must never contain the table's NAME: renaming a table would then orphan every code already glued to it. Use the database id."
);
want(
  tab.includes("qrUrl(tableLink(t))"),
  "the QR picture must encode exactly the table link shown next to it (qrUrl(tableLink(t))) — a picture of anything else is a code that opens the wrong page."
);

/* ── 3. the owner's saved stable domain decides the link ──────────────────── */
want(
  /setBaseUrl\(saved \|\| window\.location\.origin\)/.test(tab),
  "the link base must be the owner's saved stable domain (qr_base_url) first, and only fall back to window.location.origin — otherwise printing from a preview/localhost URL would produce codes that die with that URL."
);
want(
  tab.includes("qr_base_url: customBase.trim()"),
  "the Tables & QR screen must still be able to save the stable domain (qr_base_url) that all printed codes are built from."
);

/* ── 4. what leaves the building to draw the picture ──────────────────────── */
const qrFn = (tab.match(/function qrUrl\(link: string[\s\S]*?\n}/) || [""])[0];
want(qrFn.length > 0, "qrUrl() disappeared — the print screen has no way to draw a code.");
want(
  qrFn.includes("data=${encodeURIComponent(link)}"),
  "the QR picture request must send the link URL-encoded in `data` — anything else encodes the wrong address."
);
const qrParams = [...qrFn.matchAll(/[?&]([a-zA-Z]+)=/g)].map((m) => m[1]).sort();
want(
  JSON.stringify(qrParams) === JSON.stringify(["bgcolor", "color", "data", "margin", "size"]),
  `the QR picture request must send only size/data/color/bgcolor/margin — no other information about the café or its guests may leave for the outside service. Found: ${qrParams.join(", ")}`
);
want(
  !/\b(pin|password|staff|token|session|phone|customer)\b/i.test(qrFn),
  "the QR picture request must never carry credentials or guest data."
);

/* ── 5. the outside service is used on the print screen alone ─────────────── */
const srcDir = join(root, "src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|mjs|js)$/.test(name) ? [full] : [];
  });
const qrserverFiles = walk(srcDir)
  .filter((f) => readFileSync(f, "utf8").includes("qrserver"))
  .map((f) => relative(root, f));
want(
  qrserverFiles.length === 1 && qrserverFiles[0] === TAB,
  `api.qrserver.com must be used ONLY by the owner's print screen (${TAB}) so no guest device ever depends on a third party. Found in: ${qrserverFiles.join(", ") || "(nowhere — did the print screen lose its QR?)"}`
);
const guestScreens = ["src/components/rms/CustomerMenuApp.tsx", "src/components/rms/OrderStatus.tsx", "src/app/menu/page.tsx"];
for (const f of guestScreens) {
  want(
    statSync(join(root, f)).isFile() && !read(f).includes("qrserver"),
    `the guest-facing screen ${f} must not call the outside QR service — a guest's phone should only ever talk to this app.`
  );
}

/* ── 6. a table id can never be handed to a different table ───────────────── */
const schema = read("src/db/schema.ts");
const tableDef = (schema.match(/export const cafeTables = pgTable\("cafe_tables", \{[\s\S]*?\n\}\);/) || [""])[0];
want(
  /id: serial\("id"\)\.primaryKey\(\)/.test(tableDef),
  "cafe_tables.id must stay a serial primary key: Postgres then never reuses an id, so a printed code can never come to mean a different table after one is deleted."
);
const tablesRoute = read("src/app/api/tables/route.ts");
const postFn = (tablesRoute.match(/export async function POST[\s\S]*?\n}/) || [""])[0];
want(
  postFn.length > 0 && !/id:\s*body\.id/.test(postFn) && !/values\(\{[^}]*\bid\b/.test(postFn),
  "POST /api/tables must never accept an id from the client — a hand-picked id could collide with a code that is already printed and glued to a table."
);
const delFn = (tablesRoute.match(/export async function DELETE[\s\S]*?\n}/) || [""])[0];
want(
  delFn.length > 0 && !/update\(cafeTables\)/.test(delFn),
  "DELETE /api/tables must only delete — it must never renumber or rewrite the ids the printed codes depend on."
);

/* ── 7. the older printed shape still opens the menu ──────────────────────── */
const legacy = read("src/app/table/[id]/page.tsx");
want(
  legacy.includes("router.replace(`/menu?table=${params.id}`)"),
  "the legacy /table/<id> address must keep redirecting to /menu?table=<id>: codes printed in that older shape are still on tables and must keep opening the menu."
);

/* ── 8. the owner can read what a sheet will encode ───────────────────────── */
want(
  /break-all font-mono">\{tableLink\(t\)\}/.test(tab),
  "the Tables & QR print screen must show each link as readable text beside its picture, so the owner can check a sheet before printing 50 copies of it."
);
want(
  /<img src=\{qrUrl\(tableLink\(t\)\)\} alt=\{`QR \$\{t\.name\}`\}/.test(tab),
  "each printed card must pair the table's own picture with the table's own link (alt `QR ${t.name}`) — a mismatched pair is a code that sends guests to the wrong table."
);

if (problems.length > 0) {
  console.error("❌ printed QR link guard failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(
  "✅ printed QR link guard passed: the 53 codes already on tables keep their exact address " +
    "(/menu?table=<serial id> on the owner's saved domain), only that address is sent to the picture service, " +
    "guests never touch it, and ids are never reused"
);
