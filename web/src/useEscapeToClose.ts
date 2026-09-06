import { useEffect } from "react";

/**
 * Dismiss an open card or sheet when the user presses Escape.
 *
 * Every card is a role="dialog", but the map behind it has no keyboard exit, so
 * without this a keyboard or switch user who opens the bus card or the stop card
 * can close it only by finding the small × button. The About sheet already
 * closed on Escape; this shares one handler so all three behave the same.
 */
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
