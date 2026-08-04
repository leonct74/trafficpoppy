import { useCallback, useEffect, useState } from "react";
import { host, ADVANCED_STATS_PRODUCT, type PurchaseInfo } from "./host";

/**
 * Entitlement for a paid feature (DESIGN.md §12) — one paid unit is ONE DOMAIN, so every
 * check carries the domain as the purchase `target`.
 *
 * ⚠ THE GATE IS THE HOST, NOT THIS HOOK. `host.isPurchased` is verified server-side; this
 * hook only reflects the answer so the UI can render. Never treat `entitled` as authority
 * for anything valuable — re-ask the host when it matters, and remember a determined user
 * can flip any client-side boolean.
 *
 * The `purchased` event bubbles to document when the host-rendered button completes a
 * checkout, so the UI unlocks without a reload or a poll.
 */
export interface Entitlement {
  /** undefined while we're still asking — render neither locked nor unlocked yet. */
  entitled: boolean | undefined;
  info: PurchaseInfo | null;
  refresh: () => Promise<void>;
  manage: () => Promise<void>;
}

export function useEntitlement(target: string | undefined, productId = ADVANCED_STATS_PRODUCT): Entitlement {
  const [entitled, setEntitled] = useState<boolean | undefined>(undefined);
  const [info, setInfo] = useState<PurchaseInfo | null>(null);

  const refresh = useCallback(async () => {
    if (!target) {
      setEntitled(false);
      return;
    }
    try {
      const [owned, i] = await Promise.all([
        host.isPurchased(productId, { target }),
        host.purchaseInfo(productId, { target }).catch(() => null),
      ]);
      setEntitled(owned);
      setInfo(i);
    } catch {
      // Commerce unavailable (offline, or the capability isn't granted) — fail CLOSED so a
      // paid feature is never handed out because a check errored.
      setEntitled(false);
    }
  }, [productId, target]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-check when the host-rendered button reports a completed purchase.
  useEffect(() => {
    const onPurchased = () => void refresh();
    document.addEventListener("purchased", onPurchased);
    return () => document.removeEventListener("purchased", onPurchased);
  }, [refresh]);

  const manage = useCallback(async () => {
    if (target) await host.manageSubscription(productId, { target });
  }, [productId, target]);

  return { entitled, info, refresh, manage };
}

/** "$14.99/month" from the host's live price — never a hard-coded number in our UI. */
export function formatPrice(info: PurchaseInfo | null): string | null {
  if (!info?.price) return null;
  const { amountMinor, currency, kind, interval } = info.price;
  const amount = new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amountMinor / 100);
  return kind === "subscription" ? `${amount}/${interval ?? "month"}` : amount;
}
