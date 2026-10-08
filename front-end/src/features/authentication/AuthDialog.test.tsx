import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { DhumiApiError } from "../../api/errors";
import {
  SessionContext,
  type SessionContextValue,
} from "../../session/SessionProvider";
import { AuthDialog } from "./AuthDialog";

function sessionValue(
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return {
    session: null,
    identityEmail: null,
    isAuthenticated: false,
    signUp: vi.fn(async () => ({
      accepted: true as const,
      message: "Account request accepted. Sign in to continue.",
    })),
    signIn: vi.fn(async () => ({
      access_token: "access",
      token_type: "Bearer" as const,
      expires_in: 3600,
      csrf_token: "csrf-token-value",
    })),
    refresh: vi.fn(async () => ({
      access_token: "access",
      token_type: "Bearer" as const,
      expires_in: 3600,
      csrf_token: "csrf-token-value",
    })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderDialog(
  mode: "sign-up" | "sign-in",
  session: SessionContextValue,
  onModeChange = vi.fn(),
  onAuthenticated = vi.fn(),
) {
  render(
    <SessionContext.Provider value={session}>
      <AuthDialog
        mode={mode}
        onClose={vi.fn()}
        onModeChange={onModeChange}
        onAuthenticated={onAuthenticated}
      />
    </SessionContext.Provider>,
  );

  return { onModeChange, onAuthenticated };
}

describe("AuthDialog", () => {
  it("shows only the support contact in a small popup without requesting a code or clearing sign-in fields", async () => {
    const user = userEvent.setup();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const session = sessionValue();
    renderDialog("sign-in", session);
    expect(
      screen.getByRole("heading", { name: "Sign in to Dhumi" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "dhumitechnologies@gmail.com" }),
    ).not.toBeInTheDocument();
    await user.type(
      screen.getByLabelText("Email address"),
      "owner@example.test",
    );
    await user.type(
      screen.getByLabelText("Password"),
      "private-unsent-password",
    );
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(
      screen.getByRole("region", { name: "Password support" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send.*code/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Verification code"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue(
      "private-unsent-password",
    );
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "owner@example.test",
    );
    expect(
      screen.getByRole("link", { name: "dhumitechnologies@gmail.com" }),
    ).toHaveAttribute("href", "mailto:dhumitechnologies@gmail.com");
    expect(fetcher).not.toHaveBeenCalled();
    expect(session.signIn).not.toHaveBeenCalled();
    expect(session.signUp).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Close password help" }),
    );
    expect(
      screen.queryByRole("region", { name: "Password support" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue(
      "private-unsent-password",
    );
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "owner@example.test",
    );
    expect(
      screen.getByRole("button", { name: "Forgot password?" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("region", { name: "Password support" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
  it("keeps duplicate signup open with a sign-in action and password-help contact", async () => {
    const user = userEvent.setup();
    const session = sessionValue({
      signUp: vi.fn(async () => {
        throw new DhumiApiError({
          status: 409,
          code: "ACCOUNT_ALREADY_EXISTS",
          title: "Account already exists",
        });
      }),
    });
    const { onModeChange, onAuthenticated } = renderDialog("sign-up", session);
    await user.type(
      screen.getByLabelText("Email address"),
      "existing@example.test",
    );
    await user.type(
      screen.getByLabelText("Password"),
      "a-sufficiently-long-password",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "a-sufficiently-long-password",
    );
    await user.click(
      screen.getByLabelText(
        "I agree to the Terms of Service and Privacy Policy.",
      ),
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An account with this email already exists.",
    );
    expect(
      screen.getByRole("link", { name: "dhumitechnologies@gmail.com" }),
    ).toHaveAttribute("href", "mailto:dhumitechnologies@gmail.com");
    expect(onModeChange).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Sign in to your account" }),
    );
    expect(onModeChange).toHaveBeenCalledWith("sign-in");
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "existing@example.test",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
  it("rejects invalid email, short passwords and missing consent without submitting", async () => {
    const user = userEvent.setup(),
      session = sessionValue();
    renderDialog("sign-up", session);
    await user.type(screen.getByLabelText("Email address"), "invalid");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(
      await screen.findByText("Enter a valid email address."),
    ).toBeInTheDocument();
    expect(screen.getByText("Use at least 12 characters.")).toBeInTheDocument();
    expect(session.signUp).not.toHaveBeenCalled();
  });
  it("does not label an idempotency conflict as a duplicate account", async () => {
    const user = userEvent.setup();
    renderDialog(
      "sign-up",
      sessionValue({
        signUp: vi.fn(async () => {
          throw new DhumiApiError({
            status: 409,
            code: "IDEMPOTENCY_CONFLICT",
            title: "Idempotency conflict",
          });
        }),
      }),
    );
    await user.type(
      screen.getByLabelText("Email address"),
      "owner@example.test",
    );
    await user.type(
      screen.getByLabelText("Password"),
      "a-sufficiently-long-password",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "a-sufficiently-long-password",
    );
    await user.click(
      screen.getByLabelText(
        "I agree to the Terms of Service and Privacy Policy.",
      ),
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This request conflicts with an earlier account request.",
    );
    expect(
      screen.queryByRole("button", { name: "Sign in to your account" }),
    ).not.toBeInTheDocument();
  });
  it("rejects mismatched passwords and keeps the password unchanged when trimming email", async () => {
    const user = userEvent.setup(),
      session = sessionValue();
    renderDialog("sign-up", session);
    await user.type(
      screen.getByLabelText("Email address"),
      " owner@acme.test ",
    );
    await user.type(
      screen.getByLabelText("Password"),
      "a-sufficiently-long-password",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "different-long-password",
    );
    await user.click(
      screen.getByLabelText(
        "I agree to the Terms of Service and Privacy Policy.",
      ),
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(
      await screen.findByText("Passwords must match."),
    ).toBeInTheDocument();
    expect(session.signUp).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(
      screen.getByLabelText("Confirm password"),
      "a-sufficiently-long-password",
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() =>
      expect(session.signUp).toHaveBeenCalledWith({
        email: "owner@acme.test",
        password: "a-sufficiently-long-password",
      }),
    );
  });
  it("does not expose unexpected internal errors to a customer", async () => {
    const user = userEvent.setup(),
      session = sessionValue({
        signIn: vi.fn(async () => {
          throw new Error("private database connection details");
        }),
      });
    renderDialog("sign-in", session);
    await user.type(screen.getByLabelText("Email address"), "owner@acme.test");
    await user.type(
      screen.getByLabelText("Password"),
      "a-sufficiently-long-password",
    );
    await user.click(screen.getByRole("button", { name: /^sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not complete your request.",
    );
    expect(screen.queryByText(/private database/)).not.toBeInTheDocument();
  });
  it("validates and submits the customer signup fields", async () => {
    const user = userEvent.setup();
    const session = sessionValue();
    const { onModeChange } = renderDialog("sign-up", session);

    expect(
      screen.queryByLabelText("Company website or company name"),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Email address"), "owner@acme.test");
    await user.type(
      screen.getByLabelText("Password"),
      "a-sufficiently-long-password",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "a-sufficiently-long-password",
    );
    await user.click(
      screen.getByLabelText(
        "I agree to the Terms of Service and Privacy Policy.",
      ),
    );
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(session.signUp).toHaveBeenCalledWith({
        email: "owner@acme.test",
        password: "a-sufficiently-long-password",
      }),
    );
    expect(onModeChange).toHaveBeenCalledWith("sign-in");
    expect(
      screen.getByText("Account request accepted. Sign in to continue."),
    ).toBeInTheDocument();
  });

  it("signs in and reports authentication to the page", async () => {
    const user = userEvent.setup();
    const session = sessionValue();
    const { onAuthenticated } = renderDialog("sign-in", session);

    await user.type(screen.getByLabelText("Email address"), "owner@acme.test");
    await user.type(
      screen.getByLabelText("Password"),
      "a-sufficiently-long-password",
    );
    await user.click(screen.getByRole("button", { name: /^sign in/i }));

    await waitFor(() =>
      expect(session.signIn).toHaveBeenCalledWith({
        email: "owner@acme.test",
        password: "a-sufficiently-long-password",
      }),
    );
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });
});
