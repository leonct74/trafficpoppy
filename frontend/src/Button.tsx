import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /**
   * The click handler. If it returns a promise, the button shows a spinner and stays
   * disabled until the promise settles — so no async action can ever look unresponsive,
   * and a second click can't fire while the first is in flight. Sync handlers just run.
   */
  onClick?: () => void | Promise<void>;
  /** Optional label to swap in while busy (e.g. "Removing…"). Defaults to the children. */
  busyLabel?: ReactNode;
  children: ReactNode;
}

/**
 * The one button every action in the poppy uses. Every button that kicks off work is
 * responsive on the first click: it disables and shows a spinner immediately, then clears
 * when the work finishes — the founder's rule, applied uniformly rather than per-button.
 */
export function Button({ onClick, busyLabel, children, disabled, ...rest }: ButtonProps) {
  const [busy, setBusy] = useState(false);

  const handle = () => {
    if (busy) return;
    const result = onClick?.();
    if (result instanceof Promise) {
      setBusy(true);
      // Always clear busy, even if the handler rejects — the caller surfaces the error;
      // the button must never be left spinning forever. The rejection is swallowed HERE:
      // handlers own their error UI, and re-surfacing it would make every failed action
      // an unhandled-rejection console error.
      void result.catch(() => {}).finally(() => setBusy(false));
    }
  };

  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={handle}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, ...rest.style }}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      <span>{busy && busyLabel ? busyLabel : children}</span>
    </button>
  );
}
