import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
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
  it("validates and submits the customer signup fields", async () => {
    const user = userEvent.setup();
    const session = sessionValue();
    const { onModeChange } = renderDialog("sign-up", session);

    await user.type(
      screen.getByLabelText("Company website or company name"),
      "Acme Research",
    );
    await user.type(screen.getByLabelText("Email address"), "owner@acme.test");
    await user.type(
      screen.getByLabelText("Password"),
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
        companyNameOrWebsite: "Acme Research",
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
