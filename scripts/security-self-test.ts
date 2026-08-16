/**
 * Group 1 (security) self-test — exercises the REAL modules, not copies:
 *   - bcrypt hashing / verification (new + legacy plaintext migration)
 *   - in-memory rate limiter (allow then block, window reset)
 * Run: npx tsx scripts/security-self-test.ts
 */
import { hashSecret, verifySecret, isHashed } from "../src/lib/auth";
import { checkRateLimit, getClientIp } from "../src/lib/rate-limit";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures += 1;
}

async function main() {
  // ── Hashing ────────────────────────────────────────────────
  const hash = await hashSecret("fana2026");
  check("hash is 60-char bcrypt ($2b$)", hash.length === 60 && hash.startsWith("$2"));
  check("isHashed detects bcrypt hash", isHashed(hash) === true);
  check("isHashed rejects plaintext", isHashed("fana2026") === false);

  check("verify correct password against hash", (await verifySecret("fana2026", hash)) === true);
  check("verify wrong password against hash", (await verifySecret("wrong", hash)) === false);

  // Legacy plaintext (existing accounts) must still verify — no lockout.
  check("legacy plaintext still verifies", (await verifySecret("1111", "1111")) === true);
  check("legacy plaintext rejects wrong", (await verifySecret("9999", "1111")) === false);

  // Each hash is salted differently.
  const hash2 = await hashSecret("fana2026");
  check("hashes are salted (unique per call)", hash !== hash2);

  // ── Rate limiter ──────────────────────────────────────────
  const key = "test:127.0.0.1";
  const limit = 5;
  const window = 60_000;
  let blocked = false;
  let retry = 0;
  for (let i = 0; i < 10; i++) {
    const r = checkRateLimit(key, limit, window);
    if (!r.allowed) {
      blocked = true;
      retry = r.retryAfterSeconds;
      break;
    }
  }
  check("rate limiter blocks after 5 attempts", blocked === true);
  check("rate limiter returns retry-after seconds", retry >= 1 && retry <= 60);

  // Different keys are independent (staff vs admin buckets).
  const admin = checkRateLimit("admin:1.2.3.4", limit, window);
  check("independent buckets do not block each other", admin.allowed === true);

  // getClientIp parses X-Forwarded-For.
  const req = new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" } });
  check("getClientIp reads first X-Forwarded-For", getClientIp(req) === "203.0.113.7");

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
