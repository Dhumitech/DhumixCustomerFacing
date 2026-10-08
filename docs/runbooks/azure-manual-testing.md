# Manual testing of the Azure-connected demo

**Active runtime, 9 October:** [hosted Container Apps](../../deploy/azure/Container-Apps.md),
at https://ca-dhumi-frontend-ci-01.bluerock-9b30fd6a.centralindia.azurecontainerapps.io.
Frontend/API/workers all run in Azure; no PC process or SSH tunnel is required.
Local 4173 Docker roles are stopped and older PC workers remain paused. Sign in
again at this HTTPS origin and follow the hosted manual acceptance steps. Do
not start a local worker/observer from the historical recipes below.

Current state, 9 October 2026: **ready for owner testing at http://127.0.0.1:4173**
in the [fresh Docker rehearsal](../../deploy/azure-rehearsal/README.md). Frontend,
API, outbox and Job Manager run in containers; the preceding PC API/workers are
paused. Sign in again on this different browser host. SQL, Blob, Service Bus
and Redis are the same real Azure services, with shared application data.
Application hosting is on this PC's Docker engine; SQL uses
[direct verified TLS](../../deploy/azure/Portable-Connections.md) with its public
CA embedded in the env. Keep the application processes running.

The owner explicitly retained the tested demo: no OTP; create organization only;
invitations/joining/member activity deferred; Marketplace cards are Coming soon.
Real Bright Data execution remains enabled. The qualification used no additional
provider submission; owner manual collection is the actual real-scraping test.

1. **Authentication.** Sign in with an existing account. A fresh signup attempt
   with an existing email must show the account-exists error and sign-in/contact
   options. For a new email, test validation and successful signup. Forgot
   password opens the support contact, with no send-code/reset workflow.
2. **Organization.** A new signed-in user must create an organization before
   service use. Returning users keep a valid active organization. After creating
   one, that user cannot create another. Invitations remain unavailable.
3. **Saved scraper.** Open the published Amazon Collect by URL operation and
   save/select a scraper. Changing the organization must not expose another
   organization's saved scrapers or Runs.
4. **Collection.** Enter the intended URL/options and submit through the existing
   Run/progress screen. Test the supported variants option on/off in separate
   owner-started collections. Follow acceptance, start, result and completion
   events; verify failures remain safe and visible rather than synthetic success.
5. **Results/history/usage.** Open the same Run from the Runs page, inspect its
   lifecycle and download available raw/normalized results. Confirm usage is
   shown under the selected organization and previous results remain accessible.
6. **Return/logout.** Refresh the page, sign out and sign back in. Check the
   selected organization is retained when still authorized and protected pages
   require authentication after logout. Marketplace remains a showcase.

From `back-end`, read-only infrastructure checks are:

```powershell
npm run deployment:check
npm run database:check
npm run redis:check
npm run queue:check
npm run storage:check
```

These validate configuration/connections without starting duplicate workers,
creating users/Runs or submitting provider/email work. Use the existing private
connected-session launcher for status; `demo:start` selects the separate
Docker/Azurite/emulator stack and must not replace this session silently.

Verification before handoff: 1,095 backend unit tests, one local Redis regression,
14 live Azure lease assertions and 41 actual backend connection/API/download
checks pass. Current API/frontend/worker health and config projections pass, with
no recorded app errors. [Redis handoff](../../deploy/azure/Redis.md),
[Service Bus handoff](../../deploy/azure/Service-Bus.md) and
[single environment](../../deploy/azure/Backend-Environment.md) describe the scope.
`leads_engine` and the other live project's environment/services are untouched.
