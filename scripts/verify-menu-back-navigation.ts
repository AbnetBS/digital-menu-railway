import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installMenuBackNavigation } from "../src/lib/menu-back-navigation";

async function main() {
  const dom = new JSDOM("", { url: "https://cafe.test/previous" });
  const win = dom.window as unknown as Window;
  const routerState = { __NA: true, tree: { page: "menu" } };
  win.history.pushState(routerState, "", "/menu?table=5");
  const url = win.location.href;
  let layer = "";
  let hint = false;
  const closeLayer = () => { if (!layer) return false; layer = ""; return true; };
  let cleanup = installMenuBackNavigation(win, closeLayer, (v) => { hint = v; });
  const length = win.history.length;
  cleanup(); // Strict Mode effect replay must not add another entry.
  cleanup = installMenuBackNavigation(win, closeLayer, (v) => { hint = v; });
  assert.equal(win.history.length, length);
  assert.equal(win.history.state.__NA, true);
  assert.deepEqual(win.history.state.tree, routerState.tree);
  const back = async () => {
    win.history.back();
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  for (const name of ["detail", "gallery", "review", "status", "detail"]) {
    layer = name;
    await back();
    assert.equal(layer, "");
    assert.equal(hint, false);
    assert.equal(win.location.href, url);
    assert.equal(win.history.length, length);
  }
  // X/backdrop closes do not add a history entry.
  layer = "detail";
  layer = "";
  await back();
  assert.equal(hint, true);
  assert.equal(win.location.href, url);
  // Waiting beyond the double-back window requires a fresh first press.
  const realNow = Date.now;
  const later = realNow() + 3000;
  Date.now = () => later;
  await back();
  assert.equal(win.location.href, url);
  assert.equal(hint, true);
  await back();
  Date.now = realNow;
  assert.equal(win.location.pathname, "/previous");
  assert.equal(hint, false);
  cleanup();
  dom.window.close();
  console.log("✓ Menu Back: closes layers, keeps QR URL/router state, reuses guard, and exits only on double Back");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
