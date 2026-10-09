/**
 * Which platforms can have a stored login per user, and in which form (P1). One definition for the API (validates
 * and stores) and the worker (decrypts and hands over), so the two cannot drift apart.
 *
 *   instagram, patreon  cookies.txt (Netscape format), handed to gallery-dl as a file (-C)
 *   youtube             cookies.txt, optional, handed to yt-dlp as a file (--cookies)
 *   pixiv               OAuth refresh token, handed to gallery-dl in a config file (-c), never as an argument
 */
export const CREDENTIAL_PLATFORMS = ['instagram', 'patreon', 'pixiv', 'youtube'] as const;
export type CredentialPlatform = typeof CREDENTIAL_PLATFORMS[number];

export type CredentialKind = 'cookies' | 'token';

const KIND_OF_PLATFORM: Readonly<Record<CredentialPlatform, CredentialKind>> = {
  instagram: 'cookies',
  patreon: 'cookies',
  pixiv: 'token',
  youtube: 'cookies'
};

export function isCredentialPlatform(value: unknown): value is CredentialPlatform {
  return typeof value === 'string' && (CREDENTIAL_PLATFORMS as readonly string[]).includes(value);
}

export function credentialKindOf(platform: CredentialPlatform): CredentialKind {
  return KIND_OF_PLATFORM[platform];
}

/**
 * Binds a ciphertext to its owner and platform (plan 06, SEC-01): a blob copied into another user's row or into
 * another platform's row cannot be decrypted. The API encrypts with it, the worker decrypts with it.
 */
export function credentialAad(platform: CredentialPlatform, userId: string): string {
  return `kura:credential:${platform}:${userId}`;
}
