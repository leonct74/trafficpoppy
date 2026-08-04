// Minimal host-bridge client (inlined — the AgentsPoppy SDK isn't published to npm,
// so like MailPoppy we mirror the tiny wire contract instead of taking a cross-repo
// build dependency). Protocol mirrors @agentspoppy/extension-sdk bridge.ts exactly:
// post { id, method, params } to the parent; await { id, ok, result | error }.

export type AccessState = "granted" | "pending" | "denied";

export interface BackendInvoke {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

interface HostRequest {
  id: string;
  method: string;
  params: unknown[];
}
type HostResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const res = e.data as HostResponse;
  if (!res || typeof (res as { id?: unknown }).id !== "string" || !("ok" in res)) return;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  clearTimeout(p.timer);
  if (res.ok) p.resolve(res.result);
  else p.reject(new Error(res.error));
});

function call<T>(method: string, params: unknown[], timeoutMs = 120_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    seq += 1;
    const id = `req-${Date.now().toString(36)}-${seq}`;
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`AgentsPoppy didn't respond in time (${method}).`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    const req: HostRequest = { id, method, params };
    window.parent.postMessage(req, "*");
  });
}

export const host = {
  ensureAccess: (): Promise<AccessState> => call("ensureAccess", []),
  getConnection: (): Promise<{ id: string; status: string; app?: { id: string; name: string } }> =>
    call("getConnection", []),
  /** `timeoutMs` overrides the 2-minute default for calls that legitimately run long
   *  (teardown waits for CloudFormation to finish deleting). */
  invokeBackend: <T = unknown>(request: BackendInvoke, timeoutMs?: number): Promise<T> =>
    call("invokeBackend", [request], timeoutMs),
  openExternal: (url: string): Promise<void> => call("openExternal", [url]),
  notify: (n: { title: string; body?: string }): Promise<void> => call("notify", [n]),

  /**
   * Commerce (AGENTS.md / extension-sdk §4, capability `commerce:purchase`).
   *
   * `target` scopes a purchase to ONE thing — here, a site's domain — which is how §12's
   * per-domain pricing works without any machinery of our own (MailPoppy's model).
   *
   * ⚠ `isPurchased` is the gate and the host verifies ownership SERVER-SIDE. Never cache the
   * result as a durable "unlocked" flag or let a client-only boolean stand in for it.
   */
  purchaseInfo: (productId: string, options?: PurchaseTarget): Promise<PurchaseInfo> =>
    call("purchaseInfo", options === undefined ? [productId] : [productId, options]),
  isPurchased: (productId: string, options?: PurchaseTarget): Promise<boolean> =>
    call("isPurchased", options === undefined ? [productId] : [productId, options]),
  buyProduct: (productId: string, options?: PurchaseTarget): Promise<{ owned: boolean }> =>
    call("buyProduct", options === undefined ? [productId] : [productId, options]),
  /** Opens the buyer's Stripe portal. REQUIRED to be reachable wherever a paid feature lives. */
  manageSubscription: (productId: string, options?: PurchaseTarget): Promise<void> =>
    call("manageSubscription", options === undefined ? [productId] : [productId, options]),
};

export interface PurchaseTarget {
  target?: string;
}

export interface PurchaseInfo {
  name?: string;
  price: { amountMinor: number; currency: string; kind: "subscription" | "one_time"; interval?: string } | null;
  owned: boolean;
}

/** The product id priced in the developer dashboard (§12). One paid unit = one domain. */
export const ONLINE_DASHBOARD_PRODUCT = "online-dashboard";
