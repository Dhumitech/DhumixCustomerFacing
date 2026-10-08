import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { DhumiApiError } from "../../api/errors";
import type {
  DemoOrganizationCompleted,
  VerificationAccepted,
} from "../../api/generated";
import {
  ORGANIZATION_NEEDED,
  organizationPath,
  selectedOrganization,
} from "../../api/organizationScope";
import { organizationsApi } from "../../api/organizations";
import { BrandMark } from "../../components/ui/BrandMark";
import { useDialogFocus } from "../../components/ui/useDialogFocus";
import { useSession } from "../../session/useSession";
import {
  preferenceUserId,
  rememberOrganization,
} from "./organizationPreference";
import { useOrganizationsQuery } from "./organizationQueries";

export function OrganizationPanel({
  mandatory = false,
}: {
  readonly mandatory?: boolean;
}) {
  const { session, logout } = useSession();
  const location = useLocation(),
    navigate = useNavigate(),
    queries = useQueryClient();
  const memberships = useOrganizationsQuery();
  const organizationId = selectedOrganization(location.pathname);
  const activeOrganization = memberships.data?.organizations.find(
    (org) => org.id === organizationId,
  );
  const hasMultipleOrganizations =
    (memberships.data?.organizations.length ?? 0) > 1;
  const singleActiveOrganization = !hasMultipleOrganizations
    ? activeOrganization
    : undefined;
  const needsOrganization =
    memberships.isSuccess && memberships.data.organizations.length === 0;
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const panel = useRef<HTMLElement>(null);
  const open = opened || needsOrganization || mandatory;
  const required = needsOrganization || mandatory;
  const canCreate =
    memberships.data?.can_create !== false &&
    !memberships.data?.organizations.some((org) => org.is_creator);
  useDialogFocus(open, panel, required ? undefined : () => setOpened(false));
  useEffect(() => {
    const show = () => setOpened(true);
    window.addEventListener(ORGANIZATION_NEEDED, show);
    return () => window.removeEventListener(ORGANIZATION_NEEDED, show);
  }, []);

  function select(id: string) {
    if (!memberships.data?.organizations.some((org) => org.id === id)) return;
    if (id === organizationId) {
      setOpened(false);
      return;
    }
    enterOrganization(id);
  }
  function enterOrganization(id: string) {
    rememberOrganization(preferenceUserId(session?.access_token), id);
    const unscoped = location.pathname.replace(/^\/o\/[^/]+/, "");
    const search = new URLSearchParams(location.search);
    search.delete("run");
    search.delete("service");
    const path = unscoped.startsWith("/workspace")
      ? unscoped
      : "/workspace/scrapers";
    navigate(organizationPath(path + (search.size ? `?${search}` : ""), id));
    setOpened(false);
    setPending(null);
  }
  async function perform(work: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof DhumiApiError && cause.status === 409
          ? "You can create only one organization. Select your existing organization to continue."
          : cause instanceof DhumiApiError && cause.status === 429
            ? "Too many requests. Wait a moment and try again."
            : "The request could not be completed. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function started(
    result: DemoOrganizationCompleted | VerificationAccepted,
  ) {
    if ("organization_id" in result) {
      await queries.invalidateQueries({ queryKey: ["organizations"] });
      enterOrganization(result.organization_id);
    } else {
      setPending(result.verification_id);
      setResendAt(Date.now() + 60_000);
      if (result.message) setError(result.message);
    }
  }
  return (
    <div className="organization-selector">
      {!mandatory && (
        <button
          className="organization-selector__button"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? "organization-dialog" : undefined}
          title={
            hasMultipleOrganizations
              ? "Switch organization"
              : "Your organization"
          }
          onClick={() => setOpened(true)}
        >
          <svg
            className="organization-selector__icon"
            aria-hidden="true"
            viewBox="0 0 24 24"
          >
            <path d="M4 21V3h12v18M16 9h4v12M2 21h20M8 7h4M8 11h4M8 15h4M8 21v-3h4v3" />
          </svg>
          <span className="organization-selector__label">
            {activeOrganization?.name ?? "Organizations"}
          </span>
          <span className="organization-selector__chevron" aria-hidden="true">
            ⌄
          </span>
        </button>
      )}
      {open &&
        createPortal(
          <div className="organization-modal">
            <div className="organization-modal__backdrop" aria-hidden="true" />
            <section
              ref={panel}
              id="organization-dialog"
              tabIndex={-1}
              className="organization-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="organization-dialog-title"
              aria-describedby="organization-dialog-intro"
            >
              {!required && (
                <button
                  className="organization-dialog__close"
                  aria-label="Close organization window"
                  type="button"
                  onClick={() => setOpened(false)}
                >
                  ×
                </button>
              )}
              <BrandMark />
              <p className="workspace-eyebrow">Your workspace</p>
              <h2 id="organization-dialog-title">
                {required
                  ? "Create your organization"
                  : hasMultipleOrganizations
                    ? "Switch organization"
                    : "Your organization"}
              </h2>
              <p id="organization-dialog-intro">
                {required
                  ? "An organization is mandatory to use services. Save scrapers, start collections and keep your results together in one workspace."
                  : hasMultipleOrganizations
                    ? "Select an organization to view its saved scrapers, collections and results."
                    : "Your saved scrapers, collections and results are kept together in this workspace."}
              </p>
              {memberships.isPending && (
                <p role="status">Loading organizations…</p>
              )}
              {memberships.isError && (
                <p role="alert">
                  Organizations could not be loaded.{" "}
                  <button
                    type="button"
                    onClick={() => void memberships.refetch()}
                  >
                    Try again
                  </button>
                </p>
              )}
              <div className="organization-choices">
                {singleActiveOrganization ? (
                  <div className="organization-choice organization-choice--summary is-selected">
                    <strong>{singleActiveOrganization.name}</strong>
                    <span>Active organization</span>
                  </div>
                ) : (
                  memberships.data?.organizations.map((org) => (
                    <button
                      className={
                        org.id === organizationId
                          ? "organization-choice is-selected"
                          : "organization-choice"
                      }
                      key={org.id}
                      type="button"
                      onClick={() => select(org.id)}
                    >
                      <strong>{org.name}</strong>{" "}
                      <span>
                        {org.is_creator
                          ? "Your organization"
                          : "Member organization"}
                        {org.id === organizationId ? " · Selected" : ""}
                      </span>
                    </button>
                  ))
                )}
              </div>
              {!pending ? (
                canCreate && memberships.isSuccess ? (
                  <form
                    className="organization-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = name.trim();
                      if (!value || value.length > 120) {
                        setError(
                          "Enter an organization name of 1–120 characters.",
                        );
                        return;
                      }
                      void perform(async () =>
                        started(await organizationsApi.create(value)),
                      );
                    }}
                  >
                    <label className="auth-field">
                      Organization name
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        required
                        maxLength={120}
                        autoComplete="organization"
                        placeholder="Your team or company"
                      />
                    </label>
                    <p className="organization-form__hint">
                      You can create one organization per account.
                    </p>
                    <button
                      className="auth-submit"
                      type="submit"
                      disabled={busy || !name.trim()}
                      aria-busy={busy}
                    >
                      {busy ? "Creating organization…" : "Create organization"}
                      <span aria-hidden="true">→</span>
                    </button>
                  </form>
                ) : (
                  memberships.isSuccess &&
                  required && (
                    <p className="organization-form__hint">
                      You have already created your organization. Contact
                      support if you need access restored.
                    </p>
                  )
                )
              ) : (
                <form
                  className="organization-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async () => {
                      const result = await organizationsApi.confirm(pending, {
                        code,
                      });
                      await queries.invalidateQueries({
                        queryKey: ["organizations"],
                      });
                      if (result.organization_id)
                        enterOrganization(result.organization_id);
                    });
                  }}
                >
                  <p>
                    Check your email for a fresh verification code. No
                    organization change has happened yet.
                  </p>
                  <label className="auth-field">
                    Verification code
                    <input
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      pattern="[0-9]{6}"
                      maxLength={6}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      required
                    />
                  </label>
                  <button className="auth-submit" type="submit" disabled={busy}>
                    Confirm
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (Date.now() < resendAt) {
                        setError("Wait 60 seconds before resending.");
                        return;
                      }
                      void perform(async () => {
                        const result = await organizationsApi.resend(pending);
                        setPending(result.verification_id);
                        setCode("");
                        setResendAt(Date.now() + 60_000);
                      });
                    }}
                  >
                    Resend code
                  </button>
                </form>
              )}
              <p className="organization-next-update-note">
                Invitations and member activity are coming in the next update,
                with email verification.
              </p>
              {!required && (
                <button
                  className="auth-submit organization-dialog__return"
                  type="button"
                  disabled={busy}
                  onClick={() => setOpened(false)}
                >
                  Back to workspace
                </button>
              )}
              {required && (
                <button
                  className="organization-dialog__signout"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await logout();
                      navigate("/", { replace: true });
                    })
                  }
                >
                  Sign out
                </button>
              )}
              {error && (
                <p className="auth-message auth-message--error" role="alert">
                  {error}
                </p>
              )}
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
