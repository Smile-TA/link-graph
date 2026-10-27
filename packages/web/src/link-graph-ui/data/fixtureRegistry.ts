import type { Site, Page, Link } from './sampleData';
export interface BrokenLink { fromUrl: string; toUrl: string; statusCode: number; anchor: string }
export interface Fixture {
  site: Site;
  pages: Page[];
  links: Link[];
  brokenLinks: BrokenLink[];
  brokenExternalLinks?: BrokenLink[];
  source: 'recorded' | 'synthetic' | 'database';
  description: string;
}
