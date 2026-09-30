/**
 * ONE BACK PRESS = ONE STEP BACK (owner's decision, Sept 2026).
 *
 * THE COMPLAINT, in his words: "when they click back button to see the all
 * table it completely return them to chrome or browser this isnt good
 * programing ... 1 back button clcik 1 step back not completly take them to
 * the start".
 *
 * Every staff screen keeps its screens in React state (login → tables →
 * order/bill → payment, or a modal over the board), so the browser's history
 * knew nothing about them: the phone's Back button walked straight out of the
 * app to whatever the browser had before it — the waiter lost her place in the
 * middle of service.
 *
 * THE FIX: each staff screen installs ONE guard history entry above the real
 * page. Every Back press lands on that guard, and the screen then closes its
 * top layer — a modal, then the open bill, then the tables grid, then the
 * login — and pushes the guard again, so the next press is caught the same
 * way. Only when the screen has nothing left to step back through (the waiter
 * is already on her login screen) does the guard let the real Back happen and
 * leave the app.
 *
 * The URL never changes, so Next's router state, the QR query string and any
 * deep link (?tab=, ?id=) survive untouched — the same rule the customer menu
 * follows in @/lib/menu-back-navigation.
 *
 * PURE on purpose: no React, no Next.js. The screens pass one callback and get
 * a cleanup function back, so a React effect can own its whole lifetime.
 */

/** The history key this guard writes, so a reload or a re-install can reuse it. */
const GUARD_KEY = "fanaStaffBack";

type GuardLevel = "base" | "guard";

/**
 * Install the guard for one staff screen.
 *
 * @param win       the window (injected so the regression test can use jsdom).
 * @param stepBack  Close the top layer and report whether one was closed.
 *                  Called on every Back press, newest layer first: a modal
 *                  before the screen under it, the screen before the login.
 *                  Returning `false` means "nothing left to step back through",
 *                  and the real Back (leaving the app) is allowed.
 * @returns a cleanup that removes the listener (a React effect's return).
 */
export function installStaffBackNavigation(
  win: Window,
  stepBack: () => boolean,
): () => void {
  const url = win.location.href;
  let exiting = false;

  const mark = (level: GuardLevel) => ({ ...win.history.state, [GUARD_KEY]: { url, level } });
  const pushGuard = () => win.history.pushState(mark("guard"), "", url);

  // Reuse the entry already in place on a reload or a React Strict Mode effect
  // replay, instead of stacking a second guard the user would have to press
  // through twice.
  const state = win.history.state as { [GUARD_KEY]?: { url: string; level: GuardLevel } } | null;
  if (state?.[GUARD_KEY]?.url !== url || state[GUARD_KEY].level !== "guard") {
    win.history.replaceState(mark("base"), "", url);
    pushGuard();
  }

  const onPop = (event: PopStateEvent) => {
    // A navigation away (the app's own redirect, a link out) is not our press.
    if (exiting || win.location.href !== url) return;
    const level = (event.state as { [GUARD_KEY]?: { level: GuardLevel } } | null)?.[GUARD_KEY]?.level;
    if (level !== "base") return;
    // One press, one step. The guard goes straight back on top, so the next
    // press is caught exactly like this one.
    if (stepBack()) {
      pushGuard();
      return;
    }
    // Nothing left inside the app: the base entry is where we stand, so the
    // next Back is the browser's own and really leaves the page.
    exiting = true;
    win.history.back();
  };

  win.addEventListener("popstate", onPop);
  return () => {
    exiting = true;
    win.removeEventListener("popstate", onPop);
  };
}

/**
 * The step order a staff screen walks, deepest first. Kept as data so the
 * screens stay readable and the regression test can assert the order itself:
 * "the modal closes before the screen under it, the screen before the grid".
 *
 * `at` answers "is this layer on screen right now?" and `close` takes it away.
 */
export interface BackLayer {
  at: () => boolean;
  close: () => void;
}

/**
 * Walk `layers` in order and close the first one that is open.
 * Returns true when a layer was closed (the Back press was consumed).
 */
export function closeTopBackLayer(layers: BackLayer[]): boolean {
  for (const layer of layers) {
    if (!layer.at()) continue;
    layer.close();
    return true;
  }
  return false;
}
