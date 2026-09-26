import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../../app/App";

function renderAnalysis() {
  return render(
    <MemoryRouter initialEntries={["/analysis"]}>
      <AppRoutes isAuthenticated={false} initialAuthMode={null} />
    </MemoryRouter>,
  );
}

describe("public price analysis", () => {
  it("rejects a bad ZIP, then reaches read-only dashboard results", async () => {
    const user = userEvent.setup();
    renderAnalysis();

    expect(
      screen.getByRole("navigation", { name: "Primary navigation" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Price analysis" }),
    ).toHaveAttribute("href", "/analysis");
    expect(
      screen.getByRole("heading", {
        name: "Start with your store, request, and ZIP.",
      }),
    ).toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Website"),
      "https://northwind.example",
    );
    await user.type(
      screen.getByLabelText("What should we compare?"),
      "Compare trail running shoes",
    );
    await user.type(screen.getByLabelText("US ZIP"), "abc");
    await user.click(screen.getByRole("button", { name: "Review products" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a US ZIP or ZIP+4",
    );

    await user.clear(screen.getByLabelText("US ZIP"));
    await user.type(screen.getByLabelText("US ZIP"), "02110");
    await user.click(screen.getByRole("button", { name: "Review products" }));

    await user.click(
      screen.getByRole("checkbox", { name: "Confirm Trail Runner" }),
    );
    await user.click(screen.getByRole("button", { name: "Choose platforms" }));
    await user.click(screen.getByRole("checkbox", { name: "Amazon" }));
    await user.click(screen.getByRole("button", { name: "Start analysis" }));

    expect(await screen.findByText("Northline Outfitters")).toBeInTheDocument();
    expect(
      screen.getByText("Parity within 5% ($0.00, 0.0%)"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /remove competitor/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });
});
