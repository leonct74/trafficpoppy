import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Backup } from "./Backup";
import { api } from "./api";

vi.mock("./api", () => ({
  api: { backup: vi.fn(), listBackups: vi.fn(), restore: vi.fn() },
}));

const mocked = api as unknown as {
  backup: ReturnType<typeof vi.fn>;
  listBackups: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listBackups.mockResolvedValue({ backups: [] });
});

describe("Back up & restore", () => {
  it("says the privacy truth up front: nothing about individual visitors is in a backup", async () => {
    render(<Backup />);
    expect(await screen.findByText(/never contains anything about individual visitors/i)).toBeInTheDocument();
  });

  it("says the paid rule: a backup covers the sites unlocked with Advanced Stats", async () => {
    render(<Backup />);
    expect(await screen.findByText(/covers the sites you've unlocked with Advanced/i)).toBeInTheDocument();
  });

  it("NAMES any site left out — a silent omission would be found only after a teardown", async () => {
    mocked.backup.mockResolvedValue({
      path: "/x/TrafficPoppy-backup-2026-08-05.json",
      rows: 10,
      sites: 1,
      counters: 9,
      skippedSites: ["other-site.com", "third.com"],
    });
    render(<Backup />);
    await userEvent.click(await screen.findByRole("button", { name: /back up all statistics now/i }));
    expect(await screen.findByText(/Not in this backup:/i)).toBeInTheDocument();
    expect(screen.getByText(/other-site\.com, third\.com/)).toBeInTheDocument();
    expect(screen.getByText(/a removal would take them with it/i)).toBeInTheDocument();
  });

  it("backs up on click and shows the saved path with a copy button", async () => {
    mocked.backup.mockResolvedValue({
      path: "/Users/x/Documents/TrafficPoppy-backup-2026-08-05.json",
      rows: 43,
      sites: 1,
      counters: 42,
      skippedSites: [],
    });
    render(<Backup />);
    await userEvent.click(await screen.findByRole("button", { name: /back up all statistics now/i }));
    expect(await screen.findByText(/42/)).toBeInTheDocument(); // daily records count
    expect(screen.getByText(/TrafficPoppy-backup-2026-08-05\.json/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("restore is two-step confirmed, then reports what came back", async () => {
    mocked.listBackups.mockResolvedValue({
      backups: [{ path: "/x/TrafficPoppy-backup-2026-08-05.json", date: "2026-08-05", bytes: 2048 }],
    });
    mocked.restore.mockResolvedValue({ restored: 43 });
    render(<Backup />);

    await userEvent.click(await screen.findByRole("button", { name: /^restore$/i }));
    expect(mocked.restore).not.toHaveBeenCalled(); // first click only asks
    await userEvent.click(screen.getByRole("button", { name: /really restore/i }));
    await waitFor(() =>
      expect(mocked.restore).toHaveBeenCalledWith("/x/TrafficPoppy-backup-2026-08-05.json"),
    );
    expect(await screen.findByText(/have their history back/i)).toBeInTheDocument();
  });
});
