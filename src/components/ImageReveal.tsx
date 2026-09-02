"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ImgHTMLAttributes,
  type ReactNode,
} from "react";
import { FALLBACK_FOOD_IMAGE } from "@/lib/image-utils";

/**
 * "All the food photos appear together" image loading.
 *
 * WHAT IT FIXES
 * -------------
 * The customer menu used to render the grid the instant the menu JSON arrived
 * and then let every <img> fetch on its own. On a phone that has never visited
 * (no HTTP cache yet) the browser works through those requests in DOM order, so
 * the owner watched dish 1 download, then dish 2, then dish 3…
 *
 * HOW IT WORKS
 * ------------
 * 1. <ImageBatchProvider urls={…}> receives the photo URLs of the FIRST SCREEN
 *    of dishes and fires them all at once as <link rel="preload" as="image"
 *    fetchpriority="high"> the moment the URLs are known — before React paints
 *    the cards. Parallel + high priority instead of a sequential trickle.
 * 2. <RevealImage> renders each photo on top of a shimmering placeholder and
 *    keeps it at opacity 0 until the batch is released, then every photo of that
 *    batch fades in together in one 500ms cross-fade.
 * 3. Nothing is blocked: names, prices and the +/− buttons are on screen and
 *    usable the whole time, and a hard timeout releases the batch even if one
 *    photo is slow or dead, so the menu can never be held hostage by an image.
 * 4. Photos outside the batch (below the fold, gallery, search results) stay
 *    `loading="lazy"` and simply fade in individually as they arrive — no mobile
 *    data is spent on dishes the customer has not scrolled to.
 */

/** Separator for the URL signature (never appears in a URL). */
const SEP = "\u0001";

const NO_GATE: ReadonlySet<string> = new Set<string>();

interface ImageBatchValue {
  /** false while the first-screen batch is still downloading */
  released: boolean;
  /** src values that belong to the batch — these wait for `released` */
  gated: ReadonlySet<string>;
}

const ImageBatchContext = createContext<ImageBatchValue>({ released: true, gated: NO_GATE });

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

export interface ImageBatchProviderProps {
  /**
   * Photo URLs that must land before the batch is revealed.
   * Pass `[]` to disable the gate (each photo then fades in on its own).
   */
  urls: string[];
  /** Hard cap on how long photos may hold back the reveal, in ms. */
  timeoutMs?: number;
  children: ReactNode;
}

export function ImageBatchProvider({ urls, timeoutMs = 2500, children }: ImageBatchProviderProps) {
  // Derived by VALUE (not by array identity) so a caller that rebuilds the array
  // on every render cannot retrigger the effect — and so switching back to a
  // category whose photos are already cached never blinks.
  const signature = uniqueUrls(urls).join(SEP);
  const gated = useMemo(
    () => new Set<string>(signature ? signature.split(SEP) : []),
    [signature]
  );
  // An empty batch (search typing, empty category) never holds anything back.
  const [released, setReleased] = useState(signature === "");
  const [trackedSignature, setTrackedSignature] = useState(signature);
  if (signature !== trackedSignature) {
    // Reset during render — React's sanctioned "adjust state when props change"
    // pattern — so a new batch starts gated without a cascading effect render.
    setTrackedSignature(signature);
    setReleased(signature === "");
  }

  useEffect(() => {
    const list = signature ? signature.split(SEP) : [];
    if (list.length === 0) return;

    let active = true;
    let pending = list.length;
    const links: HTMLLinkElement[] = [];
    // One slow/broken photo must never delay the rest for longer than this.
    let guard: ReturnType<typeof setTimeout> | undefined;

    function release() {
      if (!active) return;
      if (guard) clearTimeout(guard);
      setReleased(true);
    }
    function settle() {
      pending -= 1;
      if (pending <= 0) release();
    }

    guard = setTimeout(release, timeoutMs);
    for (const href of list) {
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = "image";
      link.href = href;
      // Without this the browser deprioritises images behind the page's own JS
      // and CSS and serves them one after another.
      link.setAttribute("fetchpriority", "high");
      link.addEventListener("load", settle);
      link.addEventListener("error", settle);
      document.head.appendChild(link);
      links.push(link);
    }

    return () => {
      active = false;
      clearTimeout(guard);
      for (const link of links) link.remove();
    };
  }, [signature, timeoutMs]);

  const value = useMemo<ImageBatchValue>(() => ({ released, gated }), [released, gated]);
  return <ImageBatchContext.Provider value={value}>{children}</ImageBatchContext.Provider>;
}

export interface RevealImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "onLoad" | "onError"> {
  src: string;
  alt: string;
  /**
   * Above-the-fold photo: fetched immediately at high priority instead of
   * lazily, so it can take part in the synchronized reveal.
   */
  eager?: boolean;
  /** Layout classes for the positioning box (default `w-full`, add `h-full` when the parent sets the height). */
  boxClassName?: string;
  /** Shown when the photo fails — same behaviour as the old inline onError. */
  fallbackSrc?: string;
  /** Fired once the photo (or its fallback) is on screen. */
  onReady?: () => void;
}

export function RevealImage({
  src,
  alt,
  className = "",
  boxClassName = "w-full",
  eager = false,
  fallbackSrc = FALLBACK_FOOD_IMAGE,
  onReady,
  ...rest
}: RevealImageProps) {
  const { released, gated } = useContext(ImageBatchContext);
  const [ready, setReady] = useState(false);

  const [trackedSrc, setTrackedSrc] = useState(src);
  if (src !== trackedSrc) {
    // Reset during render so a card that swaps photo (admin replaced the dish
    // image, category chip tapped) can never keep showing the previous one.
    setTrackedSrc(src);
    setReady(false);
  }

  // A photo that is already in the HTTP cache can finish BEFORE React attaches
  // onLoad (server-rendered HTML, repeat visits, back navigation). Reconciling
  // through the ref callback covers that, otherwise the card stays blank.
  const attachImg = useCallback((node: HTMLImageElement | null) => {
    if (node && node.complete && node.naturalWidth > 0) setReady(true);
  }, []);

  // Absolute safety net: a photo is never allowed to stay invisible.
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setReady(true), 15000);
    return () => clearTimeout(timer);
  }, [ready, src]);

  const waitsForBatch = gated.has(src);
  const visible = ready && (!waitsForBatch || released);

  return (
    <span className={`relative block overflow-hidden ${boxClassName}`}>
      <span
        className="img-shimmer absolute inset-0"
        style={{ opacity: visible ? 0 : 1 }}
        aria-hidden="true"
      />
      <img
        ref={attachImg}
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={eager ? "high" : "auto"}
        onLoad={() => {
          setReady(true);
          onReady?.();
        }}
        onError={(event) => {
          const el = event.currentTarget;
          // Identical to the previous inline handler: swap in the placeholder
          // once; its own load event then reveals the card.
          if (!el.src.includes("placeholder")) el.src = fallbackSrc;
          else {
            setReady(true);
            onReady?.();
          }
        }}
        className={`block transition-opacity duration-500 ease-out ${className} ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        {...rest}
      />
    </span>
  );
}
