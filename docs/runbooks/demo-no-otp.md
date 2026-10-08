# Quick demo without OTP

The owner requested this temporary mode on 8 October 2026. Signup and password
sign-in remain public. Signed-in users can create one organization immediately,
without an email code. The owner's later clarification disables invitations,
joining and member activity for this update. Existing memberships remain
selectable; organization permissions, CSRF and idempotency still apply. Read
[the current design](../specs/demo-organization-design.md) and [qualified demo
deployment](../../deploy/demo/README.md). Earlier invitation details below
describe the retained future backend, not an enabled demo flow.

## Enable or disable

In the existing ignored `back-end/.env`, set:

```dotenv
DEMO_DISABLE_OTP=true
```

Restart the backend after changing the switch. The owner's local environment
already has this value. No migration, new database login or credential change
is needed. The example environment defaults to `false`.

With `true`, OTP and email credentials are not required. Invitation links use
`APP_PUBLIC_URL`, falling back to `FRONTEND_ORIGIN`. Use the frontend origin that
participants can actually open; remote origins require HTTPS. Both
`NODE_ENV=production` and `APP_ENVIRONMENT=production` reject this demo bypass.

To restore the normal flow, set `DEMO_DISABLE_OTP=false`, provide the existing
OTP/email settings documented in `back-end/.env.example`, and restart. Use a
fresh create/join request after changing modes; an idempotency key from the
other mode cannot replay a different verification policy.

## Demonstrate the flow

1. Sign up with an email address and password, then sign in.
2. Open **Organizations**, enter a name and select **Create organization**.
   It selects the new organization immediately; the creator is its admin.
3. Open **Members and invitations**. Create an invitation with a future expiry.
   Enter an email for a single-use invitation, or leave it blank for a join code.
4. Copy and share the displayed invitation link or code manually. Demo mode
   sends no invitation email. The secret is shown only on minting; **Resend**
   rotates it and invalidates the previous token/code.
5. The recipient signs up/signs in. For an email invitation, use the invited
   address and open the link, then select **Confirm**. For a code, open
   **Organizations**, paste it and select **Join organization**. Joining completes
   immediately without an OTP screen.

Expired, revoked or exhausted invitations remain invalid. Joining still checks
the signed-in account and membership. Invitations and organizations persist
normally when used outside a rolled-back test.

## API and recovery behavior

Demo organization creation returns `201`; invite acceptance returns `200`:

```json
{
  "confirmed": true,
  "organization_id": "<organization UUID>",
  "verification_skipped": true
}
```

The normal mode retains `202` pending verification. The generated frontend
client handles both responses. Demo mode leaves `email_verified_at` unchanged
and records the bypass in organization audit actions. The existing database RLS
context receipt is created and consumed within the same transaction; it never
becomes a pending code or proof of mailbox ownership.

Password reset and verification confirm/resend return `403` in demo mode.
Use a known account password. Removing password-reset proof would allow account
takeover; the demo switch does not do that.

This switch changes organization onboarding. It does not publish templates,
enable provider traffic, provision infrastructure or deploy the application.
Startup testing used child-only unavailable storage, with the temporary API
stopped afterwards. Demo participants still need the configured API/frontend
processes and any infrastructure required by the features they demonstrate.
