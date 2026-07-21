import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { costApprox, Dashboard } from "./Dashboard";
import { api } from "./api";
import type { RangeStats } from "./types";

vi.mock("./api", () => ({
  api: { rangeStats: vi.fn() },
}));

const mocked = api as unknown as { rangeStats: ReturnType<typeof vi.fn> };

const site = { id: "s1", name: "Olly Digital", domain: "ollydigital.com", createdAt: "2026-07-18" };

function range(over: Partial<RangeStats> = {}): RangeStats {
  return {
    siteId: "s1",
    from: "2026-07-15",
    to: "2026-07-21",
    days: [
      { day: "2026-07-20", views: 3, uniques: 2 },
      { day: "2026-07-21", views: 9, uniques: 4 },
    ],
    views: 12,
    uniques: 6,
    topPages: [
      { key: "/", count: 8 },
      { key: "/pricing", count: 4 },
    ],
    topReferrers: [{ key: "news.ycombinator.com", count: 3 }],
    browsers: [{ key: "Chrome", count: 12 }],
    os: [{ key: "macOS", count: 12 }],
    sizes: [{ key: "desktop", count: 12 }],
    receiving: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.rangeStats.mockResolvedValue({ range: range() });
});

describe("Dashboard", () => {
  it("shows the headline numbers and every breakdown for the default 7-day range", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    // "12" also appears in the cost line's view count, so match all.
    expect((await screen.findAllByText("12")).length).toBeGreaterThan(0); // views
    expect(screen.getByText("6")).toBeInTheDocument(); // visitors
    expect(mocked.rangeStats).toHaveBeenCalledWith("s1", 7);
    expect(screen.getByText("/pricing")).toBeInTheDocument();
    expect(screen.getByText("news.ycombinator.com")).toBeInTheDocument();
    expect(screen.getByText("Chrome")).toBeInTheDocument();
    expect(screen.getByText("macOS")).toBeInTheDocument();
    expect(screen.getByText("desktop")).toBeInTheDocument();
  });

  it("re-reads when the range changes", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    await screen.findAllByText("12");
    await userEvent.click(screen.getByRole("tab", { name: /30 days/i }));
    await waitFor(() => expect(mocked.rangeStats).toHaveBeenCalledWith("s1", 30));
  });

  it("teaches the snippet when the range has no data", async () => {
    mocked.rangeStats.mockResolvedValue({
      range: range({ receiving: false, views: 0, uniques: 0, topPages: [], topReferrers: [], browsers: [], os: [], sizes: [] }),
    });
    render(<Dashboard site={site} onBack={() => {}} />);
    expect(await screen.findByText(/no visits recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/numbers appear within seconds/i)).toBeInTheDocument();
  });

  it("shows the cost line from real 30-day usage, labeled approximate", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    expect(await screen.findByText(/what this costs you/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/approximate/i)).toBeInTheDocument());
  });

  it("goes back to the sites list", async () => {
    const onBack = vi.fn();
    render(<Dashboard site={site} onBack={onBack} />);
    await userEvent.click(await screen.findByRole("button", { name: /all sites/i }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("costApprox — honest, never alarming, never lying", () => {
  it("says $0.00 for zero traffic", () => {
    expect(costApprox(0)).toBe("$0.00");
  });
  it("floors tiny-but-nonzero usage at 'less than $0.01' rather than claiming free", () => {
    expect(costApprox(100)).toBe("less than $0.01");
  });
  it("scales with volume", () => {
    expect(costApprox(1_000_000)).toBe("~$12.00");
  });
});
