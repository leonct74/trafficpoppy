import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Conversions } from "./Conversions";
import { api } from "./api";
import type { RangeStats, Site } from "./types";

vi.mock("./api", () => ({
  api: { listSites: vi.fn(), rangeStats: vi.fn(), updateSiteGoals: vi.fn() },
}));

const mocked = api as unknown as {
  listSites: ReturnType<typeof vi.fn>;
  rangeStats: ReturnType<typeof vi.fn>;
  updateSiteGoals: ReturnType<typeof vi.fn>;
};

const site = (over: Partial<Site> = {}): Site => ({
  id: "s1",
  name: "Olly",
  domain: "ollydigital.com",
  createdAt: "2026-01-01",
  ...over,
});

const range = (over: Partial<RangeStats> = {}): RangeStats =>
  ({
    siteId: "s1",
    from: "2026-07-01",
    to: "2026-07-30",
    days: [],
    views: 500,
    uniques: 200,
    topPages: [],
    topReferrers: [],
    browsers: [],
    os: [],
    sizes: [],
    utmSources: [],
    utmCampaigns: [],
    utmMediums: [],
    countries: [],
    hours: [],
    newVisitors: 0,
    returningVisitors: 0,
    goals: [],
    entries: [],
    edges: [],
    receiving: true,
    ...over,
  }) as RangeStats;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listSites.mockResolvedValue({ sites: [site(), site({ id: "s2", domain: "other.com" })] });
  mocked.rangeStats.mockResolvedValue({ range: range() });
  mocked.updateSiteGoals.mockImplementation(async (_id: string, goals: unknown) => ({ goals }));
});

const PAID = ["ollydigital.com"];

describe("Conversions tracker — the setup surface", () => {
  it("picks the website from ONE dropdown — a chip row doesn't survive tens of sites", async () => {
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    const picker = (await screen.findByLabelText("Website")) as HTMLSelectElement;
    expect(picker.tagName).toBe("SELECT");
    expect(picker.value).toBe("s1");
    // Locked sites stay visible but unselectable — the gate must be legible, and a site
    // silently missing from the list reads as a bug.
    const locked = screen.getByRole("option", { name: /other\.com 🔒/ }) as HTMLOptionElement;
    expect(locked.disabled).toBe(true);
  });

  /** The whole design rests on this: ONE plain question, no jargon, two answers. */
  it("asks what to count in plain words — never 'event' or 'selector'", async () => {
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    expect(await screen.findByText(/Someone reaches a page/i)).toBeInTheDocument();
    expect(screen.getByText(/Someone presses a button or link/i)).toBeInTheDocument();
    expect(screen.queryByText(/selector/i)).not.toBeInTheDocument();
  });

  it("creates a page goal from one field, and names it automatically", async () => {
    const user = userEvent.setup();
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    await user.click(await screen.findByText(/Someone reaches a page/i));
    await user.type(screen.getByPlaceholderText("/thank-you"), "/thank-you");
    await user.click(screen.getByRole("button", { name: /Start counting this page/i }));

    await waitFor(() =>
      expect(mocked.updateSiteGoals).toHaveBeenCalledWith("s1", [
        { name: "thank-you", kind: "page", path: "/thank-you" },
      ]),
    );
  });

  it("creates a button goal and then shows exactly what to paste", async () => {
    const user = userEvent.setup();
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    await user.click(await screen.findByText(/Someone presses a button or link/i));
    await user.type(screen.getByPlaceholderText("download"), "Download");
    await user.click(screen.getByRole("button", { name: /Create and show me what to paste/i }));

    await waitFor(() =>
      expect(mocked.updateSiteGoals).toHaveBeenCalledWith("s1", [{ name: "download", kind: "event" }]),
    );
    // Shown twice on purpose: in the goal's own line, and in the copyable setup block.
    expect(await screen.findAllByText('data-tp-goal="download"')).not.toHaveLength(0);
    // The AI route is offered right there — the attribute edit is the one place this
    // feature can go wrong (AGENTS.md §9: onboarding is a prompt, not a manual).
    expect(screen.getByRole("button", { name: /Copy the prompt/i })).toBeInTheDocument();
  });

  it("tells the truth about page goals working backwards", async () => {
    const user = userEvent.setup();
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    await user.click(await screen.findByText(/Someone reaches a page/i));
    expect(screen.getByText(/visits already recorded for that address are counted straight away/i)).toBeInTheDocument();
  });
});

describe("Conversions tracker — a goal that already exists", () => {
  beforeEach(() => {
    mocked.listSites.mockResolvedValue({
      sites: [site({ goals: [{ name: "download", kind: "event", createdAt: "2026-08-01" }] })],
    });
  });

  it("keeps 'Add another conversion' ABOVE the goal cards, so it never scrolls out of sight", async () => {
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    const add = await screen.findByText(/Add another conversion/i);
    const goal = screen.getByText(/download/, { selector: "strong" });
    // FOLLOWING means the goal card comes after the add card in document order.
    expect(add.compareDocumentPosition(goal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the two choice buttons carry readable text on a dark surface", async () => {
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    const choice = (await screen.findByText(/Someone presses a button or link/i)).closest("button")!;
    // A <button> without our .btn class would fall back to the UA's black `buttontext`.
    expect(choice.style.color).toBe("var(--poppy-text)");
  });

  it("says 'waiting for the first press' until one lands — the setup self-check", async () => {
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    expect(await screen.findByText(/Waiting for the first press/i)).toBeInTheDocument();
  });

  it("turns green and shows conversions, converters and the rate once presses arrive", async () => {
    mocked.rangeStats.mockResolvedValue({
      range: range({
        goals: [{ name: "download", kind: "event", conversions: 30, converters: 20, prevConversions: 10 }],
      }),
    });
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    expect(await screen.findByText("Working")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument(); // 20 converters of 200 visitors
  });

  it("removing a goal is two-step and says the numbers already collected stay", async () => {
    const user = userEvent.setup();
    render(<Conversions onlineDomains={[]} paidDomains={PAID} />);
    await user.click(await screen.findByRole("button", { name: /^Remove$/i }));
    expect(screen.getByText(/numbers you already have stay/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Remove$/i }));
    await waitFor(() => expect(mocked.updateSiteGoals).toHaveBeenCalledWith("s1", []));
  });
});
