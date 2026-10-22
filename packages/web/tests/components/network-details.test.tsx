import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkDetails } from '@workspace/link-graph-ui/components/network-details';
import { createDataset } from '../fixtures/dataset.mjs';

describe('Windowed connection evidence', () => {
  it('pages every neighbor and group without accumulating DOM or mutating evidence', async () => {
    const { fixture } = createDataset();
    const nodes = fixture.pages.slice(0, 53).map(page => ({ page, hop: 1, parentUrl: fixture.pages[0].url }));
    const rows = Array.from({ length: 61 }, (_, i) => ({ ...fixture.links[0], anchor: `Evidence ${i}`, count: i + 1 }));
    const edges = new Map(nodes.map(node => [node.page.url, rows]));
    const before = JSON.stringify([...edges]);
    const locate = vi.fn();
    const { container } = render(<NetworkDetails nodes={nodes} edges={edges}
      heading={node => <h3>{node.page.url}</h3>}
      evidence={edge => <p className="link-meta">{edge.anchor} · {edge.count} rows</p>}
      locate={locate} />);
    expect(container.querySelectorAll('.link-detail')).toHaveLength(25);
    const first = container.querySelector('.link-detail') as HTMLElement;
    expect(within(first).getByText('Evidence 0 · 1 rows')).toBeVisible();
    await userEvent.click(within(first).getByText('Next link groups'));
    expect(within(first).queryByText('Evidence 0 · 1 rows')).not.toBeInTheDocument();
    expect(within(first).getByText('Evidence 25 · 26 rows')).toBeVisible();
    await userEvent.click(within(first).getByText('Next link groups'));
    expect(first.querySelectorAll('.link-meta')).toHaveLength(11);
    expect(within(first).getByText('Evidence 60 · 61 rows')).toBeVisible();
    await userEvent.click(within(first).getByText('Previous link groups'));
    expect(within(first).getByText('Evidence 25 · 26 rows')).toBeVisible();
    await userEvent.click(screen.getByText('Next connected pages'));
    expect(container.querySelectorAll('.link-detail')).toHaveLength(25);
    await userEvent.click(screen.getByText('Next connected pages'));
    expect(container.querySelectorAll('.link-detail')).toHaveLength(3);
    await userEvent.click(screen.getByText('Previous connected pages'));
    expect(container.querySelector('[data-detail-start]')).toHaveAttribute('data-detail-start', '25');
    await userEvent.type(screen.getByLabelText('Find connected page or destination'), nodes[52].page.url);
    expect(container.querySelectorAll('.link-detail')).toHaveLength(1);
    await userEvent.click(screen.getByText('Locate in diagram'));
    expect(locate).toHaveBeenCalledWith(nodes[52]);
    await userEvent.clear(screen.getByLabelText('Find connected page or destination'));
    expect(container.querySelectorAll('.link-detail')).toHaveLength(25);
    expect(container.querySelector('[data-detail-start]')).toHaveAttribute('data-detail-start', '0');
    expect(JSON.stringify([...edges])).toBe(before);
  });
});
