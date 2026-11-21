import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@proxyshard/shardx-ui-kit";

/// A piece of the overview that opens and closes in place: its height moves
/// from where it is to its content's height (or to nothing) on the spring,
/// so the list below slides rather than jumps, and a turn midway starts from
/// the current height (a CSS transition). Reduce motion makes it instant
/// (app.css `.overview-fold`). The content keeps being laid out while
/// closed, so it opens straight to the right height.
///
/// Room: the fold reaches 5 px past its content on every side (`-m-1.5`,
/// with the same padding inside), so the lift, the shadow and the focus ring
/// of what it holds are never clipped. Closed, it keeps only that room,
/// which its negative margins cancel: it takes no space.
export function Fold({ open, instant, hold, id, className, children }: {
  open: boolean;
  /** No movement (the page's first paint). */
  instant: boolean;
  /** Drawn, taking its room, but unseen and out of reach (the cards'
   *  reads are still coming in). */
  hold?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [room, setRoom] = useState(0);
  // Read before the paint after every render (new content is drawn at its
  // height in the same frame), and on any other change of size (a line that
  // wraps on a resize).
  useLayoutEffect(() => {
    if (inner.current) setHeight(inner.current.offsetHeight);
  });
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const s = getComputedStyle(el);
    setRoom(parseFloat(s.paddingTop) + parseFloat(s.paddingBottom));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const shut = !open || hold;
  return (
    <div
      id={id}
      data-open={open || undefined}
      data-hold={hold || undefined}
      data-instant={instant || undefined}
      aria-hidden={shut || undefined}
      inert={shut || undefined}
      className={cn("overview-fold -m-1.5", className)}
      style={{ height: open ? height ?? undefined : room }}
    >
      <div ref={inner} className="p-1.5">{children}</div>
    </div>
  );
}
