"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, innermost last: Escape and the focus trap apply only to the top one. */
const stack: HTMLElement[] = [];

/**
 * Dialog behavior required by the dashboard guide: Escape closes, Tab stays inside, and focus
 * returns to the element that opened the dialog. Attach the returned ref to the dialog element
 * and give it `tabIndex={-1}`.
 */
export function useModalFocus<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The opener is read while rendering the open state: an `autoFocus` control inside the dialog
  // takes focus during commit, before any effect could see the opener.
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open && typeof document !== "undefined") triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const trigger = triggerRef.current;
    stack.push(dialog);
    // The dialog itself takes focus so a phone keyboard does not open until the user taps a field.
    if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (stack.at(-1) !== dialog || event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = stack.lastIndexOf(dialog);
      if (index >= 0) stack.splice(index, 1);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
