import Fastify, { type FastifyInstance } from "fastify";
import type { OrganizationWorkflowService } from "./services/organizations/organizationWorkflowService.js";
import type { OrganizationActivityService } from './services/organizations/organizationActivity.js';
import { installAccessSurface } from "./routes/accessSurface.js";
import type { RuntimeConfig } from "./config/environment.js";
import { createLoggerOptions } from "./config/logger.js";
import { installErrorHandling } from "./middleware/errorHandler.js";
import { createRequestId, installRequestContext, requestTraceId } from "./middleware/requestContext.js";
import { installRequestSecurity } from "./middleware/requestSecurity.js";
import { installJsonContentTypeGuard } from "./middleware/jsonContentType.js";
import { registerRoutes } from "./routes/index.js";
import type { BrowserAuthenticationService } from "./services/identity/browserAuthenticationService.js";
import type { LogoutService } from "./services/identity/logoutService.js";
import type { SignInService } from "./services/identity/signInService.js";
import type { RefreshService } from "./services/identity/refreshService.js";
import type { RestoreSessionService } from "./services/identity/restoreSessionService.js";
import type { SignupService } from "./services/identity/signupService.js";
import type { TenantAuthorizationService } from "./services/tenantAccess/tenantAuthorizationService.js";
import type { WorkspaceService } from "./services/workspace/workspaceService.js";
import type { ListCatalogTemplatesService } from "./services/catalogue/listCatalogTemplatesService.js";
import type { GetCatalogTemplateService } from "./services/catalogue/getCatalogTemplateService.js";
import type { ListServicesService } from "./services/customerServices/listServicesService.js";
import type { CreateServiceService } from "./services/customerServices/createServiceService.js";
import type { GetServiceService } from "./services/customerServices/getServiceService.js";
import type { CreateRunService } from "./services/admission/createRunService.js";
import type { CancelRunService } from "./services/admission/cancelRunService.js";
import type { RetryRunService } from "./services/admission/retryRunService.js";
import type { ListRunsService } from "./services/runQuery/listRunsService.js";
import type { GetRunService } from "./services/runQuery/getRunService.js";
import type { ListRunEventsService } from "./services/runQuery/listRunEventsService.js";
import type { GetRunResultService } from "./services/runQuery/getRunResultService.js";
import type { GetUsageSummaryService } from "./services/usage/getUsageSummaryService.js";
import type { ListUsageEventsService } from "./services/usage/listUsageEventsService.js";
import type { GetPlatformStatusService } from "./services/status/getPlatformStatusService.js";
import type { MarketplacePreviewService } from "./services/marketplacePreview/marketplacePreviewService.js";
import type { MarketplaceSampleDownloadService } from "./services/marketplaceSampleDownload/marketplaceSampleDownloadService.js";
import type { MarketplaceExpertEnquiryService } from "./services/marketplaceExpertEnquiry/marketplaceExpertEnquiryService.js";

export interface AppDependencies {
  readonly organizationActivityService?: OrganizationActivityService;
  /** Optional only for legacy test compositions. Required at runtime. */
  readonly organizationWorkflowService?: OrganizationWorkflowService;
  readonly signupService: SignupService;
  readonly signInService: SignInService;
  readonly refreshService: RefreshService;
  readonly restoreSessionService?: RestoreSessionService;
  readonly browserAuthenticationService: BrowserAuthenticationService;
  readonly logoutService: LogoutService;
  readonly tenantAuthorizationService: TenantAuthorizationService;
  readonly workspaceService: WorkspaceService;
  readonly listCatalogTemplatesService: ListCatalogTemplatesService;
  readonly getCatalogTemplateService: GetCatalogTemplateService;
  readonly listServicesService: ListServicesService;
  readonly createServiceService: CreateServiceService;
  readonly getServiceService: GetServiceService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly createRunService?: CreateRunService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly listRunsService?: ListRunsService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly getRunService?: GetRunService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly listRunEventsService?: ListRunEventsService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly getRunResultService?: GetRunResultService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly cancelRunService?: CancelRunService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly retryRunService?: RetryRunService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly getUsageSummaryService?: GetUsageSummaryService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly listUsageEventsService?: ListUsageEventsService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly getPlatformStatusService?: GetPlatformStatusService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly marketplacePreviewService?: MarketplacePreviewService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly marketplaceSampleDownloadService?: MarketplaceSampleDownloadService;
  /** Optional only for legacy test compositions; runtime startup requires it. */
  readonly marketplaceExpertEnquiryService?: MarketplaceExpertEnquiryService;
}

export async function buildApp(
  config: RuntimeConfig,
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  if(config.nodeEnv!=='test'&&!dependencies.organizationActivityService)throw new Error('organizationActivityService must be composed outside the test environment');
  if (config.nodeEnv !== "test" && !dependencies.organizationWorkflowService)
    throw new Error("organizationWorkflowService must be composed outside the test environment");
  if (config.nodeEnv !== "test" && dependencies.createRunService === undefined) {
    throw new Error("createRunService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.listRunsService === undefined) {
    throw new Error("listRunsService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.getRunService === undefined) {
    throw new Error("getRunService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.listRunEventsService === undefined) {
    throw new Error("listRunEventsService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.marketplacePreviewService === undefined) {
    throw new Error("marketplacePreviewService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.marketplaceSampleDownloadService === undefined) {
    throw new Error(
      "marketplaceSampleDownloadService must be composed outside the test environment",
    );
  }
  if (config.nodeEnv !== "test" && dependencies.marketplaceExpertEnquiryService === undefined) {
    throw new Error(
      "marketplaceExpertEnquiryService must be composed outside the test environment",
    );
  }
  if (config.nodeEnv !== "test" && dependencies.cancelRunService === undefined) {
    throw new Error("cancelRunService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.getRunResultService === undefined) {
    throw new Error("getRunResultService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.retryRunService === undefined) {
    throw new Error("retryRunService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.getUsageSummaryService === undefined) {
    throw new Error("getUsageSummaryService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.listUsageEventsService === undefined) {
    throw new Error("listUsageEventsService must be composed outside the test environment");
  }
  if (config.nodeEnv !== "test" && dependencies.getPlatformStatusService === undefined) {
    throw new Error("getPlatformStatusService must be composed outside the test environment");
  }
  const createRunService = dependencies.createRunService ?? {
    async create(): Promise<never> {
      throw new Error("createRunService was not supplied to this test application");
    },
  };
  const listRunsService = dependencies.listRunsService ?? {
    async list(): Promise<never> {
      throw new Error("listRunsService was not supplied to this test application");
    },
  };
  const getRunService = dependencies.getRunService ?? {
    async get(): Promise<never> {
      throw new Error("getRunService was not supplied to this test application");
    },
  };
  const listRunEventsService = dependencies.listRunEventsService ?? {
    async list(): Promise<never> {
      throw new Error("listRunEventsService was not supplied to this test application");
    },
  };
  const cancelRunService = dependencies.cancelRunService ?? {
    async cancel(): Promise<never> {
      throw new Error("cancelRunService was not supplied to this test application");
    },
  };
  const retryRunService = dependencies.retryRunService ?? {
    async retry(): Promise<never> {
      throw new Error("retryRunService was not supplied to this test application");
    },
  };
  const getRunResultService = dependencies.getRunResultService ?? {
    async get(): Promise<never> {
      throw new Error("getRunResultService was not supplied to this test application");
    },
  };
  const getUsageSummaryService = dependencies.getUsageSummaryService ?? {
    async get(): Promise<never> {
      throw new Error("getUsageSummaryService was not supplied to this test application");
    },
  };
  const listUsageEventsService = dependencies.listUsageEventsService ?? {
    async list(): Promise<never> {
      throw new Error("listUsageEventsService was not supplied to this test application");
    },
  };
  const getPlatformStatusService = dependencies.getPlatformStatusService ?? {
    async get(): Promise<never> {
      throw new Error("getPlatformStatusService was not supplied to this test application");
    },
  };
  const marketplacePreviewService = dependencies.marketplacePreviewService ?? {
    async get(): Promise<never> {
      throw new Error("marketplacePreviewService was not supplied to this test application");
    },
    async query(): Promise<never> {
      throw new Error("marketplacePreviewService was not supplied to this test application");
    },
  };
  const marketplaceSampleDownloadService = dependencies.marketplaceSampleDownloadService ?? {
    async authorize(): Promise<never> {
      throw new Error("marketplaceSampleDownloadService was not supplied to this test application");
    },
  };
  const marketplaceExpertEnquiryService = dependencies.marketplaceExpertEnquiryService ?? {
    async submit(): Promise<never> {
      throw new Error("marketplaceExpertEnquiryService was not supplied to this test application");
    },
  };
  const app = Fastify({
    logger: createLoggerOptions(config),
    requestIdHeader: false,
    genReqId: createRequestId,
    childLoggerFactory(logger, bindings, options, rawRequest) {
      return logger.child({ ...bindings, trace_id: requestTraceId(rawRequest) }, options);
    },
    bodyLimit: 1_048_576,
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    keepAliveTimeout: 72_000,
    trustProxy: config.trustedProxyHops === 1 ? (_address, hop) => hop === 0 : false,
    ajv: {
      customOptions: {
        // Fastify defaults to removeAdditional: true, which silently strips a
        // property that `additionalProperties: false` was meant to reject. The
        // contract requires unknown request properties to be rejected, so an
        // unexpected field must fail validation rather than disappear.
        removeAdditional: false,
        coerceTypes: false,
      },
    },
  });

  app.decorate('organizationActivityService',dependencies.organizationActivityService??{async get(){throw new Error('Activity service is not composed');}});
  app.decorate("signupService", dependencies.signupService);
  app.decorate("organizationWorkflowService", dependencies.organizationWorkflowService ?? {
    async run() { throw new Error("Organization workflows are not composed in this legacy test"); },
  });
  app.decorate("signInService", dependencies.signInService);
  app.decorate("refreshService", dependencies.refreshService);
  app.decorate("restoreSessionService", dependencies.restoreSessionService ?? { async restore() { throw new Error("Session restoration is not composed in this test"); } });
  app.decorate("browserAuthenticationService", dependencies.browserAuthenticationService);
  app.decorate("logoutService", dependencies.logoutService);
  app.decorate("tenantAuthorizationService", dependencies.tenantAuthorizationService);
  app.decorate("workspaceService", dependencies.workspaceService);
  app.decorate("listCatalogTemplatesService", dependencies.listCatalogTemplatesService);
  app.decorate("getCatalogTemplateService", dependencies.getCatalogTemplateService);
  app.decorate("listServicesService", dependencies.listServicesService);
  app.decorate("createServiceService", dependencies.createServiceService);
  app.decorate("getServiceService", dependencies.getServiceService);
  app.decorate("createRunService", createRunService);
  app.decorate("listRunsService", listRunsService);
  app.decorate("getRunService", getRunService);
  app.decorate("listRunEventsService", listRunEventsService);
  app.decorate("cancelRunService", cancelRunService);
  app.decorate("retryRunService", retryRunService);
  app.decorate("getRunResultService", getRunResultService);
  app.decorate("getUsageSummaryService", getUsageSummaryService);
  app.decorate("listUsageEventsService", listUsageEventsService);
  app.decorate("getPlatformStatusService", getPlatformStatusService);
  app.decorate("marketplacePreviewService", marketplacePreviewService);
  app.decorate("marketplaceSampleDownloadService", marketplaceSampleDownloadService);
  app.decorate("marketplaceExpertEnquiryService", marketplaceExpertEnquiryService);
  app.decorate("sessionCookie", config.session.cookie);
  app.decorateRequest("trustedSessionIdentity", null);
  app.decorateRequest("trustedTenantIdentity", null);
  app.decorateRequest("trustedTenantPrincipal", null);
  app.decorateRequest("trustedBrowsePrincipal", null);

  await installRequestSecurity(app, config);
  installRequestContext(app);
  installJsonContentTypeGuard(app);
  installErrorHandling(app);
  installAccessSurface(app);
  await registerRoutes(app, config);
  return app;
}
