// Robots are not visitors (founder 2026-08-09).
//
// A download button reported 31 conversions from 23 "visitors" in a week when the
// destination store saw almost nothing. Nothing in the pipeline had ever rejected an
// automated client: a headless scanner loads the page and fires the click handler, and we
// counted it as a person converting.
//
// The two halves of this file matter equally. Catching bots is the feature; NOT catching
// people is the safety property, because a false positive deletes a real visit and the
// owner has no way to discover it.

import { describe, expect, it } from "vitest";
import { isAutomated, normalize } from "./core";

const ctx = (userAgent: string) => ({ userAgent, doNotTrack: false });
const view = { s: "site1", p: "/download" };
const goal = { s: "site1", p: "/download", g: "download-win" };

describe("clients that must NOT be counted", () => {
  const bots: Record<string, string> = {
    "Googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Bingbot": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "AhrefsBot": "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    "GPTBot": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "PerplexityBot": "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/bot)",
    "Facebook unfurler": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    "Slack unfurler": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Headless Chrome": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
    "Playwright": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 playwright/1.44",
    "Lighthouse": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome-Lighthouse",
    "UptimeRobot": "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
    "curl": "curl/8.4.0",
    "Python requests": "python-requests/2.31.0",
    "Go client": "Go-http-client/2.0",
    "a generic crawler": "SomeCorp Crawler (+https://example.com/crawl)",
    "a bot we have never heard of": "BrandNewThingBot/1.0 (+https://example.com)",
  };

  for (const [name, ua] of Object.entries(bots)) {
    it(`${name} is automation`, () => expect(isAutomated(ua)).toBe(true));
  }

  it("a crawler's page view is counted as nothing at all", () => {
    expect(normalize(view, ctx(bots["Googlebot"]!))).toBeNull();
  });

  it("and neither is its CLICK — the number this bug was inflating", () => {
    // The whole reason the filter sits above the goal branch in normalize().
    expect(normalize(goal, ctx(bots["Headless Chrome"]!))).toBeNull();
  });
});

describe("people who must STILL be counted", () => {
  const humans: Record<string, string> = {
    "Chrome on Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Edge on Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    "Safari on macOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Safari on iPhone": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Firefox on Linux": "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Samsung Internet": "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    // The false positive a naive /bot/ would cause: a real phone, a real person, whose
    // model name simply ends in BOT. They would vanish from the owner's stats silently.
    "someone on a Cubot phone": "Mozilla/5.0 (Linux; Android 12; CUBOT NOTE 20 Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36",
    // In-app browsers are people reading in an app, NOT the server-side link unfurlers.
    "someone inside the WhatsApp browser": "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 WhatsApp/2.24",
    "someone inside the Instagram browser": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Instagram 335.0.0.32.99",
    "someone inside the Facebook app": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/468.0.0.35.107]",
    "an Electron-based desktop app": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/30.0.6 Safari/537.36",
  };

  for (const [name, ua] of Object.entries(humans)) {
    it(`${name} is not automation`, () => expect(isAutomated(ua)).toBe(false));
  }

  it("their page view is still counted", () => {
    expect(normalize(view, ctx(humans["Chrome on Windows"]!))).not.toBeNull();
  });

  it("their conversion is still counted", () => {
    expect(normalize(goal, ctx(humans["someone on a Cubot phone"]!))?.goal).toBe("download-win");
  });
});

describe("the conservative edges", () => {
  it("a MISSING user-agent is counted, not dropped", () => {
    // Suspicious, but a header can go missing without it being the visitor's fault, and a
    // wrong drop is invisible to the owner. Prefer missing a bot to inventing one.
    expect(isAutomated(undefined)).toBe(false);
    expect(isAutomated("")).toBe(false);
    expect(normalize(view, ctx(""))).not.toBeNull();
  });

  it("the opt-out still wins over everything", () => {
    expect(normalize(view, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/126", doNotTrack: true })).toBeNull();
  });
});
