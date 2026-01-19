import { config } from './config';

export const CONSUMERS = [
  {
    key: 'heimgeist',
    label: 'Heimgeist',
    url: config.heimgeistUrl,
    token: config.heimgeistToken,
  },
  {
    key: 'leitstand',
    label: 'Leitstand',
    url: config.leitstandUrl,
    token: config.leitstandToken,
  },
  {
    key: 'hauski',
    label: 'hausKI',
    url: config.hauskiUrl,
    token: config.hauskiToken,
  },
  {
    key: 'chronik',
    label: 'Chronik',
    url: config.chronikUrl,
    token: config.chronikToken,
  },
];
