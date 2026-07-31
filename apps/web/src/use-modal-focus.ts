import { useEffect, useRef } from "react";

export function useModalFocus<
  DialogElement extends HTMLElement,
  InitialElement extends HTMLElement
>(options: {
  onClose: () => void;
  ignoreWhenSelector?: string;
}) {
  const dialogRef = useRef<DialogElement>(null);
  const initialFocusRef = useRef<InitialElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    initialFocusRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (
        options.ignoreWhenSelector &&
        dialogRef.current?.querySelector(options.ignoreWhenSelector)
      ) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        options.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [options.ignoreWhenSelector, options.onClose]);

  return { dialogRef, initialFocusRef };
}
