import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";
import { RunsWorkspacePage } from "../runs/RunsWorkspacePage";
import { AmazonDomainPage } from "./AmazonDomainPage";
import { WorkspaceLibraryPage } from "./WorkspaceLibraryPage";
import { WorkspaceShell } from "./WorkspaceShell";

const authSession = {
  access_token: "access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "csrf-token",
};

const amazonTemplate = {
  slug: "amazon-products-collect-by-url",
  version: 4,
  family: "scraper_library",
  name: "Amazon products — Collect by URL",
  description: "Amazon products — Collect by URL through Dhumi.",
  availability: "available",
  presentation: {
    domain_slug: "amazon-com",
    domain_name: "amazon.com",
    category: "e-commerce",
    icon_key: "amazon",
    operation_group: "Amazon products",
    operation_name: "Collect by URL",
    display_priority: 100,
  },
  configuration_schema: { type: "object", additionalProperties: false },
  input_schema: {
    type: "object",
    required: ["targets"],
    properties: {
      targets: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri" },
            zipcode: {
              type: "string",
              pattern: "^[0-9]{5}$",
            },
            language: { type: "string", enum: ["EN"] },
            all_variations: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

const controlledLocalTemplate = {
  ...amazonTemplate,
  slug: "pattern4-controlled-local",
  version: 1,
  name: "Pattern 4 controlled local",
  description:
    "Local-only durable execution test. It does not call Bright Data.",
  presentation: {
    ...amazonTemplate.presentation,
    domain_slug: "amazon",
    domain_name: "Amazon",
    category: "web-data",
    operation_group: "Products",
    operation_name: "Pattern 4 controlled local",
    display_priority: 990,
  },
};

const savedService = {
  id: "service-1",
  name: "My Amazon Products Scraper",
  template_slug: amazonTemplate.slug,
  template_version: 4,
  version: 1,
  family: "scraper_library",
  state: "active",
  configuration: {},
  created_at: "2026-09-04T00:00:00.000Z",
};

const legacyService = {
  ...savedService,
  id: "service-v3",
  name: "Existing v3 scraper",
  template_version: 3,
};

const createdService = {
  ...savedService,
  id: "service-2",
  name: "Research collection",
};

const run = {
  id: "run-1",
  service_id: savedService.id,
  status: "running",
  retryable: false,
  created_at: "2026-09-04T00:01:00.000Z",
  updated_at: "2026-09-04T00:02:00.000Z",
};

const runEvents = {
  data: [
    {
      id: "event-1",
      type: "accepted",
      message: "Run accepted.",
      occurred_at: "2026-09-04T00:01:00.000Z",
    },
    {
      id: "event-2",
      type: "started",
      message: "Run started.",
      occurred_at: "2026-09-04T00:02:00.000Z",
    },
  ],
  page: { next_cursor: null, has_more: false },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createBackendFetch() {
  return vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);

    if (url.pathname === "/v1/organizations") return jsonResponse({ can_create: false, organizations: [{ id: "11111111-1111-4111-8111-111111111111", name: "Acme Research", state: "active", role: "admin", is_creator: true }] });
    if (url.pathname === "/v1/workspace") {
      return jsonResponse({
        id: "workspace-1",
        name: "Acme Research",
        state: "active",
        created_at: "2026-09-04T00:00:00.000Z",
      });
    }
    if (url.pathname === "/v1/catalog/templates") {
      return jsonResponse({
        data: [amazonTemplate, controlledLocalTemplate],
        page: { next_cursor: null, has_more: false },
      });
    }
    if (
      url.pathname === "/v1/catalog/templates/amazon-products-collect-by-url"
    ) {
      return jsonResponse(amazonTemplate);
    }
    if (url.pathname === "/v1/services" && request.method === "GET") {
      return jsonResponse({
        data: [savedService, legacyService],
        page: { next_cursor: null, has_more: false },
      });
    }
    if (url.pathname === "/v1/services" && request.method === "POST") {
      return jsonResponse(createdService);
    }
    if (url.pathname === "/v1/services/service-1") {
      return jsonResponse(savedService);
    }
    if (url.pathname === "/v1/services/service-2") {
      return jsonResponse(createdService);
    }
    if (
      url.pathname === "/v1/services/service-1/runs" &&
      request.method === "POST"
    ) {
      return jsonResponse({
        run_id: run.id,
        status: "queued",
        accepted_at: run.created_at,
      });
    }
    if (url.pathname === "/v1/runs") {
      return jsonResponse({
        data: [run],
        page: { next_cursor: null, has_more: false },
      });
    }
    if (url.pathname === "/v1/runs/run-1") return jsonResponse(run);
    if (url.pathname === "/v1/runs/run-1/events") {
      return jsonResponse(runEvents);
    }
    return jsonResponse({});
  });
}

function createSignedInSession(
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return {
    session: authSession,
    identityEmail: "customer@example.test",
    isAuthenticated: true,
    signUp: vi.fn(),
    signIn: vi.fn(),
    refresh: vi.fn(),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function LocationProbe() {
  return <output aria-label="Current route">{useLocation().pathname}</output>;
}

function renderWorkspace(
  overrides: Partial<SessionContextValue> = {},
  initialEntry = "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers",
) {
  const session = createSignedInSession(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <LocationProbe />
          <Routes>
            <Route element={<WorkspaceShell />}>
              <Route
                path="/o/11111111-1111-4111-8111-111111111111/workspace/scrapers"
                element={<WorkspaceLibraryPage />}
              />
              <Route
                path="/o/11111111-1111-4111-8111-111111111111/workspace/scrapers/:domainSlug"
                element={<AmazonDomainPage />}
              />
              <Route
                path="/o/11111111-1111-4111-8111-111111111111/workspace/scrapers/:domainSlug/:templateSlug"
                element={<AmazonDomainPage />}
              />
              <Route path="/o/11111111-1111-4111-8111-111111111111/workspace/runs" element={<RunsWorkspacePage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );

  return { ...result, session };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers");
  tokenStore.set(authSession, "customer@example.test");
  vi.stubGlobal("fetch", createBackendFetch());
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  tokenStore.clear();
  vi.unstubAllGlobals();
});

describe("Workspace scraper journey", () => {
  it("offers the organization selector below workspace status in the sidebar and allows keyboard dismissal", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const selector = await screen.findByRole("button", { name: "Acme Research" });
    const footer = selector.closest(".workspace-rail__footer");
    expect(footer).not.toBeNull();
    expect(footer).toHaveTextContent("Workspace active");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(selector);
    expect(screen.getByRole("dialog", { name: "Your organization" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(selector).toHaveFocus();
  });
  it("shows backend workspace and customer context above the published catalogue", async () => {
    renderWorkspace();

    expect(
      await screen.findByRole("heading", { name: "Acme Research" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Scrapers Library" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("customer@example.test")).toHaveLength(2);
    expect(
      screen.queryByRole("link", { name: /API Keys/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Runs/i })).toHaveAttribute(
      "href",
      "/o/11111111-1111-4111-8111-111111111111/workspace/runs",
    );
    expect(screen.getByRole("link", { name: /Usage/i })).toHaveAttribute(
      "href",
      "/o/11111111-1111-4111-8111-111111111111/workspace/usage",
    );
    expect(
      await screen.findByRole("link", { name: /amazon\.com/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 available")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", {
        name: /Local-only durable execution test/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("collapses and expands the workspace navigation rail", async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace();
    await user.click(
      screen.getByRole("button", { name: "Collapse navigation" }),
    );
    expect(container.querySelector(".workspace-page")).toHaveClass(
      "workspace-page--rail-collapsed",
    );
    expect(
      screen.getByRole("button", { name: "Expand navigation" }),
    ).toBeInTheDocument();
  });

  it("signs out through the shared session service", async () => {
    const user = userEvent.setup();
    const { session } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(session.logout).toHaveBeenCalledOnce();
  });

  it("loads selected operation detail and matching tenant services", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(await screen.findByRole("link", { name: /amazon\.com/i }));

    expect(await screen.findByLabelText("Current route")).toHaveTextContent(
      "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers/amazon-com/amazon-products-collect-by-url",
    );
    expect(
      await screen.findByRole("heading", {
        name: "Amazon products — Collect by URL",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("My Amazon Products Scraper")).toHaveLength(2);
    expect(screen.getByText("1 active saved service")).toBeInTheDocument();
    expect(screen.getByLabelText("Product URL 1")).toBeRequired();
    expect(screen.getByLabelText("ZIP code 1")).toBeInTheDocument();
    expect(screen.getByLabelText("ZIP code 1")).toHaveAttribute(
      "pattern",
      "^[0-9]{5}$",
    );
    expect(screen.getByLabelText("Language 1")).toHaveRole("combobox");
    expect(screen.getByLabelText("Language 1")).toHaveValue("EN");
    expect(screen.getByLabelText("Language 1")).toHaveTextContent(
      "Marketplace defaultEnglish (EN)",
    );
    expect(screen.queryByText(/â€”/)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Collect all variations 1"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Existing v3 scraper")).not.toBeInTheDocument();
  });

  it("blocks malformed ZIP input and limits language to qualified choices", async () => {
    const user = userEvent.setup();
    renderWorkspace(
      {},
      "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers/amazon-com/amazon-products-collect-by-url",
    );
    const urlInput = await screen.findByLabelText("Product URL 1");
    const zipcodeInput = screen.getByLabelText("ZIP code 1");
    const languageInput = screen.getByLabelText("Language 1");
    await user.type(urlInput, "https://www.amazon.com/dp/B00TEST001");
    await user.type(zipcodeInput, "rrrrrrtrteret");

    expect(zipcodeInput).toBeInvalid();
    expect(languageInput).toHaveValue("EN");
    expect(
      screen.queryByRole("option", { name: "ENertertert" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start collection" }));
    expect(
      vi
        .mocked(fetch)
        .mock.calls.map(([input]) => input as Request)
        .some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname === "/v1/services/service-1/runs",
        ),
    ).toBe(false);

    await user.clear(zipcodeInput);
    await user.type(zipcodeInput, "94107");
    expect(zipcodeInput).toBeValid();
  });

  it("enforces the published maximum of twenty inputs", async () => {
    const user = userEvent.setup();
    renderWorkspace(
      {},
      "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers/amazon-com/amazon-products-collect-by-url",
    );
    await screen.findByLabelText("Product URL 1");
    const addInput = screen.getByRole("button", { name: /add input/i });

    for (let index = 2; index <= 20; index += 1) await user.click(addInput);

    expect(screen.getByLabelText("Product URL 20")).toBeInTheDocument();
    expect(screen.queryByLabelText("Product URL 21")).not.toBeInTheDocument();
    expect(addInput).toBeDisabled();
    expect(screen.getByText("20 / 20 inputs")).toBeInTheDocument();
  });

  it("supports the published schema limit with repeatable product inputs", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(await screen.findByRole("link", { name: /amazon\.com/i }));
    await user.type(
      await screen.findByLabelText("Product URL 1"),
      "https://www.amazon.com/dp/B00TEST001",
    );
    await user.click(screen.getByRole("button", { name: /add input/i }));
    await user.type(
      screen.getByLabelText("Product URL 2"),
      "https://www.amazon.com/dp/B00TEST002",
    );
    const startButton = screen.getByRole("button", {
      name: "Start collection",
    });
    await waitFor(() => expect(startButton).toBeEnabled());
    await user.click(startButton);
    expect(
      await screen.findByText("2 inputs were accepted."),
    ).toBeInTheDocument();
    expect(screen.getByText("Current collection")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", {
        name: "Collection lifecycle progress",
      }),
    ).toHaveAttribute("aria-valuenow", "35");
    expect(screen.getByRole("link", { name: "View all runs" })).toHaveAttribute(
      "href",
      "/o/11111111-1111-4111-8111-111111111111/workspace/runs?run=run-1",
    );
    const runRequest = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => input as Request)
      .find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/v1/services/service-1/runs",
      );
    expect(runRequest).toBeDefined();
    expect(runRequest?.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.run\.create\./,
    );
    expect(runRequest?.headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(await runRequest?.clone().json()).toEqual({
      input: {
        targets: [
          {
            url: "https://www.amazon.com/dp/B00TEST001",
            language: "EN",
            all_variations: false,
          },
          {
            url: "https://www.amazon.com/dp/B00TEST002",
            language: "EN",
            all_variations: false,
          },
        ],
      },
    });
  });

  it("saves a new scraper through the shared Service contract", async () => {
    const user = userEvent.setup();
    renderWorkspace(
      {},
      "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers/amazon-com/amazon-products-collect-by-url",
    );
    await screen.findByLabelText("Product URL 1");
    await user.click(
      screen.getByRole("button", {
        name: /save this scraper with a new name/i,
      }),
    );
    await user.type(
      screen.getByLabelText("Saved scraper name"),
      "Research collection",
    );
    await user.click(screen.getByRole("button", { name: "Save scraper" }));
    expect(
      await screen.findByText("Research collection was saved."),
    ).toBeInTheDocument();

    const serviceRequest = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => input as Request)
      .find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === "/v1/services",
      );
    expect(serviceRequest).toBeDefined();
    expect(serviceRequest?.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.service\.create\./,
    );
    expect(await serviceRequest?.clone().json()).toEqual({
      template_slug: amazonTemplate.slug,
      name: "Research collection",
      configuration: {},
    });
  });

  it("keeps run details closed until a row is selected", async () => {
    const user = userEvent.setup();
    renderWorkspace({}, "/o/11111111-1111-4111-8111-111111111111/workspace/runs");

    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Safe event history" }),
    ).not.toBeInTheDocument();

    const [firstRun] = await screen.findAllByRole("button", {
      name: /My Amazon Products Scraper/i,
    });
    expect(firstRun).toBeDefined();
    if (!firstRun) throw new Error("Expected at least one selectable Run.");
    await user.click(firstRun);

    expect(screen.getByLabelText("Current route")).toHaveTextContent(
      "/o/11111111-1111-4111-8111-111111111111/workspace/runs",
    );
    expect(
      await screen.findByRole("heading", { name: "Safe event history" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close run details" }));
    expect(
      screen.queryByRole("heading", { name: "Safe event history" }),
    ).not.toBeInTheDocument();
  });

  it("switches between configuration and overview and links Runs explicitly", async () => {
    const user = userEvent.setup();
    renderWorkspace(
      {},
      "/o/11111111-1111-4111-8111-111111111111/workspace/scrapers/amazon-com/amazon-products-collect-by-url",
    );
    expect(await screen.findByLabelText("Product URL 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(
      screen.getByRole("heading", { level: 3, name: amazonTemplate.name }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Product URL 1")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByLabelText("Product URL 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute(
      "href",
      "/o/11111111-1111-4111-8111-111111111111/workspace/runs?service=service-1",
    );
  });

  it("filters API-provided domain cards locally", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByRole("link", { name: /amazon\.com/i });
    await user.type(screen.getByLabelText("Search scrapers"), "twitter");
    expect(
      screen.getByText("No scrapers match this search."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /amazon\.com/i }),
    ).not.toBeInTheDocument();
  });
});
