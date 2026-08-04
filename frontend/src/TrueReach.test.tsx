import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrueReach } from "./TrueReach";
import { api } from "./api";
import type { EdgeStatus } from "./types";

vi.mock("./api", () => ({
  api: { edgeStatus: vi.fn(), edgeDeploy: vi.fn(), edgeRemove: vi.fn(), edgeUpdate: vi.fn() },
}));

// True Reach is a paid tier (§12), so the card now asks the host whether this domain is
// subscribed. Default these tests to "subscribed" and assert the gate separately below.
vi.mock("./host", async () => {
  const actual = await vi.importActual<typeof import("./host")>("./host");
  return {
    ...actual,
    host: {
      isPurchased: vi.fn().mockResolvedValue(true),
      purchaseInfo: vi.fn().mockResolvedValue({ price: null, owned: true }),
      buyProduct: vi.fn(),
      manageSubscription: vi.fn(),
    },
  };
});

const mocked = api as unknown as {
  edgeStatus: ReturnType<typeof vi.fn>;
  edgeDeploy: ReturnType<typeof vi.fn>;
  edgeUpdate: ReturnType<typeof vi.fn>;
};

const edge = (over: Partial<EdgeStatus>): EdgeStatus => ({
  phase: "none",
  records: [],
  inProgress: false,
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { host } = await import("./host");
  (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (host.purchaseInfo as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ price: null, owned: true });
});

describe("TrueReach card", () => {
  it("pitches the tier and takes a hostname when nothing is deployed", async () => {
    mocked.edgeStatus.mockResolvedValue({ edge: edge({ phase: "none" }) });
    render(<TrueReach suggestedDomain="stats.ollydigital.com" />);
    expect(await screen.findByText(/country statistics/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("stats.ollydigital.com")).toBeInTheDocument();

    mocked.edgeDeploy.mockResolvedValue({ operation: "CREATE" });
    await userEvent.click(screen.getByRole("button", { name: /set up true reach/i }));
    await waitFor(() => expect(mocked.edgeDeploy).toHaveBeenCalledWith("stats.ollydigital.com"));
  });

  it("shows the validation record with copy buttons while ACM waits (resumable by design)", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edge: edge({
        phase: "validating",
        domain: "stats.ollydigital.com",
        inProgress: true,
        records: [
          { purpose: "certificate-validation", name: "_abc.stats.ollydigital.com.", type: "CNAME", value: "_xyz.acm-validations.aws." },
        ],
      }),
    });
    render(<TrueReach />);
    expect(await screen.findByText(/domain-ownership check/i)).toBeInTheDocument();
    expect(screen.getByText("_xyz.acm-validations.aws.")).toBeInTheDocument();
    expect(screen.getByText(/waiting for your dns record/i)).toBeInTheDocument();
    expect(screen.getByText(/even if you close the app/i)).toBeInTheDocument();
  });

  it("when live, shows the pointing record and says snippets now serve first-party", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edge: edge({
        phase: "ready",
        domain: "stats.ollydigital.com",
        distributionDomain: "d1.cloudfront.net",
        records: [
          { purpose: "point-your-domain", name: "stats.ollydigital.com.", type: "CNAME", value: "d1.cloudfront.net" },
        ],
      }),
    });
    render(<TrueReach />);
    expect(await screen.findByText(/point your subdomain/i)).toBeInTheDocument();
    expect(screen.getByText("d1.cloudfront.net")).toBeInTheDocument();
    expect(screen.getByText(/first-party/)).toBeInTheDocument();
  });

  it("reports the live state upward so the sites list can swap snippet origins", async () => {
    const seen: EdgeStatus[] = [];
    mocked.edgeStatus.mockResolvedValue({ edge: edge({ phase: "ready", domain: "stats.ollydigital.com" }) });
    render(<TrueReach onStatus={(e) => seen.push(e)} />);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]!.domain).toBe("stats.ollydigital.com");
  });
});

describe("the paid gate (§12 — per domain)", () => {
  it("will not set up True Reach for a domain that isn't subscribed", async () => {
    const { host } = await import("./host");
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    mocked.edgeStatus.mockResolvedValue({ edge: edge({ phase: "none" }) });

    render(<TrueReach suggestedDomain="stats.ollydigital.com" />);

    const btn = await screen.findByRole("button", { name: /set up true reach/i });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(mocked.edgeDeploy).not.toHaveBeenCalled();
  });

  it("offers the unlock, priced per domain, when not subscribed", async () => {
    const { host } = await import("./host");
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (host.purchaseInfo as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      price: { amountMinor: 1499, currency: "USD", kind: "subscription", interval: "month" },
      owned: false,
    });
    mocked.edgeStatus.mockResolvedValue({ edge: edge({ phase: "none" }) });

    render(<TrueReach suggestedDomain="stats.ollydigital.com" />);
    expect(await screen.findByRole("button", { name: /Unlock · \$14\.99\/month/ })).toBeInTheDocument();
  });

  it("PLATFORM RULE: a live subscription always shows a way to manage billing", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edge: edge({ phase: "ready", domain: "stats.ollydigital.com", records: [] }),
    });
    render(<TrueReach />);
    expect(await screen.findByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  });

  it("offers the edge update when the deployed edge is behind — never applies it itself", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edge: edge({ phase: "ready", domain: "stats.ollydigital.com", updateAvailable: true }),
    });
    mocked.edgeUpdate.mockResolvedValue({
      edge: edge({ phase: "ready", domain: "stats.ollydigital.com", viewerAtEdge: true }),
    });
    render(<TrueReach />);

    const btn = await screen.findByRole("button", { name: /update true reach/i });
    expect(mocked.edgeUpdate).not.toHaveBeenCalled(); // detection alone must not touch AWS
    await userEvent.setup().click(btn);
    await waitFor(() => expect(mocked.edgeUpdate).toHaveBeenCalled());
    // The card re-renders from the returned state: page now on the domain, banner gone.
    expect(await screen.findByText(/open the statistics page at/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update true reach/i })).not.toBeInTheDocument();
  });

  it("shows the statistics-page address once the dashboard rides the domain", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edge: edge({ phase: "ready", domain: "stats.ollydigital.com", viewerAtEdge: true }),
    });
    render(<TrueReach />);
    expect(await screen.findByText(/open the statistics page at/i)).toBeInTheDocument();
  });
});
