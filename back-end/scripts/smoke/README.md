# Manual verification

Two ways to check that signup and sign-in work.

| File | What it does |
|---|---|
| `Verify-Auth.ps1` | Runs everything end to end, PASS/FAIL per assertion |
| `verify-auth.sql` | Read-only psql inspection of what the database received |
| `Reset-TestData.ps1` | Clears accumulated test identities from `dhumi_test` |

Everything targets `dhumi_test` only. The runtime refuses to start if `.env.test`
names any other database.

---

## Before you start

1. `.env.test` exists, with the two restricted role passwords and an
   `ACCESS_TOKEN_SECRET` of at least 32 characters.
2. The restricted LOGIN roles exist in `dhumi_test`. If not, run
   `scripts\bootstrap\0004_runtime_login_roles.sql` first.
3. PostgreSQL is running on `localhost:5432`.

Never paste a password into a command line, a Markdown file or a commit.

---

## Option A — the script

```powershell
cd D:\BrightDataCustomerFacing\back-end
.\scripts\smoke\Verify-Auth.ps1
```

Fifteen steps, **47 assertions**, exits non-zero if any fail.

| Steps | Cover |
|---|---|
| 1–4 | Prerequisites, static checks, live database suite, build and start |
| 5–8 | Signup: accepted path, replay, conflict, rejections, enumeration |
| 9–11 | Sign-in: `200` with four fields, refresh cookie, token claims |
| 12 | Sign-in: wrong password, unknown email and malformed body are **byte-identical** |
| 13 | Sign-in: timing does not reveal whether an address exists |
| 14–15 | Database rows, shutdown, summary |

Switches: `-SkipBuild` to reuse `dist`, `-KeepServer` to leave it running.

**Step 13 is the one to watch.** It measures six requests each for a known and
an unknown address and fails if the medians differ by more than a factor of two.
That is the check that catches someone "optimising" away the unconditional
password hash, which would turn the identical error message into an
enumeration oracle solvable with a stopwatch. Expect a ratio near 1.0.

---

## Option B — by hand

### 1. Static and database suites

```powershell
cd D:\BrightDataCustomerFacing\back-end
npm run typecheck
npm test
npm run test:database
```

Expect 103 passed with three files skipped, then 22 passed.

### 2. Start the server

```powershell
npm run build
node --env-file=.env.test dist/server.js
```

**Check the port first.** An orphaned server from an earlier run keeps port 3001,
so a new one never binds and every request below silently measures the *old*
build:

```powershell
netstat -ano | Select-String ":3001.*LISTENING"
```

If anything is listening, stop it before continuing. This mistake produced a
false timing result three times during development.

### 3. Sign up

```powershell
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$email = "manual-$stamp@example.test"
$hash  = 'a' * 64
@{
  email = $email
  password = 'a-sufficiently-long-password'
  workspace_name = 'Manual Check'
  legal_acceptances = @(@{
    document_type = 'terms'; document_version = 'manual-v1'
    content_hash = $hash; accepted = $true
  })
} | ConvertTo-Json -Depth 5 -Compress | Set-Content signup.json -Encoding utf8

curl.exe -s -i -X POST http://127.0.0.1:3001/v1/auth/signup `
  -H "content-type: application/json" -H "idempotency-key: manual-$stamp-idem" `
  --data-binary "@signup.json"
```

**Expect** `202` and exactly:

```json
{"accepted":true,"message":"Account request accepted. Sign in to continue."}
```

No `user_id`, no `tenant_id`, no UUID.

### 4. Sign in

```powershell
@{ email = $email; password = 'a-sufficiently-long-password' } |
  ConvertTo-Json -Compress | Set-Content signin.json -Encoding utf8

curl.exe -s -i -X POST http://127.0.0.1:3001/v1/auth/sign-in `
  -H "content-type: application/json" --data-binary "@signin.json"
```

**Expect** `200`, a body with exactly four fields, and a cookie:

```text
set-cookie: dhumi_refresh=<value>; Path=/v1/auth; Expires=...; HttpOnly; SameSite=Strict
{"access_token":"eyJ...","token_type":"Bearer","expires_in":900,"csrf_token":"..."}
```

Check that the refresh value in the cookie does **not** appear in the JSON body.

### 5. Look inside the access token

```powershell
$token = (curl.exe -s -X POST http://127.0.0.1:3001/v1/auth/sign-in `
  -H "content-type: application/json" --data-binary "@signin.json" |
  ConvertFrom-Json).access_token

$payload = ($token -split '\.')[1].Replace('-','+').Replace('_','/')
switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } }
[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
```

**Expect** `sub`, `sid`, `tid`, `pur = browser_access`, `iss`, `aud`, `exp`,
`iat`, `jti`.

`tid` is the tenant the customer never supplied. It is signed here because
`dhumi_customer_api` cannot discover a user's tenant on its own.

### 6. The three rejections must be identical

```powershell
# wrong password
@{ email = $email; password = 'definitely-wrong-password' } |
  ConvertTo-Json -Compress | Set-Content wrong.json -Encoding utf8

# unknown address
@{ email = "ghost-$stamp@example.test"; password = 'a-sufficiently-long-password' } |
  ConvertTo-Json -Compress | Set-Content ghost.json -Encoding utf8

# unknown property
@{ email = $email; password = 'a-sufficiently-long-password'; remember_me = $true } |
  ConvertTo-Json -Compress | Set-Content badshape.json -Encoding utf8

foreach ($f in 'wrong.json','ghost.json','badshape.json') {
  curl.exe -s -i -X POST http://127.0.0.1:3001/v1/auth/sign-in `
    -H "content-type: application/json" --data-binary "@$f"
  ""
}
```

**Expect all three** to return `401`, carry `www-authenticate: Bearer`, use
`application/problem+json`, and produce bodies that differ **only** in
`request_id`.

The malformed body deliberately returns `401`, not `400`: sign-in declares no
`400` or `422`, and answering identically means a caller cannot tell a rejected
request from rejected credentials.

Signup, by contrast, *does* declare `400`, and still returns it:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:3001/v1/auth/signup `
  -H "content-type: application/json" -H "idempotency-key: manual-badbody-00001" `
  -d '{\"email\":\"x@example.test\"}'
```

### 7. Time the two paths

```powershell
foreach ($f in 'wrong.json','ghost.json') {
  $times = 1..6 | ForEach-Object {
    [double](curl.exe -s -o NUL -w "%{time_total}" -X POST `
      http://127.0.0.1:3001/v1/auth/sign-in `
      -H "content-type: application/json" --data-binary "@$f")
  }
  "{0}: median {1:N1} ms" -f $f, (($times | Sort-Object)[3] * 1000)
}
```

**Expect** both medians near 27 ms and within a factor of two of each other. A
known address answering much slower than an unknown one means the unconditional
password hash was removed.

If both come back near 1 ms, you are being rate limited, not measuring timing.
Restart the server with `$env:SIGNIN_RATE_LIMIT_MAX = '500'`.

### 8. Inspect the database

```powershell
$psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
& $psql -X -W -h localhost -p 5432 -U <admin-principal> -d dhumi_test `
  -v email="$email" -f scripts\smoke\verify-auth.sql
```

Twelve read-only sections. The script prints its own expected result at the end.

### 9. Clean up

```powershell
Remove-Item signup.json, signin.json, wrong.json, ghost.json, badshape.json
```

Stop the server with Ctrl+C. Identities remain in `dhumi_test`, which is
disposable; clear them with `Reset-TestData.ps1`.

---

## Reading a failure

| Symptom | Likely cause |
|---|---|
| Server will not start | Restricted roles missing, `.env.test` wrong, or `ACCESS_TOKEN_SECRET` under 32 characters |
| `500` on every signup | Role assumption failed; `app.create_signup` requires `current_user = dhumi_identity` |
| Unknown property returns `202` | `removeAdditional` regressed; the contract rule is unenforced |
| Sign-in returns `400` | The `attachValidation` mapping regressed; that status is undeclared |
| Unknown address answers far faster | Conditional password hashing reintroduced |
| `23502` on signup | `content_hash` reached the database without mapping to `document_hash_hex` |
| `22P02` on sign-in | A non-UUID `X-Request-ID` reached `audit_events.request_id` |
| Everything returns `429` | Rate limits, or a stale server with exhausted buckets |
| Results contradict the code | Check port 3001 for an orphan before anything else |
