// The browser dashboard's ROUTER, exercised in a real DOM (§7b, founder ask 2026-08-07).
//
// This page is a hand-written SPA served as a string, so nothing else in the build would
// notice if a navigation broke. These tests run the actual served script in jsdom and drive
// it the way a person does: land on a deep link, refresh, click through, press Back.

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardHtml } from "./viewer-page";

const SITES = {
  sites: [
    { id: "s1", name: "Olly Digital", domain: "ollydigital.com" },
    { id: "s2", name: "Second", domain: "second.com" },
  ],
  viewer: { email: "someone@example.com" },
};

const RANGE = {
  range: {
    siteId: "s1",
    from: "2026-08-01",
    to: "2026-08-07",
    days: [{ day: "2026-08-07", views: 10, uniques: 5 }],
    views: 10,
    uniques: 5,
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
  },
};

let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

/** Boot the real page at `url`, already signed in, with every fetch answered locally. */
function open(url: string): { win: Window & typeof globalThis; calls: string[] } {
  const calls: string[] = [];
  dom = new JSDOM(dashboardHtml({ region: "eu-west-1", userPoolClientId: "client123" }), {
    url,
    runScripts: "dangerously",
    beforeParse(window) {
      window.sessionStorage.setItem("tp_tok", "a.valid.token"); // skip the login screen
      // @ts-expect-error — a minimal stand-in for the browser's fetch
      window.fetch = (input: string) => {
        calls.push(String(input));
        const body = String(input).includes("/api/sites/") ? RANGE : SITES;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      };
    },
  });
  return { win: dom.window as unknown as Window & typeof globalThis, calls };
}

/** Wait for the page to settle after an async render. */
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

const text = (win: Window) => win.document.body.textContent ?? "";

describe("the dashboard's urls (§7b routing)", () => {
  it("a deep link opens that site's statistics — the refresh case", async () => {
    // Founder 2026-08-07: "if a user wants to refresh the stats of one website, he will
    // land in the home page with the list of domains instead of the stats page".
    const { win, calls } = open("https://stats.example.com/site/s1");
    await settle();
    expect(win.document.title).toBe("Olly Digital · Analytics");
    expect(calls.some((c) => c.startsWith("/api/sites/s1/range"))).toBe(true);
    expect(win.document.getElementById("detail")!.className).not.toContain("hide");
  });

  it("the range rides in the url too, so a refresh keeps the period", async () => {
    const { calls } = open("https://stats.example.com/site/s1?days=30");
    await settle();
    expect(calls.find((c) => c.startsWith("/api/sites/s1/range"))).toContain("days=30");
  });

  it("a custom range survives the same way", async () => {
    const { calls } = open("https://stats.example.com/site/s1?from=2026-07-01&to=2026-07-10");
    await settle();
    const q = calls.find((c) => c.startsWith("/api/sites/s1/range"))!;
    expect(q).toContain("from=2026-07-01");
    expect(q).toContain("to=2026-07-10");
  });

  it("clicking a site pushes its url; Back returns to the list", async () => {
    const { win } = open("https://stats.example.com/");
    await settle();
    expect(win.location.pathname).toBe("/");

    const row = win.document.querySelector(".site") as HTMLAnchorElement;
    expect(row.getAttribute("href")).toBe("/site/s1"); // a real link, ⌘-clickable
    row.click();
    await settle();
    expect(win.location.pathname).toBe("/site/s1");

    win.history.back();
    await settle();
    expect(win.location.pathname).toBe("/");
    expect(win.document.title).toBe("Analytics");
  });

  it("the range tabs navigate rather than mutate hidden state", async () => {
    const { win } = open("https://stats.example.com/site/s1");
    await settle();
    const tab = win.document.querySelector('.tab[data-d="30"]') as HTMLElement;
    tab.click();
    await settle();
    expect(win.location.pathname + win.location.search).toBe("/site/s1?days=30");
  });

  it("'← All sites' goes home", async () => {
    const { win } = open("https://stats.example.com/site/s1");
    await settle();
    (win.document.getElementById("back") as HTMLElement).click();
    await settle();
    expect(win.location.pathname).toBe("/");
  });

  /**
   * A url naming a site this viewer can't see says the same thing whether or not it
   * exists — the dashboard must never become a way to discover other people's sites
   * (the §7b enumeration guard, enforced server-side; this is the matching wording).
   */
  it("an unknown site id says 'not available', without revealing whether it exists", async () => {
    const { win } = open("https://stats.example.com/site/does-not-exist");
    await settle();
    expect(text(win)).toMatch(/isn't available to you/i);
    expect(text(win)).not.toMatch(/deleted|no such site/i);
  });
});
