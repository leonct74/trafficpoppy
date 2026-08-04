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

  it("shows all three sections as tabs, with sites first", async () => {
    await openApp();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Your sites", "Team access", "True Reach"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("hides Team access and True Reach until their tab is picked", async () => {
    await openApp();
    // hidden: true reaches into the hidden panel — visible queries must NOT find it.
    expect(screen.queryByRole("heading", { name: /Team access/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Team access/i, hidden: true })).not.toBeVisible();
    await userEvent.setup().click(screen.getByRole("tab", { name: /Team access/i }));
    expect(screen.getByRole("heading", { name: /Team access/i })).toBeVisible();
  });

  it("keeps inactive panels MOUNTED so True Reach polling survives tab switches", async () => {
    await openApp();
    // Never unmounted: the edge status was fetched even though the tab wasn't opened.
    await waitFor(() => expect(mocked.edgeStatus).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: /Team access/i, hidden: true })).toBeInTheDocument();
  });
});
