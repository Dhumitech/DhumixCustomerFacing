export function cleanCustomerText(value: string): string {
  return value.replaceAll("â€”", "—").replaceAll("â€“", "–");
}
