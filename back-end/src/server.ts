import pino from "pino";
import path from "node:path";
import { loadOrganizationWorkflowConfig, loadOrganizationInviteResendLifetimeDays, loadOrganizationCollaborationEnabled } from "./config/organizationEnvironment.js";
import { createRestoreSessionService } from "./services/identity/restoreSessionService.js";
import { createAcsEmailSender, createFileEmailSender, createDisabledEmailSender } from "./services/organizations/verificationEmail.js";
import { createOrganizationWorkflowRepository } from "./services/organizations/organizationWorkflowRepository.js";
import { createOrganizationWorkflowService } from "./services/organizations/organizationWorkflowService.js";
import { buildApp } from "./app.js";
import { requireExecutionContraction, requireMarketplaceContraction } from './services/database/refactorSchemaGate.js';
import { createOrganizationActivityService } from './services/organizations/organizationActivity.js';
import { loadRuntimeConfig } from "./config/environment.js";
import { createLoggerOptions, safeErrorLogContext } from "./config/logger.js";
import { createAccessTokenService } from "./helpers/accessToken.js";
import { createCsrfService } from "./helpers/csrf.js";
import { createPasswordHasher } from "./helpers/password.js";
import { createRefreshTokenService } from "./helpers/refreshToken.js";
import { createDatabasePools } from "./services/database/pools.js";
import { createBrowserAuthenticationRepository } from "./services/identity/browserAuthenticationRepository.js";
import { createBrowserAuthenticationService } from "./services/identity/browserAuthenticationService.js";
import { createLogoutRepository } from "./services/identity/logoutRepository.js";
import { createLogoutService } from "./services/identity/logoutService.js";
import { createSignInRepository } from "./services/identity/signInRepository.js";
import { createSignInService } from "./services/identity/signInService.js";
import { createRefreshRepository } from "./services/identity/refreshRepository.js";
import { createRefreshService } from "./services/identity/refreshService.js";
import { createSignupRepository } from "./services/identity/signupRepository.js";
import { createSignupService } from "./services/identity/signupService.js";
import { createTenantAuthorizationRepository } from "./services/tenantAccess/tenantAuthorizationRepository.js";
import { createTenantAuthorizationService } from "./services/tenantAccess/tenantAuthorizationService.js";
import { createWorkspaceRepository } from "./services/workspace/workspaceRepository.js";
import { createWorkspaceService } from "./services/workspace/workspaceService.js";
import { verifyDatabasePools } from "./services/database/roleVerification.js";
import { createListCatalogTemplatesRepository } from "./services/catalogue/listCatalogTemplatesRepository.js";
import { createListCatalogTemplatesService } from "./services/catalogue/listCatalogTemplatesService.js";
import { createGetCatalogTemplateRepository } from "./services/catalogue/getCatalogTemplateRepository.js";
import { createGetCatalogTemplateService } from "./services/catalogue/getCatalogTemplateService.js";
import { createListServicesRepository } from "./services/customerServices/listServicesRepository.js";
import { createListServicesService } from "./services/customerServices/listServicesService.js";
import { createServiceRepository } from "./services/customerServices/createServiceRepository.js";
import { createServiceService } from "./services/customerServices/createServiceService.js";
import { createGetServiceRepository } from "./services/customerServices/getServiceRepository.js";
import { createGetServiceService } from "./services/customerServices/getServiceService.js";
import { createServiceConfigurationValidator } from "./helpers/serviceConfigurationValidator.js";
import { createRunRepository } from "./services/admission/createRunRepository.js";
import { createRunService } from "./services/admission/createRunService.js";
import { createListRunsRepository } from "./services/runQuery/listRunsRepository.js";
import { createListRunsService } from "./services/runQuery/listRunsService.js";
import { createGetRunRepository } from "./services/runQuery/getRunRepository.js";
import { createGetRunService } from "./services/runQuery/getRunService.js";
import { createListRunEventsRepository } from "./services/runQuery/listRunEventsRepository.js";
import { createListRunEventsService } from "./services/runQuery/listRunEventsService.js";
import { createCancelRunRepository } from "./services/admission/cancelRunRepository.js";
import { createCancelRunService } from "./services/admission/cancelRunService.js";
import { createRetryRunRepository } from "./services/admission/retryRunRepository.js";
import { createRetryRunService } from "./services/admission/retryRunService.js";
import { createGetRunResultRepository } from "./services/runQuery/getRunResultRepository.js";
import { createGetRunResultService } from "./services/runQuery/getRunResultService.js";
import { createConfiguredResultUrlSigner } from "./services/storage/resultStorageComposition.js";
import { createGetUsageSummaryRepository } from "./services/usage/getUsageSummaryRepository.js";
import { createGetUsageSummaryService } from "./services/usage/getUsageSummaryService.js";
import { createListUsageEventsRepository } from "./services/usage/listUsageEventsRepository.js";
import { createListUsageEventsService } from "./services/usage/listUsageEventsService.js";
import { createGetPlatformStatusRepository } from "./services/status/getPlatformStatusRepository.js";
import { createGetPlatformStatusService } from "./services/status/getPlatformStatusService.js";
import { createMarketplacePreviewRepository } from
  "./services/marketplacePreview/marketplacePreviewRepository.js";
import { createMarketplacePreviewService } from
  "./services/marketplacePreview/marketplacePreviewService.js";
import { createConfiguredMarketplaceSampleStore } from
  "./services/marketplaceSample/azuriteMarketplaceSampleStore.js";
import type { MarketplaceSampleStore } from
  "./services/marketplaceSample/marketplaceSampleStore.js";
import { createMarketplaceSampleDownloadRepository } from
  "./services/marketplaceSampleDownload/marketplaceSampleDownloadRepository.js";
import { createMarketplaceSampleDownloadService } from
  "./services/marketplaceSampleDownload/marketplaceSampleDownloadService.js";
import { createConfiguredMarketplaceSampleDownloadStore } from
  "./services/marketplaceSampleDownload/azuriteMarketplaceSampleDownloadStore.js";
import {
  createUnavailableMarketplaceSampleDownloadStore,
} from "./services/marketplaceSampleDownload/marketplaceSampleDownloadStore.js";
import { createMarketplaceExpertEnquiryRepository } from
  "./services/marketplaceExpertEnquiry/marketplaceExpertEnquiryRepository.js";
import { createMarketplaceExpertEnquiryService } from
  "./services/marketplaceExpertEnquiry/marketplaceExpertEnquiryService.js";

async function start(): Promise<void> {
  const config = loadRuntimeConfig();
  const organizationConfig = loadOrganizationWorkflowConfig();
  const collaborationEnabled = loadOrganizationCollaborationEnabled();
  const inviteResendLifetimeDays = loadOrganizationInviteResendLifetimeDays();
  const bootstrapLogger = pino(createLoggerOptions(config));
  const pools = createDatabasePools(config.database, (poolName, error) => {
    bootstrapLogger.error(
      { ...safeErrorLogContext(error), pool: poolName },
      "Unexpected idle database client error",
    );
  });
  // Composition root: pools become a repository, the repository plus the
  // password hasher become a service, and only the service reaches the app.
  try {await requireExecutionContraction(pools.identity);await requireMarketplaceContraction(pools.identity);}catch(error){await pools.close();throw error;}
  const signupService = createSignupService({
    repository: createSignupRepository(pools.identity),
    passwordHasher: createPasswordHasher(config.passwordHash),
    legal: config.legal,
  });
  const passwordHasher = createPasswordHasher(config.passwordHash);
  const accessTokens = createAccessTokenService(config.session.accessToken);
  const refreshTokens = createRefreshTokenService();
  const csrf = createCsrfService(config.session.accessToken.secret);
  const workflowEmail = organizationConfig.demoDisableOtp ? createDisabledEmailSender()
    : organizationConfig.email.driver === "acs" ? createAcsEmailSender(organizationConfig.email)
    : await createFileEmailSender(organizationConfig.email, path.resolve(".runtime/mail"));
  const organizationWorkflowService = createOrganizationWorkflowService({
    repository: createOrganizationWorkflowRepository({ identityPool: pools.identity, customerPool: pools.customerApi,
      otpSecret: organizationConfig.demoDisableOtp ? "" : organizationConfig.email.otpSecret,
      demoDisableOtp: organizationConfig.demoDisableOtp, publicUrl: organizationConfig.publicUrl, inviteResendLifetimeDays }),
    passwordHasher, csrf, email: workflowEmail, demoDisableOtp: organizationConfig.demoDisableOtp, collaborationEnabled,
    recordDelivery: (traceId, outcome, receipt, purpose) => bootstrapLogger.info({ traceId, outcome, purpose,
      operationId: receipt?.operationId, operationLocation: receipt?.operationLocation, retryAfterSeconds: receipt?.retryAfterSeconds }, "Organization email handoff"),
  });
  const signInService = createSignInService({
    repository: createSignInRepository(pools.identity),
    passwordHasher,
    accessTokens,
    refreshTokens,
    csrf,
    session: config.session,
    lockout: config.lockout,
  });
  const refreshService = createRefreshService({
    repository: createRefreshRepository(pools.identity),
    accessTokens,
    refreshTokens,
    csrf,
  });
  const browserAuthenticationService = createBrowserAuthenticationService({
    accessTokens,
    repository: createBrowserAuthenticationRepository(pools.identity),
  });
  const logoutService = createLogoutService({
    repository: createLogoutRepository(pools.identity),
    csrf,
  });
  const tenantAuthorizationService = createTenantAuthorizationService({
    repository: createTenantAuthorizationRepository(pools.identity),
  });
  const workspaceService = createWorkspaceService({
    repository: createWorkspaceRepository(pools.customerApi),
  });
  const listCatalogTemplatesService = createListCatalogTemplatesService({
    repository: createListCatalogTemplatesRepository(pools.customerApi),
  });
  const getCatalogTemplateService = createGetCatalogTemplateService({
    repository: createGetCatalogTemplateRepository(pools.customerApi),
  });
  const listServicesService = createListServicesService({
    repository: createListServicesRepository(pools.customerApi),
  });
  const createServiceServiceInstance = createServiceService({
    repository: createServiceRepository(pools.admission),
    validator: createServiceConfigurationValidator(),
    csrf,
    providerEnvironment: config.providerEnvironment,
  });
  const getServiceService = createGetServiceService({
    repository: createGetServiceRepository(pools.customerApi),
  });
  const runConfigurationValidator = createServiceConfigurationValidator();
  const createRunServiceInstance = createRunService({
    repository: createRunRepository(pools.admission),
    validator: runConfigurationValidator,
    csrf,
    providerEnvironment: config.providerEnvironment,
  });
  const listRunsService = createListRunsService({
    repository: createListRunsRepository(pools.customerApi),
  });
  const getRunService = createGetRunService({
    repository: createGetRunRepository(pools.customerApi),
  });
  const listRunEventsService = createListRunEventsService({
    repository: createListRunEventsRepository(pools.customerApi),
  });
  const cancelRunService = createCancelRunService({
    repository: createCancelRunRepository(pools.admission),
    csrf,
  });
  const retryRunService = createRetryRunService({
    repository: createRetryRunRepository(pools.admission),
    validator: runConfigurationValidator,
    csrf,
    providerEnvironment: config.providerEnvironment,
  });
  const getRunResultService = createGetRunResultService({
    repository: createGetRunResultRepository(pools.customerApi),
    // Pattern 3 composes a real local signer only when validated Azurite
    // configuration is present. Production remains unavailable until the
    // managed-identity Azure adapter passes its deployment gate.
    urlSigner: await createConfiguredResultUrlSigner(config.resultStorage),
  });
  const getUsageSummaryService = createGetUsageSummaryService({
    repository: createGetUsageSummaryRepository(pools.customerApi),
  });
  const listUsageEventsService = createListUsageEventsService({
    repository: createListUsageEventsRepository(pools.customerApi),
  });
  const getPlatformStatusService = createGetPlatformStatusService({
    repository: createGetPlatformStatusRepository(
      pools.customerApi,
      config.providerEnvironment,
    ),
  });
  const marketplaceSampleStore: MarketplaceSampleStore =
    config.resultStorage.driver === "azurite" &&
    config.resultStorage.connectionString !== null
      ? await createConfiguredMarketplaceSampleStore({
          connectionString: config.resultStorage.connectionString,
          containerName: config.resultStorage.containerName,
        })
      : {
          async open(): Promise<never> {
            throw new Error("Marketplace sample storage is unavailable");
          },
          async putImmutable(): Promise<never> {
            throw new Error("Marketplace sample storage is unavailable");
          },
          async deleteAndVerify(): Promise<never> {
            throw new Error("Marketplace sample storage is unavailable");
          },
        };
  const marketplacePreviewService = createMarketplacePreviewService({
    repository: createMarketplacePreviewRepository(pools.customerApi),
    store: marketplaceSampleStore,
    csrf,
    cursorSecret: config.session.accessToken.secret,
    maxBytes: config.resultStorage.maxBytes,
  });
  const marketplaceSampleDownloadStore =
    config.resultStorage.driver === "azurite" && config.resultStorage.connectionString !== null
      ? await createConfiguredMarketplaceSampleDownloadStore({
          connectionString: config.resultStorage.connectionString,
          containerName: config.resultStorage.containerName,
          ...(config.resultStorage.publicBaseUrl ? { publicBaseUrl: config.resultStorage.publicBaseUrl } : {}),
        })
      : createUnavailableMarketplaceSampleDownloadStore();
  const marketplaceSampleDownloadService = createMarketplaceSampleDownloadService({
    preview: marketplacePreviewService,
    repository: createMarketplaceSampleDownloadRepository(pools.customerApi),
    store: marketplaceSampleDownloadStore,
    csrf,
    ...config.marketplaceSampleDownload,
  });
  const marketplaceExpertEnquiryService = createMarketplaceExpertEnquiryService({
    repository: createMarketplaceExpertEnquiryRepository(pools.customerApi),
    csrf,
  });
  const app = await buildApp(config, {
    organizationActivityService:createOrganizationActivityService(pools.customerApi,{enabled:collaborationEnabled}),
    organizationWorkflowService,
    signupService,
    signInService,
    refreshService,
    restoreSessionService: createRestoreSessionService({ pool: pools.identity, accessTokens, csrf, refreshTokens }),
    browserAuthenticationService,
    logoutService,
    tenantAuthorizationService,
    workspaceService,
    listCatalogTemplatesService,
    getCatalogTemplateService,
    listServicesService,
    createServiceService: createServiceServiceInstance,
    getServiceService,
    createRunService: createRunServiceInstance,
    listRunsService,
    getRunService,
    listRunEventsService,
    cancelRunService,
    retryRunService,
    getRunResultService,
    getUsageSummaryService,
    listUsageEventsService,
    getPlatformStatusService,
    marketplacePreviewService,
    marketplaceSampleDownloadService,
    marketplaceExpertEnquiryService,
  });
  let shuttingDown = false;
  app.addHook("onClose", async () => { workflowEmail.close(); });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Graceful shutdown started");
    await app.close();
    await pools.close();
    app.log.info("Graceful shutdown completed");
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await verifyDatabasePools(
      pools,
      config.database.identity.user,
      config.database.customerApi.user,
      config.database.admission.user,
    );
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    await pools.close();
    throw error;
  }
}

start().catch((error: unknown) => {
  const fallbackLogger = pino({ base: { service: "dhumi-customer-facing-backend" } });
  fallbackLogger.error(safeErrorLogContext(error), "Backend startup failed");
  process.exitCode = 1;
});
