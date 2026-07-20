import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Sites } from "./Sites";
import { api } from "./api";

vi.mock("./api", () => ({
  api: {
    listSites: vi.fn(),
    addSite: vi.fn(),
    removeSite: vi.fn(),
    siteStats: vi.fn(),
  },
}));

const mocked = api as unknown as {
  listSites: ReturnType<typeof vi.fn>;
  siteStats: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocked.siteStats.mockResolvedValue({ stats: { receiving: false, views: 0, uniques: 0, topPages: [], topReferrers: [], browsers: [] } });
});

const URL = "https://abc123.lambda-url.eu-west-1.on.aws/";

describe("Sites screen", () => {
  it("teaches the install when there are no sites yet", async () => {
    mocked.listSites.mockResolvedValue({ sites: [] });
    render(<Sites collectorUrl={URL} />);
    expect(await screen.findByText(/paste into its pages/i)).toBeInTheDocument();
  });

  it("builds the snippet with the deployed collector origin and the site's own id", async () => {
    mocked.listSites.mockResolvedValue({
      sites: [{ id: "Ab3xYz9k2m", name: "Olly Digital", domain: "ollydigital.com", createdAt: "2026-07-18" }],
    });
    render(<Sites collectorUrl={URL} />);

    const snippet = await screen.findByText(/<script defer/i);
    expect(snippet.textContent).toBe(
      '<script defer src="https://abc123.lambda-url.eu-west-1.on.aws/t.js" data-site="Ab3xYz9k2m"></script>',
    );
  });

  it("shows the receiving badge + live counts once data lands", async () => {
    mocked.listSites.mockResolvedValue({
      sites: [{ id: "s1", name: "Site", domain: "s.com", createdAt: "2026-07-18" }],
    });
    mocked.siteStats.mockResolvedValue({
      stats: { receiving: true, views: 128, uniques: 73, topPages: [], topReferrers: [], browsers: [] },
    });
    render(<Sites collectorUrl={URL} />);

    await waitFor(() => expect(screen.getByText(/receiving data/i)).toBeInTheDocument());
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("73")).toBeInTheDocument();
  });
});
