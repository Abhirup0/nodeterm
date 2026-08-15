/** Minimal secret-storage contract shared by feature-specific credential services. */
export interface SecretStore {
  readonly availability: 'encrypted' | 'restricted-file' | 'unavailable'
  readForHost(): Promise<string | null>
  save(secret: string): Promise<void>
  clear(): Promise<void>
}
