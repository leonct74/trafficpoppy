import { describe, expect, it } from "vitest";
import { trackerScript, trackerHeaders } from "./tracker";

const script = trackerScript("https://abc.lambda-url.eu-west-1.on.aws/");

describe("t.js — the script that runs on the visitor's page", () => {
  it("bakes in the collector origin (trailing slash trimmed) and posts to /e", () => {
    expect(script).toContain('"https://abc.lambda-url.eu-west-1.on.aws/e"');
    expect(script).not.toContain(".on.aws//e");
  });

  it("honors GPC and DNT before doing anything else", () => {
    // The opt-out check must be present and precede any send.
    expect(script).toMatch(/globalPrivacyControl===true/);
    expect(script).toMatch(/doNotTrack==="1"/);
    const optOutAt = script.indexOf("globalPrivacyControl");
    const firstSend = script.indexOf("sendBeacon");
    expect(optOutAt).toBeGreaterThan(-1);
    expect(optOutAt).toBeLessThan(firstSend);
  });

  it("never touches cookies, localStorage, or fingerprinting surfaces", () => {
    expect(script).not.toMatch(/document\.cookie/);
    expect(script).not.toMatch(/localStorage|sessionStorage/);
    expect(script).not.toMatch(/canvas|toDataURL|getImageData/i);
  });

  it("only forwards the query string when an allowlisted utm is present", () => {
    // The full search string rides along ONLY behind the utm_source guard; the server
    // then allowlists it. No utm ⇒ no query string on the wire.
    expect(script).toMatch(/if\(u\.utm_source\)body\.q=w\.location\.search/);
    expect(script).not.toMatch(/body\.q=w\.location\.search;var/); // not unconditional
  });

  it("hooks History API + popstate so SPA navigations are counted", () => {
    expect(script).toMatch(/pushState/);
    expect(script).toMatch(/replaceState/);
    expect(script).toMatch(/popstate/);
  });

  it("stays small — the whole point is a ~1 KB tag", () => {
    expect(script.length).toBeLessThan(2048);
  });

  it("is served as javascript with a day of caching", () => {
    const h = trackerHeaders();
    expect(h["content-type"]).toMatch(/javascript/);
    expect(h["cache-control"]).toMatch(/max-age=86400/);
  });
});
