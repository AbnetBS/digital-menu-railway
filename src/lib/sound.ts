"use client";

/**
 * Ring-bell sound engine for the POS.
 * Browsers require ONE user click to unlock audio — that's why each dashboard
 * shows an "Enable Sound" button (tap it once in the morning on each device).
 */

let ctx: AudioContext | null = null;

/** Call this from a user click once to unlock audio playback. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();
  } catch {
    /* audio unsupported */
  }
}

/** Double bell-ring (ding-ding) — plays after unlockAudio() has been called once. */
export function playDing(hits = 2) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") ctx.resume();

    const start = ctx.currentTime;
    for (let i = 0; i < hits; i++) {
      const t = start + i * 0.28;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(988, t); // B5 bell note
      osc.frequency.exponentialRampToValueAtTime(1319, t + 0.08); // E6 shimmer
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.6);
    }
  } catch {
    /* ignore */
  }
}
