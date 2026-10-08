import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  organizationPath,
  selectedOrganization,
} from "../../api/organizationScope";
import { BrandMark } from "../../components/ui/BrandMark";
import { useSession } from "../../session/useSession";
import { OrganizationPanel } from "../organizations/OrganizationPanel";
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
  const navigate = useNavigate();
  const organizationId = selectedOrganization(location.pathname);
  const workspaceQuery = useWorkspaceQuery();
  const customerLabel = identityEmail ?? "Authenticated customer";
  const customerInitial = customerLabel.slice(0, 1).toLocaleUpperCase();
  const workspaceName = workspaceQuery.data?.name ?? "Browse Dhumi";
  const workspaceState = workspaceQuery.data?.state ?? null;
  const isMarketplace = location.pathname.includes("/workspace/marketplace");

  async function signOut(): Promise<void> {
    setIsSigningOut(true);
    setSignOutError(null);

    try {
      await logout();
      navigate("/", { replace: true });
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
            to={organizationPath("/workspace/scrapers", organizationId)}
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
            to={organizationPath("/workspace/scrapers", organizationId)}
            title="Scrapers Library"
          >
            <span>01</span>
            <strong>Scrapers Library</strong>
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to={organizationPath("/workspace/marketplace", organizationId)}
            title="Dataset Marketplace"
          >
            <span>02</span>
            <strong>Dataset Marketplace</strong>
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to={organizationPath("/workspace/runs", organizationId)}
            title="Runs"
          >
            <span>03</span>
            <strong>Runs</strong>
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
            }
            to={organizationPath("/workspace/usage", organizationId)}
            title="Usage"
          >
            <span>04</span>
            <strong>Usage</strong>
          </NavLink>
          {organizationId && (
            <NavLink
              className={({ isActive }) =>
                `workspace-navigation__item${isActive ? " workspace-navigation__item--active" : ""}`
              }
              to={organizationPath("/workspace/members", organizationId)}
              title="Members"
            >
              <span>05</span>
              <strong>Members</strong>
            </NavLink>
          )}
        </nav>

        <div className="workspace-rail__footer">
          <div className="workspace-state">
            <span aria-hidden="true" />
            <span className="workspace-state__label">
              {selectedOrganization(location.pathname) &&
              workspaceQuery.isPending
                ? "Loading workspace"
                : workspaceState
                  ? `Workspace ${workspaceState}`
                  : "Browsing without an organization"}
            </span>
          </div>
          <OrganizationPanel />
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

          {isMarketplace ? (
            <div
              className="platform-status platform-status--not_enabled"
              role="status"
            >
              <span aria-hidden="true" />
              Marketplace coming soon
            </div>
          ) : (
            <PlatformStatusNotice family="scraper_library" />
          )}

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
          <Outlet key={selectedOrganization(location.pathname) ?? "browse"} />
        </main>
      </div>
    </div>
  );
}
