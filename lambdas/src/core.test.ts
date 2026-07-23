import { describe, expect, it } from "vitest";
import {
  allowlistedUtm,
  browserFamily,
  counterKeys,
  isDoNotTrack,
  normalize,
  normalizePath,
  osFamily,
  referrerHost,
  sizeBucket,
  type RawEvent,
  type RequestContext,
} from "./core";

const track: RequestContext = { doNotTrack: false, userAgent: undefined };

describe("privacy invariant: opt-out means count NOTHING (DESIGN.md §6)", () => {
  it("returns null under GPC/DNT, so no counter is ever built", () => {
    const raw: RawEvent = { s: "abc123", p: "/pricing" };
    expect(normalize(raw, { doNotTrack: true })).toBeNull();
  });

  it("reads GPC and DNT from headers, case-insensitively", () => {
    expect(isDoNotTrack({ "Sec-GPC": "1" })).toBe(true);
    expect(isDoNotTrack({ "sec-gpc": "1" })).toBe(true);
    expect(isDoNotTrack({ DNT: "1" })).toBe(true);
    expect(isDoNotTrack({ dnt: "1" })).toBe(true);
    expect(isDoNotTrack({ DNT: "0" })).toBe(false);
    expect(isDoNotTrack({})).toBe(false);
  });
});

describe("privacy invariant: referrer reduced to hostname only", () => {
  it("keeps only the hostname — the query string (which can carry tokens) is dropped", () => {
    expect(referrerHost("https://mail.google.com/mail/u/0/?token=SECRET#inbox")).toBe("mail.google.com");
  });

  it("strips a leading www.", () => {
    expect(referrerHost("https://www.example.com/x")).toBe("example.com");
  });

  it("treats a same-site referrer as internal navigation (undefined)", () => {
    expect(referrerHost("https://shop.example.com/a", "shop.example.com")).toBeUndefined();
  });

  it("returns undefined for direct visits and junk", () => {
    expect(referrerHost("")).toBeUndefined();
    expect(referrerHost("not a url")).toBeUndefined();
    expect(referrerHost(undefined)).toBeUndefined();
  });
});

describe("privacy invariant: utm allowlisted to exactly source/medium/campaign", () => {
  it("keeps the three allowed keys and drops everything else", () => {
    const utm = allowlistedUtm("?utm_source=news&utm_medium=email&utm_campaign=spring&utm_term=SECRET&gclid=XYZ&fbclid=Z");
    expect(utm).toEqual({ utm_source: "news", utm_medium: "email", utm_campaign: "spring" });
    expect(utm).not.toHaveProperty("utm_term");
  });

  it("handles a query string with or without the leading ?", () => {
    expect(allowlistedUtm("utm_source=x")).toEqual({ utm_source: "x" });
    expect(allowlistedUtm("")).toEqual({});
  });
});

describe("privacy invariant: UA reduced to a coarse family, never stored raw", () => {
  const chrome =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  const safari =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const edge = chrome.replace("Chrome/120.0 Safari/537.36", "Chrome/120.0 Safari/537.36 Edg/120.0");
  const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0";
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  it("classifies browsers, not mistaking Chrome's 'Safari' token or Edge's 'Chrome' token", () => {
    expect(browserFamily(chrome)).toBe("Chrome");
    expect(browserFamily(safari)).toBe("Safari");
    expect(browserFamily(edge)).toBe("Edge"); // must beat Chrome
    expect(browserFamily(firefox)).toBe("Firefox");
    expect(browserFamily("something weird")).toBe("Other");
  });

  it("classifies OS families", () => {
    expect(osFamily(chrome)).toBe("Windows");
    expect(osFamily(safari)).toBe("macOS");
    expect(osFamily(firefox)).toBe("Linux");
    expect(osFamily(iphone)).toBe("iOS");
    expect(osFamily(undefined)).toBe("Other");
  });
});

describe("viewport is bucketed, never the exact pixel width", () => {
  it("bands widths into device classes", () => {
    expect(sizeBucket(375)).toBe("mobile");
    expect(sizeBucket(800)).toBe("tablet");
    expect(sizeBucket(1440)).toBe("laptop");
    expect(sizeBucket(2560)).toBe("desktop");
    expect(sizeBucket(0)).toBe("unknown");
    expect(sizeBucket("nope")).toBe("unknown");
  });
});

describe("path normalization", () => {
  it("keeps the pathname and strips any embedded query/hash", () => {
    expect(normalizePath("/pricing?utm_source=x#top")).toBe("/pricing");
    expect(normalizePath("pricing")).toBe("/pricing");
    expect(normalizePath("")).toBeUndefined();
  });
});

describe("normalize — the gate before anything is counted", () => {
  it("rejects events with no site id or no path", () => {
    expect(normalize({ p: "/x" }, track)).toBeNull();
    expect(normalize({ s: "abc" }, track)).toBeNull();
  });

  it("rejects a site id that isn't an opaque token (defends the key space)", () => {
    expect(normalize({ s: "a b/c", p: "/x" }, track)).toBeNull();
    expect(normalize({ s: "site#injection", p: "/x" }, track)).toBeNull();
  });

  it("produces a fully reduced event for a good request", () => {
    const raw: RawEvent = {
      s: "aB3xYz",
      p: "/blog/post",
      q: "?utm_source=hn&utm_term=drop",
      r: "https://news.ycombinator.com/item?id=1",
      w: 1440,
    };
    const ev = normalize(raw, {
      doNotTrack: false,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/121.0",
    });
    expect(ev).toEqual({
      siteId: "aB3xYz",
      path: "/blog/post",
      referrerHost: "news.ycombinator.com",
      browser: "Firefox",
      os: "macOS",
      size: "laptop",
      utm: { utm_source: "hn" },
    });
  });
});

describe("country — CloudFront-derived, country-level only (True Reach tier)", () => {
  it("keeps a valid two-letter code and counts it", () => {
    const ev = normalize({ s: "s1", p: "/x" }, { ...track, country: "IT" })!;
    expect(ev.country).toBe("IT");
    expect(counterKeys(ev, "2026-07-23").some((k) => k.sk === "country#IT")).toBe(true);
  });

  it("drops junk, lowercase, unknown-country and absent values — never guesses", () => {
    for (const bad of ["ZZ", "it", "ITA", "1x", "", undefined]) {
      const ev = normalize({ s: "s1", p: "/x" }, { ...track, country: bad as string | undefined })!;
      expect(ev.country, `country=${String(bad)}`).toBeUndefined();
    }
  });
});

describe("counterKeys — the rows one pageview increments (DESIGN.md §2)", () => {
  const ev = normalize(
    { s: "s1", p: "/x", r: "https://t.co/a", q: "utm_source=tw", w: 400 },
    { doNotTrack: false, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari/604.1" },
  )!;

  it("increments total, page, browser, os, size, referrer and utm — all in one partition", () => {
    const keys = counterKeys(ev, "2026-07-18");
    const sks = keys.map((k) => k.sk);
    expect(sks).toContain("total#views");
    expect(sks).toContain("page#/x");
    expect(sks).toContain("browser#Safari");
    expect(sks).toContain("os#iOS");
    expect(sks).toContain("size#mobile");
    expect(sks).toContain("ref#t.co");
    expect(sks).toContain("utm_source#tw");
    expect(new Set(keys.map((k) => k.pk))).toEqual(new Set(["site#s1#day#2026-07-18"]));
  });

  it("omits the referrer row for a direct visit", () => {
    const direct = normalize({ s: "s1", p: "/x", w: 400 }, { doNotTrack: false })!;
    expect(counterKeys(direct, "2026-07-18").map((k) => k.sk)).not.toContain("ref#");
  });
});
