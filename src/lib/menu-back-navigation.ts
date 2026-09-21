/** One same-URL history guard. Preserve Next's router state and the QR query. */
export function installMenuBackNavigation(
  win: Window,
  closeTopLayer: () => boolean,
  showExitHint: (visible: boolean) => void,
) {
  const key = "fanaMenuBack";
  const url = win.location.href;
  let lastBack = 0;
  let exiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mark = (level: "base" | "page") => ({ ...win.history.state, [key]: { url, level } });
  const pushGuard = () => win.history.pushState(mark("page"), "", url);
  // Reuse on reload and React Strict Mode effect replay, rather than stacking guards.
  if (win.history.state?.[key]?.url !== url || win.history.state[key].level !== "page") {
    win.history.replaceState(mark("base"), "", url);
    pushGuard();
  }
  const reset = () => {
    lastBack = 0;
    clearTimeout(timer);
    showExitHint(false);
  };
  const onPop = (event: PopStateEvent) => {
    if (exiting || win.location.href !== url || event.state?.[key]?.level !== "base") return;
    if (closeTopLayer()) {
      reset();
      pushGuard();
      return;
    }
    const now = Date.now();
    if (lastBack && now - lastBack < 2000) {
      exiting = true;
      reset();
      // We are on the base entry now: the next Back is the real previous page.
      win.history.back();
      return;
    }
    lastBack = now;
    pushGuard();
    showExitHint(true);
    clearTimeout(timer);
    timer = setTimeout(reset, 2000);
  };
  win.addEventListener("popstate", onPop);
  return () => {
    clearTimeout(timer);
    win.removeEventListener("popstate", onPop);
  };
}
