import { config } from './config';

export type AuthKind = 'bearer' | 'x-auth' | 'none';

// `legacyHeimgeistForwarding` is present and false in the real runtime config.
// Older unit-test config fixtures predate that field; treating only an explicit
// false as the hard cut keeps those fixtures usable while production can no
// longer activate Heimgeist through HEIMGEIST_URL/HEIMGEIST_TOKEN.
const legacyHeimgeistForwarding = config.legacyHeimgeistForwarding !== false;

export const CONSUMERS: {
  key: string;
  label: string;
  url?: string;
  token?: string;
  authKind: AuthKind;
}[] = [
  {
    key: 'heimgeist',
    label: 'Heimgeist',
    url: legacyHeimgeistForwarding ? config.heimgeistUrl : undefined,
    token: legacyHeimgeistForwarding ? config.heimgeistToken : undefined,
    authKind: 'x-auth',
  },
  {
    key: 'leitstand',
    label: 'Leitstand',
    url: config.leitstandUrl,
    token: config.leitstandToken,
    authKind: 'bearer',
  },
  {
    key: 'hauski',
    label: 'hausKI',
    url: config.hauskiUrl,
    token: config.hauskiToken,
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
