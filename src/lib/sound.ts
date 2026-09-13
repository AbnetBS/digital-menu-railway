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
 * TWO COMPLETELY DIFFERENT SOUNDS, ONE SKELETON (owner's fix, Sept 2026): the
 * kitchen and the juice bar stand close together and the one shared alarm
 * made the kitchen crew answer the juice calls (and back). So the alarm
 * SKELETON is identical for everyone — 6 pairs of hits (hit-hit × 6), the
 * same gaps, the same ~3.8 s length, the same loudness, the same vibration —
 * and only the SOUND differs. It is not "a different bell": it is a different
 * instrument, so there is zero chance of mixing them up by ear:
 *
 *   kitchen (the default) → the ORIGINAL counter bell, untouched: a G-family
 *                           "ding" (G6 lead, C7 major-third sparkle, deep G4
 *                           body). Every screen that never calls
 *                           setStationBell() keeps this exact sound.
 *   juice                 → an ELECTRONIC TWO-TONE "ba-doo" beep: square-wave
 *                           A5 / D6 (odd harmonics, 1/n — mathematically a
 *                           square wave), each PAIR plays one "ba-doo", like
 *                           a POS order alarm. A flat, hard electronic edge —
 *                           the exact opposite of a ringing bell.
 *
 *   Both are loudness-matched: each is peak-normalised to the same full
 *   scale, and the denser beep gets a measured `rmsTrim` (0.58) applied after
 *   normalisation so its perceived volume equals the bell's (within 0.1 dB).
 *
 * A page chooses its sound once with setStationBell(); every alarm path on
 * that page — SSE new items, stop-work, the pocket push relay, the test
 * button, the short dings — then follows it. Each staff screen is its own
 * tab, i.e. its own copy of this module, so the two sounds can never leak
 * into each other.
 *
 * LOUDNESS strategy: a hit is several oscillators stacked (the ear reads the
 * sum as much louder), gains pushed at the compressor ceiling, and the
 * pattern repeats so a waiter half-hears the first hit and fully catches the
 * later ones. High frequencies (1.3-8.2 kHz) cut through cafe noise, the
 * low-octave layer (the bell's G4 body) carries the energy on small phone
 * speakers that cannot move much air. On phones we ALSO vibrate — in a
 * pocket, vibration is felt when sound is muffled.
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
/** Which sound THIS page rings. Default = the original kitchen bell, so every
 *  screen that never calls setStationBell() sounds exactly as before. */
let activeBell: AlarmBell = "kitchen";
let gestureArmed = false;

/* ── The two sounds: one per station, one skeleton for both ───────────────── */

export type AlarmBell = "kitchen" | "juice";

/** One tone component: [frequency, relative level, oscillator type?]. The
 *  oscillator type is optional and only needed when the default rule
 *  (sine above 2093 Hz, triangle below — the original kitchen rule) does not
 *  fit the sound being built. */
type BellPartial = [number, number, ("sine" | "triangle")?];

/**
 * One station's alarm sound.
 *
 * `timbres` is the list of hit shapes; hit i plays timbres[i % length]
 * (kitchen = one timbre repeated 12 times, juice = A5/D6 alternating).
 * `divisor` scales the raw hit down to a common pre-normalisation level.
 * `rmsTrim` is applied AFTER peak normalisation so a denser sound (the
 * square-wave beep packs more energy per hit than the bell) still sits at
 * the SAME perceived volume: 0.58 was measured so the beep matches the
 * kitchen bell within 0.1 dB.
 */
type BellSpec = {
  timbres: BellPartial[][];
  divisor: number;
  rmsTrim: number;
};

/** The ORIGINAL kitchen counter bell — kept exactly as it was. */
const KITCHEN_BELL: BellSpec = {
  timbres: [
    [
      [1568, 1.0], // G6 — cuts through kitchen noise
      [2093, 0.6], // C7 — shimmer a major third up
      [784, 0.5], // G5 — body
      [392, 0.7], // G4 — low-octave layer, energy on small phone speakers
    ],
  ],
  divisor: 2.8,
  rmsTrim: 1,
};

/**
 * The JUICE BAR's alarm — a completely different instrument: an electronic
 * two-tone "ba-doo" beep. Each PAIR is one A5 "ba" + D6 "doo", so the
 * ding-ding × 6 pattern reads the same, but the flat square-wave edge
 * (odd harmonics at 1/n = a mathematical square wave) can never be mistaken
 * for a bell. The D6 tone is scaled to 0.82 so both tones peak equally, and
 * rmsTrim 0.58 keeps its volume identical to the kitchen bell.
 */
const JUICE_BELL: BellSpec = {
  timbres: [
    // "ba" — A5 880 Hz square wave
    [
      [880, 1.0, "sine"],
      [2640, 0.3333, "sine"],
      [4400, 0.2, "sine"],
      [6160, 0.1429, "sine"],
      [7920, 0.1111, "sine"],
    ],
    // "doo" — D6 1174.66 Hz square wave (0.82 amplitude match)
    [
      [1174.66, 0.82, "sine"],
      [3523.98, 0.2733, "sine"],
      [5873.3, 0.164, "sine"],
      [8222.62, 0.1171, "sine"],
    ],
  ],
  divisor: 1.8,
  rmsTrim: 0.58,
};

const ALARM_BELLS: Record<AlarmBell, BellSpec> = {
  kitchen: KITCHEN_BELL,
  juice: JUICE_BELL,
};

/**
 * Point THIS page at its alarm sound — call once on mount from a staff
 * screen. Also pre-renders that sound's WAV so the first alarm starts
 * instantly.
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

function renderAlarmWav(spec: BellSpec): string {
  const rate = 22050;
  const duration = (ALARM_PAIRS - 1) * PAIR_GAP + PAIR_OFFSET + 0.6;
  const length = Math.ceil(rate * duration);
  const data = new Float32Array(length);

  const hits: number[] = [];
  for (let pair = 0; pair < ALARM_PAIRS; pair += 1) {
    const base = pair * PAIR_GAP;
    hits.push(base, base + PAIR_OFFSET);
  }

  hits.forEach((hit, i) => {
    const timbre = spec.timbres[i % spec.timbres.length];
    const startSample = Math.floor(hit * rate);
    for (let j = 0; j < Math.floor(0.6 * rate); j += 1) {
      const idx = startSample + j;
      if (idx >= length) break;
      const t = j / rate;
      // 15 ms attack, exponential decay to silence by ~0.5 s (same shape for
      // every sound, so both engines and both stations share the rhythm).
      const env = t < 0.015 ? t / 0.015 : Math.exp(-(t - 0.015) * 7.5);
      let sample = 0;
      for (const [freq, level] of timbre) {
        sample += Math.sin(2 * Math.PI * freq * t) * level;
      }
      data[idx] += (sample / spec.divisor) * env;
    }
  });

  // Normalise to the full scale, apply the loudness trim, then soft-clip:
  // loud without the crunch of hard clipping. rmsTrim < 1 trims the denser
  // beep back down to the bell's perceived volume (both stay at the same
  // ceiling, nothing clips).
  let peak = 0;
  for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
  const scale = (peak > 0 ? 0.98 / peak : 1) * spec.rmsTrim;

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
        // near -6 dB with a high ratio so the summed hits ride close to full
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

    // Prime EVERY sound INSIDE the gesture: playing (and immediately pausing)
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

/**
 * One hit of a station's alarm sound: the stacked tones, fast attack,
 * half-second decay. Hit `index` picks the timbre (kitchen repeats one,
 * juice alternates "ba"/"doo"). The loudness trim keeps both stations at
 * the same volume in this engine too.
 */
function hit(at: number, level: number, spec: BellSpec, index: number) {
  if (!ctx || !compressor) return;
  const timbre = spec.timbres[index % spec.timbres.length];
  for (const [freq, rel, wave] of timbre) {
    const gainLevel = level * rel * spec.rmsTrim;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    // Default keeps the original kitchen rule (sine shimmer above 2093 Hz,
    // triangle body below); the beep's sine harmonics say so explicitly.
    osc.type = wave ?? (freq >= 2093 ? "sine" : "triangle");
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
    const spec = ALARM_BELLS[activeBell];
    const start = ctx.currentTime + 0.01;
    // 6 pairs × (hit + hit 160ms later), pair gap 620ms → ~3.8 s of ringing.
    // Long on purpose: a customer top-up must punch through a lunch-rush room.
    let hitIndex = 0;
    for (let pair = 0; pair < ALARM_PAIRS; pair += 1) {
      const base = start + pair * PAIR_GAP;
      hit(base, 1.0, spec, hitIndex++);
      hit(base + PAIR_OFFSET, 1.0, spec, hitIndex++);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Standard ring — a few hits (e.g. a status changed, nothing urgent).
 * `hits` defaults to 3. Rings with the page's own sound, so a quantity
 * correction on the juice screen gets three quick "ba-doo" beeps, not bells.
 */
export function playDing(hits = 3) {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    unlockAudio();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();

    const spec = ALARM_BELLS[activeBell];
    const start = ctx.currentTime + 0.01;
    for (let i = 0; i < hits; i += 1) {
      hit(start + i * 0.3, 0.9, spec, i);
    }
    vibrate([250, 120, 250]);
  } catch {
    /* ignore */
  }
}

/**
 * THE ALARM — long, loud and impossible to miss: 6 pairs of hits
 * (hit-hit … hit-hit … hit-hit), ~3.8 s. The SOUND depends on the page
 * (setStationBell): the kitchen hears the original G-family counter bell,
 * the juice bar hears its electronic two-tone "ba-doo" beep — same pattern,
 * same volume, same vibration, completely different sound.
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
