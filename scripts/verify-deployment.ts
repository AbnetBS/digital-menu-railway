import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bearerToken } from '../src/lib/bearer-token';
import { deviceAllowed } from '../src/lib/attendance-device';
import { getSiteUrl } from '../src/lib/site-url';

assert.equal(bearerToken('Bearer test-secret'), 'test-secret');
assert.equal(bearerToken('bearer  test-secret  '), 'test-secret');
assert.equal(bearerToken('test-secret'), null);
assert.equal(bearerToken('Bearer '), null);
const old = { ...process.env };
try {
  process.env.NEXT_PUBLIC_SITE_URL = 'https://cafe.example/';
  assert.equal(getSiteUrl(), 'https://cafe.example');
  process.env.ATTENDANCE_DEVICE_TOKEN = 'test-device-token';
  assert.equal(deviceAllowed(new Request('https://cafe.example', { headers: { 'x-attendance-device': 'test-device-token' } })), true);
  assert.equal(deviceAllowed(new Request('https://cafe.example')), false);
  assert.equal(deviceAllowed(new Request('https://cafe.example', { headers: { 'x-attendance-device': 'wrong' } })), false);
  delete process.env.ATTENDANCE_DEVICE_TOKEN;
  assert.equal(deviceAllowed(new Request('https://cafe.example')), true, 'legacy unconfigured device access');
} finally {
  if (old.NEXT_PUBLIC_SITE_URL === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = old.NEXT_PUBLIC_SITE_URL;
  if (old.ATTENDANCE_DEVICE_TOKEN === undefined) delete process.env.ATTENDANCE_DEVICE_TOKEN;
  else process.env.ATTENDANCE_DEVICE_TOKEN = old.ATTENDANCE_DEVICE_TOKEN;
}
const read = (path: string) => readFileSync(path, 'utf8');
const clock = read('src/app/api/attendance/clock/route.ts');
const pending = read('src/app/api/attendance/biometrics/route.ts');
const mappings = read('src/app/api/attendance/mappings/route.ts');
const cleanup = read('src/app/api/tickets/cleanup/route.ts');
assert.ok(clock.includes('method === "fingerprint" && !deviceAllowed(request)'));
assert.ok(pending.includes('pending !== "1" || !deviceAllowed(request)'));
assert.ok(mappings.includes('if (!deviceAllowed(request))'));
assert.ok(cleanup.includes('bearerToken(request.headers.get("authorization"))'));
assert.ok(read('src/lib/receipt-cleanup.ts').includes('throw error;'), 'cleanup failures must not masquerade as zero cleared');
console.log('Deployment guard PASSED: canonical URL, bearer parsing, device-token checks');
