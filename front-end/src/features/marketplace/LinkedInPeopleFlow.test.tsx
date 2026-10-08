import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { tokenStore } from "../../session/tokenStore";
import { LinkedInPeoplePage } from "./LinkedInPeoplePage";
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

const fields = [
  {
    name: "url",
    type: "url",
    active: true,
    required: true,
    description: "LinkedIn profile URL",
    sample_visibility: "visible",
    allowed_operators: ["=", "!=", "includes", "not_includes"],
  },
  {
    name: "name",
    type: "text",
    active: true,
    required: false,
    description: "Profile name",
    sample_visibility: "visible",
    allowed_operators: ["=", "!=", "includes", "not_includes"],
  },
  {
    name: "email",
    type: "text",
    active: true,
    required: false,
    description: "Business email when available",
    sample_visibility: "masked",
    allowed_operators: [],
  },
] as const;

const contactModes = [
  {
    code: "standard",
    display_order: 1,
    customer_meaning: "Standard profile data without a contact-data promise.",
    preview_state: "available",
    fulfillment_state: "not_enabled",
  },
  {
    code: "enriched_when_available",
    display_order: 2,
    customer_meaning:
      "Standard profiles with business contact information when available.",
    preview_state: "not_enabled",
    fulfillment_state: "not_enabled",
  },
  {
    code: "contacts_only",
    display_order: 3,
    customer_meaning: "Only profiles containing business contact information.",
    preview_state: "not_enabled",
    fulfillment_state: "not_enabled",
  },
] as const;

const peopleTemplate = {
  slug: "linkedin-people",
  version: 1,
  family: "marketplace_dataset",
  name: "LinkedIn People",
  description: "Preview governed LinkedIn profile sample data.",
  availability: "preview_available",
  presentation: {
    domain_slug: "linkedin",
    domain_name: "LinkedIn",
    category: "professional-network",
    icon_key: "linkedin",
    operation_group: "LinkedIn",
    operation_name: "People",
    display_priority: 110,
  },
  configuration_schema: { type: "object", additionalProperties: false },
  input_schema: { type: "object", additionalProperties: false },
  marketplace: {
    record_count: null,
    record_count_as_of: "2026-09-13T17:05:35.686Z",
    sample: {
      state: "available",
      version: 1,
      record_count: 5,
      display_page_size: 5,
      collected_at: "2026-09-13T17:05:35.686Z",
      expires_at: "2026-10-13T17:05:35.686Z",
      masking_notice: "Values containing *** are masked.",
    },
    capabilities: {
      sample_query: "available",
      sample_download: "available",
      full_export: "not_enabled",
    },
    fields,
    contact_modes: contactModes,
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function peopleSample(
  rows = [
    { url: "https://linkedin.com/in/alice", name: "Alice", email: "***" },
  ],
) {
  return {
    template_slug: "linkedin-people",
    template_version: 1,
    sample_version: 1,
    sample_record_count: 5,
    matches_in_sample: rows.length,
    selected_fields: ["url", "name", "email"],
    rows,
    masking_notice:
      "Values containing *** are masked. Counts describe only this stored sample, not the full dataset.",
    page: { next_cursor: null, has_more: false },
  };
}

function renderPeopleFlow() {
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
              path="/o/11111111-1111-4111-8111-111111111111/workspace/marketplace/linkedin-people"
              element={<LinkedInPeoplePage />}
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
  vi.restoreAllMocks();
});

describe("LinkedIn People database-backed customer flow", () => {
  it("renders API-projected contact modes and keeps unavailable modes disabled", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/catalog/templates") {
        return response({
          data: [peopleTemplate],
          page: { next_cursor: null, has_more: false },
        });
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-people") {
        return response(peopleTemplate);
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-people/sample") {
        return response(peopleSample());
      }
      if (
        url.pathname === "/v1/catalog/templates/linkedin-people/sample/query" &&
        request.method === "POST"
      ) {
        return response(peopleSample());
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPeopleFlow();
    await user.click(await screen.findByRole("link", { name: /LinkedIn/i }));
    await user.click(
      await screen.findByRole("link", { name: /LinkedIn People/i }),
    );

    await user.click(
      await screen.findByRole("button", { name: /Contact filters/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "Contact filters" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(contactModes[0].customer_meaning),
    ).toBeInTheDocument();
    expect(
      screen.getByText(contactModes[1].customer_meaning),
    ).toBeInTheDocument();
    expect(
      screen.getByText(contactModes[2].customer_meaning),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /standard/i })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: /enriched when available/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: /contacts only/i }),
    ).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: "Apply contact filter" }),
    );

    await user.click(screen.getByRole("button", { name: /^Filters$/i }));
    await user.type(
      screen.getByPlaceholderText("Enter a sample value"),
      "alice",
    );
    await user.click(screen.getByRole("button", { name: "Apply filter" }));

    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/sample/query"),
        ),
      ).toBe(true),
    );
    const queryRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/sample/query"),
    );
    const queryBody = await queryRequest?.clone().json();
    expect(queryBody).not.toHaveProperty("contact_mode");
    expect(queryBody).toMatchObject({
      expected_sample_version: 1,
      selected_fields: ["url", "name", "email"],
    });
    expect(
      requests.every(
        (request) => !new URL(request.url).pathname.startsWith("/datasets"),
      ),
    ).toBe(true);
  });

  it("authorizes the current People sample download without sending a contact mode", async () => {
    const user = userEvent.setup();
    const requests: Request[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/catalog/templates") {
        return response({
          data: [peopleTemplate],
          page: { next_cursor: null, has_more: false },
        });
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-people") {
        return response(peopleTemplate);
      }
      if (url.pathname === "/v1/catalog/templates/linkedin-people/sample") {
        return response(peopleSample());
      }
      if (
        url.pathname ===
          "/v1/catalog/templates/linkedin-people/sample/downloads" &&
        request.method === "POST"
      ) {
        return response(
          {
            sample_version: 1,
            format: "json",
            record_count: 1,
            content_type: "application/json; charset=utf-8",
            byte_count: 500,
            checksum: "a".repeat(64),
            download_url:
              "http://127.0.0.1:10000/devstoreaccount1/dhumi-dev-results/people.json?sig=redacted",
            download_expires_at: "2026-09-14T12:05:00.000Z",
          },
          201,
        );
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPeopleFlow();
    await user.click(await screen.findByRole("link", { name: /LinkedIn/i }));
    await user.click(
      await screen.findByRole("link", { name: /LinkedIn People/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Download JSON" }),
    );

    expect(
      await screen.findByText(/masked JSON sample download was authorized/i),
    ).toBeInTheDocument();
    const downloadRequest = requests.find((request) =>
      new URL(request.url).pathname.endsWith("/sample/downloads"),
    );
    expect(downloadRequest).toBeDefined();
    expect(downloadRequest?.headers.get("X-CSRF-Token")).toBe("csrf-token");
    const downloadBody = await downloadRequest?.clone().json();
    expect(downloadBody).not.toHaveProperty("contact_mode");
    expect(downloadBody).toMatchObject({
      expected_sample_version: 1,
      selected_fields: ["url", "name", "email"],
      format: "json",
    });
  });
});
