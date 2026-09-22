[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('Test', 'Dev')]
    [string]$Target = 'Test'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    throw 'psql was not found on PATH.'
}

$environmentName = $Target.ToLowerInvariant()
$database = if ($Target -eq 'Test') { 'dhumi_test' } else { 'dhumi_dev' }
$operatorLogin = if ($Target -eq 'Test') {
    'dhumi_test_operator_login'
}
else {
    'dhumi_dev_operator_login'
}

& psql `
    -X `
    -h localhost `
    -p 5432 `
    -U postgres `
    -W `
    -d $database `
    -v ON_ERROR_STOP=1 `
    -v expected_operator_login=$operatorLogin `
    -c "SET ROLE dhumi_owner; SELECT version, applied_at, checksum FROM app.schema_migrations WHERE version = '0030_durable_execution_reconciliation'; SELECT to_regprocedure('app.schedule_run_reconciliation(uuid,text)') AS schedule_function, to_regprocedure('app.inspect_run_reconciliation(uuid)') AS inspect_function, to_regprocedure('app.recover_dead_lettered_run_command(uuid,text)') AS recovery_function; RESET ROLE;" `
    -c "SELECT login.rolname, login.rolcanlogin, login.rolinherit, granted.rolname AS granted_capability, membership.inherit_option, membership.set_option, membership.admin_option FROM pg_roles AS login LEFT JOIN pg_auth_members AS membership ON membership.member = login.oid LEFT JOIN pg_roles AS granted ON granted.oid = membership.roleid WHERE login.rolname IN ('dhumi_${environmentName}_outbox_dispatcher_login', 'dhumi_${environmentName}_job_manager_login', :'expected_operator_login');"

if ($LASTEXITCODE -ne 0) {
    throw "Pattern 4 readiness inspection failed for $database."
}
