import { credentialAad as platformCredentialAad } from '@kura/adapters';

/**
 * Kept for the IG-B tests that import it from here. The routes of all platforms are in credential-routes.ts and
 * the additional authenticated data is defined once in @kura/adapters.
 */
export function credentialAad(userId: string): string {
  return platformCredentialAad('instagram', userId);
}
