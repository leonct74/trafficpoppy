import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrueReach } from "./TrueReach";
import { api } from "./api";
import type { EdgeStatus } from "./types";

vi.mock("./api", () => ({
  api: { edgeStatus: vi.fn(), edgeDeploy: vi.fn(), edgeRemove: vi.fn(), edgeUpdate: vi.fn(), listSites: vi.fn() },
}));

// Advanced Stats is a paid tier (§12), so the card asks the host whether each site is
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
  listSites: ReturnType<typeof vi.fn>;
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
  // SITE-FIRST (2026-08-05): the card is a list of the tracked sites — default to one.
  mocked.listSites.mockResolvedValue({
    sites: [{ id: "s1", name: "Olly", domain: "ollydigital.com", createdAt: "2026-01-01" }],
  });
});

describe("the site-first card (founder decision 2026-08-05)", () => {
  beforeEach(() => {
    mocked.edgeStatus.mockResolvedValue({ edges: [] });
  });

  it("pitches the tier and lists each tracked site with its online state", async () => {
    render(<TrueReach />);
    // The pitch leads with the MAIN benefit (your stats page on your own address,
    // shareable from any browser) and only then the ad-blocker recovery.
    const pitch = await screen.findByText(/statistics page on your own address/i);
    expect(pitch.textContent!.indexOf("your own address")).toBeLessThan(
      pitch.textContent!.indexOf("ad blockers"),
    );
    expect(screen.getByText("ollydigital.com")).toBeInTheDocument();
    expect(screen.getByText("not online")).toBeInTheDocument();
  });

  it("a subscribed site derives its address: fixed .domain suffix, editable name in front", async () => {
    render(<TrueReach />);
    const input = await screen.findByLabelText("subdomain name");
    expect(input).toHaveValue("stats"); // the usual choice, pre-filled
    expect(screen.getByText(".ollydigital.com")).toBeInTheDocument(); // NOT typeable — no wrong domain possible

    mocked.edgeDeploy.mockResolvedValue({ operation: "CREATE" });
    await userEvent.click(screen.getByRole("button", { name: /put it online/i }));
    await waitFor(() => expect(mocked.edgeDeploy).toHaveBeenCalledWith("stats.ollydigital.com"));
  });

  it("any name works in front of the domain — insights.<site> deploys as typed", async () => {
    render(<TrueReach />);
    const input = await screen.findByLabelText("subdomain name");
    await userEvent.clear(input);
    await userEvent.type(input, "insights");
    mocked.edgeDeploy.mockResolvedValue({ operation: "CREATE" });
    await userEvent.click(screen.getByRole("button", { name: /put it online/i }));
    await waitFor(() => expect(mocked.edgeDeploy).toHaveBeenCalledWith("insights.ollydigital.com"));
  });

  it("refuses www — that is the website itself, not a stats address", async () => {
    render(<TrueReach />);
    const input = await screen.findByLabelText("subdomain name");
    await userEvent.clear(input);
    await userEvent.type(input, "www");
    expect(await screen.findByText(/www is your website's own address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /put it online/i })).toBeDisabled();
  });

  it("with no sites yet, points at the Your sites step — nothing to unlock", async () => {
    mocked.listSites.mockResolvedValue({ sites: [] });
    render(<TrueReach />);
    expect(await screen.findByText(/First add your website/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /put it online/i })).not.toBeInTheDocument();
  });

  it("shows the one-dashboard rule once a statistics page is live", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com", viewerAtEdge: true })],
    });
    render(<TrueReach />);
    expect(await screen.findByText(/Your statistics page:/i)).toBeInTheDocument();
    expect(screen.getByText(/one login there shows every site/i)).toBeInTheDocument();
  });

  it("keeps an edge manageable when no tracked site lives under it (orphan)", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.somewhere-else.com" })],
    });
    render(<TrueReach />);
    expect(await screen.findByText(/No site you track lives under/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
  });
});

describe("the paid gate (§12 — per site, keyed on the site's domain)", () => {
  it("an unsubscribed site shows Unlock for ITS domain — no address form, no deploy", async () => {
    const { host } = await import("./host");
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    mocked.edgeStatus.mockResolvedValue({ edges: [] });

    render(<TrueReach />);
    expect(await screen.findByText(/Put ollydigital\.com online/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("subdomain name")).not.toBeInTheDocument();
    expect(mocked.edgeDeploy).not.toHaveBeenCalled();
  });

  it("the checkout targets the SITE's domain — the key that survives an address rename", async () => {
    const { host } = await import("./host");
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (host.buyProduct as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    mocked.edgeStatus.mockResolvedValue({ edges: [] });

    render(<TrueReach />);
    await userEvent.click(await screen.findByRole("button", { name: /unlock/i }));
    await waitFor(() =>
      expect(host.buyProduct).toHaveBeenCalledWith(expect.any(String), { target: "ollydigital.com" }),
    );
  });

  it("offers the unlock at the live per-site price", async () => {
    const { host } = await import("./host");
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (host.purchaseInfo as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      price: { amountMinor: 1499, currency: "USD", kind: "subscription", interval: "month" },
      owned: false,
    });
    mocked.edgeStatus.mockResolvedValue({ edges: [] });

    render(<TrueReach />);
    expect(await screen.findByRole("button", { name: /Unlock · \$14\.99\/month/ })).toBeInTheDocument();
  });

  it("honours a pre-site-first subscription keyed on the stats hostname — never a second charge", async () => {
    const { host } = await import("./host");
    // Old key: entitled for stats.ollydigital.com only, NOT for ollydigital.com.
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_p: string, o: { target: string }) => Promise.resolve(o.target === "stats.ollydigital.com"),
    );
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com" })],
    });
    render(<TrueReach />);
    expect(await screen.findByText(/subscribed/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unlock/i })).not.toBeInTheDocument();
  });

  it("PLATFORM RULE: a live subscription always shows a way to manage billing", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com", records: [] })],
    });
    render(<TrueReach />);
    expect(await screen.findByRole("button", { name: /manage billing/i })).toBeInTheDocument();
  });
});

describe("subscription lapse (§12): notice + renew, never a silent teardown", () => {
  beforeEach(async () => {
    const { host } = await import("./host");
    // The platform answers: no active subscription under EITHER key.
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com" })],
    });
  });

  it("says the subscription ended and offers the two real options: renew or remove", async () => {
    render(<TrueReach />);
    expect(await screen.findByText(/subscription for ollydigital\.com has ended/i)).toBeInTheDocument();
    // Data safety is stated at the decision point, not discovered after.
    expect(screen.getByText(/every number you've collected stays/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /renew/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
    // The edge itself keeps running — lapse must NEVER touch the owner's AWS by itself.
    expect(screen.getByText(/^live$/i)).toBeInTheDocument();
  });

  it("Renew opens checkout for the SITE's domain (the post-08-05 key)", async () => {
    const { host } = await import("./host");
    (host.buyProduct as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    render(<TrueReach />);
    await userEvent.click(await screen.findByRole("button", { name: /renew/i }));
    await waitFor(() =>
      expect(host.buyProduct).toHaveBeenCalledWith(expect.any(String), { target: "ollydigital.com" }),
    );
  });

  it("shows no lapse notice while the subscription is in good standing", async () => {
    const { host } = await import("./host");
    (host.isPurchased as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    render(<TrueReach />);
    expect(await screen.findByText(/^live$/i)).toBeInTheDocument();
    expect(screen.queryByText(/has ended/i)).not.toBeInTheDocument();
  });
});

describe("the live edge lifecycle (unchanged by site-first)", () => {
  it("shows the validation record with copy buttons while ACM waits (resumable by design)", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({
        phase: "validating",
        domain: "stats.ollydigital.com",
        inProgress: true,
        records: [
          { purpose: "certificate-validation", name: "_abc.stats.ollydigital.com.", type: "CNAME", value: "_xyz.acm-validations.aws." },
        ],
      })],
    });
    render(<TrueReach />);
    expect(await screen.findByText(/domain-ownership check/i)).toBeInTheDocument();
    expect(screen.getByText("_xyz.acm-validations.aws.")).toBeInTheDocument();
    expect(screen.getByText(/waiting for your dns record/i)).toBeInTheDocument();
    expect(screen.getByText(/even if you close the app/i)).toBeInTheDocument();
  });

  it("DNS record chips select as ONE unit and never show surrounding whitespace", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({
        phase: "validating",
        domain: "stats.ollydigital.com",
        inProgress: true,
        records: [
          // A hypothetical padded answer from AWS must render (and copy) clean.
          { purpose: "certificate-validation", name: " _abc.stats.ollydigital.com. ", type: "CNAME", value: " _xyz.acm-validations.aws. " },
        ],
      })],
    });
    render(<TrueReach />);
    const chip = await screen.findByText("_xyz.acm-validations.aws.");
    expect(chip.textContent).toBe("_xyz.acm-validations.aws."); // trimmed
    // user-select: all → a manual click selects exactly the value, a drag can't grab a
    // neighbouring space (the \040 NXDOMAIN lesson, 2026-08-06).
    expect(chip).toHaveStyle({ userSelect: "all" });
  });

  it("when live, shows the pointing record and says snippets now serve first-party", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({
        phase: "ready",
        domain: "stats.ollydigital.com",
        distributionDomain: "d1.cloudfront.net",
        records: [
          { purpose: "point-your-domain", name: "stats.ollydigital.com.", type: "CNAME", value: "d1.cloudfront.net" },
        ],
      })],
    });
    render(<TrueReach />);
    expect(await screen.findByText(/point your subdomain/i)).toBeInTheDocument();
    expect(screen.getByText("d1.cloudfront.net")).toBeInTheDocument();
    expect(screen.getByText(/first-party/)).toBeInTheDocument();
  });

  it("reports the live state upward so the sites list can swap snippet origins", async () => {
    const seen: EdgeStatus[][] = [];
    mocked.edgeStatus.mockResolvedValue({ edges: [edge({ phase: "ready", domain: "stats.ollydigital.com" })] });
    render(<TrueReach onStatus={(e) => seen.push(e)} />);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]![0]!.domain).toBe("stats.ollydigital.com");
  });

  it("offers the edge update when the deployed edge is behind — never applies it itself", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com", updateAvailable: true })],
    });
    mocked.edgeUpdate.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com", viewerAtEdge: true })],
    });
    render(<TrueReach />);

    const btn = await screen.findByRole("button", { name: /update now/i });
    expect(mocked.edgeUpdate).not.toHaveBeenCalled(); // detection alone must not touch AWS
    // After the update applies, the refresh re-reads the (now current) live state.
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com", viewerAtEdge: true })],
    });
    await userEvent.setup().click(btn);
    await waitFor(() => expect(mocked.edgeUpdate).toHaveBeenCalledWith("stats.ollydigital.com"));
    // The card re-renders from the returned state: page now on the domain, banner gone.
    expect(await screen.findByText(/open the statistics page at/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update now/i })).not.toBeInTheDocument();
  });

  it("shows the statistics-page address once the dashboard rides the domain", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [edge({ phase: "ready", domain: "stats.ollydigital.com", viewerAtEdge: true })],
    });
    render(<TrueReach />);
    expect(await screen.findByText(/open the statistics page at/i)).toBeInTheDocument();
  });
});
