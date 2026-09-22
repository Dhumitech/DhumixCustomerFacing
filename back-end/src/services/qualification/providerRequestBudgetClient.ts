import type { BrightDataIntegrationClient } from
  "../brightdata/brightDataIntegrationClient.js";

export class QualificationProviderRequestBudgetError extends Error {
  public readonly code:
    | "QUALIFICATION_PROVIDER_REQUEST_BUDGET_INVALID"
    | "QUALIFICATION_PROVIDER_REQUEST_BUDGET_EXHAUSTED";

  public constructor(
    code:
      | "QUALIFICATION_PROVIDER_REQUEST_BUDGET_INVALID"
      | "QUALIFICATION_PROVIDER_REQUEST_BUDGET_EXHAUSTED",
  ) {
    super("The private qualification provider-request budget was not satisfied");
    this.name = "QualificationProviderRequestBudgetError";
    this.code = code;
  }
}

export function createQualificationProviderRequestBudgetClient(
  client: BrightDataIntegrationClient,
  maximumRequests: number,
): BrightDataIntegrationClient {
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1) {
    throw new QualificationProviderRequestBudgetError(
      "QUALIFICATION_PROVIDER_REQUEST_BUDGET_INVALID",
    );
  }

  let consumedRequests = 0;
  const consume = (): void => {
    if (consumedRequests >= maximumRequests) {
      throw new QualificationProviderRequestBudgetError(
        "QUALIFICATION_PROVIDER_REQUEST_BUDGET_EXHAUSTED",
      );
    }
    consumedRequests += 1;
  };

  const budgeted: BrightDataIntegrationClient = {
    async listScrapers(input) {
      consume();
      return await client.listScrapers(input);
    },
    async submit(input) {
      consume();
      return await client.submit(input);
    },
    async trigger(input) {
      consume();
      return await client.trigger(input);
    },
    async getProgress(input) {
      consume();
      return await client.getProgress(input);
    },
    async getParts(input) {
      consume();
      return await client.getParts(input);
    },
    async download(input) {
      consume();
      return await client.download(input);
    },
    async cancel(input) {
      consume();
      return await client.cancel(input);
    },
  };
  return Object.freeze(budgeted);
}
