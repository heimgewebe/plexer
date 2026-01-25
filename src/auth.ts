
/**
 * Returns strictly authentication headers (X-Auth or Authorization).
 *
 * Contract:
 * - Only returns auth headers.
 * - Caller is responsible for setting `Content-Type` and other headers.
 */
export function getAuthHeaders(
  authKind: string,
  token: string,
  consumerKey: string
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (authKind === 'x-auth') {
    headers['X-Auth'] = token;
  } else {
    // Default to Bearer (includes 'bearer' and unknown)
    if (authKind !== 'bearer') {
      console.warn(
        `Unknown authKind "${authKind}" for consumer ${consumerKey}; defaulting to Bearer`
      );
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
}
