import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrueReach } from "./TrueReach";
import { api } from "./api";
import type { EdgeStatus } from "./types";

vi.mock("./api", () => ({
  api: { edgeStatus: vi.fn(), edgeDeploy: vi.fn(), edgeRemove: vi.fn() },
}));

const mocked = api as unknown as {
  edgeStatus: ReturnType<typeof vi.fn>;
  edgeDeploy: ReturnType<typeof vi.fn>;
};

const edge = (over: Partial<EdgeStatus>): EdgeStatus => ({
  phase: "none",
  records: [],
  inProgress: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TrueReach card", () => {
  it("pitches the tier and takes a hostname when nothing is deployed", async () => {
    mocked.edgeStatus.mockResolvedValue({ edge: edge({ phase: "none" }) });
    render(<TrueReach suggestedDomain="stats.ollydigital.com" />);
    expect(await screen.findByText(/country statistics/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("stats.ollydigital.com")).toBeInTheDocument();

    mocked.edgeDeploy.mockResolvedValue({ operation: "CREATE" });
    await userEvent.click(screen.getByRole("button", { name: /set up true reach/i }));
    await waitFor(() => expect(mocked.edgeDeploy).toHaveBeenCalledWith("stats.ollydigital.com"));
  });

  it("shows the validation record with copy buttons while ACM waits (resumable by design)", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edge: edge({
        phase: "validating",
        domain: "stats.ollydigital.com",
        inProgress: true,
        records: [
          { purpose: "certificate-validation", name: "_abc.stats.ollydigital.com.", type: "CNAME", value: "_xyz.acm-validations.aws." },
        ],
      }),
    });
    render(<TrueReach />);
    expect(await screen.findByText(/domain-ownership check/i)).toBeInTheDocument();
    expect(screen.getByText("_xyz.acm-validations.aws.")).toBeInTheDocument();
    expect(screen.getByText(/waiting for your dns record/i)).toBeInTheDocument();
    expect(screen.getByText(/even if you close the app/i)).toBeInTheDocument();
  });

  it("when live, shows the pointing record and says snippets now serve first-party", async () => {
    mocked.edgeStatus.mockResolvedValue({
      edge: edge({
        phase: "ready",
        domain: "stats.ollydigital.com",
        distributionDomain: "d1.cloudfront.net",
        records: [
          { purpose: "point-your-domain", name: "stats.ollydigital.com.", type: "CNAME", value: "d1.cloudfront.net" },
        ],
      }),
    });
    render(<TrueReach />);
    expect(await screen.findByText(/point your subdomain/i)).toBeInTheDocument();
    expect(screen.getByText("d1.cloudfront.net")).toBeInTheDocument();
    expect(screen.getByText(/first-party/)).toBeInTheDocument();
  });

  it("reports the live state upward so the sites list can swap snippet origins", async () => {
    const seen: EdgeStatus[] = [];
    mocked.edgeStatus.mockResolvedValue({ edge: edge({ phase: "ready", domain: "stats.ollydigital.com" }) });
    render(<TrueReach onStatus={(e) => seen.push(e)} />);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]!.domain).toBe("stats.ollydigital.com");
  });
});
