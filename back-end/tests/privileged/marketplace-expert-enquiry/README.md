# M6 Marketplace expert-enquiry proof

These scripts activate and prove the backend-only M6 enquiry boundary. They do
not call Bright Data and cannot create a payment, entitlement, Service, Run,
Attempt, outbox event or usage event.

Clean disposable PostgreSQL proof:

```powershell
Set-Location 'D:\BrightDataCustomerFacing\back-end'
& '.\tests\privileged\marketplace-expert-enquiry\Invoke-MarketplaceExpertEnquiryCleanDatabaseProof.ps1'
```

After the clean proof passes, apply migration `0051` to the local databases:

```powershell
& '.\tests\privileged\marketplace-expert-enquiry\Apply-MarketplaceExpertEnquiryMigration.ps1' -Target Both
```

Restart the Customer API after activation. The Outbox Dispatcher and Job
Manager are not part of this request path.
