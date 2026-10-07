/** Successful context setup for repository tests; denial tests use explicit rows. */
export function customerContextFixture(sql: string, values: readonly unknown[] = []) {
  if (sql.includes("AS user_id, set_config('app.organization_id'")) {
    return { rows: [{ user_id: values[0], organization_id: values[1] }], rowCount: 1 };
  }
  if (
    sql === "SELECT id FROM app.users WHERE id = $1 AND state = 'active'" ||
    sql.startsWith("SELECT id FROM app.organizations WHERE id = $1 AND state = 'active'")
  ) {
    return { rows: [{ id: values[0] }], rowCount: 1 };
  }
  if (sql.startsWith("SELECT user_id FROM app.organization_members WHERE organization_id = $1")) {
    return { rows: [{ user_id: values[1] }], rowCount: 1 };
  }
  return undefined;
}
