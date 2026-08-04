import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { api } from "./api";
import type { DeploymentStatus } from "./types";

vi.mock("./api", () => ({
  api: {
    status: vi.fn(),
    meta: vi.fn(),
    deploy: vi.fn(),
    listSites: vi.fn(),
    listViewers: vi.fn(),
    edgeStatus: vi.fn(),
  },
}));

vi.mock("./host", async () => {
  const actual = await vi.importActual<typeof import("./host")>("./host");
  return {
    ...actual,
    host: {
      getConnection: vi.fn().mockResolvedValue({ id: "c1", status: "approved" }),
      ensureAccess: vi.fn().mockResolvedValue("granted"),
      isPurchased: vi.fn().mockResolvedValue(false),
      purchaseInfo: vi.fn().mockResolvedValue({ price: null, owned: false }),
      buyProduct: vi.fn(),
      manageSubscription: vi.fn(),
    },
  };
});

const mocked = api as unknown as {
  status: ReturnType<typeof vi.fn>;
  meta: ReturnType<typeof vi.fn>;
  deploy: ReturnType<typeof vi.fn>;
  listSites: ReturnType<typeof vi.fn>;
  listViewers: ReturnType<typeof vi.fn>;
  edgeStatus: ReturnType<typeof vi.fn>;
};

const ready = (over: Partial<DeploymentStatus> = {}): DeploymentStatus => ({
  phase: "ready",
  stackName: "TrafficPoppyStack",
  region: "eu-west-1",
  inProgress: false,
  currentTemplateKey: "template-new",
  deployedTemplateKey: "template-old",
  updateAvailable: false,
  collectorUrl: "https://abc.lambda-url.eu-west-1.on.aws/",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocked.meta.mockResolvedValue({ account: { region: "eu-west-1", accountId: "1" }, connectionId: "c1" });
  mocked.listSites.mockResolvedValue({ sites: [] });
  mocked.listViewers.mockResolvedValue({ viewers: [] });
  mocked.edgeStatus.mockResolvedValue({ edges: [] });
});

/**
 * Regression cover for a bug that hid for several phases: the backend reported
 * `updateAvailable` from P1 onward, but NOTHING rendered it outside the technical details
 * panel — so a deployment missing new features looked broken rather than merely out of date.
 */
describe("the update banner", () => {
  it("tells the owner when their AWS setup is behind this version", async () => {
    mocked.status.mockResolvedValue(ready({ updateAvailable: true }));
    render(<App />);
    expect(await screen.findByText(/An update is ready for your AWS setup/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /update now/i })).toBeInTheDocument();
  });

  it("reassures that data and snippets survive the update", async () => {
    mocked.status.mockResolvedValue(ready({ updateAvailable: true }));
    render(<App />);
    expect(await screen.findByText(/data and your tracking snippets are/i)).toBeInTheDocument();
  });

  it("applies the update through the normal deploy path", async () => {
    const user = userEvent.setup();
    mocked.status.mockResolvedValue(ready({ updateAvailable: true }));
    mocked.deploy.mockResolvedValue({ operation: "UPDATE", stackName: "TrafficPoppyStack" });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /update now/i }));
    await waitFor(() => expect(mocked.deploy).toHaveBeenCalled());
  });

  it("stays out of the way when the deployment is already current", async () => {
    mocked.status.mockResolvedValue(ready({ updateAvailable: false }));
    render(<App />);
    await screen.findByText(/TrafficPoppy is set up/i);
    expect(screen.queryByRole("button", { name: /update now/i })).not.toBeInTheDocument();
  });
});

/**
 * Founder feedback 2026-08-04: with several sites configured, Team access and True Reach
 * sat below the fold and were "almost invisible". The ready screen is now tabbed — but the
 * inactive panels must stay MOUNTED (hidden, not removed): True Reach's polling feeds the
 * per-site snippet origins, and unmounting mid-DNS-validation would freeze that flow.
 */
describe("the section tabs", () => {
  const openApp = async () => {
    mocked.status.mockResolvedValue(ready());
    render(<App />);
    await screen.findByText(/TrafficPoppy is set up/i);
  };

  it("shows three tabs — sites first, Team access to the RIGHT of Advanced stats", async () => {
    await openApp();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(" 🔒", ""))).toEqual([
      "Your sites",
      "Advanced stats",
      "Team access",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("keeps inactive panels MOUNTED so True Reach polling survives tab switches", async () => {
    await openApp();
    // Never unmounted: the edge status was fetched even though the tab wasn't opened.
    await waitFor(() => expect(mocked.edgeStatus).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: /Team access/i, hidden: true })).toBeInTheDocument();
  });
});

/**
 * Founder decision 2026-08-04 (reverting a brief merge): Team access is its own tab, but
 * LOCKED until Advanced Stats is active — inviting people to a dashboard they can't open
 * activates a service they cannot use. The locked tab still responds to a press: it
 * explains itself in a modal (a dead control reads as broken — founder UX rule).
 */
describe("the Team access lock", () => {
  const openApp = async () => {
    mocked.status.mockResolvedValue(ready());
    render(<App />);
    await screen.findByText(/TrafficPoppy is set up/i);
  };

  it("locked without a subscription: pressing the tab explains instead of switching", async () => {
    await openApp(); // edgeStatus default: no edges
    const teamTab = screen.getByRole("tab", { name: /Team access/i });
    expect(teamTab).toHaveAttribute("aria-disabled", "true");

    await userEvent.setup().click(teamTab);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/To set up a team, Advanced Stats must be activated/i)).toBeInTheDocument();
    // Still on the sites tab — the press explained, it didn't navigate.
    expect(screen.getByRole("tab", { name: /Your sites/i })).toHaveAttribute("aria-selected", "true");
  });

  it("the modal's primary action leads to Advanced stats (never a dead end)", async () => {
    await openApp();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Team access/i }));
    await user.click(await screen.findByRole("button", { name: /open advanced stats/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Advanced stats/i })).toHaveAttribute("aria-selected", "true");
  });

  it("unlocked once a domain is live: the tab opens Team access normally", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edges: [{ phase: "ready", domain: "stats.ollydigital.com", records: [], inProgress: false }],
    });
    await openApp();
    const teamTab = await screen.findByRole("tab", { name: /^Team access$/i });
    await waitFor(() => expect(teamTab).not.toHaveAttribute("aria-disabled"));

    await userEvent.setup().click(teamTab);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Team access/i })).toBeVisible();
  });
});
