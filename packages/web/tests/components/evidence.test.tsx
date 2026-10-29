import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageExplorer } from '@workspace/link-graph-ui/components/page-explorer';
import { BrokenLinks } from '@workspace/link-graph-ui/components/broken-links';
import { Treemap, Distributions, Matrix } from '@workspace/link-graph-ui/views';
import { renderUI } from './helpers';
import { createDataset } from '../fixtures/dataset.mjs';

describe('Page and finding components', () => {
  it('searches beyond initial pages and links to the encoded focus path', async () => {
    const user = userEvent.setup();
    renderUI(<PageExplorer />);
    await user.type(screen.getByRole('searchbox'), 'encoded space');
    expect(screen.getByRole('link', { name: /View page network/ })).toHaveAttribute('href', '/sites/alpha/ego?path=%2Fencoded%20space%2F');
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'absent');
    expect(screen.queryByRole('link', { name: /View page network/ })).not.toBeInTheDocument();
  });
  it('loads more pages without duplicates', async () => {
    renderUI(<PageExplorer />);
    expect(screen.getAllByRole('link', { name: /View page network/ })).toHaveLength(12);
    await userEvent.click(screen.getByRole('button', { name: /Show more pages/ }));
    expect(screen.getAllByRole('link', { name: /View page network/ })).toHaveLength(24);
  });
  it('paginates broken links, filters status and clears the filters', async () => {
    const { fixture } = createDataset();
    renderUI(<BrokenLinks rows={fixture.brokenLinks} />);
    expect(screen.getAllByRole('row')).toHaveLength(26);
    await userEvent.click(screen.getByRole('button', { name: /Load 25 more/ }));
    expect(screen.getAllByRole('row')).toHaveLength(32);
    await userEvent.selectOptions(screen.getByLabelText('Filter by HTTP status'), '500');
    expect(screen.getAllByRole('row')).toHaveLength(16);
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getAllByRole('row')).toHaveLength(26);
  });
  it('distinguishes a genuinely empty capture from filtered-empty results', async () => {
    renderUI(<BrokenLinks rows={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('No verified broken links in this capture');
  });
});
describe('Analysis views', () => {
  it('searches and expands hierarchy sections across the full dataset', async () => {
    renderUI(<Treemap />);
    expect(screen.getByText(/50 of .* matching sections/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show 50 more/ }));
    expect(screen.queryByRole('button', { name: /Show 50 more/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox'), 'section-63');
    expect(screen.getByTestId('tile-section-%2Fsection-63%2F')).toHaveTextContent('1');
    expect(screen.queryByTestId('tile-section-%2Fsection-00%2F')).not.toBeInTheDocument();
  });
  it('groups every recorded page into depth and inbound distributions', () => {
    renderUI(<Distributions />);
    expect(screen.getByTestId('distribution-page-depth-No path from root')).toHaveTextContent('29');
    expect(screen.getByTestId('distribution-page-depth-Depth 0')).toHaveTextContent('1');
    expect(screen.getByTestId('distribution-inbound-links-0 inbound')).toHaveTextContent('29');
  });
  it('excludes boilerplate/self-edges from matrix counts and pages both axes', async () => {
    renderUI(<Matrix />);
    expect(screen.getByTestId('matrix-%2F-%2Fguide%2F')).toHaveTextContent('3');
    const rootRow = screen.getByTestId('matrix-%2F-%2Fguide%2F').closest('tr')!;
    expect(within(rootRow).queryByText('10')).not.toBeInTheDocument();
    expect(within(rootRow).getAllByText('·').length).toBeGreaterThan(0);
    const table = screen.getByRole('table');
    const firstHead = within(table).getAllByRole('columnheader').map(cell => cell.textContent);
    await userEvent.click(screen.getByRole('button', { name: 'Next columns' }));
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).not.toEqual(firstHead);
    await userEvent.click(screen.getByRole('button', { name: 'Next rows' }));
    await userEvent.type(screen.getByLabelText('Filter rows (from section)'), 'section-63');
    expect(screen.getByRole('button', { name: 'Previous rows' })).toBeDisabled();
    // Row filtering leaves the column page where it was.
    expect(screen.getByRole('button', { name: 'Previous columns' })).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Filter columns (to section)'), 'section-63');
    expect(screen.getByRole('button', { name: 'Previous columns' })).toBeDisabled();
  });
});
