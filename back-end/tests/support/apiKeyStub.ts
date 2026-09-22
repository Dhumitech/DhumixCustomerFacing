import type { CreateApiKeyService } from "../../src/services/apiKeys/createApiKeyService.js";
import type { ListApiKeysService } from "../../src/services/apiKeys/listApiKeysService.js";
import type { RevokeApiKeyService } from "../../src/services/apiKeys/revokeApiKeyService.js";
import type { ApiKeyAuthenticationService } from "../../src/services/apiKeys/apiKeyAuthenticationService.js";

export const stubCreateApiKeyService: CreateApiKeyService = {
  async create() {
    throw new Error("stub create-API-key service was not expected to be called");
  },
};

export const stubListApiKeysService: ListApiKeysService = {
  async list() {
    throw new Error("stub list-API-keys service was not expected to be called");
  },
};

export const stubRevokeApiKeyService: RevokeApiKeyService = {
  async revoke() {
    throw new Error("stub revoke-API-key service was not expected to be called");
  },
};

export const stubApiKeyAuthenticationService: ApiKeyAuthenticationService = {
  async authenticate() {
    throw new Error("stub API-key authentication service was not expected to be called");
  },
};
