import type { SessionCookieConfig } from "../config/environment.js";
import type { OrganizationWorkflowService } from "../services/organizations/organizationWorkflowService.js";
import type { OrganizationActivityService } from '../services/organizations/organizationActivity.js';
import type { AccessLevel } from "../routes/accessSurface.js";
import type {
  BrowserAuthenticationService,
  TrustedSessionIdentity,
} from "../services/identity/browserAuthenticationService.js";
import type { LogoutService } from "../services/identity/logoutService.js";
import type { SignInService } from "../services/identity/signInService.js";
import type { RefreshService } from "../services/identity/refreshService.js";
import type { RestoreSessionService } from "../services/identity/restoreSessionService.js";
import type { SignupService } from "../services/identity/signupService.js";
import type {
  TenantAuthorizationService,
  TrustedTenantIdentity,
} from "../services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "../services/workspace/workspaceService.js";
import type { TrustedTenantPrincipal } from "../services/tenantAccess/trustedTenantPrincipal.js";
import type { TrustedBrowsePrincipal } from "../services/tenantAccess/trustedBrowsePrincipal.js";
import type { ListCatalogTemplatesService } from "../services/catalogue/listCatalogTemplatesService.js";
import type { GetCatalogTemplateService } from "../services/catalogue/getCatalogTemplateService.js";
import type { ListServicesService } from "../services/customerServices/listServicesService.js";
import type { CreateServiceService } from "../services/customerServices/createServiceService.js";
import type { GetServiceService } from "../services/customerServices/getServiceService.js";
import type { CreateRunService } from "../services/admission/createRunService.js";
import type { ListRunsService } from "../services/runQuery/listRunsService.js";
import type { GetRunService } from "../services/runQuery/getRunService.js";
import type { ListRunEventsService } from "../services/runQuery/listRunEventsService.js";
import type { GetRunResultService } from "../services/runQuery/getRunResultService.js";
import type { CancelRunService } from "../services/admission/cancelRunService.js";
import type { RetryRunService } from "../services/admission/retryRunService.js";
import type { GetUsageSummaryService } from "../services/usage/getUsageSummaryService.js";
import type { ListUsageEventsService } from "../services/usage/listUsageEventsService.js";
import type { GetPlatformStatusService } from "../services/status/getPlatformStatusService.js";
import type { MarketplacePreviewService } from "../services/marketplacePreview/marketplacePreviewService.js";
import type { MarketplaceSampleDownloadService } from "../services/marketplaceSampleDownload/marketplaceSampleDownloadService.js";
import type { MarketplaceExpertEnquiryService } from "../services/marketplaceExpertEnquiry/marketplaceExpertEnquiryService.js";

declare module "fastify" {
  interface FastifyContextConfig { access?: AccessLevel }
  interface FastifyInstance {
    organizationActivityService:OrganizationActivityService;
    organizationWorkflowService: OrganizationWorkflowService;
    /**
     * Composed in the application entry point from the Identity pool. Routes
     * receive a service, never a connection pool, so controllers cannot reach
     * SQL and tests can supply a fake without a database.
     */
    signupService: SignupService;
    signInService: SignInService;
    refreshService: RefreshService;
    restoreSessionService: RestoreSessionService;
    browserAuthenticationService: BrowserAuthenticationService;
    logoutService: LogoutService;
    tenantAuthorizationService: TenantAuthorizationService;
    workspaceService: WorkspaceService;
    listCatalogTemplatesService: ListCatalogTemplatesService;
    getCatalogTemplateService: GetCatalogTemplateService;
    listServicesService: ListServicesService;
    createServiceService: CreateServiceService;
    getServiceService: GetServiceService;
    createRunService: CreateRunService;
    listRunsService: ListRunsService;
    getRunService: GetRunService;
    listRunEventsService: ListRunEventsService;
    getRunResultService: GetRunResultService;
    cancelRunService: CancelRunService;
    retryRunService: RetryRunService;
    getUsageSummaryService: GetUsageSummaryService;
    listUsageEventsService: ListUsageEventsService;
    getPlatformStatusService: GetPlatformStatusService;
    marketplacePreviewService: MarketplacePreviewService;
    marketplaceSampleDownloadService: MarketplaceSampleDownloadService;
    marketplaceExpertEnquiryService: MarketplaceExpertEnquiryService;
    sessionCookie: SessionCookieConfig;
  }

  interface FastifyRequest {
    /** Server-generated correlation UUID; caller request.id is echo/log only. */
    traceId: string;
    trustedSessionIdentity: TrustedSessionIdentity | null;
    trustedTenantIdentity: TrustedTenantIdentity | null;
    trustedTenantPrincipal: TrustedTenantPrincipal | null;
    trustedBrowsePrincipal: TrustedBrowsePrincipal | null;
  }
}
