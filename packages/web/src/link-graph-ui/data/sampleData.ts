/**
 * Static presentation fixture extracted from the checked-in 403bplan.net HTML captures.
 * Summary counts are pinned by the repository analysis integration test.
 * Graph rows contain only non-self internal links resolving to one of the 13 captured pages.
 * Unresolved internal and external destinations remain summary-only, never misreported as broken.
 */
export interface Site {
  siteId: string;
  host: string;
  latestCrawlAt: string;
  pageCount: number;
  orphanCount: number | null;
  unresolvedInternalLinks: number;
  brokenLinks: number;
  externalDestinations: number;
  totalLinkRows: number;
  sampleLabel: string;
  crawlId?: string | null;
  captureVersion?: string;
  crawlStatus?: string;
  orphanUnknownReason?: string | null;
  enabled?: boolean;
}

export interface Page {
  url: string;
  path: string;
  title: string;
  statusCode: number | null;
  pageClass: string;
  depth: number | null;
  indexable: boolean;
  inboundCount: number;
  outboundCount: number;
  postType?: string | null;
  inTruthSource?: boolean;
  /** Graph-only terminal destination; never part of captured-page metrics. */
  isExternal?: boolean;
}

export interface Link {
  fromUrl: string;
  toUrl: string;
  isExternal: boolean;
  anchor: string;
  container: string;
  isBoilerplate: boolean | null;
  count?: number;
  /** External links only: what the link check concluded about the destination. */
  externalCheck?: 'broken' | 'unverified' | 'ok' | null;
  externalStatusCode?: number | null;
}

export const sites: Site[] = [{
  siteId: '403bplan-net',
  host: '403bplan.net',
  latestCrawlAt: '2026-08-20T09:08:15.000Z',
  pageCount: 13,
  orphanCount: 4,
  unresolvedInternalLinks: 17,
  brokenLinks: 0,
  externalDestinations: 23,
  totalLinkRows: 240,
  sampleLabel: 'Recorded fixture · 403bplan.net',
}];

export const pages: Page[] = [
  {
    "url": "https://403bplan.net/",
    "path": "/",
    "title": "403b Plan Consultants - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 0,
    "indexable": true,
    "inboundCount": 12,
    "outboundCount": 9
  },
  {
    "url": "https://403bplan.net/test-pay-button/",
    "path": "/test-pay-button/",
    "title": "Test Pay Button - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "orphan",
    "depth": null,
    "indexable": true,
    "inboundCount": 0,
    "outboundCount": 7
  },
  {
    "url": "https://403bplan.net/contact-us/",
    "path": "/contact-us/",
    "title": "Contact Us - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 1,
    "indexable": true,
    "inboundCount": 14,
    "outboundCount": 6
  },
  {
    "url": "https://403bplan.net/disclosures/",
    "path": "/disclosures/",
    "title": "Disclosures - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 1,
    "indexable": true,
    "inboundCount": 12,
    "outboundCount": 6
  },
  {
    "url": "https://403bplan.net/newsletter-signup/",
    "path": "/newsletter-signup/",
    "title": "Newsletter Signup - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "orphan",
    "depth": null,
    "indexable": true,
    "inboundCount": 0,
    "outboundCount": 7
  },
  {
    "url": "https://403bplan.net/newsletters/",
    "path": "/newsletters/",
    "title": "Newsletters - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "orphan",
    "depth": null,
    "indexable": true,
    "inboundCount": 0,
    "outboundCount": 7
  },
  {
    "url": "https://403bplan.net/plan-participant/financial-calculators/",
    "path": "/plan-participant/financial-calculators/",
    "title": "Financial Calculators - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 2,
    "indexable": true,
    "inboundCount": 1,
    "outboundCount": 7
  },
  {
    "url": "https://403bplan.net/plan-participant/online-access/",
    "path": "/plan-participant/online-access/",
    "title": "Online Access - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "orphan",
    "depth": null,
    "indexable": true,
    "inboundCount": 0,
    "outboundCount": 7
  },
  {
    "url": "https://403bplan.net/terms-of-service/",
    "path": "/terms-of-service/",
    "title": "Terms of Service - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 1,
    "indexable": true,
    "inboundCount": 12,
    "outboundCount": 6
  },
  {
    "url": "https://403bplan.net/plan-participant/",
    "path": "/plan-participant/",
    "title": "Plan Participant - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 1,
    "indexable": true,
    "inboundCount": 13,
    "outboundCount": 9
  },
  {
    "url": "https://403bplan.net/plan-sponsor/",
    "path": "/plan-sponsor/",
    "title": "Plan Sponsor - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 1,
    "indexable": true,
    "inboundCount": 13,
    "outboundCount": 6
  },
  {
    "url": "https://403bplan.net/financial-advisor/",
    "path": "/financial-advisor/",
    "title": "Financial Advisor - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 1,
    "indexable": true,
    "inboundCount": 13,
    "outboundCount": 7
  },
  {
    "url": "https://403bplan.net/plan-participant/fund-prospectuses/",
    "path": "/plan-participant/fund-prospectuses/",
    "title": "Fund Prospectuses - 403bplan Consultants",
    "statusCode": 200,
    "pageClass": "linked",
    "depth": 2,
    "indexable": true,
    "inboundCount": 1,
    "outboundCount": 7
  }
];

const linkRows: Array<[number, number, string, string, boolean]> = [
  [
    0,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    0,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    0,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    0,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    0,
    9,
    "Learn More",
    "main",
    false
  ],
  [
    0,
    10,
    "Learn More",
    "main",
    false
  ],
  [
    0,
    11,
    "Learn More",
    "main",
    false
  ],
  [
    0,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    0,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    1,
    0,
    "",
    "header",
    true
  ],
  [
    1,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    1,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    1,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    1,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    1,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    1,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    2,
    0,
    "",
    "header",
    true
  ],
  [
    2,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    2,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    2,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    2,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    2,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    3,
    0,
    "",
    "header",
    true
  ],
  [
    3,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    3,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    3,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    3,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    3,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    4,
    0,
    "",
    "header",
    true
  ],
  [
    4,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    4,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    4,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    4,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    4,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    4,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    5,
    0,
    "",
    "header",
    true
  ],
  [
    5,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    5,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    5,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    5,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    5,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    5,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    6,
    0,
    "",
    "header",
    true
  ],
  [
    6,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    6,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    6,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    6,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    6,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    6,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    7,
    0,
    "",
    "header",
    true
  ],
  [
    7,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    7,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    7,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    7,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    7,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    7,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    8,
    0,
    "",
    "header",
    true
  ],
  [
    8,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    8,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    8,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    8,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    8,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    9,
    0,
    "",
    "header",
    true
  ],
  [
    9,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    9,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    9,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    9,
    12,
    "View Prospectus",
    "main",
    false
  ],
  [
    9,
    2,
    "Contact Us",
    "main",
    true
  ],
  [
    9,
    6,
    "Financial Calculators",
    "main",
    false
  ],
  [
    9,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    9,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    10,
    0,
    "",
    "header",
    true
  ],
  [
    10,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    10,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    10,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    10,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    10,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    11,
    0,
    "",
    "header",
    true
  ],
  [
    11,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    11,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    11,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    11,
    2,
    "Contact Us",
    "main",
    true
  ],
  [
    11,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    11,
    8,
    "Terms of Service",
    "footer",
    true
  ],
  [
    12,
    0,
    "",
    "header",
    true
  ],
  [
    12,
    9,
    "Plan Participant",
    "header",
    true
  ],
  [
    12,
    10,
    "Plan Sponsor",
    "header",
    true
  ],
  [
    12,
    11,
    "Financial Advisor",
    "header",
    true
  ],
  [
    12,
    2,
    "Contact Us",
    "header",
    true
  ],
  [
    12,
    3,
    "Disclosures",
    "footer",
    true
  ],
  [
    12,
    8,
    "Terms of Service",
    "footer",
    true
  ]
];

export const links: Link[] = linkRows.map(([from, to, anchor, container, isBoilerplate]) => ({
  fromUrl: pages[from].url,
  toUrl: pages[to].url,
  isExternal: false,
  anchor,
  container,
  isBoilerplate,
}));
