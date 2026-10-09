/**
 * Fake cookie files for the Instagram credential tests. Every value is obviously made up; no real cookie appears
 * anywhere in the repository.
 */
export const FAKE_SESSION_VALUE = 'FAKE-SESSIONID-VALUE-for-tests-only';
export const FAKE_CSRF_VALUE = 'FAKE-CSRFTOKEN-VALUE-for-tests-only';
export const FAKE_FOREIGN_VALUE = 'FAKE-FOREIGN-SITE-VALUE-must-be-dropped';

const HEADER = '# Netscape HTTP Cookie File\n# This is a generated file!  Do not edit.\n\n';

/** One cookie line: domain, include-subdomains, path, secure, expiry (epoch seconds), name, value. */
export function cookieLine(domain: string, name: string, value: string, expires = 1_900_000_000, options: { httpOnly?: boolean } = {}): string {
  const include = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  return `${options.httpOnly ? '#HttpOnly_' : ''}${domain}\t${include}\t/\tTRUE\t${expires}\t${name}\t${value}`;
}

export function cookieFile(...lines: string[]): string {
  return `${HEADER}${lines.join('\n')}\n`;
}

/** A normal export: Instagram cookies plus cookies of an unrelated site. */
export function validCookieFile(): string {
  return cookieFile(
    cookieLine('.instagram.com', 'sessionid', FAKE_SESSION_VALUE, 1_900_000_000, { httpOnly: true }),
    cookieLine('.instagram.com', 'csrftoken', FAKE_CSRF_VALUE, 1_850_000_000),
    cookieLine('.instagram.com', 'ds_user_id', '1234567890', 0),
    cookieLine('.example.org', 'othersite', FAKE_FOREIGN_VALUE),
    cookieLine('.notinstagram.com', 'lookalike', FAKE_FOREIGN_VALUE),
    cookieLine('instagram.com.example.org', 'lookalike2', FAKE_FOREIGN_VALUE)
  );
}
