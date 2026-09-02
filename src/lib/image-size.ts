/**
 * Pure display-size helpers for the photo endpoint (`/api/images/{id}`).
 *
 * WHY THIS EXISTS
 * ---------------
 * Uploaded dish photos are stored as ~900px-wide JPEGs (100-250 KB each) but the
 * customer menu renders them in a ~190 CSS-px card. On a phone that has never
 * visited before, a QR scan therefore pulled a megabyte-plus of oversized pixels
 * — and the browser trickled those requests out one card at a time, which is the
 * "photo 1 downloads, then photo 2 downloads…" effect the owner saw.
 *
 * Callers now ask for the size they actually render (`?w=&h=`) and the endpoint
 * downscales once, serves WebP, and lets the browser cache it forever.
 *
 * Requested sizes are SNAPPED UP to a short allow-list of steps. Two reasons:
 *   1. Cache efficiency — every menu card asks for the same 400x256 box, so one
 *      derived variant is shared by every card, every device and every visit.
 *   2. Abuse resistance — the variant key space stays tiny, so nobody can force
 *      unbounded re-encoding by wiggling `w` / `h` / `q` values.
 *
 * No DB, no `sharp`, no runtime imports: safe to unit-test and to call from
 * either side of the wire.
 */

/** Hard ceiling for a derived edge — larger requests are clamped to this. */
export const MAX_IMAGE_EDGE = 1600;
/** Anything smaller is pointless (and would upscale tiny logos). */
export const MIN_IMAGE_EDGE = 32;
/** WebP quality used when the caller does not ask for one. */
export const DEFAULT_IMAGE_QUALITY = 72;

const WIDTH_STEPS: readonly number[] = [160, 240, 320, 400, 480, 640, 800, 960, 1200, MAX_IMAGE_EDGE];
const HEIGHT_STEPS: readonly number[] = [160, 200, 256, 320, 400, 500, 640, 800, 960, 1200];
const QUALITY_STEPS: readonly number[] = [60, DEFAULT_IMAGE_QUALITY, 85];

/** Round UP to the nearest allowed step, so we never crop below what was asked. */
function snapUp(value: number, steps: readonly number[]): number {
  for (const step of steps) if (value <= step) return step;
  return steps[steps.length - 1];
}

function readEdge(raw: string | number | null | undefined, steps: readonly number[]): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return snapUp(Math.min(MAX_IMAGE_EDGE, Math.max(MIN_IMAGE_EDGE, Math.round(parsed))), steps);
}

/** Allowed output width for `?w=`, or undefined when the caller wants the original. */
export function snapImageWidth(raw: string | number | null | undefined): number | undefined {
  return readEdge(raw, WIDTH_STEPS);
}

/** Allowed output height for `?h=`, or undefined when the caller wants the original. */
export function snapImageHeight(raw: string | number | null | undefined): number | undefined {
  return readEdge(raw, HEIGHT_STEPS);
}

/** Allowed WebP quality for `?q=` (always a valid number — defaults to 72). */
export function snapImageQuality(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_IMAGE_QUALITY;
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IMAGE_QUALITY;
  return snapUp(Math.min(100, Math.round(parsed)), QUALITY_STEPS);
}

/**
 * Stable in-process cache key for one derived variant.
 * `undefined` edges are encoded as 0 so `?w=400` and `?w=400&h=` never collide.
 */
export function imageVariantKey(
  id: number,
  width: number | undefined,
  height: number | undefined,
  quality: number
): string {
  return `${id}|${width ?? 0}|${height ?? 0}|${quality}`;
}
