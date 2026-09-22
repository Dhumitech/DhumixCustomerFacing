import { type FormEvent, useMemo, useState } from "react";
import type { ApiKeyMetadata, ApiScope } from "../../api/generated";
import {
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useRevokeApiKeyMutation,
} from "./apiKeyQueries";
import "./apiKeysWorkspace.css";

const SCOPES: ReadonlyArray<{
  readonly value: ApiScope;
  readonly label: string;
}> = [
  { value: "catalog:read", label: "Browse catalogue" },
  { value: "services:read", label: "Read scrapers" },
  { value: "services:write", label: "Create scrapers" },
  { value: "runs:read", label: "Read collections" },
  { value: "runs:write", label: "Start and manage collections" },
  { value: "results:read", label: "Download results" },
  { value: "usage:read", label: "Read usage" },
];

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function keyStateLabel(key: ApiKeyMetadata): string {
  return `${key.state.slice(0, 1).toLocaleUpperCase()}${key.state.slice(1)}`;
}

export function ApiKeysWorkspacePage() {
  const keysQuery = useApiKeysQuery();
  const createMutation = useCreateApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<ApiScope>>(
    () => new Set<ApiScope>(),
  );
  const [revokeCandidate, setRevokeCandidate] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const keys = useMemo(
    () => keysQuery.data?.pages.flatMap((page) => page.data) ?? [],
    [keysQuery.data],
  );

  function toggleScope(scope: ApiScope): void {
    setSelectedScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (selectedScopes.size === 0) return;
    createMutation.reset();
    setCopyState("idle");
    try {
      await createMutation.mutateAsync({
        name: name.trim(),
        scopes: [...selectedScopes],
        ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      });
    } catch {
      return;
    }
    setName("");
    setExpiresAt("");
    setSelectedScopes(new Set<ApiScope>());
  }

  async function copySecret(): Promise<void> {
    const secret = createMutation.data?.secret;
    if (!secret) return;
    if (!navigator.clipboard) {
      setCopyState("manual");
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
    }
  }

  async function confirmRevoke(keyId: string): Promise<void> {
    try {
      await revokeMutation.mutateAsync(keyId);
    } catch {
      return;
    }
    setRevokeCandidate(null);
  }

  return (
    <section className="keys-page" aria-labelledby="keys-title">
      <header className="keys-page__header">
        <div>
          <p className="workspace-eyebrow">Developer access</p>
          <h2 id="keys-title">Dhumi API keys</h2>
          <p>
            Create scoped credentials for Dhumi APIs. Provider credentials are
            never exposed here.
          </p>
        </div>
        <span>{keys.length} loaded</span>
      </header>

      <div className="keys-layout">
        <form className="key-create" onSubmit={(event) => void submit(event)}>
          <div className="key-create__intro">
            <span className="key-section-kicker">New credential</span>
            <h3>Create an API key</h3>
            <p>The complete secret is shown once. Store it before leaving.</p>
          </div>

          <label className="key-field">
            <span>Key name</span>
            <input
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Reporting integration"
              autoComplete="off"
            />
          </label>

          <fieldset className="key-scopes">
            <legend>Permissions</legend>
            {SCOPES.map((scope) => (
              <label key={scope.value}>
                <input
                  type="checkbox"
                  checked={selectedScopes.has(scope.value)}
                  onChange={() => toggleScope(scope.value)}
                />
                <span>
                  <strong>{scope.label}</strong>
                  <code>{scope.value}</code>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="key-field">
            <span>Expiry · Optional</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>

          {createMutation.isError && (
            <p className="key-message key-message--error" role="alert">
              The API key could not be created. Review the fields and try again.
            </p>
          )}

          <button
            className="key-primary-action"
            type="submit"
            disabled={
              createMutation.isPending ||
              name.trim().length === 0 ||
              selectedScopes.size === 0
            }
          >
            {createMutation.isPending ? "Creating…" : "Create API key"}
          </button>
        </form>

        <section className="key-list" aria-labelledby="saved-keys-title">
          <div className="key-list__heading">
            <div>
              <span className="key-section-kicker">Workspace credentials</span>
              <h3 id="saved-keys-title">Saved API keys</h3>
            </div>
            {keysQuery.isFetching && !keysQuery.isPending && (
              <small role="status">Refreshing…</small>
            )}
          </div>

          {createMutation.data && (
            <aside
              className="key-secret"
              aria-labelledby="new-key-secret-title"
            >
              <div>
                <span className="key-section-kicker">Created successfully</span>
                <h4 id="new-key-secret-title">Copy this secret now</h4>
              </div>
              <code>{createMutation.data.secret}</code>
              <p>
                Dhumi does not display this complete secret in the key list.
              </p>
              <div>
                <button type="button" onClick={() => void copySecret()}>
                  {copyState === "copied" ? "Copied" : "Copy secret"}
                </button>
                <button type="button" onClick={() => createMutation.reset()}>
                  I have stored it
                </button>
              </div>
              {copyState === "manual" && (
                <small role="status">
                  Select and copy the secret manually.
                </small>
              )}
            </aside>
          )}

          {keysQuery.isPending ? (
            <div className="key-list__state" role="status">
              Loading API keys…
            </div>
          ) : keysQuery.isError ? (
            <div className="key-list__state key-message--error" role="alert">
              API keys could not be loaded.
            </div>
          ) : keys.length === 0 ? (
            <div className="key-list__state">
              <strong>No API keys yet.</strong>
              <span>
                Create a narrowly scoped credential when you need one.
              </span>
            </div>
          ) : (
            <div className="key-cards">
              {keys.map((key) => (
                <article className="key-card" key={key.id}>
                  <div className="key-card__heading">
                    <div>
                      <h4>{key.name}</h4>
                      <code>{key.prefix}…</code>
                    </div>
                    <span className={`key-state key-state--${key.state}`}>
                      {keyStateLabel(key)}
                    </span>
                  </div>
                  <div className="key-card__dates">
                    <span>Created {formatDate(key.created_at)}</span>
                    <span>Last used {formatDate(key.last_used_at)}</span>
                    <span>Expires {formatDate(key.expires_at)}</span>
                  </div>
                  <div className="key-card__scopes">
                    {key.scopes.map((scope) => (
                      <code key={scope}>{scope}</code>
                    ))}
                  </div>
                  {key.state === "active" &&
                    (revokeCandidate === key.id ? (
                      <fieldset className="key-card__confirm">
                        <legend>Revoke this key permanently?</legend>
                        <button
                          type="button"
                          disabled={revokeMutation.isPending}
                          onClick={() => void confirmRevoke(key.id)}
                        >
                          {revokeMutation.isPending
                            ? "Revoking…"
                            : "Confirm revoke"}
                        </button>
                        <button
                          type="button"
                          disabled={revokeMutation.isPending}
                          onClick={() => setRevokeCandidate(null)}
                        >
                          Keep key
                        </button>
                      </fieldset>
                    ) : (
                      <button
                        className="key-card__revoke"
                        type="button"
                        onClick={() => setRevokeCandidate(key.id)}
                      >
                        Revoke key
                      </button>
                    ))}
                </article>
              ))}
            </div>
          )}

          {revokeMutation.isError && (
            <p className="key-message key-message--error" role="alert">
              The API key could not be revoked. Its current state is unchanged.
            </p>
          )}

          {keysQuery.hasNextPage && (
            <button
              className="key-list__more"
              type="button"
              disabled={keysQuery.isFetchingNextPage}
              onClick={() => void keysQuery.fetchNextPage()}
            >
              {keysQuery.isFetchingNextPage ? "Loading…" : "Load more keys"}
            </button>
          )}
        </section>
      </div>
    </section>
  );
}
