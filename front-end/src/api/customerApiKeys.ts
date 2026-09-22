import { tokenStore } from "../session/tokenStore";
import { dhumiClient } from "./client";
import { asDhumiRequest } from "./errors";
import {
  type ApiKeyCreated,
  type ApiKeyCreateInput,
  type ApiKeyPage,
  createApiKey as generatedCreateApiKey,
  listApiKeys as generatedListApiKeys,
  revokeApiKey as generatedRevokeApiKey,
} from "./generated";
import {
  acquireMutationIdempotency,
  completeMutationIdempotency,
} from "./mutationIdempotency";

const MAX_PAGE_SIZE = 100;

function currentCsrfToken(): string {
  const session = tokenStore.getSnapshot();
  if (session === null) {
    throw new Error("An authenticated browser session is required.");
  }
  return session.csrf_token;
}

export const apiKeysApi = Object.freeze({
  async list(cursor?: string): Promise<ApiKeyPage> {
    const response = await asDhumiRequest(
      generatedListApiKeys({
        client: dhumiClient,
        query: {
          limit: MAX_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
        throwOnError: true,
      }),
    );
    return response.data;
  },

  async create(input: ApiKeyCreateInput): Promise<ApiKeyCreated> {
    const lease = await acquireMutationIdempotency("api-key.create", input);
    const response = await asDhumiRequest(
      generatedCreateApiKey({
        client: dhumiClient,
        body: input,
        headers: {
          "X-CSRF-Token": currentCsrfToken(),
          "Idempotency-Key": lease.headerValue,
        },
        throwOnError: true,
      }),
    );
    completeMutationIdempotency(lease);
    return response.data;
  },

  async revoke(keyId: string): Promise<void> {
    await asDhumiRequest(
      generatedRevokeApiKey({
        client: dhumiClient,
        path: { key_id: keyId },
        headers: { "X-CSRF-Token": currentCsrfToken() },
        throwOnError: true,
      }),
    );
  },
});
