import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { WelcomePage } from "../features/authentication/WelcomePage";
import { MarketplaceShowcasePage } from "../features/marketplace/MarketplaceShowcasePage";
import { ActivityPage } from "../features/organizations/ActivityPage";
import { CollaborationNotice } from "../features/organizations/CollaborationNotice";
import { MembersPage } from "../features/organizations/MembersPage";
import { OrganizationBoundary } from "../features/organizations/OrganizationBoundary";
import { VerificationPage } from "../features/organizations/VerificationPage";
import { PriceAnalysisPage } from "../features/priceAnalysis/PriceAnalysisPage";
import { RunsWorkspacePage } from "../features/runs/RunsWorkspacePage";
import { UsageWorkspacePage } from "../features/usage/UsageWorkspacePage";
import { AmazonDomainPage } from "../features/workspace/AmazonDomainPage";
import { WorkspaceLibraryPage } from "../features/workspace/WorkspaceLibraryPage";
import { WorkspaceShell } from "../features/workspace/WorkspaceShell";
import { useSession } from "../session/useSession";

export function AppRoutes({
  isAuthenticated,
  initialAuthMode,
}: {
  readonly isAuthenticated: boolean;
  readonly initialAuthMode: "sign-in" | "sign-up" | null;
}) {
  return (
    <Routes>
      <Route path="/verify" element={<VerificationPage />} />
      <Route path="/invite" element={<CollaborationNotice />} />
      <Route
        path="/analysis"
        element={<PriceAnalysisPage isAuthenticated={isAuthenticated} />}
      />
      {isAuthenticated ? (
        <>
          {["/workspace", "/o/:organizationId/workspace"].map((prefix) => (
            <Route
              key={prefix}
              path={prefix}
              element={
                <OrganizationBoundary>
                  <WorkspaceShell />
                </OrganizationBoundary>
              }
            >
              <Route index element={<Navigate to="scrapers" replace />} />
              <Route path="scrapers" element={<WorkspaceLibraryPage />} />
              <Route
                path="scrapers/:domainSlug"
                element={<AmazonDomainPage />}
              />
              <Route
                path="scrapers/:domainSlug/:templateSlug"
                element={<AmazonDomainPage />}
              />
              <Route
                path="marketplace/*"
                element={<MarketplaceShowcasePage />}
              />
              <Route path="runs" element={<RunsWorkspacePage />} />
              <Route path="usage" element={<UsageWorkspacePage />} />
              <Route path="members" element={<MembersPage />} />
              <Route path="activity" element={<ActivityPage />} />
            </Route>
          ))}
          <Route
            path="*"
            element={<Navigate to="/workspace/scrapers" replace />}
          />
        </>
      ) : (
        <Route
          path="*"
          element={<WelcomePage initialAuthMode={initialAuthMode} />}
        />
      )}
    </Routes>
  );
}

export function App() {
  const { isAuthenticated, isRestoring } = useSession();
  if (isRestoring)
    return (
      <main className="organization-entry">
        <p role="status">Restoring your session…</p>
      </main>
    );
  const initialAuthMode =
    window.location.pathname === "/sign-up"
      ? "sign-up"
      : window.location.pathname === "/sign-in"
        ? "sign-in"
        : null;

  return (
    <BrowserRouter>
      <AppRoutes
        isAuthenticated={isAuthenticated}
        initialAuthMode={initialAuthMode}
      />
    </BrowserRouter>
  );
}
