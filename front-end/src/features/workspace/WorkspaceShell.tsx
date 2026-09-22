import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { BrandMark } from "../../components/ui/BrandMark";
import { useSession } from "../../session/useSession";
import { PlatformStatusNotice } from "../status/PlatformStatusNotice";
import { useWorkspaceQuery } from "./workspaceQueries";

function CollapseIcon({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={collapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"} />
    </svg>
  );
}

export function WorkspaceShell() {
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { identityEmail, logout } = useSession();
  const location = useLocation();
  const workspaceQuery = useWorkspaceQuery();
  const customerLabel = identityEmail ?? "Authenticated customer";
  const customerInitial = customerLabel.slice(0, 1).toLocaleUpperCase();
  const workspaceName = workspaceQuery.data?.name ?? "Workspace";
  const workspaceState = workspaceQuery.data?.state ?? null;
  const statusFamily = location.pathname.startsWith("/workspace/marketplace")
    ? "marketplace_dataset"
    : "scraper_library";

  async function signOut(): Promise<void> {
    setIsSigningOut(true);
    setSignOutError(null);

    try {
      await logout();
      window.history.replaceState(null, "", "/");
    } catch {
      setIsSigningOut(false);
      setSignOutError("Sign out could not be completed. Please try again.");
    }
  }

  return (
    <div
      className={`workspace-page${railCollapsed ? " workspace-page--rail-collapsed" : ""}`}
    >
      <a className="skip-link" href="#workspace-main">
        Skip to workspace content
      </a>

      <aside className="workspace-rail" aria-label="Workspace navigation">
        <div className="workspace-rail__header">
          <NavLink
            className="workspace-brand"
            to="/workspace/scrapers"
            aria-label="Dhumi Data Scrappers home"
          >
            <BrandMark compact={railCollapsed} />
          </NavLink>
          <button
            className="workspace-rail__toggle"
            type="button"
            aria-label={
              railCollapsed ? "Expand navigation" : "Collapse navigation"
            }
            aria-expanded={!railCollapsed}
            onClick={() => setRailCollapsed((collapsed) => !collapsed)}
          >
            <CollapseIcon collapsed={railCollapsed} />
          </button>
        </div>

        <nav className="workspace-navigation" aria-label="Customer workspace">
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to="/workspace/scrapers"
            title="Scrapers Library"
          >
            <span>01</span>
            <strong>Scrapers Library</strong>
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to="/workspace/marketplace"
            title="Dataset Marketplace"
          >
            <span>02</span>
            <strong>Dataset Marketplace</strong>
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to="/workspace/runs"
            title="Runs"
          >
            <span>03</span>
            <strong>Runs</strong>
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to="/workspace/usage"
            title="Usage"
          >
            <span>04</span>
            <strong>Usage</strong>
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to="/workspace/api-keys"
            title="API Keys"
          >
            <span>05</span>
            <strong>API Keys</strong>
          </NavLink>
        </nav>

        <div className="workspace-rail__footer">
          <div className="workspace-state">
            <span aria-hidden="true" />
            <span className="workspace-state__label">
              {workspaceQuery.isPending
                ? "Loading workspace"
                : workspaceState
                  ? `Workspace ${workspaceState}`
                  : "Workspace unavailable"}
            </span>
          </div>
          <strong>{workspaceName}</strong>
          <small title={customerLabel}>{customerLabel}</small>
          <button
            className="workspace-signout"
            type="button"
            disabled={isSigningOut}
            aria-busy={isSigningOut}
            onClick={signOut}
          >
            <span aria-hidden="true">↪</span>
            <span className="workspace-signout__label">
              {isSigningOut ? "Signing out…" : "Sign out"}
            </span>
          </button>
          {signOutError && (
            <span className="workspace-signout__error" role="alert">
              {signOutError}
            </span>
          )}
        </div>
      </aside>

      <div className="workspace-stage">
        <header className="workspace-topbar">
          <div className="workspace-topbar__identity">
            <p className="workspace-eyebrow">Workspace</p>
            <h1>{workspaceName}</h1>
            {workspaceState && (
              <span className="workspace-topbar__state">{workspaceState}</span>
            )}
            {workspaceQuery.isError && (
              <span className="workspace-topbar__error" role="alert">
                Workspace details could not be loaded.
              </span>
            )}
          </div>

          <PlatformStatusNotice family={statusFamily} />

          <div className="workspace-account">
            <span className="workspace-account__avatar" aria-hidden="true">
              {customerInitial}
            </span>
            <span>
              <small>Signed in as</small>
              <strong title={customerLabel}>{customerLabel}</strong>
            </span>
          </div>
        </header>

        <main className="workspace-content" id="workspace-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
