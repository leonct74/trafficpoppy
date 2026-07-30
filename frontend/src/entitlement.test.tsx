import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook, act } from "@testing-library/react";
import { useEntitlement, formatPrice } from "./entitlement";
import { Purchase } from "./Purchase";
import { host } from "./host";

vi.mock("./host", async () => {
  const actual = await vi.importActual<typeof import("./host")>("./host");
  return {
    ...actual,
    host: {
      isPurchased: vi.fn(),
      purchaseInfo: vi.fn(),
      buyProduct: vi.fn(),
      manageSubscription: vi.fn(),
    },
  };
});

const mocked = host as unknown as {
  isPurchased: ReturnType<typeof vi.fn>;
  purchaseInfo: ReturnType<typeof vi.fn>;
  buyProduct: ReturnType<typeof vi.fn>;
  manageSubscription: ReturnType<typeof vi.fn>;
};

const PRICE = {
  name: "True Reach",
  price: { amountMinor: 1499, currency: "USD", kind: "subscription" as const, interval: "month" },
  owned: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.isPurchased.mockResolvedValue(false);
  mocked.purchaseInfo.mockResolvedValue(PRICE);
});

describe("useEntitlement", () => {
  it("asks the host per DOMAIN — one paid unit is one domain (§12)", async () => {
    renderHook(() => useEntitlement("ollydigital.com"));
    await waitFor(() =>
      expect(mocked.isPurchased).toHaveBeenCalledWith("true-reach", { target: "ollydigital.com" }),
    );
  });

  it("reports an owned subscription", async () => {
    mocked.isPurchased.mockResolvedValue(true);
    const { result } = renderHook(() => useEntitlement("ollydigital.com"));
    await waitFor(() => expect(result.current.entitled).toBe(true));
  });

  it("FAILS CLOSED when the commerce check errors — never unlock on an error", async () => {
    mocked.isPurchased.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useEntitlement("ollydigital.com"));
    await waitFor(() => expect(result.current.entitled).toBe(false));
  });

  it("is not entitled when there's no domain to bill against", async () => {
    const { result } = renderHook(() => useEntitlement(undefined));
    await waitFor(() => expect(result.current.entitled).toBe(false));
    expect(mocked.isPurchased).not.toHaveBeenCalled();
  });

  it("starts undefined so the UI shows neither locked nor unlocked while checking", () => {
    const { result } = renderHook(() => useEntitlement("ollydigital.com"));
    expect(result.current.entitled).toBeUndefined();
  });

  it("re-checks when the host reports a completed purchase", async () => {
    const { result } = renderHook(() => useEntitlement("ollydigital.com"));
    await waitFor(() => expect(result.current.entitled).toBe(false));

    mocked.isPurchased.mockResolvedValue(true);
    await act(async () => {
      document.dispatchEvent(new CustomEvent("purchased", { bubbles: true }));
    });
    await waitFor(() => expect(result.current.entitled).toBe(true));
  });
});

describe("formatPrice", () => {
  it("renders the host's live price, never a hard-coded number", () => {
    expect(formatPrice(PRICE)).toBe("$14.99/month");
  });
  it("handles a one-time price and a missing one", () => {
    expect(formatPrice({ price: { amountMinor: 4900, currency: "USD", kind: "one_time" }, owned: false })).toBe(
      "$49.00",
    );
    expect(formatPrice(null)).toBeNull();
    expect(formatPrice({ price: null, owned: false })).toBeNull();
  });
});

describe("Purchase surface", () => {
  const ent = (over = {}) => ({
    entitled: false as boolean | undefined,
    info: PRICE,
    refresh: vi.fn(),
    manage: vi.fn(),
    ...over,
  });

  it("shows the live price on the unlock button", () => {
    render(<Purchase entitlement={ent()} target="ollydigital.com" pitch="why" />);
    expect(screen.getByRole("button", { name: /Unlock · \$14\.99\/month/ })).toBeInTheDocument();
  });

  it("PLATFORM RULE: once owned, a visible Manage billing control is present", () => {
    render(<Purchase entitlement={ent({ entitled: true })} target="ollydigital.com" pitch="why" />);
    expect(screen.getByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  });

  it("Manage billing opens the billing portal", async () => {
    const user = userEvent.setup();
    const e = ent({ entitled: true });
    render(<Purchase entitlement={e} target="ollydigital.com" pitch="why" />);
    await user.click(screen.getByRole("button", { name: /manage billing/i }));
    expect(e.manage).toHaveBeenCalled();
  });

  it("re-asks the host after checkout instead of trusting the returned flag", async () => {
    const user = userEvent.setup();
    const e = ent();
    mocked.buyProduct.mockResolvedValue({ owned: true });
    render(<Purchase entitlement={e} target="ollydigital.com" pitch="why" />);

    await user.click(screen.getByRole("button", { name: /unlock/i }));
    await waitFor(() => expect(mocked.buyProduct).toHaveBeenCalledWith("true-reach", { target: "ollydigital.com" }));
    await waitFor(() => expect(e.refresh).toHaveBeenCalled());
  });

  it("shows nothing decisive while the check is still running", () => {
    render(<Purchase entitlement={ent({ entitled: undefined })} target="x.com" pitch="why" />);
    expect(screen.queryByRole("button", { name: /unlock/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Checking your subscription/i)).toBeInTheDocument();
  });
});
