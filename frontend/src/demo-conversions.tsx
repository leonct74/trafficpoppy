// Screenshot harness (not shipped): renders the REAL Conversions tracker against a
// fictional coffee shop, so marketing shots are of the actual UI and never of real traffic.
// Run: npx vite --config vite.config.ts  →  /demo.html#state=<empty|configured>
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { Conversions } from "./Conversions";
import "./poppy.css";
import "./theme.css";
import type { RangeStats, Site } from "./types";

const configured = !location.hash.includes("empty");

const sites: Site[] = [
  {
    id: "demo",
    name: "Roasted Bean Co",
    domain: "roastedbean.co",
    createdAt: "2026-06-01",
    goals: configured
      ? [
          { name: "checkout-complete", kind: "page", path: "/order/thank-you", createdAt: "2026-07-02" },
          { name: "add-to-basket", kind: "event", createdAt: "2026-07-02" },
        ]
      : [],
  },
  { id: "demo2", name: "Bean Journal", domain: "beanjournal.blog", createdAt: "2026-06-04" },
];

const range = {
  siteId: "demo",
  from: "2026-07-09",
  to: "2026-08-07",
  days: [],
  views: 10945,
  uniques: 6765,
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
  goals: [
    { name: "checkout-complete", kind: "page", path: "/order/thank-you", conversions: 604, converters: 561, prevConversions: 470 },
    { name: "add-to-basket", kind: "event", conversions: 2318, converters: 1402, prevConversions: 2510 },
  ],
  entries: [],
  edges: [],
  receiving: true,
} as unknown as RangeStats;

api.listSites = async () => ({ sites });
api.rangeStats = async () => ({ range });
api.updateSiteGoals = async (_id: string, goals) => ({ goals });

createRoot(document.getElementById("root")!).render(
  <div className="app" style={{ padding: 18 }}>
    <Conversions onlineDomains={["stats.roastedbean.co"]} paidDomains={["roastedbean.co"]} />
  </div>,
);
