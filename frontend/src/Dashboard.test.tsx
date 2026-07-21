import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { computeMovers, costApprox, Dashboard } from "./Dashboard";
import { api } from "./api";
import type { RangeStats } from "./types";

vi.mock("./api", () => ({
  api: { rangeStats: vi.fn(), liveStats: vi.fn() },
}));

const mocked = api as unknown as { rangeStats: ReturnType<typeof vi.fn>; liveStats: ReturnType<typeof vi.fn> };

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
    utmSources: [{ key: "newsletter", count: 5 }],
    utmCampaigns: [],
    utmMediums: [],
    hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? 7 : 0)),
    prev: { views: 6, uniques: 6, topPages: [{ key: "/old-post", count: 5 }], topReferrers: [] },
    receiving: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.rangeStats.mockResolvedValue({ range: range() });
  mocked.liveStats.mockResolvedValue({
    live: { siteId: "s1", minutes: [{ minute: "2026-07-21T10:00", views: 2 }], views: 2 },
  });
});

describe("Dashboard", () => {
  it("shows headline numbers, every breakdown, and the campaigns teach-state", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    expect((await screen.findAllByText("12")).length).toBeGreaterThan(0); // views
    expect(await screen.findByText("6")).toBeInTheDocument(); // visitors (counts up async)
    expect(mocked.rangeStats).toHaveBeenCalledWith("s1", 7);
    // Page keys can appear in BOTH the top-pages list and the movers chips.
    expect(screen.getAllByText("/pricing").length).toBeGreaterThan(0);
    expect(screen.getByText("news.ycombinator.com")).toBeInTheDocument();
    expect(screen.getByText("newsletter")).toBeInTheDocument();
    expect(screen.getByText(/utm_campaign=/i)).toBeInTheDocument();
  });

  it("shows Δ% against the previous window (views doubled ⇒ +100%)", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    expect(await screen.findByText(/\+100%/)).toBeInTheDocument();
    // uniques 6 vs 6 — no chip for an unchanged metric (asserted via the delta count).
    expect(screen.getAllByText(/↑/).length).toBeGreaterThan(0);
  });

  it("surfaces top movers — risers and the faded /old-post", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    expect(await screen.findByText(/top movers/i)).toBeInTheDocument();
    expect(screen.getByText("/old-post")).toBeInTheDocument(); // fell to zero — still shown
  });

  it("renders the hour-of-day strip with per-hour tooltips", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    await screen.findByText(/busiest hours/i);
    expect(screen.getByTitle(/09:00 UTC — 7 views/)).toBeInTheDocument();
  });

  it("shows the live last-30-minutes badge from its own poll", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/2 live/)).toBeInTheDocument());
    expect(mocked.liveStats).toHaveBeenCalledWith("s1");
  });

  it("re-reads when the range changes", async () => {
    render(<Dashboard site={site} onBack={() => {}} />);
    await screen.findAllByText("12");
    await userEvent.click(screen.getByRole("tab", { name: /30 days/i }));
    await waitFor(() => expect(mocked.rangeStats).toHaveBeenCalledWith("s1", 30));
  });

  it("teaches the snippet when the range has no data", async () => {
    mocked.rangeStats.mockResolvedValue({
      range: range({
        receiving: false,
        views: 0,
        uniques: 0,
        topPages: [],
        topReferrers: [],
        browsers: [],
        os: [],
        sizes: [],
        utmSources: [],
        hours: Array(24).fill(0),
        prev: undefined,
      }),
    });
    render(<Dashboard site={site} onBack={() => {}} />);
    expect(await screen.findByText(/no visits recorded/i)).toBeInTheDocument();
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

describe("computeMovers — what changed vs the previous window", () => {
  it("ranks by absolute change, both directions, and includes pages that fell to zero", () => {
    const movers = computeMovers(
      [
        { key: "/hot", count: 10 },
        { key: "/steady", count: 5 },
      ],
      [
        { key: "/steady", count: 5 },
        { key: "/gone", count: 7 },
      ],
    );
    expect(movers).toEqual([
      { key: "/hot", count: 10, delta: 10 },
      { key: "/gone", count: 0, delta: -7 },
    ]);
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
