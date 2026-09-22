import {
  decodeApiKeyListCursor,
  encodeApiKeyListCursor,
  type ApiKeyListCursorPosition,
} from "../../helpers/apiKeyListCursor.js";
import type { ApiScope } from "../../helpers/apiKeyMaterial.js";
import type { TrustedTenantIdentity } from "../tenantAccess/tenantAuthorizationService.js";
import { apiKeyValidationFailed } from "./apiKeyErrors.js";
import type {
  ApiKeyMetadataState,
  ListApiKeysRecord,
  ListApiKeysRepository,
} from "./listApiKeysRepository.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/;

export interface ApiKeyMetadata {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly ApiScope[];
  readonly state: ApiKeyMetadataState;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

export interface ApiKeyPage {
  readonly data: readonly ApiKeyMetadata[];
  readonly page: {
    readonly next_cursor: string | null;
    readonly has_more: boolean;
  };
}

export interface ListApiKeysRequest {
  readonly identity: TrustedTenantIdentity;
  readonly cursor: unknown;
  readonly limit: unknown;
  readonly schemaErrors: readonly { readonly field: string; readonly message: string }[];
}

export interface ListApiKeysService {
  list(request: ListApiKeysRequest): Promise<ApiKeyPage>;
}

export interface ListApiKeysServiceDependencies {
  readonly repository: ListApiKeysRepository;
}

function validationError(field: string, message: string): never {
  throw apiKeyValidationFailed([{ field, message }]);
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !DECIMAL_INTEGER_PATTERN.test(value)) {
    return validationError("limit", "must be an integer between 1 and 100");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return validationError("limit", "must be an integer between 1 and 100");
  }
  return parsed;
}

function parseCursor(value: unknown): ApiKeyListCursorPosition | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return validationError("cursor", "must be a valid API-key page cursor");
  }
  try {
    return decodeApiKeyListCursor(value);
  } catch {
    return validationError("cursor", "must be a valid API-key page cursor");
  }
}

function publicMetadata(record: ListApiKeysRecord): ApiKeyMetadata {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    scopes: record.scopes,
    state: record.state,
    created_at: record.createdAt.toISOString(),
    last_used_at: record.lastUsedAt?.toISOString() ?? null,
    expires_at: record.expiresAt?.toISOString() ?? null,
    revoked_at: record.revokedAt?.toISOString() ?? null,
  };
}

export function createListApiKeysService(
  dependencies: ListApiKeysServiceDependencies,
): ListApiKeysService {
  return {
    async list(request): Promise<ApiKeyPage> {
      if (request.schemaErrors.length > 0) {
        throw apiKeyValidationFailed(request.schemaErrors);
      }
      const limit = parseLimit(request.limit);
      const cursor = parseCursor(request.cursor);
      const records = await dependencies.repository.list({
        tenantId: request.identity.tenantId,
        cursor,
        fetchLimit: limit + 1,
      });
      const hasMore = records.length > limit;
      const visibleRecords = records.slice(0, limit);
      const lastVisible = visibleRecords.at(-1);

      return {
        data: visibleRecords.map(publicMetadata),
        page: {
          next_cursor:
            hasMore && lastVisible !== undefined
              ? encodeApiKeyListCursor({
                  createdAt: lastVisible.createdAt.toISOString(),
                  id: lastVisible.id,
                })
              : null,
          has_more: hasMore,
        },
      };
    },
  };
}
