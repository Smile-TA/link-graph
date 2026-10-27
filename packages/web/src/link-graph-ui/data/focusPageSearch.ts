import type { Page } from './sampleData';

export function pageLabel(path: string) {
  return path === '/' ? 'Home' : path;
}

export function focusPageLabel(page: Page) {
  const label = pageLabel(page.path);
  return page.title === page.path || page.title === label || !page.title
    ? label : `${label} — ${page.title}`;
}

/** Search the complete site page set before limiting rendered options. */
export function searchFocusPages(pages: Page[], query: string) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return pages;
  return pages.filter(page =>
    `${pageLabel(page.path)} ${page.path} ${page.title} ${page.url}`.toLocaleLowerCase().includes(term),
  );
}
