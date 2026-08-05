import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyButton, copyText } from "./CopyButton";

/**
 * Live lesson 2026-08-06: a DNS validation record pasted with ONE leading space was
 * stored by Route 53 as a different name (`\040_3d47…`), served NXDOMAIN, and looked
 * perfectly normal in every UI while it cost a whole debugging session. Whatever a user
 * copies from TrafficPoppy must never carry surrounding whitespace.
 */
describe("copyText never copies surrounding whitespace", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("trims what it writes to the clipboard", async () => {
    await copyText("  _3d47.stats.agentspoppy.com. \n");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("_3d47.stats.agentspoppy.com.");
  });

  it("the button copies the trimmed text too", async () => {
    render(<CopyButton text={"  value-with-space  "} label="Name" />);
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("value-with-space"));
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });
});
