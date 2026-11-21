import { useEffect, useState } from "react";
import { useProfile } from "../../../entities/profile";
import { overlayHasKeyboard } from "../../../shared/lib/keyboard";
import { askDone, askLater, loadStarAsk, recordStart, shouldAsk } from "../model/starAsk";

type ProfileState = ReturnType<typeof useProfile.getState>;

/** The profiles this window is starting (the launch not yet confirmed). */
const starting = (s: ProfileState) => new Set(Object.keys(s.pending).filter((id) => s.pending[id].kind === "start"));

/// Counts a Start once it is confirmed: a start this window made that the
/// poll then sees running. A failed launch drops the pending start and the
/// running mark in one store write, so it is never counted. Profiles already
/// running when the app opens, or started elsewhere, never were pending here.
/// Says when to ask. It never opens over another dialog, menu or list: a
/// due ask waits until none is open (MP4 review, M13).
export function useStarAsk() {
  const [due, setDue] = useState(false);
  const [show, setShow] = useState(false);
  useEffect(() => {
    let before = starting(useProfile.getState());
    return useProfile.subscribe((s) => {
      for (const id of before) {
        if (s.pending[id]?.kind === "start" || !s.running[id]) continue;
        if (shouldAsk(recordStart(new Date()), Date.now())) setDue(true);
      }
      before = starting(s);
    });
  }, []);
  useEffect(() => {
    if (!due || show) return;
    if (!overlayHasKeyboard()) { setShow(true); return; }
    // Overlays mount in portals under the body, and mark their exit.
    const watch = new MutationObserver(() => {
      if (overlayHasKeyboard()) return;
      watch.disconnect();
      setShow(true);
    });
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-ending-style"] });
    return () => watch.disconnect();
  }, [due, show]);
  return {
    show,
    later: () => { askLater(Date.now()); setDue(false); setShow(false); },
    done: () => { askDone(); setDue(false); setShow(false); },
  };
}

export { loadStarAsk };
