import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ApiKeysWorkspacePage } from "../features/apiKeys/ApiKeysWorkspacePage";
import { WelcomePage } from "../features/authentication/WelcomePage";
import { LinkedInPeoplePage } from "../features/marketplace/LinkedInPeoplePage";
import { LinkedInPostsPage } from "../features/marketplace/LinkedInPostsPage";
import { MarketplaceDatasetPage } from "../features/marketplace/MarketplaceDatasetPage";
import { MarketplaceDomainPage } from "../features/marketplace/MarketplaceDomainPage";
import { MarketplaceLibraryPage } from "../features/marketplace/MarketplaceLibraryPage";
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
      <Route
        path="/analysis"
        element={<PriceAnalysisPage isAuthenticated={isAuthenticated} />}
      />
      {isAuthenticated ? (
        <>
          <Route element={<WorkspaceShell />}>
            <Route
              path="/workspace/scrapers"
              element={<WorkspaceLibraryPage />}
            />
            <Route
              path="/workspace/scrapers/:domainSlug"
              element={<AmazonDomainPage />}
            />
            <Route
              path="/workspace/scrapers/:domainSlug/:templateSlug"
              element={<AmazonDomainPage />}
            />
            <Route
              path="/workspace/marketplace"
              element={<MarketplaceLibraryPage />}
            />
            <Route
              path="/workspace/marketplace/linkedin"
              element={<MarketplaceDomainPage domainSlug="linkedin" />}
            />
            <Route
              path="/workspace/marketplace/groups/:domainSlug"
              element={<MarketplaceDomainPage />}
            />
            <Route
              path="/workspace/marketplace/linkedin-posts"
              element={<LinkedInPostsPage />}
            />
            <Route
              path="/workspace/marketplace/linkedin-people"
              element={<LinkedInPeoplePage />}
            />
            <Route
              path="/workspace/marketplace/:templateSlug"
              element={<MarketplaceDatasetPage />}
            />
            <Route path="/workspace/runs" element={<RunsWorkspacePage />} />
            <Route path="/workspace/usage" element={<UsageWorkspacePage />} />
            <Route
              path="/workspace/api-keys"
              element={<ApiKeysWorkspacePage />}
            />
          </Route>
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
  const { isAuthenticated } = useSession();
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
