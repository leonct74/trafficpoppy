import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Backup } from "./Backup";
import { api } from "./api";

vi.mock("./api", () => ({
  api: { backup: vi.fn(), listBackups: vi.fn(), restore: vi.fn(), listSites: vi.fn() },
}));

// Each site asks the host whether it's subscribed — default to "no" so the tests below
// pin the SUBSCRIPTION as the gate, separately from a deployed edge.
vi.mock("./host", async () => {
  const actual = await vi.importActual<typeof import("./host")>("./host");
  return {
    ...actual,
    host: {
      isPurchased: vi.fn().mockResolvedValue(false),
      purchaseInfo: vi.fn().mockResolvedValue({ price: null, owned: false }),
      buyProduct: vi.fn(),
      manageSubscription: vi.fn(),
    },
  };
});

const mocked = api as unknown as {
  backup: ReturnType<typeof vi.fn>;
  listBackups: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  listSites: ReturnType<typeof vi.fn>;
};

const ONLINE = ["stats.ollydigital.com"];

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listBackups.mockResolvedValue({ backups: [] });
  mocked.listSites.mockResolvedValue({
    sites: [
      { id: "s1", name: "Olly", domain: "ollydigital.com", createdAt: "2026-01-01" },
      { id: "s2", name: "Other", domain: "other-site.com", createdAt: "2026-01-02" },
    ],
  });
});

describe("Back up & restore", () => {
  it("says the privacy truth up front: nothing about individual visitors is in a backup", async () => {
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    expect(await screen.findByText(/never contains anything about individual visitors/i)).toBeInTheDocument();
  });

  it("says the paid rule: a backup covers the sites unlocked with Advanced Stats", async () => {
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    expect(await screen.findByText(/covers the sites you've unlocked with Advanced/i)).toBeInTheDocument();
  });

  /**
   * Founder feedback 2026-08-05: "Back up all statistics now" said nothing about WHICH
   * sites were covered. The list is now shown before the button — unlocked sites
   * selectable, locked ones visible but disabled, so the gate is legible at a glance.
   */
  it("lists sites before the button: unlocked ones pickable, locked ones shown and disabled", async () => {
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    const olly = await screen.findByLabelText("ollydigital.com");
    expect(olly).toBeChecked();
    const other = screen.getByLabelText("other-site.com (locked)");
    expect(other).toBeDisabled();
    expect(other).not.toBeChecked();
    expect(screen.getByText(/needs Advanced Stats/i)).toBeInTheDocument();
  });

  it("the button names what it will do, and backs up only the ticked sites", async () => {
    mocked.backup.mockResolvedValue({ path: "/x/f.json", rows: 3, sites: 1, counters: 2, skippedSites: [] });
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    // One unlocked site → the button says its name rather than a bare count.
    const btn = await screen.findByRole("button", { name: /back up ollydigital\.com/i });
    await userEvent.click(btn);
    await waitFor(() => expect(mocked.backup).toHaveBeenCalledWith(["s1"], ["ollydigital.com"]));
  });

  it("untick everything and there is nothing to back up — the button disables", async () => {
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    await userEvent.click(await screen.findByLabelText("ollydigital.com"));
    await waitFor(() => expect(screen.getByRole("button", { name: /back up 0 sites/i })).toBeDisabled());
    expect(mocked.backup).not.toHaveBeenCalled();
  });

  it("with no site unlocked, points at the Advanced stats tab instead", async () => {
    render(<Backup onlineDomains={[]} paidDomains={[]} />);
    expect(await screen.findByText(/No site has Advanced Stats yet/i)).toBeInTheDocument();
  });

  /**
   * Founder 2026-08-05: "even if I unlock 3 domains subscriptions, I can only backup
   * ollydigital.com". The first cut gated on the DEPLOYED EDGE, so a paid domain whose
   * DNS wasn't finished was excluded — holding back numbers someone had paid for. The
   * subscription is the gate; a live edge only counts as an additional way in.
   */
  it("a SUBSCRIBED site is backable before its address exists — no edge required", async () => {
    mocked.backup.mockResolvedValue({ path: "/x/f.json", rows: 1, sites: 1, counters: 0, skippedSites: [] });

    // Subscribed, nothing deployed at all.
    render(<Backup onlineDomains={[]} paidDomains={["other-site.com"]} />);
    const other = await screen.findByLabelText("other-site.com");
    expect(other).toBeChecked();
    // …and the site that is neither paid nor deployed stays locked.
    expect(screen.getByLabelText("ollydigital.com (locked)")).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /back up other-site\.com/i }));
    await waitFor(() => expect(mocked.backup).toHaveBeenCalledWith(["s2"], ["other-site.com"]));
  });

  it("a live edge still counts, so a lapsed subscription never strands the numbers", async () => {
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />); // isPurchased: false everywhere
    expect(await screen.findByLabelText("ollydigital.com")).toBeChecked();
  });

  it("NAMES any site left out — a silent omission would be found only after a teardown", async () => {
    mocked.backup.mockResolvedValue({
      path: "/x/TrafficPoppy-backup-2026-08-05.json",
      rows: 10,
      sites: 1,
      counters: 9,
      skippedSites: ["other-site.com", "third.com"],
    });
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: /back up /i }));
    expect(await screen.findByText(/Not in this backup:/i)).toBeInTheDocument();
    expect(screen.getByText(/other-site\.com, third\.com/)).toBeInTheDocument();
    expect(screen.getByText(/a removal would take them with it/i)).toBeInTheDocument();
  });

  it("shows the saved path with a copy button", async () => {
    mocked.backup.mockResolvedValue({
      path: "/Users/x/Documents/TrafficPoppy-backup-2026-08-05.json",
      rows: 43,
      sites: 1,
      counters: 42,
      skippedSites: [],
    });
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: /back up /i }));
    expect(await screen.findByText(/42/)).toBeInTheDocument(); // daily records count
    expect(screen.getByText(/TrafficPoppy-backup-2026-08-05\.json/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("restore is two-step confirmed, then reports what came back", async () => {
    mocked.listBackups.mockResolvedValue({
      backups: [{ path: "/x/TrafficPoppy-backup-2026-08-05.json", date: "2026-08-05", bytes: 2048 }],
    });
    mocked.restore.mockResolvedValue({ restored: 43, mergedSites: [], conflicts: [] });
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);

    await userEvent.click(await screen.findByRole("button", { name: /^restore$/i }));
    expect(mocked.restore).not.toHaveBeenCalled(); // first click only asks
    await userEvent.click(screen.getByRole("button", { name: /really restore/i }));
    await waitFor(() =>
      expect(mocked.restore).toHaveBeenCalledWith("/x/TrafficPoppy-backup-2026-08-05.json"),
    );
    expect(await screen.findByText(/have their history back/i)).toBeInTheDocument();
  });

  it("says when a restore merged into a site the owner had re-created", async () => {
    mocked.listBackups.mockResolvedValue({
      backups: [{ path: "/x/TrafficPoppy-backup-2026-08-05.json", date: "2026-08-05", bytes: 2048 }],
    });
    mocked.restore.mockResolvedValue({ restored: 43, mergedSites: ["ollydigital.com"], conflicts: [] });
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: /^restore$/i }));
    await userEvent.click(screen.getByRole("button", { name: /really restore/i }));
    expect(await screen.findByText(/Merged into your existing ollydigital\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/each site appears once/i)).toBeInTheDocument();
  });

  it("reports a clash instead of deleting, when both copies hold data", async () => {
    mocked.listBackups.mockResolvedValue({
      backups: [{ path: "/x/TrafficPoppy-backup-2026-08-05.json", date: "2026-08-05", bytes: 2048 }],
    });
    mocked.restore.mockResolvedValue({ restored: 43, mergedSites: [], conflicts: ["ollydigital.com"] });
    render(<Backup onlineDomains={ONLINE} paidDomains={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: /^restore$/i }));
    await userEvent.click(screen.getByRole("button", { name: /really restore/i }));
    expect(await screen.findByText(/now appears twice/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was deleted/i)).toBeInTheDocument();
  });
});
