import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";
import { LinkedInPostsPage } from "./LinkedInPostsPage";
import { MarketplaceDomainPage } from "./MarketplaceDomainPage";
import { MarketplaceLibraryPage } from "./MarketplaceLibraryPage";

const authSession = {
  access_token: "access-token",
  token_type: "Bearer" as const,
  expires_in: 3600,
  csrf_token: "csrf-token",
};

const session: SessionContextValue = {
  session: authSession,
  identityEmail: "customer@example.test",
  isAuthenticated: true,
  signUp: vi.fn(),
  signIn: vi.fn(),
  refresh: vi.fn(),
  logout: vi.fn(),
};

const marketplace = {
  record_count: 1_000_000,
  record_count_as_of: "2026-09-10T00:00:00.000Z",
  sample: {
    state: "available",
    version: 1,
    record_count: 2,
    display_page_size: 30,
    collected_at: "2026-09-10T00:00:00.000Z",
    expires_at: "2026-10-10T00:00:00.000Z",
    masking_notice: "Values containing *** are masked.",
  },
  capabilities: {
    sample_query: "available",
    sample_download: "available",
    full_export: "not_enabled",
  },
  fields: [
    {
      name: "url",
      type: "url",
      active: true,
      required: true,
      description: "LinkedIn post URL",
      sample_visibility: "visible",
      allowed_operators: ["=", "!=", "includes", "not_includes"],
    },
    {
      name: "text",
      type: "text",
      active: true,
      required: false,
      description: "LinkedIn post text",
      sample_visibility: "masked",
      allowed_operators: [],
    },
  ],
  contact_modes: [],
};

const template = {
  slug: "linkedin-posts",
  version: 1,
  family: "marketplace_dataset",
  name: "LinkedIn Posts",
  description:
    "Preview a governed synthetic LinkedIn Posts sample before purchase.",
  availability: "preview_available",
  presentation: {
    domain_slug: "linkedin",
    domain_name: "LinkedIn",
    category: "professional-network",
    icon_key: "linkedin",
    operation_group: "LinkedIn",
    operation_name: "Posts",
    display_priority: 100,
  },
  configuration_schema: { type: "object", additionalProperties: false },
  input_schema: { type: "object", additionalProperties: false },
  marketplace,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sample(
  rows = [
    {
      url: "https://www.linkedin.com/posts/synthetic-one",
      text: "Post***one",
    },
    {
      url: "https://www.linkedin.com/posts/synthetic-two",
      text: "Post***two",
    },
  ],
) {
  return {
    template_slug: "linkedin-posts",
    template_version: 1,
    sample_version: 1,
    sample_record_count: 2,
    matches_in_sample: rows.length,
    selected_fields: ["url", "text"],
    rows,
    masking_notice:
      "Values containing *** are masked. Counts describe only this stored sample, not the full dataset.",
    page: { next_cursor: null, has_more: false },
  };
}

function renderFlow() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>
        <MemoryRouter initialEntries={["/o/11111111-1111-4111-8111-111111111111/workspace/marketplace"]}>
          <Routes>
            <Route
              path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace"
              element={<MarketplaceLibraryPage />}
            />
            <Route
              path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/groups/:domainSlug"
              element={<MarketplaceDomainPage />}
            />
            <Route
              path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/:templateSlug"
              element={<LinkedInPostsPage />}
            />
          </Routes>
        </MemoryRouter>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/o/11111111-1111-4111-8111-111111111111/workspace/marketplace");
  tokenStore.set(authSession, "customer@example.test");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  tokenStore.clear();
  vi.unstubAllGlobals();
});

describe("M4 Dataset Marketplace customer flow", () => {
  it("shows only the governed Posts sample and filters it without a provider endpoint", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (
        url.pathname === "/v1/catalog/templates" &&
        request.method === "GET"
      ) {
        return response({
          data: [template],
          page: { next_cursor: null, has_more: false },
        });
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts" &&
        request.method === "GET"
      ) {
        return response(template);
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample" &&
        request.method === "GET"
      ) {
        return response(sample());
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample/query" &&
        request.method === "POST"
      ) {
        return response(
          sample([
            {
              url: "https://www.linkedin.com/posts/synthetic-one",
              text: "Post***one",
            },
          ]),
        );
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFlow();

    expect(
      await screen.findByRole("heading", { name: "Dataset Marketplace" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/LinkedIn People/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();

    await user.click(await screen.findByRole("link", { name: /LinkedIn/i }));
    await user.click(
      await screen.findByRole("link", { name: /LinkedIn Posts/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "Data sample" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Post***one")).toBeInTheDocument();
    expect(screen.getByText("Post***two")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Filters/i }));
    expect(
      within(screen.getByLabelText("Field")).queryByRole("option", {
        name: "Text",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("columnheader", { name: "Text" })).queryByRole(
        "button",
      ),
    ).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Enter a sample value"), "one");
    await user.click(screen.getByRole("button", { name: "Apply filter" }));

    await waitFor(() =>
      expect(screen.queryByText("Post***two")).not.toBeInTheDocument(),
    );
    const queryRequest = requests.find((request) => request.method === "POST");
    expect(queryRequest).toBeDefined();
    expect(queryRequest?.headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(await queryRequest?.clone().json()).toMatchObject({
      expected_sample_version: 1,
      selected_fields: ["url", "text"],
      filter: { name: "url", operator: "includes", value: "one" },
    });
    expect(
      requests.every(
        (request) => !new URL(request.url).pathname.startsWith("/datasets"),
      ),
    ).toBe(true);
  });

  it("clears a failed sample query and does not leak a draft filter into sorting", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    let queryAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/catalog/templates") {
        return response({
          data: [template],
          page: { next_cursor: null, has_more: false },
        });
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-posts") {
        return response(template);
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-posts/sample") {
        return response(sample());
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample/query" &&
        request.method === "POST"
      ) {
        queryAttempts += 1;
        if (queryAttempts === 1) {
          return response(
            {
              type: "about:blank",
              title: "Validation failed",
              status: 422,
              detail: "The Marketplace sample request is invalid.",
              code: "VALIDATION_ERROR",
              request_id: "request-1",
            },
            422,
          );
        }
        return response(sample());
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFlow();
    await user.click(await screen.findByRole("link", { name: /LinkedIn/i }));
    await user.click(
      await screen.findByRole("link", { name: /LinkedIn Posts/i }),
    );
    await user.click(await screen.findByRole("button", { name: /Filters/i }));
    const value = screen.getByPlaceholderText("Enter a sample value");
    await user.type(value, "invalid");
    await user.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(
      await screen.findByText("The Marketplace sample request is invalid."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      screen.queryByText("The Marketplace sample request is invalid."),
    ).not.toBeInTheDocument();
    expect(value).toHaveValue("");

    await user.type(value, "draft-not-applied");
    await user.click(screen.getByRole("button", { name: /Url ↕/ }));

    await waitFor(() => expect(queryAttempts).toBe(2));
    const sortRequest = requests.filter((request) =>
      new URL(request.url).pathname.endsWith("/sample/query"),
    )[1];
    expect(await sortRequest?.clone().json()).toMatchObject({
      selected_fields: ["url", "text"],
      sort: [{ field: "url", direction: "asc" }],
    });
    expect(await sortRequest?.clone().json()).not.toHaveProperty("filter");
  });

  it("appends the initial sample page and preserves its committed query cursor", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    const firstRow = {
      url: "https://www.linkedin.com/posts/synthetic-one",
      text: "Post***one",
    };
    const secondRow = {
      url: "https://www.linkedin.com/posts/synthetic-two",
      text: "Post***two",
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/catalog/templates") {
        return response({
          data: [template],
          page: { next_cursor: null, has_more: false },
        });
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-posts") {
        return response(template);
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-posts/sample") {
        return response({
          ...sample([firstRow]),
          sample_record_count: 2,
          matches_in_sample: 2,
          page: { next_cursor: "cursor-1", has_more: true },
        });
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample/query" &&
        request.method === "POST"
      ) {
        return response({
          ...sample([secondRow]),
          sample_record_count: 2,
          matches_in_sample: 2,
        });
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderFlow();
    await user.click(await screen.findByRole("link", { name: /LinkedIn/i }));
    await user.click(
      await screen.findByRole("link", { name: /LinkedIn Posts/i }),
    );
    await user.click(await screen.findByRole("button", { name: /Filters/i }));
    await user.type(
      screen.getByPlaceholderText("Enter a sample value"),
      "draft-not-applied",
    );
    await user.click(
      screen.getByRole("button", { name: "Load more sample rows" }),
    );

    expect(await screen.findByText("Post***one")).toBeInTheDocument();
    expect(await screen.findByText("Post***two")).toBeInTheDocument();
    const pageRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/sample/query"),
    );
    expect(await pageRequest?.clone().json()).toMatchObject({
      selected_fields: ["url", "text"],
      page: { cursor: "cursor-1", limit: 30 },
    });
    expect(await pageRequest?.clone().json()).not.toHaveProperty("filter");
  });

  it("authorizes the exact current masked sample projection as JSON without a provider call", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts" &&
        request.method === "GET"
      ) {
        return response(template);
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample" &&
        request.method === "GET"
      ) {
        return response(sample());
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample/query" &&
        request.method === "POST"
      ) {
        return response(
          sample([
            {
              url: "https://www.linkedin.com/posts/synthetic-one",
              text: "Post***one",
            },
          ]),
        );
      }
      if (
        url.pathname ===
          "/v1/catalog/templates/linkedin-posts/sample/downloads" &&
        request.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            sample_version: 1,
            format: "json",
            record_count: 1,
            content_type: "application/json; charset=utf-8",
            byte_count: 241,
            checksum: "a".repeat(64),
            download_url:
              "http://127.0.0.1:10000/devstoreaccount1/dhumi-dev-results/sample.json?sig=redacted",
            download_expires_at: "2026-09-11T12:05:00.000Z",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider value={session}>
          <MemoryRouter
            initialEntries={["/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/linkedin-posts"]}
          >
            <Routes>
              <Route
                path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/:templateSlug"
                element={<LinkedInPostsPage />}
              />
            </Routes>
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /Filters/i }));
    await user.type(screen.getByPlaceholderText("Enter a sample value"), "one");
    await user.click(screen.getByRole("button", { name: "Apply filter" }));
    await waitFor(() =>
      expect(screen.queryByText("Post***two")).not.toBeInTheDocument(),
    );
    await user.click(
      await screen.findByRole("button", { name: "Download JSON" }),
    );
    expect(
      screen.getByText(
        /CSV is for spreadsheet viewing and may prefix formula-like cells/i,
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/masked JSON sample download was authorized/i),
    ).toBeInTheDocument();
    const authorizationRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/sample/downloads"),
    );
    expect(authorizationRequest).toBeDefined();
    expect(authorizationRequest?.headers.get("X-CSRF-Token")).toBe(
      "csrf-token",
    );
    expect(authorizationRequest?.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.marketplace\.sample-download\./,
    );
    expect(await authorizationRequest?.clone().json()).toEqual({
      expected_sample_version: 1,
      selected_fields: ["url", "text"],
      filter: { name: "url", operator: "includes", value: "one" },
      format: "json",
      record_limit: 1,
    });
    expect(click).toHaveBeenCalledOnce();
    expect(
      requests.every(
        (request) => !new URL(request.url).pathname.startsWith("/datasets"),
      ),
    ).toBe(true);
  });

  it("retries an expert enquiry with the same idempotency key and displays its received state", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    let enquiryAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts" &&
        request.method === "GET"
      ) {
        return response(template);
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample" &&
        request.method === "GET"
      ) {
        return response(sample());
      }
      if (
        url.pathname ===
          "/v1/catalog/templates/linkedin-posts/expert-enquiries" &&
        request.method === "POST"
      ) {
        enquiryAttempts += 1;
        if (enquiryAttempts === 1) {
          return response(
            {
              type: "about:blank",
              title: "Service unavailable",
              status: 503,
              detail: "The enquiry could not be recorded.",
              instance: "/v1/catalog/templates/linkedin-posts/expert-enquiries",
              code: "SERVICE_UNAVAILABLE",
              request_id: "request-1",
            },
            503,
          );
        }
        return response(
          {
            id: "7f100000-0000-4000-8000-000000000091",
            template_slug: "linkedin-posts",
            template_version: 1,
            state: "received",
            submitted_at: "2026-09-13T10:00:00.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider value={session}>
          <MemoryRouter
            initialEntries={["/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/linkedin-posts"]}
          >
            <Routes>
              <Route
                path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/:templateSlug"
                element={<LinkedInPostsPage />}
              />
            </Routes>
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>,
    );

    const enquiryButton = await screen.findByRole("button", {
      name: "Talk to a data expert",
    });
    await user.click(enquiryButton);
    expect(
      await screen.findByText("The enquiry could not be recorded."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Talk to a data expert" }),
    );

    expect(await screen.findByText(/Status: received/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Request received" }),
    ).toBeDisabled();

    const enquiryRequests = requests.filter(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith("/expert-enquiries"),
    );
    expect(enquiryRequests).toHaveLength(2);
    expect(enquiryRequests[0]?.headers.get("X-CSRF-Token")).toBe("csrf-token");
    expect(enquiryRequests[0]?.headers.get("Idempotency-Key")).toMatch(
      /^frontend\.marketplace\.expert-enquiry\./,
    );
    expect(enquiryRequests[1]?.headers.get("Idempotency-Key")).toBe(
      enquiryRequests[0]?.headers.get("Idempotency-Key"),
    );
    expect(await enquiryRequests[1]?.clone().json()).toEqual({
      expected_template_version: 1,
    });
    expect(
      requests.every(
        (request) => !new URL(request.url).pathname.startsWith("/datasets"),
      ),
    ).toBe(true);
  });

  it("builds the documented flat OR group without calling a provider route", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/catalog/templates/linkedin-posts") {
        return response(template);
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-posts/sample") {
        return response(sample());
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample/query" &&
        request.method === "POST"
      ) {
        return response(sample());
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider value={session}>
          <MemoryRouter
            initialEntries={["/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/linkedin-posts"]}
          >
            <Routes>
              <Route
                path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/:templateSlug"
                element={<LinkedInPostsPage />}
              />
            </Routes>
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /^Filters$/ }));
    await user.type(
      screen.getByPlaceholderText("Enter a sample value"),
      "first",
    );
    await user.click(screen.getByRole("button", { name: "+ Add rule" }));
    const values = screen.getAllByPlaceholderText("Enter a sample value");
    await user.type(values[1] as HTMLInputElement, "second");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter group logic" }),
      "or",
    );
    await user.click(screen.getByRole("button", { name: "Apply filter" }));

    const queryRequest = await waitFor(() => {
      const found = requests.find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/sample/query"),
      );
      expect(found).toBeDefined();
      return found as Request;
    });
    expect(await queryRequest.clone().json()).toMatchObject({
      filter: {
        operator: "or",
        filters: [
          { name: "url", operator: "includes", value: "first" },
          { name: "url", operator: "includes", value: "second" },
        ],
      },
    });
    expect(
      requests.every(
        (request) => !new URL(request.url).pathname.startsWith("/datasets"),
      ),
    ).toBe(true);
  });

  it("reorders the requested table projection and exposes reviewed detail tabs", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/catalog/templates/linkedin-posts") {
        return response(template);
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-posts/sample") {
        return response(sample());
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-posts/sample/query" &&
        request.method === "POST"
      ) {
        return response({ ...sample(), selected_fields: ["text", "url"] });
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionContext.Provider value={session}>
          <MemoryRouter
            initialEntries={["/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/linkedin-posts"]}
          >
            <Routes>
              <Route
                path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/:templateSlug"
                element={<LinkedInPostsPage />}
              />
            </Routes>
          </MemoryRouter>
        </SessionContext.Provider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "Purchase unavailable" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "Dictionary" }));
    expect(
      await screen.findByRole("heading", { name: "Data dictionary" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Data sample" }));
    await user.click(screen.getByRole("button", { name: "Edit table" }));
    await user.click(screen.getByRole("button", { name: "Move Text up" }));
    await user.click(
      screen.getByRole("button", { name: "Apply table layout" }),
    );

    const queryRequest = await waitFor(() => {
      const found = requests.find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/sample/query"),
      );
      expect(found).toBeDefined();
      return found as Request;
    });
    expect(await queryRequest.clone().json()).toMatchObject({
      selected_fields: ["text", "url"],
    });
    const headers = screen.getAllByRole("columnheader");
    expect(headers[1]).toHaveTextContent("Text");
    expect(headers[2]).toHaveTextContent("Url");
  });
});
