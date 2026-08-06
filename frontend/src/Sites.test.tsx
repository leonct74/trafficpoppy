import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sites, isFirstPartyFor } from "./Sites";
import { api } from "./api";

vi.mock("./api", () => ({
  api: {
    listSites: vi.fn(),
    addSite: vi.fn(),
    removeSite: vi.fn(),
    siteStats: vi.fn(),
    mergeSites: vi.fn(),
  },
}));

const mocked = api as unknown as {
  listSites: ReturnType<typeof vi.fn>;
  siteStats: ReturnType<typeof vi.fn>;
  mergeSites: ReturnType<typeof vi.fn>;
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

  it("uses the True Reach subdomain ONLY for the site it's first-party for", async () => {
    mocked.listSites.mockResolvedValue({
      sites: [
        { id: "olly", name: "Olly Digital", domain: "ollydigital.com", createdAt: "2026-07-18" },
        { id: "mail", name: "MailPoppy", domain: "mailpoppy.com", createdAt: "2026-07-18" },
      ],
    });
    render(<Sites collectorUrl={URL} trueReachDomains={["stats.ollydigital.com"]} />);

    const snippets = await screen.findAllByText(/<script defer/i);
    const texts = snippets.map((n) => n.textContent);
    // ollydigital.com → first-party via its own subdomain
    expect(texts).toContain('<script defer src="https://stats.ollydigital.com/t.js" data-site="olly"></script>');
    // mailpoppy.com must NOT be pointed at another domain's subdomain — falls back to AWS
    expect(texts).toContain(
      '<script defer src="https://abc123.lambda-url.eu-west-1.on.aws/t.js" data-site="mail"></script>',
    );
    // and the True Reach badge appears once (only the matching site)
    expect(screen.getAllByText("Advanced Stats")).toHaveLength(1);
  });

  it("isFirstPartyFor matches a subdomain of the site's own domain, nothing else", () => {
    expect(isFirstPartyFor("ollydigital.com", "stats.ollydigital.com")).toBe(true);
    expect(isFirstPartyFor("https://www.ollydigital.com/", "stats.ollydigital.com")).toBe(true);
    expect(isFirstPartyFor("ollydigital.com", "ollydigital.com")).toBe(true);
    expect(isFirstPartyFor("mailpoppy.com", "stats.ollydigital.com")).toBe(false);
    // guard against suffix spoofing: notollydigital.com must not match .ollydigital.com
    expect(isFirstPartyFor("notollydigital.com", "stats.ollydigital.com")).toBe(false);
    expect(isFirstPartyFor(undefined, "stats.ollydigital.com")).toBe(false);
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

/**
 * Founder 2026-08-05, after a rebuild + restore: "I see 2 instances of each website, one
 * with backup stats and one with the current one". The live snippet reports into exactly
 * one of them, so neither can simply be deleted — the two are merged, into the id the tag
 * already carries (the newer record), so no website ever needs editing.
 */
describe("two records for the same website", () => {
  const twins = [
    { id: "old", name: "Olly", domain: "ollydigital.com", createdAt: "2026-06-01" },
    { id: "new", name: "Olly", domain: "www.ollydigital.com", createdAt: "2026-08-05" },
  ];

  it("offers to merge them, and explains that nothing is lost", async () => {
    mocked.listSites.mockResolvedValue({ sites: twins });
    render(<Sites collectorUrl={URL} />);
    expect(await screen.findByText(/Some websites are listed twice/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is lost/i)).toBeInTheDocument();
    // Matched on the bare domain, so a www. difference still counts as the same site.
    expect(screen.getByText(/2 records/i)).toBeInTheDocument();
  });

  it("merges the older record INTO the newer one — the id the live tag uses", async () => {
    mocked.listSites.mockResolvedValue({ sites: twins });
    mocked.mergeSites.mockResolvedValue({ movedRows: 40, days: 20 });
    render(<Sites collectorUrl={URL} />);
    await userEvent.click(await screen.findByRole("button", { name: /merge into one/i }));
    await waitFor(() => expect(mocked.mergeSites).toHaveBeenCalledWith("old", "new"));
  });

  it("says nothing at all when every website appears once", async () => {
    mocked.listSites.mockResolvedValue({ sites: [twins[0]] });
    render(<Sites collectorUrl={URL} />);
    await screen.findByText(/ollydigital\.com/i);
    expect(screen.queryByText(/listed twice/i)).not.toBeInTheDocument();
  });
});

describe("restore → sites reload (tabs stay mounted)", () => {
  it("re-reads the site list when the Back up tab announces a restore", async () => {
    mocked.listSites.mockResolvedValue({ sites: [] });
    render(<Sites collectorUrl={URL} />);
    await screen.findByText(/paste into its pages/i);
    expect(mocked.listSites).toHaveBeenCalledTimes(1);

    // What Backup.tsx dispatches after a successful restore.
    document.dispatchEvent(new CustomEvent("tp:data-restored"));
    await waitFor(() => expect(mocked.listSites).toHaveBeenCalledTimes(2));
  });
});

describe("adding a site tells the other (mounted) tabs", () => {
  it("emits tp:sites-changed, so Advanced stats can offer the new site immediately", async () => {
    mocked.listSites.mockResolvedValue({ sites: [] });
    const mockedApi = api as unknown as { addSite: ReturnType<typeof vi.fn> };
    mockedApi.addSite.mockResolvedValue({ site: { id: "n1", name: "New", domain: "new.example", createdAt: "2026-08-06" } });
    const seen: string[] = [];
    const onChanged = () => seen.push("changed");
    document.addEventListener("tp:sites-changed", onChanged);

    render(<Sites collectorUrl={URL} />);
    await screen.findByText(/paste into its pages/i);
    const inputs = screen.getAllByRole("textbox");
    await userEvent.type(inputs[0]!, "New");
    await userEvent.type(inputs[1]!, "new.example");
    await userEvent.click(screen.getByRole("button", { name: /add site/i }));

    await waitFor(() => expect(seen).toHaveLength(1));
    document.removeEventListener("tp:sites-changed", onChanged);
  });
});
