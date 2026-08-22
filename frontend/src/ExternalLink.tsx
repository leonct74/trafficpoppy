// A text link that actually opens. The poppy frontend lives in a sandboxed frame where a
// plain <a target="_blank"> and window.open are SILENT no-ops — the same sandbox that kills
// downloads — so every external link in this UI must go through host.openExternal.
import { host } from "./host";

export function ExternalLink(props: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.href}
      onClick={() => void host.openExternal(props.href)}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        font: "inherit",
        color: "inherit",
        textDecoration: "underline",
        textUnderlineOffset: 2,
        cursor: "pointer",
      }}
    >
      {props.children}
    </button>
  );
}
