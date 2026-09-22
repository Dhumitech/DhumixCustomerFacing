import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformStatusNotice } from "./PlatformStatusNotice";

function renderNotice() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlatformStatusNotice />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("customer-safe platform status", () => {
  it("shows the scraper-library projection without provider details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              state: "operational",
              products: [
                {
                  family: "scraper_library",
                  state: "operational",
                  updated_at: "2026-09-01T00:00:00.000Z",
                },
                {
                  family: "marketplace_dataset",
                  state: "not_enabled",
                  updated_at: "2026-09-01T00:00:00.000Z",
                },
              ],
              updated_at: "2026-09-01T00:00:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    renderNotice();

    expect(await screen.findByText("Scrapers Operational")).toBeInTheDocument();
    expect(screen.queryByText(/bright data/i)).not.toBeInTheDocument();
  });

  it("shows the Marketplace projection when requested by a Marketplace page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              state: "operational",
              products: [
                {
                  family: "scraper_library",
                  state: "operational",
                  updated_at: "2026-09-01T00:00:00.000Z",
                },
                {
                  family: "marketplace_dataset",
                  state: "operational",
                  updated_at: "2026-09-01T00:00:00.000Z",
                },
              ],
              updated_at: "2026-09-01T00:00:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <PlatformStatusNotice family="marketplace_dataset" />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Marketplace Operational"),
    ).toBeInTheDocument();
  });

  it("fails to a customer-safe unavailable label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    renderNotice();
    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
  });

  it("rejects a successful response that does not match the status contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    renderNotice();

    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
  });
});
