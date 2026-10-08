import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { DhumiApiError } from "../../api/auth";
import { BrandMark } from "../../components/ui/BrandMark";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { useSession } from "../../session/useSession";
import { PASSWORD_SUPPORT_EMAIL, PasswordSupport } from "./PasswordSupport";

export type AuthMode = "sign-up" | "sign-in";

interface AuthDialogProps {
  readonly mode: AuthMode;
  readonly onClose: () => void;
  readonly onModeChange: (mode: AuthMode) => void;
  readonly onAuthenticated: () => void;
}

interface AuthFormValues {
  readonly email: string;
  readonly password: string;
  readonly confirmPassword: string;
  readonly legalConsent: boolean;
}

function customerErrorMessage(error: unknown): string {
  if (!(error instanceof DhumiApiError)) {
    return "We could not complete your request. Please try again.";
  }

  if (error.status === 401) {
    return "The email address or password is incorrect.";
  }

  if (error.status === 409) {
    if (error.code === "ACCOUNT_ALREADY_EXISTS") {
      return "An account with this email already exists.";
    }
    return "This request conflicts with an earlier account request. Please try again.";
  }

  if (error.status === 429) {
    return "Too many attempts were made. Please wait a moment and try again.";
  }

  if (error.status === null) {
    return "Dhumi is unavailable right now. Check your connection and try again.";
  }

  return "We could not complete your request. Please check your details and try again.";
}

export function AuthDialog({
  mode,
  onClose,
  onModeChange,
  onAuthenticated,
}: AuthDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const passwordHelpButtonRef = useRef<HTMLButtonElement>(null);
  const passwordHelpLinkRef = useRef<HTMLAnchorElement>(null);
  const { signIn, signUp } = useSession();
  const [requestError, setRequestError] = useState<{
    message: string;
    accountExists: boolean;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [passwordHelpOpen, setPasswordHelpOpen] = useState(false);
  const isSignUp = mode === "sign-up";
  const {
    register,
    handleSubmit,
    getValues,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AuthFormValues>({
    defaultValues: {
      email: "",
      password: "",
      confirmPassword: "",
      legalConsent: false,
    },
    shouldUnregister: true,
  });

  function closePasswordHelp(): void {
    setPasswordHelpOpen(false);
    passwordHelpButtonRef.current?.focus();
  }

  useDialogFocus(true, panelRef, () => {
    if (passwordHelpOpen) closePasswordHelp();
    else onClose();
  });
  useEffect(() => {
    if (passwordHelpOpen) passwordHelpLinkRef.current?.focus();
  }, [passwordHelpOpen]);

  function changeMode(nextMode: AuthMode): void {
    const email = getValues("email");
    reset({
      email,
      password: "",
      confirmPassword: "",
      legalConsent: false,
    });
    setRequestError(null);
    setNotice(null);
    setPasswordHelpOpen(false);
    onModeChange(nextMode);
  }

  async function submit(values: AuthFormValues): Promise<void> {
    setRequestError(null);
    setNotice(null);

    try {
      if (isSignUp) {
        const result = await signUp({
          email: values.email.trim(),
          password: values.password,
        });
        reset({
          email: values.email,
          password: "",
          confirmPassword: "",
          legalConsent: false,
        });
        onModeChange("sign-in");
        setNotice(result.message);
        return;
      }

      await signIn({ email: values.email.trim(), password: values.password });
      onAuthenticated();
    } catch (error) {
      setRequestError({
        message: customerErrorMessage(error),
        accountExists:
          isSignUp &&
          error instanceof DhumiApiError &&
          error.status === 409 &&
          error.code === "ACCOUNT_ALREADY_EXISTS",
      });
    }
  }

  return (
    <div className="auth-modal">
      <button
        className="auth-modal__backdrop"
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        ref={panelRef}
        className="auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-dialog-title"
        aria-describedby="auth-dialog-intro"
      >
        <button
          className="auth-dialog__close"
          type="button"
          aria-label="Close account window"
          onClick={onClose}
          ref={closeButtonRef}
        >
          <span aria-hidden="true">×</span>
        </button>

        <div className="auth-panel">
          <a
            className="auth-brand"
            href="/"
            aria-label="Dhumi Data Scrappers home"
          >
            <BrandMark />
          </a>

          <div className="auth-form-wrap">
            <div
              className="auth-tabs"
              role="tablist"
              aria-label="Account access"
            >
              <button
                className={isSignUp ? "auth-tab auth-tab--active" : "auth-tab"}
                type="button"
                role="tab"
                aria-selected={isSignUp}
                onClick={() => changeMode("sign-up")}
              >
                Sign up
              </button>
              <button
                className={!isSignUp ? "auth-tab auth-tab--active" : "auth-tab"}
                type="button"
                role="tab"
                aria-selected={!isSignUp}
                onClick={() => changeMode("sign-in")}
              >
                Sign in
              </button>
            </div>

            <p className="auth-eyebrow">
              {isSignUp ? "Create your account" : "Welcome back"}
            </p>
            <h2 id="auth-dialog-title">
              {isSignUp ? "Start with Dhumi." : "Sign in to Dhumi"}
            </h2>
            <p className="auth-intro" id="auth-dialog-intro">
              {isSignUp
                ? "Create your account, then create your organization to save scrapers and collect data."
                : "Access your workspace, scrapers and results."}
            </p>

            {notice && (
              <p className="auth-message auth-message--success" role="status">
                {notice}
              </p>
            )}

            {requestError && (
              <div className="auth-message auth-message--error" role="alert">
                <p>{requestError.message}</p>
                {requestError.accountExists && (
                  <>
                    <button
                      className="auth-account-signin"
                      type="button"
                      onClick={() => changeMode("sign-in")}
                    >
                      Sign in to your account
                    </button>
                    <PasswordSupport />
                  </>
                )}
              </div>
            )}

            <form
              className="auth-form"
              onSubmit={handleSubmit(submit)}
              noValidate
            >
              <label className="auth-field">
                Email address
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  aria-invalid={errors.email ? "true" : "false"}
                  {...register("email", {
                    setValueAs: (value: string) => value.trim(),
                    required: "Enter your email address.",
                    maxLength: {
                      value: 320,
                      message: "Use no more than 320 characters.",
                    },
                    pattern: {
                      value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                      message: "Enter a valid email address.",
                    },
                  })}
                />
                {errors.email && (
                  <span className="auth-field__error" role="alert">
                    {errors.email.message}
                  </span>
                )}
              </label>

              <label className="auth-field">
                Password
                <input
                  type="password"
                  autoComplete={isSignUp ? "new-password" : "current-password"}
                  placeholder={
                    isSignUp ? "Create a secure password" : "Your password"
                  }
                  aria-invalid={errors.password ? "true" : "false"}
                  {...register("password", {
                    required: "Enter your password.",
                    minLength: isSignUp
                      ? {
                          value: 12,
                          message: "Use at least 12 characters.",
                        }
                      : undefined,
                    maxLength: {
                      value: 256,
                      message: "Use no more than 256 characters.",
                    },
                  })}
                />
                {errors.password && (
                  <span className="auth-field__error" role="alert">
                    {errors.password.message}
                  </span>
                )}
              </label>

              {isSignUp && (
                <div className="auth-field">
                  <label htmlFor="auth-confirm-password">
                    Confirm password
                  </label>
                  <input
                    id="auth-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    aria-invalid={errors.confirmPassword ? "true" : "false"}
                    aria-describedby={
                      errors.confirmPassword
                        ? "auth-confirm-password-error"
                        : undefined
                    }
                    {...register("confirmPassword", {
                      required: "Confirm your password.",
                      validate: (value) =>
                        value === getValues("password") ||
                        "Passwords must match.",
                    })}
                  />
                  {errors.confirmPassword && (
                    <span
                      id="auth-confirm-password-error"
                      className="auth-field__error"
                      role="alert"
                    >
                      {errors.confirmPassword.message}
                    </span>
                  )}
                </div>
              )}
              {isSignUp && (
                <label className="auth-consent">
                  <input
                    type="checkbox"
                    aria-invalid={errors.legalConsent ? "true" : "false"}
                    {...register("legalConsent", {
                      required:
                        "Accept the Terms of Service and Privacy Policy to continue.",
                    })}
                  />
                  <span>
                    I agree to the Terms of Service and Privacy Policy.
                    {errors.legalConsent && (
                      <span
                        className="auth-field__error auth-field__error--consent"
                        role="alert"
                      >
                        {errors.legalConsent.message}
                      </span>
                    )}
                  </span>
                </label>
              )}

              <button
                className="auth-submit"
                type="submit"
                disabled={isSubmitting}
                aria-busy={isSubmitting}
              >
                {isSubmitting
                  ? isSignUp
                    ? "Creating account…"
                    : "Signing in…"
                  : isSignUp
                    ? "Create account"
                    : "Sign in"}
                <span aria-hidden="true">→</span>
              </button>
            </form>
            {!isSignUp && (
              <div className="auth-recovery">
                {passwordHelpOpen && (
                  <section
                    className="auth-support-popup"
                    id="auth-password-support"
                    aria-label="Password support"
                  >
                    <p>
                      Contact{" "}
                      <a
                        ref={passwordHelpLinkRef}
                        href={`mailto:${PASSWORD_SUPPORT_EMAIL}`}
                      >
                        {PASSWORD_SUPPORT_EMAIL}
                      </a>
                    </p>
                    <button
                      className="auth-support-popup__close"
                      type="button"
                      aria-label="Close password help"
                      onClick={closePasswordHelp}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </section>
                )}
                <button
                  className="auth-text-button"
                  type="button"
                  ref={passwordHelpButtonRef}
                  aria-expanded={passwordHelpOpen}
                  aria-controls="auth-password-support"
                  onClick={() => setPasswordHelpOpen((open) => !open)}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <p className="auth-switch">
              {isSignUp ? "Already have an account?" : "New to Dhumi?"}{" "}
              <button
                type="button"
                onClick={() => changeMode(isSignUp ? "sign-in" : "sign-up")}
              >
                {isSignUp ? "Sign in" : "Create an account"}
              </button>
            </p>
          </div>
        </div>

        <aside
          className="auth-story"
          aria-label="What a Dhumi workspace offers"
        >
          <div className="auth-story__grid" aria-hidden="true" />
          <div className="auth-story__content">
            <p className="auth-story__eyebrow">One workspace. Clear results.</p>
            <h3>Everything you collect, clearly organized.</h3>
            <ul>
              <li>
                <span>01</span>
                Choose from ready-made scrapers
              </li>
              <li>
                <span>02</span>
                Follow collections as they progress
              </li>
              <li>
                <span>03</span>
                Download structured results when ready
              </li>
            </ul>
            <p className="auth-story__note">
              From pages to usable data, every step stays simple and visible.
            </p>
          </div>
        </aside>
      </section>
    </div>
  );
}
