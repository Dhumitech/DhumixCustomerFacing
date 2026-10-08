import fs from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Operator .mjs modules deliberately remain outside the compiled API package.
// @ts-expect-error The plain Node launcher has no TypeScript declaration file.
import { demoEnvironment, processEnvironment, liveProviderSettings } from '../../scripts/local-demo/common.mjs';

const key = Buffer.alloc(32, 7).toString('base64url');
const fixture = `DATABASE_HOST=localhost\nDATABASE_PORT=5432\nDATABASE_NAME=dhumi_test\nPOSTGRES_USER=existing_admin\nPOSTGRES_PASSWORD=private-admin-fixture\nBRIGHTDATA_API_KEY=private-provider-fixture\nPROVIDER_REFERENCE_LOCAL_KEY=${key}\nRESULT_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true\nSERVICE_BUS_CONNECTION_STRING=Endpoint=sb://localhost;UseDevelopmentEmulator=true\nDATABASE_IDENTITY_USER=identity_login\nDATABASE_IDENTITY_PASSWORD=identity_fixture\nDATABASE_JOB_MANAGER_USER=jobs_login\nDATABASE_JOB_MANAGER_PASSWORD=jobs_fixture\nDATABASE_RESULT_RECORDER_USER=results_login\nDATABASE_RESULT_RECORDER_PASSWORD=results_fixture\n`;
describe('Real local demo execution/secret boundary', () => {
  beforeEach(() => { vi.spyOn(fs, 'readFileSync').mockReturnValue(fixture); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('defaults to real Bright Data execution in the isolated Docker target', () => {
    const env = demoEnvironment();
    expect(env.RUN_EXECUTOR_DRIVER).toBe('bright_data');
    expect(env.DATABASE_PORT).toBe('55432');
    expect(env.DATABASE_NAME).toBe('dhumi_test');
    expect(env).not.toHaveProperty('POSTGRES_PASSWORD');
  });
  it.each(['api', 'frontend', 'outbox'])('never sends provider/reference/admin secrets to %s', name => {
    const env = processEnvironment(name);
    expect(env).not.toHaveProperty('BRIGHTDATA_API_KEY');
    expect(env).not.toHaveProperty('PROVIDER_REFERENCE_LOCAL_KEY');
    expect(env).not.toHaveProperty('POSTGRES_PASSWORD');
  });
  it('gives the Job Manager its provider key and only its restricted database pairs', () => {
    const env = processEnvironment('jobs');
    expect(env.BRIGHTDATA_API_KEY).toBe('private-provider-fixture');
    expect(env.PROVIDER_REFERENCE_LOCAL_KEY).toBe(key);
    expect(env.DATABASE_JOB_MANAGER_USER).toBe('jobs_login');
    expect(env.DATABASE_RESULT_RECORDER_USER).toBe('results_login');
    expect(env).not.toHaveProperty('DATABASE_IDENTITY_USER');
    expect(env).not.toHaveProperty('POSTGRES_PASSWORD');
  });
  it('fails closed when a provider key is missing', () => {
    expect(() => liveProviderSettings({ PROVIDER_REFERENCE_LOCAL_KEY: key })).toThrow(/BRIGHTDATA_API_KEY/);
  });
  it('fails closed for a missing durable reference key instead of returning fabricated results', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(() => liveProviderSettings({ BRIGHTDATA_API_KEY: 'provider-fixture' })).toThrow(/persistent private/);
  });
});
