import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { loadJobManagerConfig } from "../config/pattern4Environment.js";
import { createLoggerOptions, safeErrorLogContext } from "../config/logger.js";
import {
  createJobManagerPool,
  createResultRecorderPool,
} from "../services/database/pools.js";
import {
  verifyJobManagerPool,
  verifyResultRecorderPool,
} from "../services/database/roleVerification.js";
import { createSyntheticControlledRunExecutor } from "../services/jobs/controlledRunExecutor.js";
import { createBrightDataIntegrationClient } from "../services/brightdata/brightDataIntegrationClient.js";
import { currentProviderCallRecorder,createRecordedRunExecutor } from '../services/brightdata/providerCallContext.js';
import { requireExecutionContraction } from '../services/database/refactorSchemaGate.js';
import { createBrightDataRunExecutor } from "../services/brightdata/brightDataRunExecutor.js";
import { createProviderExecutionPlanRepository } from "../services/brightdata/providerExecutionPlanRepository.js";
import { createProviderRunExecutorRouter } from "../services/brightdata/providerRunExecutorRouter.js";
import { createVersionedProviderRunExecutor } from "../services/brightdata/versionedProviderRunExecutor.js";
import { AMAZON_EXECUTOR_IDENTITIES } from "../services/brightdata/amazonExecutorIdentities.js";
import { createScraperExecutionRepository } from "../services/brightdata/scrapers/scraperExecutionRepository.js";
import { createScraperProcessing } from "../services/scrapers/scraperProcessing.js";
import { createSharedScraperRunExecutor } from "../services/brightdata/scrapers/sharedScraperRunExecutor.js";
import { SHARED_SCRAPER_ADAPTER_CODE, SHARED_SCRAPER_ADAPTER_VERSION, SHARED_SCRAPER_ARTIFACT_DIGEST } from "../services/scrapers/sharedScraperVersion.js";
import type { ControlledRunExecutor } from "../services/jobs/controlledRunExecutor.js";
import { createLocalProviderReferenceProtector } from "../services/brightdata/providerReferenceProtector.js";
import { createLocalEnvironmentSecretProvider } from "../services/secrets/localEnvironmentSecretProvider.js";
import { createJobManagerService } from "../services/jobs/jobManagerService.js";
import { createRedisCapacityLeaseStore } from "../services/jobs/redisCapacityLeaseStore.js";
import { createRunExecutionRepository } from "../services/jobs/runExecutionRepository.js";
import { createServiceBusJobCommandReceiver } from "../services/jobs/serviceBusExecutionQueue.js";
import { createResultArtifactFinalizerRepository } from "../services/storage/resultArtifactFinalizerRepository.js";
import { createResultIngestionService } from "../services/storage/resultIngestionService.js";
import { createConfiguredResultObjectStore } from "../services/storage/resultStorageComposition.js";
import { runJobManagerSubscription } from "./jobManagerSubscription.js";

export async function startJobManager(): Promise<void> {
  const config = loadJobManagerConfig();
  const logger = pino(createLoggerOptions(config, "dhumi-job-manager"));
  const jobPool = createJobManagerPool(config.database, (error) => {
    logger.error(safeErrorLogContext(error), "Unexpected Job Manager database client error");
  });
  const resultPool = createResultRecorderPool(config.resultRecorderDatabase, (error) => {
    logger.error(safeErrorLogContext(error), "Unexpected result-recorder database client error");
  });
  const receiver = createServiceBusJobCommandReceiver(config.serviceBus, config.concurrency);
  let leaseStore: Awaited<ReturnType<typeof createRedisCapacityLeaseStore>> | undefined;
  let shutdownSignal: NodeJS.Signals | undefined;
  const abortController = new AbortController();
  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shutdownSignal !== undefined) return;
    shutdownSignal = signal;
    logger.info({ signal }, "Job Manager shutdown requested");
    abortController.abort();
  };
  const onSigint = (): void => requestShutdown("SIGINT");
  const onSigterm = (): void => requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await requireExecutionContraction(jobPool,'dhumi_job_manager');
    await Promise.all([
      verifyJobManagerPool(jobPool, config.database.credential.user),
      verifyResultRecorderPool(resultPool, config.resultRecorderDatabase.credential.user),
    ]);
    leaseStore = await createRedisCapacityLeaseStore({
      url: config.redisUrl,
      keyPrefix: config.redisLeasePrefix,
      onError: (error) => {
        logger.error(safeErrorLogContext(error), "Redis capacity lease connection failed");
      },
    });
    const objectStore = await createConfiguredResultObjectStore(config.resultStorage);
    const ingestion = createResultIngestionService({
      store: objectStore,
      finalizer: createResultArtifactFinalizerRepository(resultPool),
      maxBytes: config.resultStorage.maxBytes,
    });
    const providerEnvironment=config.nodeEnv==='development'?'local' as const:config.nodeEnv;
    const providerRepository = createProviderExecutionPlanRepository(jobPool,providerEnvironment);
    let executor: ControlledRunExecutor;
    if (config.executor.driver === "controlled") {
      executor = createSyntheticControlledRunExecutor(ingestion);
    } else {
      const common = {
        secretProvider: createLocalEnvironmentSecretProvider(config.nodeEnv),
        protector: createLocalProviderReferenceProtector(config.nodeEnv, config.executor.providerReferenceLocalKey),
        client: createBrightDataIntegrationClient({
          recorder:currentProviderCallRecorder,
          requestTimeoutMs: config.executor.requestTimeoutMs,
          controlResponseMaxBytes: config.executor.controlResponseMaxBytes,
          catalogueResponseMaxBytes: config.executor.controlResponseMaxBytes,
          resultMaxBytes: config.resultStorage.maxBytes,
        }),
        ingestion, store: objectStore, maxBytes: config.resultStorage.maxBytes,
        pollIntervalMs: config.executor.pollIntervalMs,
        pollMaxElapsedMs: config.executor.pollMaxElapsedMs,
        pollMaxConsecutiveFailures: config.executor.pollMaxConsecutiveFailures,
        providerEnvironment: config.nodeEnv === "development" ? "local" as const : config.nodeEnv,
      };
      const amazon = createBrightDataRunExecutor({ ...common, repository: providerRepository });
      if (!config.executor.sharedScraperPipelineEnabled) {
        // Preserve the currently deployed path until migration 0066 and an
        // explicit worker opt-in. No env file is modified by this refactor.
        executor = createProviderRunExecutorRouter({ repository: providerRepository, amazon });
      } else {
        const sharedRepository = createScraperExecutionRepository(jobPool, providerRepository,providerEnvironment);
        executor = createVersionedProviderRunExecutor({ repository: sharedRepository, bindings: [
          ...AMAZON_EXECUTOR_IDENTITIES.map((identity) => ({ ...identity, executor: amazon })),
          { code: SHARED_SCRAPER_ADAPTER_CODE, version: SHARED_SCRAPER_ADAPTER_VERSION, digest: SHARED_SCRAPER_ARTIFACT_DIGEST,
            executor: createSharedScraperRunExecutor({ ...common, repository: sharedRepository, processing: createScraperProcessing() }) },
        ] });
      }
      // Marketplace Filter execution is retired; only retained scraper engines are composed.
      executor=createRecordedRunExecutor(jobPool,executor);
    }
    const service = createJobManagerService({
      repository: createRunExecutionRepository(jobPool),
      leaseStore,
      executor,
      attemptLeaseMs: config.attemptLeaseMs,
      capacityLeaseMs: config.redisCapacityLeaseMs,
      renewIntervalMs: config.renewIntervalMs,
    });
    logger.info(
      { concurrency: config.concurrency, executorDriver: config.executor.driver },
      "Job Manager started",
    );
    await runJobManagerSubscription({
      receiver,
      service,
      signal: abortController.signal,
      logger,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await Promise.allSettled([
      receiver.close(),
      leaseStore?.close() ?? Promise.resolve(),
      jobPool.end(),
      resultPool.end(),
    ]);
    logger.info({ signal: shutdownSignal }, "Job Manager stopped");
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  startJobManager().catch((error: unknown) => {
    const fallbackLogger = pino({ base: { service: "dhumi-job-manager" } });
    fallbackLogger.error(safeErrorLogContext(error), "Job Manager startup failed");
    process.exitCode = 1;
  });
}
