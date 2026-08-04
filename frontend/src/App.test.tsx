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
  mocked.edgeStatus.mockResolvedValue({ edge: { phase: "none", records: [], inProgress: false } });
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
