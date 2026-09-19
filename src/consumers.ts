import { config } from './config';

export type AuthKind = 'bearer' | 'x-auth' | 'none';

/**
 * Current delivery targets only.
 *
 * Heimgeist and hausKI repositories were physically deleted. Their legacy
 * config fields remain parse-compatible in config.ts for historical fixtures
 * and retained queue bytes, but must never become live consumers again.
 */
export const CONSUMERS: {
  key: string;
  label: string;
  url?: string;
  token?: string;
  authKind: AuthKind;
}[] = [
  {
    key: 'leitstand',
    label: 'Leitstand',
    url: config.leitstandUrl,
    token: config.leitstandToken,
    authKind: 'bearer',
  },
  {
    key: 'chronik',
    label: 'Chronik',
    url: config.chronikUrl,
    token: config.chronikToken,
    authKind: 'x-auth',
  },
];
