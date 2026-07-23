import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Integrate } from "./Integrate";

const site = { id: "Cb2Md6_7RV85", name: "Olly Digital", domain: "ollydigital.com", createdAt: "2026-07-21" };

function renderIt(onBack = vi.fn()) {
  render(<Integrate site={site} region="eu-west-1" tableName="TrafficPoppyData" onBack={onBack} />);
  return onBack;
}

describe("Integrate — the your-data-is-yours screen", () => {
  it("bakes the real table, region and site id into ready-to-paste examples", () => {
    renderIt();
    const pres = screen.getAllByText(/aws dynamodb query/i);
    expect(pres.length).toBeGreaterThan(0);
    // Every example must be runnable as-is: real identifiers, no placeholders to fill in.
    expect(screen.getAllByText(new RegExp(site.id)).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/TrafficPoppyData/).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/eu-west-1/).length).toBeGreaterThan(1);
  });

  it("documents the row shapes, including the self-deleting live-ticker rows", () => {
    renderIt();
    // total#views appears in the row-shapes table AND the Node snippet's sample output.
    expect(screen.getAllByText(/total#views/).length).toBeGreaterThan(0);
    expect(screen.getByText(/self-delete after 2 h/i)).toBeInTheDocument();
  });

  it("says the private internals expire by design — the privacy story travels with the schema", () => {
    renderIt();
    expect(screen.getByText(/expire on their own/i)).toBeInTheDocument();
  });

  it("surfaces the abuse cap — the bill is bounded even if the public endpoint is spammed", () => {
    renderIt();
    expect(screen.getByText(/100,000 views\/site\/day/)).toBeInTheDocument();
  });

  it("offers a copy button per snippet and a way back to the dashboard", async () => {
    const onBack = renderIt();
    expect(screen.getAllByRole("button", { name: /copy/i }).length).toBeGreaterThanOrEqual(3);
    await userEvent.click(screen.getByRole("button", { name: /back to the dashboard/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
