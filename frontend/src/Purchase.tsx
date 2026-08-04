import { Button } from "./Button";
import { formatPrice } from "./entitlement";
import type { Entitlement } from "./entitlement";
import { host, ADVANCED_STATS_PRODUCT } from "./host";

/**
 * The purchase surface for a paid feature (DESIGN.md §12).
 *
 * ⚠️ PLATFORM RULE — DO NOT REMOVE THE "Manage billing" CONTROL.
 * The SDK's host-rendered <agentspoppy-purchase> button carries a Manage link for free, but
 * this repo inlines the bridge rather than depending on the SDK (see host.ts), so we render
 * our own button — and the rule then falls on us: a buyer must ALWAYS have a clearly visible
 * way to cancel and see what they paid, present the moment the feature is owned, not buried.
 * Omitting it is grounds for removal from the directory. MailPoppy is the reference.
 */
export function Purchase(props: {
  entitlement: Entitlement;
  target: string;
  /** One line on what paying actually gets them — shown above the price. */
  pitch: React.ReactNode;
  productId?: string;
}) {
  const { entitlement, target } = props;
  const productId = props.productId ?? ADVANCED_STATS_PRODUCT;
  const price = formatPrice(entitlement.info);

  if (entitlement.entitled === undefined) {
    return (
      <div className="row">
        <span className="spinner" /> <span className="muted">Checking your subscription…</span>
      </div>
    );
  }

  // Owned: the Manage control is REQUIRED here, and must stay visible.
  if (entitlement.entitled) {
    return (
      <div className="spread">
        <span className="badge ok">
          <span className="dot" /> Subscribed · {target}
        </span>
        <button className="btn btn-sm" onClick={() => void entitlement.manage()}>
          Manage billing
        </button>
      </div>
    );
  }

  return (
    <div className="card card-2 stack" style={{ marginBottom: 0 }}>
      <div>{props.pitch}</div>
      <div className="spread">
        <span className="muted" style={{ fontSize: 13 }}>
          {price ? (
            <>
              <strong>{price}</strong> for <span className="mono">{target}</span> · cancel any time
            </>
          ) : (
            <>Priced per domain · cancel any time</>
          )}
        </span>
        <Button
          className="btn btn-primary"
          busyLabel="Opening checkout…"
          onClick={async () => {
            await host.buyProduct(productId, { target });
            // Don't trust the resolve value as authority — re-ask the host, which verifies
            // ownership server-side.
            await entitlement.refresh();
          }}
        >
          {price ? `Unlock · ${price}` : "Unlock"}
        </Button>
      </div>
    </div>
  );
}
