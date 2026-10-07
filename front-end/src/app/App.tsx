import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { WelcomePage } from "../features/authentication/WelcomePage";
import { LinkedInPeoplePage } from "../features/marketplace/LinkedInPeoplePage";
import { LinkedInPostsPage } from "../features/marketplace/LinkedInPostsPage";
import { MarketplaceDatasetPage } from "../features/marketplace/MarketplaceDatasetPage";
import { MarketplaceDomainPage } from "../features/marketplace/MarketplaceDomainPage";
import { MarketplaceLibraryPage } from "../features/marketplace/MarketplaceLibraryPage";
import { ActivityPage } from "../features/organizations/ActivityPage";
import { MembersPage } from "../features/organizations/MembersPage";
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
      <Route path="/invite" element={<VerificationPage />} />
      <Route
        path="/analysis"
        element={<PriceAnalysisPage isAuthenticated={isAuthenticated} />}
      />
      {isAuthenticated ? (
        <>
          {["/workspace", "/o/:organizationId/workspace"].map((prefix) => (
            <Route key={prefix} path={prefix} element={<WorkspaceShell />}>
              <Route index element={<Navigate to="scrapers" replace />} />
              <Route path="scrapers" element={<WorkspaceLibraryPage />} />
              <Route path="scrapers/:domainSlug" element={<AmazonDomainPage />} />
              <Route path="scrapers/:domainSlug/:templateSlug" element={<AmazonDomainPage />} />
              <Route path="marketplace" element={<MarketplaceLibraryPage />} />
              <Route path="marketplace/linkedin" element={<MarketplaceDomainPage domainSlug="linkedin" />} />
              <Route path="marketplace/groups/:domainSlug" element={<MarketplaceDomainPage />} />
              <Route path="marketplace/linkedin-posts" element={<LinkedInPostsPage />} />
              <Route path="marketplace/linkedin-people" element={<LinkedInPeoplePage />} />
              <Route path="marketplace/:templateSlug" element={<MarketplaceDatasetPage />} />
              <Route path="runs" element={<RunsWorkspacePage />} />
              <Route path="usage" element={<UsageWorkspacePage />} />
              <Route path="members" element={<MembersPage />} />
              <Route path="activity" element={<ActivityPage />} />
            </Route>
          ))}
          <Route path="*" element={<Navigate to="/workspace/scrapers" replace />} />
        </>
      ) : (
        <Route path="*" element={<WelcomePage initialAuthMode={initialAuthMode} />} />
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
      <AppRoutes isAuthenticated={isAuthenticated} initialAuthMode={initialAuthMode} />
    </BrowserRouter>
  );
}
