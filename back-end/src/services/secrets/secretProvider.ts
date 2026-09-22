export interface SecretProvider {
  getSecret(secretReference: string): Promise<string>;
}
