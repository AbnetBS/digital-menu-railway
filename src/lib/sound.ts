"use client";

/**
 * Ring-bell sound engine for the staff screens (Group 10: "must be heard in a
 * loud restaurant").
 *
 * Browsers require ONE user click to unlock audio — the LOGIN button now does
 * it automatically (and each screen still has the manual bell toggle).
 *
 * LOUDNESS strategy: a bell is several oscillators an octave apart (the ear
 * reads the sum as much louder), gains pushed at the compressor ceiling, and
 * the pattern repeats so a waiter half-hears the first ding and fully catches
 * the later ones. High frequencies (1.5–2.1 kHz) cut through cafe noise, the
 * low-octave layer (G4/G5 body) carries the energy on small phone speakers
 * that cannot move much air. On phones we ALSO vibrate — in a pocket,
 * vibration is felt when sound is muffled.
 *
 * NOTE: no web page can out-shout the phone's OS MEDIA volume — if the device
 * is muted or media volume is at minimum, this alarm is silent no matter how
 * hot the signal is. That is why pocket mode ALSO sends a system push (which
 * uses the notification channel) and vibrates: at least one channel gets
 * through. Tell staff to keep media volume up.
 */

let ctx: AudioContext | null = null;
let compressor: DynamicsCompressorNode | null = null;

/** Call this from a user click once (login / the bell button) to unlock audio. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    if (!ctx) {
      ctx = new AC();
      // Route everything through a limiter: we deliberately push gains to the
      // ceiling, the compressor keeps it loud-but-not-distorted. Threshold sits
      // near -6 dB with a high ratio so the summed bells ride close to full
      // scale without ever clipping — the compressor is the thing that makes
      // "louder" safe instead of crunchy.
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -6;
      compressor.knee.value = 3;
      compressor.ratio.value = 20;
      compressor.attack.value = 0.002;
      compressor.release.value = 0.2;
      compressor.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
  } catch {
    /* audio unsupported */
  }
}

function vibrate(pattern: number[]) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    /* vibration unsupported (iOS Safari) */
  }
}

/** One bell hit: fundamental + octaves, fast attack, half-second decay. */
function bell(at: number, level: number) {
  if (!ctx || !compressor) return;
  for (const [freq, gainLevel] of [
    [1568, level], // G6 — cuts through kitchen noise
    [2093, level * 0.6], // C7 — shimmer an octave up
    [784, level * 0.5], // G5 — body
    [392, level * 0.7], // G4 — low-octave layer, energy on small phone speakers
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = freq >= 2093 ? "sine" : "triangle";
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainLevel), at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain);
    gain.connect(compressor);
    osc.start(at);
    osc.stop(at + 0.55);
  }
}

/**
 * Standard ring — a few bells (e.g. a status changed, nothing urgent).
 * `hits` defaults to 3.
 */
export function playDing(hits = 3) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    unlockAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const start = ctx.currentTime + 0.01;
    for (let i = 0; i < hits; i += 1) {
      bell(start + i * 0.3, 0.9);
    }
    vibrate([250, 120, 250]);
  } catch {
    /* ignore */
  }
}

/**
 * THE NEW-ORDER ALARM — long, loud and impossible to miss: paired dings
 * (ding-ding … ding-ding … ding-ding) like a counter bell being hammered.
 * Used when an order ARRIVES and someone must act on it.
 */
export function playAlarm() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    unlockAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();

    const start = ctx.currentTime + 0.01;
    // 6 pairs × (ding + ding 160ms later), pair gap 380ms → ~3.6 s of ringing.
    // Long on purpose: a customer top-up must punch through a lunch-rush room.
    for (let pair = 0; pair < 6; pair += 1) {
      const base = start + pair * 0.62;
      bell(base, 1.0);
      bell(base + 0.16, 1.0);
    }
    vibrate([400, 120, 400, 120, 400, 120, 400, 120, 400, 120, 400, 120, 400]);
  } catch {
    /* ignore */
  }
}
