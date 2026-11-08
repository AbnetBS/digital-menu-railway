"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A WIDE TABLE THAT STAYS READABLE (owner, 2026-11-07).
 *
 * His words: "when the admin wants to move the table to right the horizontal
 * scroll is at the below of the table so add horizontal scroll at the top of
 * the table also. When he scrolls to right the names also disappear so to
 * identify which row belongs to which employee, when the table scrolls to
 * right the employee name remains, only the other columns move to left".
 *
 * So this wrapper does three things:
 *   1. a SECOND horizontal scrollbar is drawn ABOVE the table and kept in step
 *      with the one at the bottom (drag either, both move);
 *   2. the first column of every row is pinned with `position: sticky`, so the
 *      employee name stays on screen while the numbers scroll away;
 *   3. the header row sticks to the top of the scroll box, so a tall month
 *      never loses the column names.
 *
 * The pinning needs one class on the cell: `fana-freeze-cell`. A header cell
 * adds `fana-freeze-head`. Nothing else changes in the table itself.
 */
export default function TableScroll({
  children,
  className = "",
  maxHeight,
  label,
}: {
  children: ReactNode;
  className?: string;
  /** "72vh" or a pixel number: the box gets its own vertical scroll too. */
  maxHeight?: number | string;
  /** Read aloud for a screen reader, e.g. "Payroll table". */
  label?: string;
}) {
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [spacer, setSpacer] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  const syncing = useRef(false);

  const measure = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const width = body.scrollWidth;
    setSpacer(width);
    setOverflowing(width - body.clientWidth > 4);
  }, []);

  useEffect(() => {
    measure();
    const body = bodyRef.current;
    if (!body) return;
    // ResizeObserver is missing in jsdom and in very old browsers: the window
    // resize listener still keeps the bars honest there.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(body);
    if (innerRef.current) observer?.observe(innerRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, children]);

  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    to.scrollLeft = from.scrollLeft;
    // Released on the next frame so the browser's own scroll handler has
    // already run before the other bar may push back.
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  return (
    <div className={className}>
      <style>{`
        .fana-freeze-cell { position: sticky; left: 0; z-index: 5; }
        .fana-freeze-head { position: sticky; left: 0; z-index: 12; }
        .fana-scroll-x { overflow-x: auto; overflow-y: hidden; }
        .fana-scroll-x::-webkit-scrollbar { height: 12px; }
        .fana-scroll-x::-webkit-scrollbar-thumb { background: #a8a29e; border-radius: 8px; }
        .fana-scroll-x::-webkit-scrollbar-track { background: #e7e5e4; border-radius: 8px; }
      `}</style>
      {/* The top scrollbar: only shown when the table is really wider. */}
      {overflowing && (
        <div
          ref={topRef}
          role="presentation"
          aria-hidden="true"
          onScroll={() => sync(topRef.current, bodyRef.current)}
          className="fana-scroll-x mb-1 rounded-lg bg-stone-200"
          style={{ height: 14 }}
        >
          <div style={{ width: spacer, height: 1 }} />
        </div>
      )}
      <div
        ref={bodyRef}
        role="region"
        aria-label={label}
        onScroll={() => sync(bodyRef.current, topRef.current)}
        tabIndex={0}
        className="fana-scroll-x rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A227]"
        style={maxHeight ? { maxHeight: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight, overflowY: "auto" } : undefined}
      >
        <div ref={innerRef}>{children}</div>
      </div>
    </div>
  );
}
