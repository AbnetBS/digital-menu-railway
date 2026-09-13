"use client";

/**
 * Ring-bell sound engine for the staff screens ("must be heard in a loud
 * restaurant, from a pocket").
 *
 * Browsers require ONE user gesture before a page may make noise. The LOGIN
 * button does it, every screen still has the manual bell toggle, AND — new —
 * the FIRST tap anywhere on the page arms the audio automatically
 * (`armAudioOnFirstGesture`). That matters because staff usually return to an
 * app that restored its session, so they never press "login" again and the old
 * code left the audio locked all shift.
 *
 * TWO ENGINES, on purpose:
 *
 *   1. An <audio> ELEMENT playing a pre-rendered bell (the primary path).
 *      Once unlocked by a gesture, a media element keeps the right to play
 *      while the tab is in the BACKGROUND or the screen is off. This is what
 *      makes the alarm audible when the phone is in a pocket with the tab
 *      still open.
 *   2. The Web Audio synth (fallback + desktop). Rich and instant, but mobile
 *      browsers suspend an AudioContext when the page is hidden — which is
 *      exactly the pocket case, so it can no longer be the only engine.
 *
 * TWO BELLS, ONE SKELETON (owner's fix, Sept 2026): the kitchen and the juice
 * bar stand close together, and one shared counter bell made the kitchen crew
 * answer the juice calls (and back). So the alarm PATTERN stays identical for
 * everyone — 6 pairs of dings, the same gaps, the same loudness ceiling, the
 * same vibration — and only the BELL differs:
 *
 *   kitchen (the default) → the ORIGINAL G-family counter bell: G6 lead with
 *                           a C7 major-third sparkle and a deep G4 body.
 *   juice                 → a NEW brighter E-family bell: E6 lead, a B6
 *                           PERFECT-FIFTH shimmer (instead of a third), an E7
 *                           sparkle and a body a full fifth higher (E5, not
 *                           G4). Same pattern, same volume, different colour —
 *                           the two can no longer be confused by ear.
 *
 * A page chooses its bell once with setStationBell(); every alarm path on that
 * page — SSE new items, stop-work, the pocket push relay, the test button —
 * then rings it. Each staff screen is its own tab, i.e. its own copy of this
 * module, so the juice bell can never leak into the kitchen tablet. Every
 * screen that never calls setStationBell() keeps the original kitchen bell.
 *
 * LOUDNESS strategy: a bell is several oscillators an octave apart (the ear
 * reads the sum as much louder), gains pushed at the compressor ceiling, and
 * the pattern repeats so a waiter half-hears the first ding and fully catches
 * the later ones. High frequencies (1.3-2.6 kHz) cut through cafe noise, the
 * low-octave layer (the G4/E5 body) carries the energy on small phone speakers
 * that cannot move much air. On phones we ALSO vibrate — in a pocket,
 * vibration is felt when sound is muffled.
 *
 * NOTE: no web page can out-shout the phone's OS MEDIA volume — if the device
 * is muted or media volume is at minimum, this alarm is silent no matter how
 * hot the signal is. That is why pocket mode ALSO sends a system push (which
 * uses the notification channel, a different volume slider) and vibrates: at
 * least one channel gets through. Tell staff to keep media volume up.
 */

let ctx: AudioContext | null = null;
let compressor: DynamicsCompressorNode | null = null;
const alarmEls = new Map<AlarmBell, HTMLAudioElement>();
const alarmElReady = new Set<AlarmBell>();
/** Which bell THIS page rings. Default = the original kitchen bell, so every
 *  screen that never calls setStationBell() sounds exactly as before. */
let activeBell: AlarmBell = "kitchen";
let gestureArmed = false;

/* ── The two bells: [frequency, relative level] per hit ───────────────────── */

export type AlarmBell = "kitchen" | "juice";

type BellPartial = [number, number];

/** The ORIGINAL kitchen counter bell — kept exactly as it was. */
const KITCHEN_BELL: BellPartial[] = [
  [1568, 1.0], // G6 — cuts through kitchen noise
  [2093, 0.6], // C7 — shimmer a major third up
  [784, 0.5], // G5 — body
  [392, 0.7], // G4 — low-octave layer, energy on small phone speakers
];

/**
 * The JUICE BAR's bell — a different colour of the SAME alarm. Same 6-pair
 * pattern and the same full-scale loudness (each bell is normalised to the
 * same peak in both engines); different music: an E-family "ting" with a
 * perfect-fifth shimmer and a body a full fifth above the kitchen's G4, so a
 * crew half-hearing it across the room knows which side of the house it is.
 */
const JUICE_BELL: BellPartial[] = [
  [1318.5, 1.0], // E6 — lead (the kitchen's lead is G6)
  [1975.5, 0.6], // B6 — shimmer a PERFECT FIFTH up (the kitchen's is a major third)
  [2637, 0.35], // E7 — high sparkle
  [659.25, 0.7], // E5 — low-octave body, a full fifth above the kitchen's G4
];

const ALARM_BELLS: Record<AlarmBell, BellPartial[]> = {
  kitchen: KITCHEN_BELL,
  juice: JUICE_BELL,
};

/**
 * Point THIS page at its bell — call once on mount from a staff screen.
 * Also pre-renders that bell's WAV so the first alarm starts instantly.
 */
export function setStationBell(bell: AlarmBell) {
  activeBell = bell;
  ensureAlarmElement(bell);
}

/** Pair timing of the alarm: 6 pairs of dings, ~3.8 s of ringing. */
const ALARM_PAIRS = 6;
const PAIR_GAP = 0.62;
const PAIR_OFFSET = 0.16;

/* ── Pre-rendered WAV (engine 1) ──────────────────────────────────────────── */

function renderAlarmWav(partials: BellPartial[]): string {
  const rate = 22050;
  const duration = (ALARM_PAIRS - 1) * PAIR_GAP + PAIR_OFFSET + 0.6;
  const length = Math.ceil(rate * duration);
  const data = new Float32Array(length);
  // Each bell divides by its OWN level sum before normalisation, so both
  // bells land at the same full scale: "different sound, same loudness".
  const levelSum = partials.reduce((sum, [, level]) => sum + level, 0);

  const hits: number[] = [];
  for (let pair = 0; pair < ALARM_PAIRS; pair += 1) {
    const base = pair * PAIR_GAP;
    hits.push(base, base + PAIR_OFFSET);
  }

  for (const hit of hits) {
    const startSample = Math.floor(hit * rate);
    for (let i = 0; i < Math.floor(0.6 * rate); i += 1) {
      const idx = startSample + i;
      if (idx >= length) break;
      const t = i / rate;
      // 15 ms attack, exponential decay to silence by ~0.5 s (same shape the
      // Web Audio bell uses, so both engines sound identical).
      const env = t < 0.015 ? t / 0.015 : Math.exp(-(t - 0.015) * 7.5);
      let sample = 0;
      for (const [freq, level] of partials) {
        sample += Math.sin(2 * Math.PI * freq * t) * level;
      }
      data[idx] += (sample / levelSum) * env;
    }
  }

  // Normalise, then soft-clip: loud without the crunch of hard clipping.
  let peak = 0;
  for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
  const scale = peak > 0 ? 0.98 / peak : 1;

  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i += 1) {
    const v = Math.tanh(data[i] * scale * 1.6);
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32767, true);
  }

  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${window.btoa(binary)}`;
}

function ensureAlarmElement(bell: AlarmBell) {
  if (alarmEls.has(bell) || typeof window === "undefined" || typeof Audio === "undefined") return;
  try {
    const el = new Audio(renderAlarmWav(ALARM_BELLS[bell]));
    el.preload = "auto";
    el.volume = 1;
    // Some Android builds refuse background playback for a muted or very short element;
    // load() up-front so the data is decoded and ready before the rush.
    el.load();
    alarmEls.set(bell, el);
  } catch {
    alarmEls.delete(bell);
  }
}

/** Call this from a user click once (login / the bell button) to unlock audio. */
export function unlockAudio() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
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
      if (ctx.state === "suspended") void ctx.resume();
    }

    // Prime EVERY bell INSIDE the gesture: playing (and immediately pausing)
    // each one here is what buys the right to play it later with the screen
    // off. Without this prime, the pocket alarm is silent.
    for (const bellName of Object.keys(ALARM_BELLS) as AlarmBell[]) {
      ensureAlarmElement(bellName);
      const el = alarmEls.get(bellName);
      if (!el || alarmElReady.has(bellName)) continue;
      const prevVolume = el.volume;
      el.volume = 0;
      const p = el.play();
      const finish = () => {
        try {
          el.pause();
          el.currentTime = 0;
          el.volume = prevVolume;
          alarmElReady.add(bellName);
        } catch {
          /* ignore */
        }
      };
      if (p && typeof p.then === "function") {
        p.then(finish).catch(() => {
          el.volume = prevVolume;
        });
      } else {
        finish();
      }
    }
  } catch {
    /* audio unsupported */
  }
}

/**
 * Arm the audio on the FIRST tap/keypress anywhere, and keep the context alive
 * when the tab comes back. Staff resume a saved session far more often than
 * they log in, so waiting for the login button meant a muted shift.
 */
export function armAudioOnFirstGesture() {
  if (gestureArmed || typeof window === "undefined") return;
  gestureArmed = true;
  const arm = () => {
    unlockAudio();
    if (alarmElReady.size > 0) {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("touchstart", arm);
      window.removeEventListener("keydown", arm);
      window.removeEventListener("click", arm);
    }
  };
  window.addEventListener("pointerdown", arm, { passive: true });
  window.addEventListener("touchstart", arm, { passive: true });
  window.addEventListener("keydown", arm);
  window.addEventListener("click", arm);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && ctx && ctx.state === "suspended") void ctx.resume();
  });
}

/** True when this device can actually make noise right now. */
export function audioArmed(): boolean {
  return alarmElReady.size > 0 || (!!ctx && ctx.state === "running");
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
function bell(at: number, level: number, partials: BellPartial[] = ALARM_BELLS[activeBell]) {
  if (!ctx || !compressor) return;
  for (const [freq, rel] of partials) {
    const gainLevel = level * rel;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = freq >= 1900 ? "sine" : "triangle";
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

/** Web Audio version of the alarm (fallback when the media element cannot play). */
function synthAlarm() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    unlockAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    const partials = ALARM_BELLS[activeBell];
    const start = ctx.currentTime + 0.01;
    // 6 pairs × (ding + ding 160ms later), pair gap 380ms → ~3.6 s of ringing.
    // Long on purpose: a customer top-up must punch through a lunch-rush room.
    for (let pair = 0; pair < ALARM_PAIRS; pair += 1) {
      const base = start + pair * PAIR_GAP;
      bell(base, 1.0, partials);
      bell(base + PAIR_OFFSET, 1.0, partials);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Standard ring — a few bells (e.g. a status changed, nothing urgent).
 * `hits` defaults to 3. Rings with the page's own bell (setStationBell), so a
 * quantity correction on the juice screen tingts like the juice bell too.
 */
export function playDing(hits = 3) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    unlockAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const partials = ALARM_BELLS[activeBell];
    const start = ctx.currentTime + 0.01;
    for (let i = 0; i < hits; i += 1) {
      bell(start + i * 0.3, 0.9, partials);
    }
    vibrate([250, 120, 250]);
  } catch {
    /* ignore */
  }
}

/**
 * THE ALARM — long, loud and impossible to miss: paired dings
 * (ding-ding … ding-ding … ding-ding) like a counter bell being hammered.
 * The BELL depends on the page (setStationBell): the kitchen hears the
 * original G-family counter bell, the juice bar hears its brighter E-family
 * bell — same 6-pair pattern, same volume, same vibration.
 *
 * Plays through the media element first so it is still heard when the tab sits
 * in the background with the screen off; the synth is the fallback.
 */
export function playAlarm() {
  // Vibration first: it is the one channel that works with the ringer muted.
  vibrate([400, 120, 400, 120, 400, 120, 400, 120, 400, 120, 400, 120, 400]);
  try {
    ensureAlarmElement(activeBell);
    const alarmEl = alarmEls.get(activeBell);
    if (alarmEl) {
      try {
        alarmEl.pause();
        alarmEl.currentTime = 0;
      } catch {
        /* ignore */
      }
      alarmEl.volume = 1;
      const p = alarmEl.play();
      if (p && typeof p.then === "function") {
        p.catch(() => synthAlarm()); // blocked (never unlocked) → try the synth
      }
      return;
    }
  } catch {
    /* fall through to the synth */
  }
  synthAlarm();
}
