import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Viewers } from "./Viewers";
import { api } from "./api";

vi.mock("./api", () => ({
  api: {
    listViewers: vi.fn(),
    listSites: vi.fn(),
    inviteViewer: vi.fn(),
    setViewerGrants: vi.fn(),
    removeViewer: vi.fn(),
  },
}));

const mocked = api as unknown as {
  listViewers: ReturnType<typeof vi.fn>;
  listSites: ReturnType<typeof vi.fn>;
  inviteViewer: ReturnType<typeof vi.fn>;
  setViewerGrants: ReturnType<typeof vi.fn>;
  removeViewer: ReturnType<typeof vi.fn>;
};

const SITES = [
  { id: "aaa", name: "Client A", domain: "a.com", createdAt: "2026-07-01" },
  { id: "bbb", name: "Client B", domain: "b.com", createdAt: "2026-07-02" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listSites.mockResolvedValue({ sites: SITES });
  mocked.listViewers.mockResolvedValue({ viewers: [] });
});

const url = "https://viewer.lambda-url.eu-west-1.on.aws/";

describe("when the deployment predates team access", () => {
  it("offers the update instead of showing an error", () => {
    render(<Viewers canManage={false} />);
    expect(screen.getByText(/Update your deployment/i)).toBeInTheDocument();
    expect(mocked.listViewers).not.toHaveBeenCalled();
  });
});

describe("the team list", () => {
  it("shows the dashboard link so the owner can share it", async () => {
    render(<Viewers canManage onlineActive viewerUrl={url} />);
    const link = await screen.findByRole("link", { name: /open dashboard/i });
    expect(link).toHaveAttribute("href", url);
  });

  it("says plainly when nobody is invited yet", async () => {
    render(<Viewers canManage onlineActive />);
    expect(await screen.findByText(/Nobody has been invited yet/i)).toBeInTheDocument();
  });

  it("behind the paywall: no link, no invite form, and the upgrade is explained", async () => {
    // Founder, 2026-08-04: inviting people to a dashboard they can't open activates a
    // service they cannot use — the whole flow waits for the tier.
    render(<Viewers canManage />);
    expect(await screen.findByText(/part of the/i)).toBeInTheDocument();
    expect(screen.getByText(/stay visible in this app only/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open dashboard/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send invite/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/colleague@example.com/i)).not.toBeInTheDocument();
  });

  it("a lapsed tier still lets the owner MANAGE existing viewers — just not invite new ones", async () => {
    mocked.listViewers.mockResolvedValue({
      viewers: [{ email: "old@x.com", status: "CONFIRMED", allSites: true, siteIds: [] }],
    });
    render(<Viewers canManage />);
    // The person is listed with their controls…
    expect(await screen.findByText("old@x.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
    // …but no new accounts can be activated.
    expect(screen.queryByRole("button", { name: /send invite/i })).not.toBeInTheDocument();
  });

  it("distinguishes a pending invite from an active account", async () => {
    mocked.listViewers.mockResolvedValue({
      viewers: [
        { email: "new@x.com", status: "FORCE_CHANGE_PASSWORD", allSites: false, siteIds: ["aaa"] },
        { email: "old@x.com", status: "CONFIRMED", allSites: true, siteIds: [] },
      ],
    });
    render(<Viewers canManage onlineActive />);
    expect(await screen.findByText("Invite sent")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("summarises access by SITE NAME, not opaque ids", async () => {
    mocked.listViewers.mockResolvedValue({
      viewers: [{ email: "a@x.com", status: "CONFIRMED", allSites: false, siteIds: ["aaa"] }],
    });
    render(<Viewers canManage onlineActive />);
    expect(await screen.findByText("Client A")).toBeInTheDocument();
  });
});

describe("inviting", () => {
  it("defaults to all sites and sends the invite", async () => {
    const user = userEvent.setup();
    mocked.inviteViewer.mockResolvedValue({ viewer: { email: "new@x.com" } });
    render(<Viewers canManage onlineActive />);

    await user.type(await screen.findByPlaceholderText(/colleague@example.com/i), "New@X.com");
    await user.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() =>
      expect(mocked.inviteViewer).toHaveBeenCalledWith("New@X.com", { allSites: true, siteIds: [] }),
    );
    expect(await screen.findByText(/temporary password/i)).toBeInTheDocument();
  });

  it("can grant only specific sites (the agency case)", async () => {
    const user = userEvent.setup();
    mocked.inviteViewer.mockResolvedValue({ viewer: { email: "client@x.com" } });
    render(<Viewers canManage onlineActive />);

    await user.type(await screen.findByPlaceholderText(/colleague@example.com/i), "client@x.com");
    await user.click(screen.getByLabelText(/Only the sites I pick/i));
    await user.click(await screen.findByLabelText(/Client A/i));
    await user.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() =>
      expect(mocked.inviteViewer).toHaveBeenCalledWith("client@x.com", { allSites: false, siteIds: ["aaa"] }),
    );
  });

  it("won't let you invite someone to nothing", async () => {
    const user = userEvent.setup();
    render(<Viewers canManage onlineActive />);
    await user.type(await screen.findByPlaceholderText(/colleague@example.com/i), "x@x.com");
    await user.click(screen.getByLabelText(/Only the sites I pick/i));
    expect(screen.getByRole("button", { name: /send invite/i })).toBeDisabled();
  });

  it("surfaces a rejected invite instead of failing silently", async () => {
    const user = userEvent.setup();
    mocked.inviteViewer.mockRejectedValue(new Error("That email is already invited."));
    render(<Viewers canManage onlineActive />);
    await user.type(await screen.findByPlaceholderText(/colleague@example.com/i), "dupe@x.com");
    await user.click(screen.getByRole("button", { name: /send invite/i }));
    expect(await screen.findByText(/already invited/i)).toBeInTheDocument();
  });
});

describe("changing and revoking access", () => {
  beforeEach(() => {
    mocked.listViewers.mockResolvedValue({
      viewers: [{ email: "a@x.com", status: "CONFIRMED", allSites: false, siteIds: ["aaa"] }],
    });
  });

  it("saves a changed grant", async () => {
    const user = userEvent.setup();
    mocked.setViewerGrants.mockResolvedValue({ ok: true });
    render(<Viewers canManage onlineActive />);

    await user.click(await screen.findByRole("button", { name: /change access/i }));
    await user.click(await screen.findByLabelText(/Client B/i));
    await user.click(screen.getByRole("button", { name: /save access/i }));

    await waitFor(() =>
      expect(mocked.setViewerGrants).toHaveBeenCalledWith("a@x.com", { allSites: false, siteIds: ["aaa", "bbb"] }),
    );
  });

  it("asks before removing someone, and names them", async () => {
    const user = userEvent.setup();
    mocked.removeViewer.mockResolvedValue({ ok: true });
    render(<Viewers canManage onlineActive />);

    await user.click(await screen.findByRole("button", { name: /^remove$/i }));
    expect(screen.getByText(/Remove a@x.com\?/i)).toBeInTheDocument();
    expect(mocked.removeViewer).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(mocked.removeViewer).toHaveBeenCalledWith("a@x.com"));
  });

  it("lets you back out of a removal", async () => {
    const user = userEvent.setup();
    render(<Viewers canManage onlineActive />);
    await user.click(await screen.findByRole("button", { name: /^remove$/i }));
    await user.click(screen.getByRole("button", { name: /keep/i }));
    expect(mocked.removeViewer).not.toHaveBeenCalled();
  });
});
