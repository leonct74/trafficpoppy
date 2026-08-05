import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Backup } from "./Backup";
import { api } from "./api";

vi.mock("./api", () => ({
  api: { backup: vi.fn(), listBackups: vi.fn(), restore: vi.fn(), listSites: vi.fn() },
}));

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
    render(<Backup onlineDomains={ONLINE} />);
    expect(await screen.findByText(/never contains anything about individual visitors/i)).toBeInTheDocument();
  });

  it("says the paid rule: a backup covers the sites unlocked with Advanced Stats", async () => {
    render(<Backup onlineDomains={ONLINE} />);
    expect(await screen.findByText(/covers the sites you've unlocked with Advanced/i)).toBeInTheDocument();
  });

  /**
   * Founder feedback 2026-08-05: "Back up all statistics now" said nothing about WHICH
   * sites were covered. The list is now shown before the button — unlocked sites
   * selectable, locked ones visible but disabled, so the gate is legible at a glance.
   */
  it("lists sites before the button: unlocked ones pickable, locked ones shown and disabled", async () => {
    render(<Backup onlineDomains={ONLINE} />);
    const olly = await screen.findByLabelText("ollydigital.com");
    expect(olly).toBeChecked();
    const other = screen.getByLabelText("other-site.com (locked)");
    expect(other).toBeDisabled();
    expect(other).not.toBeChecked();
    expect(screen.getByText(/needs Advanced Stats/i)).toBeInTheDocument();
  });

  it("the button names what it will do, and backs up only the ticked sites", async () => {
    mocked.backup.mockResolvedValue({ path: "/x/f.json", rows: 3, sites: 1, counters: 2, skippedSites: [] });
    render(<Backup onlineDomains={ONLINE} />);
    // One unlocked site → the button says its name rather than a bare count.
    const btn = await screen.findByRole("button", { name: /back up ollydigital\.com/i });
    await userEvent.click(btn);
    await waitFor(() => expect(mocked.backup).toHaveBeenCalledWith(["s1"]));
  });

  it("untick everything and there is nothing to back up — the button disables", async () => {
    render(<Backup onlineDomains={ONLINE} />);
    await userEvent.click(await screen.findByLabelText("ollydigital.com"));
    await waitFor(() => expect(screen.getByRole("button", { name: /back up 0 sites/i })).toBeDisabled());
    expect(mocked.backup).not.toHaveBeenCalled();
  });

  it("with no site unlocked, points at the Advanced stats tab instead", async () => {
    render(<Backup onlineDomains={[]} />);
    expect(await screen.findByText(/No site has Advanced Stats yet/i)).toBeInTheDocument();
  });

  it("NAMES any site left out — a silent omission would be found only after a teardown", async () => {
    mocked.backup.mockResolvedValue({
      path: "/x/TrafficPoppy-backup-2026-08-05.json",
      rows: 10,
      sites: 1,
      counters: 9,
      skippedSites: ["other-site.com", "third.com"],
    });
    render(<Backup onlineDomains={ONLINE} />);
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
    render(<Backup onlineDomains={ONLINE} />);
    await userEvent.click(await screen.findByRole("button", { name: /back up /i }));
    expect(await screen.findByText(/42/)).toBeInTheDocument(); // daily records count
    expect(screen.getByText(/TrafficPoppy-backup-2026-08-05\.json/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("restore is two-step confirmed, then reports what came back", async () => {
    mocked.listBackups.mockResolvedValue({
      backups: [{ path: "/x/TrafficPoppy-backup-2026-08-05.json", date: "2026-08-05", bytes: 2048 }],
    });
    mocked.restore.mockResolvedValue({ restored: 43 });
    render(<Backup onlineDomains={ONLINE} />);

    await userEvent.click(await screen.findByRole("button", { name: /^restore$/i }));
    expect(mocked.restore).not.toHaveBeenCalled(); // first click only asks
    await userEvent.click(screen.getByRole("button", { name: /really restore/i }));
    await waitFor(() =>
      expect(mocked.restore).toHaveBeenCalledWith("/x/TrafficPoppy-backup-2026-08-05.json"),
    );
    expect(await screen.findByText(/have their history back/i)).toBeInTheDocument();
  });
});
