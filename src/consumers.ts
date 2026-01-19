import { config } from './config';

export type AuthKind = 'bearer' | 'x-auth' | 'none';

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
    url: config.heimgeistUrl,
    token: config.heimgeistToken,
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
