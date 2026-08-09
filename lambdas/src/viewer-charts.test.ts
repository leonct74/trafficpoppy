// The dashboard's charts, driven in a real DOM the way a phone drives them.
//
// Founder 2026-08-09, from the live site: (1) the traffic-flow chart was cut off at the
// bottom once a site had a few sources and destinations; (2) "Views by hour" and "Right
// now" only gave up a column's value on hover — which on a touch screen means never.
//
// These are geometry and interaction tests, so they run the served page in jsdom rather
// than matching strings: the bug was in the numbers the SVG is built from.

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardHtml } from "./viewer-page";

const SITES = { sites: [{ id: "s1", name: "Olly Digital", domain: "ollydigital.com" }], viewer: { email: "v@example.com" } };

/** 30 minutes of ticker data, quiet except for one spike — the shape that hides small bars. */
const MINUTES = Array.from({ length: 30 }, (_, i) => ({
  minute: `2026-08-09T14:${String(i).padStart(2, "0")}`,
  views: i === 12 ? 40 : i % 7 === 0 ? 1 : 0,
}));

/**
 * A lopsided day: "direct" dwarfs everything else, and there are six of each column.
 * This is the case that overflowed — proportional heights put the tail below the
 * minimum bar height, and the minimum is what made the column taller than the viewBox.
 */
const RANGE = (over: Record<string, unknown> = {}) => ({
  range: {
    siteId: "s1",
    from: "2026-08-09",
    to: "2026-08-09",
    days: [{ day: "2026-08-09", views: 900, uniques: 500 }],
    views: 900,
    uniques: 500,
    hours: Array.from({ length: 24 }, (_, h) => (h === 14 ? 300 : h === 9 ? 120 : h % 3 === 0 ? 4 : 0)),
    topPages: [{ key: "/", count: 400 }],
    topReferrers: [],
    browsers: [],
    os: [],
    sizes: [],
    utmSources: [],
    utmCampaigns: [],
    utmMediums: [],
    countries: [],
    newVisitors: 0,
    returningVisitors: 0,
    goals: [],
    entries: [
      { source: "direct", path: "/", count: 800 },
      { source: "google.com", path: "/", count: 40 },
      { source: "news.ycombinator.com", path: "/pricing", count: 12 },
      { source: "reddit.com", path: "/pricing", count: 6 },
      { source: "a-very-long-referrer-hostname.example.com", path: "/blog/a-very-long-article-slug-here", count: 3 },
      { source: "bing.com", path: "/", count: 2 },
      { source: "duckduckgo.com", path: "/about", count: 1 },
    ],
    edges: [
      { from: "/", to: "/pricing", count: 300 },
      { from: "/", to: "/blog/a-very-long-article-slug-here", count: 40 },
      { from: "/pricing", to: "/contact", count: 20 },
      { from: "/pricing", to: "/signup", count: 9 },
      { from: "/about", to: "/contact", count: 4 },
      { from: "/blog/a-very-long-article-slug-here", to: "/", count: 2 },
    ],
    receiving: true,
    ...over,
  },
});

let dom: JSDOM | undefined;
afterEach(() => dom?.window.close());

function open(range = RANGE()): Window & typeof globalThis {
  dom = new JSDOM(dashboardHtml({ region: "eu-west-1", userPoolClientId: "c1" }), {
    url: "https://stats.example.com/site/s1?days=1",
    runScripts: "dangerously",
    beforeParse(window) {
      window.sessionStorage.setItem("tp_tok", "a.valid.token");
      // @ts-expect-error — a minimal stand-in for the browser's fetch
      window.fetch = (input: string) => {
        const p = String(input);
        const body = p.includes("/live") ? { live: { views: 47, minutes: MINUTES } } : p.includes("/range") ? range : SITES;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      };
    },
  });
  return dom.window as unknown as Window & typeof globalThis;
}

const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The card whose heading starts with `title`. */
const card = (win: Window, title: string) =>
  [...win.document.querySelectorAll(".card")].find((c) => c.querySelector("h2")?.textContent?.startsWith(title))!;

const viewBox = (svg: SVGSVGElement) => {
  const [x = 0, y = 0, w = 0, h = 0] = svg.getAttribute("viewBox")!.split(" ").map(Number);
  return { x, y, w, h };
};

/** One column of a chart, as an element that can be clicked. */
const col = (list: Element[], i: number) => list[i]! as unknown as HTMLElement;

describe("traffic flow fits inside its own chart", () => {
  it("the viewBox grows to hold every node — nothing is cut off at the bottom", async () => {
    const win = open();
    await settle();
    const svg = card(win, "Traffic flow").querySelector("svg") as unknown as SVGSVGElement;
    const { h } = viewBox(svg);

    // Every node rect must end above the bottom edge. Before the fix the height was
    // pinned at 560 and the last source sat below it, clipped away entirely.
    const nodes = [...svg.querySelectorAll("rect")];
    expect(nodes.length).toBeGreaterThan(6);
    for (const n of nodes) {
      const bottom = Number(n.getAttribute("y")) + Number(n.getAttribute("height"));
      expect(bottom).toBeLessThanOrEqual(h);
    }
    // …and with room to spare, not flush against the edge.
    const lowest = Math.max(...nodes.map((n) => Number(n.getAttribute("y")) + Number(n.getAttribute("height"))));
    expect(h - lowest).toBeGreaterThanOrEqual(6);
  });

  it("every label is inside the chart too, with the full text kept in the tooltip", async () => {
    const win = open();
    await settle();
    const svg = card(win, "Traffic flow").querySelector("svg")!;
    const { w } = viewBox(svg as unknown as SVGSVGElement);

    // What's DRAWN is the text minus its <title> child (that one is the tooltip).
    const drawn = [...svg.querySelectorAll("text")].map((t) =>
      [...t.childNodes].filter((n) => n.nodeName.toLowerCase() !== "title").map((n) => n.textContent ?? "").join(""),
    );
    expect(Math.max(...drawn.map((s) => s.length))).toBeLessThan(40); // trimmed, cannot run off the side
    expect(w).toBe(920);
    // The long referrer is trimmed on screen but recoverable on hover.
    const titles = [...svg.querySelectorAll("title")].map((t) => t.textContent ?? "");
    expect(titles.some((t) => t.includes("a-very-long-referrer-hostname.example.com"))).toBe(true);
    expect(svg.textContent).toContain("…");
  });

  it("only the lopsided case grows — an even spread keeps the chart it always had", async () => {
    // The columns fill a 560px band whatever the data; the extra height exists solely to
    // absorb minimum-height nodes. So an even spread must NOT get taller, or the fix would
    // be quietly stretching every chart on every site.
    const even = open(
      RANGE({
        entries: [
          { source: "direct", path: "/", count: 100 },
          { source: "google.com", path: "/", count: 90 },
          { source: "bing.com", path: "/pricing", count: 80 },
        ],
        edges: [
          { from: "/", to: "/pricing", count: 90 },
          { from: "/pricing", to: "/contact", count: 80 },
        ],
      }),
    );
    await settle();
    const flat = viewBox(card(even, "Traffic flow").querySelector("svg") as unknown as SVGSVGElement).h;
    even.close();

    const win = open();
    await settle();
    const skewed = viewBox(card(win, "Traffic flow").querySelector("svg") as unknown as SVGSVGElement).h;

    expect(flat).toBeLessThanOrEqual(572); // 560 band + bottom margin, as before
    expect(skewed).toBeGreaterThan(flat); // the tail of small sources earned its room
  });
});

describe("chart values without a pointer (touch)", () => {
  it("'Views by hour' carries a vertical scale, so a column reads without touching it", async () => {
    const win = open();
    await settle();
    const svg = card(win, "Views by hour").querySelector("svg")!;
    const labels = [...svg.querySelectorAll("text")].map((t) => t.textContent);
    // 0 / half / max of the busiest hour (300).
    expect(labels).toContain("0");
    expect(labels).toContain("150");
    expect(labels).toContain("300");
  });

  it("and names the busiest hour before anyone interacts at all", async () => {
    const win = open();
    await settle();
    expect(card(win, "Views by hour").querySelector(".readout")!.textContent).toBe("Busiest 14:00 UTC — 300 views");
  });

  it("tapping a column writes its value into the card — the phone case", async () => {
    const win = open();
    await settle();
    const c = card(win, "Views by hour");
    const cols = [...c.querySelectorAll("rect.col")];
    expect(cols.length).toBe(24);

    col(cols, 9).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(c.querySelector(".readout")!.textContent).toBe("09:00 UTC — 120 views");
    expect(col(cols, 9).getAttribute("class")).toContain("sel"); // the cursor stays put after the finger lifts
  });

  it("a quiet hour is as tappable as a busy one — the hit area is the whole column", async () => {
    const win = open();
    await settle();
    const c = card(win, "Views by hour");
    const cols = [...c.querySelectorAll("rect.col")];

    // Hour 1 recorded nothing: its drawn bar has zero height, so only a full-height
    // hit area makes it reachable at all.
    expect(Number(col(cols, 1).getAttribute("height"))).toBeGreaterThan(100);
    col(cols, 1).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(c.querySelector(".readout")!.textContent).toBe("01:00 UTC — 0 views");
  });

  it("only one column is highlighted at a time", async () => {
    const win = open();
    await settle();
    const c = card(win, "Views by hour");
    const cols = [...c.querySelectorAll("rect.col")];
    col(cols, 3).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    col(cols, 14).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(c.querySelectorAll("rect.col.sel").length).toBe(1);
    expect(col(cols, 14).getAttribute("class")).toContain("sel");
  });

  it("'Right now' works the same way, and shows what its tallest bar is worth", async () => {
    const win = open();
    await settle();
    const c = card(win, "Right now");
    expect(c.querySelector("svg")!.textContent).toContain("40/min"); // the scale line
    expect(c.querySelector(".readout")!.textContent).toBe("Tap a minute for its count");

    const cols = [...c.querySelectorAll("rect.col")];
    expect(cols.length).toBe(30);
    col(cols, 12).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(c.querySelector(".readout")!.textContent).toBe("14:12 UTC — 40 views");
  });

  it("hovering does it too, so a desktop mouse loses nothing", async () => {
    const win = open();
    await settle();
    const c = card(win, "Views by hour");
    const cols = [...c.querySelectorAll("rect.col")];
    col(cols, 14).dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));
    expect(c.querySelector(".readout")!.textContent).toBe("14:00 UTC — 300 views");
  });

  it("the readouts survive a range change — handlers are bound once, not once per render", async () => {
    // #detail outlives every render, so a per-render addEventListener stacked up: after
    // three renders one CSV click downloaded three files. Re-render, then check a single fire.
    const win = open();
    await settle();
    (win.document.querySelector('.tab[data-d="1"]') as HTMLElement).click();
    await settle();

    let downloads = 0;
    win.URL.createObjectURL = () => "blob:stub";
    win.URL.revokeObjectURL = () => {};
    win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) downloads++;
    };
    (win.document.querySelector("[data-csv]") as HTMLElement).click();
    expect(downloads).toBe(1);

    const c = card(win, "Views by hour");
    (c.querySelectorAll("rect.col")[14] as unknown as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    expect(c.querySelector(".readout")!.textContent).toBe("14:00 UTC — 300 views");
  });

  it("says so plainly when there is nothing to read yet", async () => {
    const win = open(RANGE({ hours: Array(24).fill(0) }));
    await settle();
    expect(card(win, "Views by hour").querySelector(".readout")!.textContent).toBe("No views recorded yet");
  });
});
