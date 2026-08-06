import { describe, expect, it } from "vitest";
import {
  MAX_GOALS,
  normalizeGoalName,
  normalizeGoalPath,
  parseGoals,
  readGoals,
  type Goal,
} from "../../shared/src/goals";
import { reduceRange } from "../../shared/src/range";

describe("goal names — the grammar that keeps a public attribute safe as a sort key", () => {
  it("tidies what people actually type", () => {
    expect(normalizeGoalName("Download")).toBe("download");
    expect(normalizeGoalName(" Buy Now ")).toBe("buy-now");
    expect(normalizeGoalName("newsletter.signup")).toBe("newsletter-signup");
  });

  it("refuses anything that would break the `goal#<name>` key grammar", () => {
    expect(normalizeGoalName("#")).toBeUndefined();
    expect(normalizeGoalName("")).toBeUndefined();
    expect(normalizeGoalName("---")).toBeUndefined();
    expect(normalizeGoalName("a#b")).toBe("ab"); // the '#' is dropped, never stored
    expect(normalizeGoalName(42)).toBeUndefined();
  });

  it("caps the length", () => {
    expect(normalizeGoalName("x".repeat(80))).toHaveLength(40);
  });
});

describe("goal paths", () => {
  it("accepts a pasted URL as readily as a path", () => {
    expect(normalizeGoalPath("https://shop.example.com/thank-you?ref=x")).toBe("/thank-you");
    expect(normalizeGoalPath("thank-you")).toBe("/thank-you");
    expect(normalizeGoalPath("/")).toBe("/");
  });
});

describe("parseGoals — the trusted-side validation (the collector counts nothing else)", () => {
  it("normalizes and keeps both kinds", () => {
    const goals = parseGoals([
      { name: "Download", kind: "event" },
      { name: "thanks", kind: "page", path: "/thank-you" },
    ]);
    expect(goals).toEqual([
      { name: "download", kind: "event" },
      { name: "thanks", kind: "page", path: "/thank-you" },
    ]);
  });

  it("rejects duplicates, unnamed goals and page goals with no page", () => {
    expect(() => parseGoals([{ name: "a", kind: "event" }, { name: "A", kind: "event" }])).toThrow(/already have/i);
    expect(() => parseGoals([{ name: "!!", kind: "event" }])).toThrow(/goal name/i);
    expect(() => parseGoals([{ name: "thanks", kind: "page" }])).toThrow(/which page/i);
  });

  it("holds the per-site limit", () => {
    const many = Array.from({ length: MAX_GOALS + 1 }, (_, i) => ({ name: `g${i}`, kind: "event" }));
    expect(() => parseGoals(many)).toThrow(new RegExp(`${MAX_GOALS} goals`));
  });

  it("a malformed stored value means 'no goals', never a crash on the hot path", () => {
    expect(readGoals("{not json")).toEqual([]);
    expect(readGoals(undefined)).toEqual([]);
    expect(readGoals(JSON.stringify([{ name: "buy", kind: "event" }]))).toEqual([{ name: "buy", kind: "event" }]);
  });
});

describe("reduceRange — how a goal becomes a number (§7e)", () => {
  const goals: Goal[] = [
    { name: "download", kind: "event" },
    { name: "thanks", kind: "page", path: "/thank-you" },
  ];
  const day = [
    { sk: "total#views", count: 100 },
    { sk: "total#uniques", count: 40 },
    { sk: "page#/thank-you", count: 12 },
    { sk: "goal#download", count: 9 },
    { sk: "goalu#download", count: 6 },
    { sk: "goalu#thanks", count: 10 },
  ];

  it("reads an event goal from its own counter, and its distinct converters", () => {
    const r = reduceRange("s1", ["2026-08-07"], [day], [], goals);
    const g = r.goals.find((x) => x.name === "download")!;
    expect(g).toMatchObject({ kind: "event", conversions: 9, converters: 6 });
  });

  it("reads a PAGE goal from the page counter — so it works retroactively", () => {
    // There is no goal#thanks row at all: the page was being counted long before anyone
    // named it a conversion, and naming it must not start the history from zero.
    const r = reduceRange("s1", ["2026-08-07"], [day], [], goals);
    const g = r.goals.find((x) => x.name === "thanks")!;
    expect(g).toMatchObject({ kind: "page", path: "/thank-you", conversions: 12, converters: 10 });
  });

  it("compares with the previous window of the same length", () => {
    const prev = [[{ sk: "goal#download", count: 4 }, { sk: "page#/thank-you", count: 20 }]];
    const r = reduceRange("s1", ["2026-08-07"], [day], prev, goals);
    expect(r.goals.map((g) => g.prevConversions)).toEqual([4, 20]);
  });

  it("is empty for a site with no goals — nothing to explain, nothing to render", () => {
    expect(reduceRange("s1", ["2026-08-07"], [day]).goals).toEqual([]);
  });
});
