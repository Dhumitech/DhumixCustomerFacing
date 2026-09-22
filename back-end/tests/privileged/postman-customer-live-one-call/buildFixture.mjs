import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const suiteDirectory = resolve("tests", "privileged", "postman-customer-live-one-call");
const collectionPath = resolve(
  suiteDirectory,
  "Dhumi_Customer_Live_One_Call.postman_collection.json",
);
const environmentPath = resolve(
  suiteDirectory,
  "Dhumi_Local_Live_One_Call.postman_environment.json",
);

const noAuth = { type: "noauth" };
const bearer = (variable) => ({
  type: "bearer",
  bearer: [{ key: "token", value: `{{${variable}}}`, type: "string" }],
});
const header = (key, value) => ({ key, value, type: "text" });
const jsonHeaders = [
  header("Accept", "application/json"),
  header("Content-Type", "application/json"),
];
const event = (listen, exec) => ({
  listen,
  script: { type: "text/javascript", exec },
});
const request = ({
  name,
  method,
  url,
  auth = noAuth,
  headers = [header("Accept", "application/json")],
  body,
  prerequest,
  tests,
  description,
}) => ({
  name,
  ...(description === undefined ? {} : { description }),
  event: [
    ...(prerequest === undefined ? [] : [event("prerequest", prerequest)]),
    ...(tests === undefined ? [] : [event("test", tests)]),
  ],
  request: {
    method,
    auth,
    header: headers,
    ...(body === undefined
      ? {}
      : { body: { mode: "raw", raw: body, options: { raw: { language: "json" } } } }),
    url,
  },
  response: [],
});

const collection = {
  info: {
    name: "Dhumi Customer Live E2E — One Billable Call",
    description:
      "Production-shaped local customer proof for one authenticated Amazon Products Run. Exactly one Bright Data scrape submission with one input. Never run without explicit billable authorization.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  auth: noAuth,
  item: [
    {
      name: "01 — Authenticated Amazon Run — ONE BILLABLE CALL",
      description:
        "Run this folder only. One authenticated Run POST produces exactly one provider scrape submission for one Amazon product URL.",
      item: [
        request({
          name: "01 — Platform status",
          method: "GET",
          url: "{{base_url}}/v1/status",
          tests: [
            "pm.test('status 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); pm.test('platform operational', function () { pm.expect(b.state).to.eql('operational'); });",
          ],
        }),
        request({
          name: "02 — Sign up fresh customer",
          method: "POST",
          url: "{{base_url}}/v1/auth/signup",
          headers: [
            ...jsonHeaders,
            header("Idempotency-Key", "{{signup_key}}"),
          ],
          prerequest: [
            "var nonce=pm.variables.replaceIn('{{$guid}}').replace(/-/g,'');",
            "var now=Date.now();",
            "pm.environment.set('email','postman-live-'+nonce+'@example.test');",
            "pm.environment.set('password','Dhumi-Live-'+nonce+'!Aa1');",
            "pm.environment.set('workspace_name','Dhumi Live '+nonce.slice(0,12));",
            "pm.environment.set('signup_key','live-signup-'+nonce);",
            "pm.environment.set('key_create_key','live-key-'+nonce);",
            "pm.environment.set('service_create_key','live-service-'+nonce);",
            "pm.environment.set('run_create_key','live-run-one-input-'+nonce);",
            "pm.environment.set('usage_from',new Date(now-3600000).toISOString());",
            "pm.environment.set('usage_to',new Date(now+3600000).toISOString());",
            "pm.environment.set('poll_attempt','0');",
            "['access_token','csrf_token','api_key_id','api_key_secret','tenant_id','service_id','run_id','download_url','expected_bytes','expected_checksum','raw_download_url','raw_expected_bytes','raw_expected_checksum','usage_event_id'].forEach(function(k){pm.environment.unset(k);});",
          ],
          body:
            '{"email":"{{email}}","password":"{{password}}","workspace_name":"{{workspace_name}}","legal_acceptances":[{"document_type":"terms_of_service","document_version":"2026-09-01","content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","accepted":true}]}',
          tests: [
            "pm.test('signup 202', function () { pm.response.to.have.status(202); });",
            "pm.test('signup accepted', function () { pm.expect(pm.response.json().accepted).to.eql(true); });",
          ],
        }),
        request({
          name: "03 — Sign in and capture browser session",
          method: "POST",
          url: "{{base_url}}/v1/auth/sign-in",
          headers: jsonHeaders,
          body: '{"email":"{{email}}","password":"{{password}}"}',
          tests: [
            "pm.test('sign-in 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); pm.test('session tokens returned', function () { pm.expect(b.access_token).not.empty; pm.expect(b.csrf_token).not.empty; });",
            "pm.environment.set('access_token',b.access_token); pm.environment.set('csrf_token',b.csrf_token);",
          ],
        }),
        request({
          name: "04 — Resolve authenticated Tenant workspace",
          method: "GET",
          url: "{{base_url}}/v1/workspace",
          auth: bearer("access_token"),
          tests: [
            "pm.test('workspace 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); pm.test('active Tenant workspace', function () { pm.expect(b.id).to.match(/^[0-9a-f-]{36}$/i); pm.expect(b.state).to.eql('active'); }); pm.environment.set('tenant_id',b.id);",
          ],
        }),
        request({
          name: "05 — Create scoped Dhumi API key",
          method: "POST",
          url: "{{base_url}}/v1/keys",
          auth: bearer("access_token"),
          headers: [
            ...jsonHeaders,
            header("X-CSRF-Token", "{{csrf_token}}"),
            header("Idempotency-Key", "{{key_create_key}}"),
          ],
          body:
            '{"name":"Postman Live One Call","scopes":["catalog:read","results:read","runs:read","runs:write","services:read","services:write","usage:read"]}',
          tests: [
            "pm.test('key 201', function () { pm.response.to.have.status(201); });",
            "var b=pm.response.json(); pm.test('scoped key returned once', function () { pm.expect(b.id).to.match(/^[0-9a-f-]{36}$/i); pm.expect(b.secret).to.match(/^dhk_v1_/); }); pm.environment.set('api_key_id',b.id); pm.environment.set('api_key_secret',b.secret);",
          ],
        }),
        request({
          name: "06 — Verify published Amazon Template",
          method: "GET",
          url: "{{base_url}}/v1/catalog/templates?family=scraper_library&limit=100",
          auth: bearer("api_key_secret"),
          tests: [
            "pm.test('catalogue 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); var t=b.data.find(function(x){return x.slug===pm.environment.get('template_slug');}); pm.test('Amazon Products v4 is published', function () { pm.expect(t).to.exist; pm.expect(t.availability).to.eql('available'); pm.expect(t.version).to.eql(4); });",
            "pm.test('provider internals are private', function () { pm.expect(pm.response.text()).not.to.match(/dataset_id|provider_credential|authorization|gd_[a-z0-9]{8,}/i); });",
          ],
        }),
        request({
          name: "07 — Create Tenant-owned Amazon Service",
          method: "POST",
          url: "{{base_url}}/v1/services",
          auth: bearer("api_key_secret"),
          headers: [
            ...jsonHeaders,
            header("Idempotency-Key", "{{service_create_key}}"),
          ],
          body:
            '{"template_slug":"{{template_slug}}","name":"Postman live one Amazon product","configuration":{}}',
          tests: [
            "pm.test('Service 201', function () { pm.response.to.have.status(201); });",
            "var b=pm.response.json(); pm.test('live Service contract', function () { pm.expect(b.template_slug).to.eql(pm.environment.get('template_slug')); pm.expect(b.template_version).to.eql(4); pm.expect(b.state).to.eql('active'); }); pm.environment.set('service_id',b.id);",
          ],
        }),
        request({
          name: "08 — Anonymous Run trigger is denied",
          method: "POST",
          url: "{{base_url}}/v1/services/{{service_id}}/runs",
          headers: [
            ...jsonHeaders,
            header("Idempotency-Key", "anonymous-run-{{$guid}}"),
          ],
          body: '{"input":{"targets":[{"url":"{{target_url}}"}]}}',
          tests: [
            "pm.test('anonymous Run POST 401', function () { pm.response.to.have.status(401); });",
            "pm.test('authentication required', function () { pm.expect(pm.response.json().code).to.eql('AUTHENTICATION_REQUIRED'); });",
          ],
        }),
        request({
          name: "09 — Authenticated Run trigger — BILLABLE CALL",
          description:
            "This is the only request in the folder that can cause provider egress. Exactly one target and one idempotent Run admission.",
          method: "POST",
          url: "{{base_url}}/v1/services/{{service_id}}/runs",
          auth: bearer("api_key_secret"),
          headers: [
            ...jsonHeaders,
            header("Idempotency-Key", "{{run_create_key}}"),
          ],
          body: '{"input":{"targets":[{"url":"{{target_url}}"}]}}',
          tests: [
            "pm.test('authenticated Run POST 202', function () { pm.response.to.have.status(202); });",
            "var b=pm.response.json(); pm.test('Run queued once', function () { pm.expect(b.run_id).to.match(/^[0-9a-f-]{36}$/i); pm.expect(b.status).to.eql('queued'); }); pm.environment.set('run_id',b.run_id); console.log('LIVE_RUN_ID='+b.run_id);",
          ],
        }),
        request({
          name: "10 — Anonymous Run status is denied",
          method: "GET",
          url: "{{base_url}}/v1/runs/{{run_id}}",
          tests: [
            "pm.test('anonymous Run GET 401', function () { pm.response.to.have.status(401); });",
            "pm.test('authentication required', function () { pm.expect(pm.response.json().code).to.eql('AUTHENTICATION_REQUIRED'); });",
          ],
        }),
        request({
          name: "11 — Poll authenticated Run until ready",
          method: "GET",
          url: "{{base_url}}/v1/runs/{{run_id}}",
          auth: bearer("api_key_secret"),
          tests: [
            "pm.test('Run detail 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); var n=Number(pm.environment.get('poll_attempt')||'0')+1; pm.environment.set('poll_attempt',String(n));",
            "pm.test('same Run', function () { pm.expect(b.id).to.eql(pm.environment.get('run_id')); });",
            "if(b.status==='ready'){pm.test('Run ready',function(){pm.expect(b.retryable).to.eql(false);});console.log('LIVE_RUN_READY='+b.id);}else if(['failed','cancelled','expired'].includes(b.status)){pm.test('Run did not fail',function(){pm.expect.fail('terminal status '+b.status+' / '+b.error_code);});pm.execution.setNextRequest(null);}else{pm.test('Run progressing',function(){pm.expect(['queued','running']).to.include(b.status);});pm.test('bounded poll',function(){pm.expect(n).below(401);});pm.execution.setNextRequest(pm.info.requestName);setTimeout(function(){},3000);}",
          ],
        }),
        request({
          name: "12 — Read safe Run events",
          method: "GET",
          url: "{{base_url}}/v1/runs/{{run_id}}/events?limit=100",
          auth: bearer("api_key_secret"),
          tests: [
            "pm.test('events 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); var types=b.data.map(function(x){return x.type;}); pm.test('public safe lifecycle', function () { ['accepted','started','result_received','progress','completed'].forEach(function(x){pm.expect(types).to.include(x);}); });",
            "pm.test('private execution data absent', function () { pm.expect(pm.response.text()).not.to.match(/dataset_id|fence_token|lease|provider_credential|authorization|brightdata/i); });",
          ],
        }),
        request({
          name: "13 — Anonymous result authorization is denied",
          method: "GET",
          url: "{{base_url}}/v1/runs/{{run_id}}/result?representation=raw",
          tests: [
            "pm.test('anonymous result GET 401', function () { pm.response.to.have.status(401); });",
            "pm.test('signed URL not disclosed', function () { pm.expect(pm.response.text()).not.to.include('download_url'); });",
          ],
        }),
        request({
          name: "14 — Authorize normalized result download",
          method: "GET",
          url: "{{base_url}}/v1/runs/{{run_id}}/result?representation=normalized",
          auth: bearer("api_key_secret"),
          tests: [
            "pm.test('result 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); pm.test('signed result contract', function () { pm.expect(b.run_id).to.eql(pm.environment.get('run_id')); pm.expect(b.byte_count).above(0); pm.expect(b.checksum).to.match(/^[a-f0-9]{64}$/i); pm.expect(b.download_url).to.match(/^http:\\/\\/(127\\.0\\.0\\.1|localhost):10000\\//); }); pm.environment.set('download_url',b.download_url); pm.environment.set('expected_bytes',String(b.byte_count)); pm.environment.set('expected_checksum',b.checksum.toLowerCase());",
          ],
        }),
        request({
          name: "15 — Download and verify exact normalized result",
          method: "GET",
          url: "{{download_url}}",
          tests: [
            "pm.test('signed download 200', function () { pm.response.to.have.status(200); });",
            "var CryptoJS=require('crypto-js'); var bytes=pm.response.stream instanceof Uint8Array?pm.response.stream:new Uint8Array(pm.response.stream); var words=[]; for(var i=0;i<bytes.length;i++){words[i>>>2]|=bytes[i]<<(24-(i%4)*8);} var wa=CryptoJS.lib.WordArray.create(words,bytes.length); var digest=CryptoJS.SHA256(wa).toString(CryptoJS.enc.Hex);",
            "pm.test('exact byte count', function () { pm.expect(bytes.length).to.eql(Number(pm.environment.get('expected_bytes'))); });",
            "pm.test('exact SHA-256', function () { pm.expect(digest).to.eql(pm.environment.get('expected_checksum')); });",
            "var rows=pm.response.json(); pm.test('one normalized Amazon record', function () { pm.expect(rows).to.be.an('array').with.lengthOf(1); pm.expect(rows[0].asin).to.eql('B07YYKF9HW'); pm.expect(rows[0].url).to.match(/^https:\\/\\/www\\.amazon\\.com\\/dp\\/B07YYKF9HW/); });",
          ],
        }),
        request({
          name: "16 — Authorize raw result download",
          method: "GET",
          url: "{{base_url}}/v1/runs/{{run_id}}/result?representation=raw",
          auth: bearer("api_key_secret"),
          tests: [
            "pm.test('raw result 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); pm.test('signed raw result contract', function () { pm.expect(b.run_id).to.eql(pm.environment.get('run_id')); pm.expect(b.byte_count).above(0); pm.expect(b.checksum).to.match(/^[a-f0-9]{64}$/i); }); pm.environment.set('raw_download_url',b.download_url); pm.environment.set('raw_expected_bytes',String(b.byte_count)); pm.environment.set('raw_expected_checksum',b.checksum.toLowerCase());",
          ],
        }),
        request({
          name: "17 — Download and verify exact raw result",
          method: "GET",
          url: "{{raw_download_url}}",
          tests: [
            "pm.test('signed raw download 200', function () { pm.response.to.have.status(200); });",
            "var CryptoJS=require('crypto-js'); var bytes=pm.response.stream instanceof Uint8Array?pm.response.stream:new Uint8Array(pm.response.stream); var words=[]; for(var i=0;i<bytes.length;i++){words[i>>>2]|=bytes[i]<<(24-(i%4)*8);} var wa=CryptoJS.lib.WordArray.create(words,bytes.length); var digest=CryptoJS.SHA256(wa).toString(CryptoJS.enc.Hex);",
            "pm.test('exact raw byte count', function () { pm.expect(bytes.length).to.eql(Number(pm.environment.get('raw_expected_bytes'))); });",
            "pm.test('exact raw SHA-256', function () { pm.expect(digest).to.eql(pm.environment.get('raw_expected_checksum')); });",
          ],
        }),
        request({
          name: "18 — Anonymous usage read is denied",
          method: "GET",
          url: "{{base_url}}/v1/usage/events?from={{usage_from}}&to={{usage_to}}&limit=100",
          tests: [
            "pm.test('anonymous usage GET 401', function () { pm.response.to.have.status(401); });",
          ],
        }),
        request({
          name: "19 — Read Tenant usage summary",
          method: "GET",
          url: "{{base_url}}/v1/usage/summary?from={{usage_from}}&to={{usage_to}}",
          auth: bearer("api_key_secret"),
          tests: [
            "pm.test('usage summary 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); pm.test('usage summary contains one-record meter', function () { pm.expect(b.items.some(function(x){return x.quantity===1 && x.unit==='records';})).to.eql(true); });",
          ],
        }),
        request({
          name: "20 — Trace usage to this exact Run",
          method: "GET",
          url: "{{base_url}}/v1/usage/events?from={{usage_from}}&to={{usage_to}}&limit=100",
          auth: bearer("api_key_secret"),
          tests: [
            "pm.test('usage events 200', function () { pm.response.to.have.status(200); });",
            "var b=pm.response.json(); var mine=b.data.filter(function(x){return x.run_id===pm.environment.get('run_id');}); pm.test('exactly one successful usage event', function () { pm.expect(mine).to.have.lengthOf(1); pm.expect(mine[0].outcome).to.eql('succeeded'); pm.expect(mine[0].quantity).to.eql(1); pm.expect(mine[0].unit).to.eql('records'); }); if(mine.length===1){pm.environment.set('usage_event_id',mine[0].id);console.log('LIVE_USAGE_EVENT_ID='+mine[0].id);}",
          ],
        }),
        request({
          name: "21 — Revoke temporary Dhumi API key",
          method: "DELETE",
          url: "{{base_url}}/v1/keys/{{api_key_id}}",
          auth: bearer("access_token"),
          headers: [
            header("Accept", "application/json"),
            header("X-CSRF-Token", "{{csrf_token}}"),
          ],
          tests: [
            "pm.test('key revoked 204', function () { pm.response.to.have.status(204); });",
          ],
        }),
        request({
          name: "22 — Logout browser session",
          method: "POST",
          url: "{{base_url}}/v1/auth/logout",
          auth: bearer("access_token"),
          headers: [
            header("Accept", "application/json"),
            header("X-CSRF-Token", "{{csrf_token}}"),
          ],
          tests: [
            "pm.test('logout 204', function () { pm.response.to.have.status(204); });",
          ],
        }),
      ],
    },
  ],
};

const environment = {
  name: "Dhumi Local — Live One Billable Call",
  values: [
    { key: "base_url", value: "http://127.0.0.1:3000", enabled: true, type: "default" },
    { key: "template_slug", value: "amazon-products-collect-by-url", enabled: true, type: "default" },
    { key: "target_url", value: "https://www.amazon.com/dp/B07YYKF9HW", enabled: true, type: "default" },
    { key: "access_token", value: "", enabled: true, type: "secret" },
    { key: "csrf_token", value: "", enabled: true, type: "secret" },
    { key: "api_key_secret", value: "", enabled: true, type: "secret" },
    { key: "raw_download_url", value: "", enabled: true, type: "secret" },
  ],
  _postman_variable_scope: "environment",
  _postman_exported_using: "Dhumi controlled fixture builder",
};

await mkdir(suiteDirectory, { recursive: true });
await writeFile(collectionPath, `${JSON.stringify(collection, null, 2)}\n`, "utf8");
await writeFile(environmentPath, `${JSON.stringify(environment, null, 2)}\n`, "utf8");
process.stdout.write(`${collectionPath}\n${environmentPath}\n`);
