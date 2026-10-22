import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FocusPagePicker } from '@workspace/link-graph-ui/components/focus-page-picker';
import { EgoNetwork } from '@workspace/link-graph-ui/components/ego-network';
import { createDataset } from '../fixtures/dataset.mjs';
import { renderUI } from './helpers';
import type { Fixture } from '@workspace/link-graph-ui/data/fixtureRegistry';

describe('Focus page picker', () => {
  it('selects a full-dataset search result and returns focus to the trigger', async () => {
    const { fixture } = createDataset();
    const select = vi.fn();
    renderUI(<FocusPagePicker pages={fixture.pages} focus={fixture.pages[0]} onSelect={select} />);
    const trigger = screen.getByTestId('focus-page-picker');
    await userEvent.click(trigger);
    await userEvent.type(screen.getByLabelText('Search focus pages'), 'section-63');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(select).toHaveBeenCalledWith('/section-63/entry/');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
  it('shows no-match results, closes with Escape, and disables empty captures', async () => {
    const { fixture } = createDataset();
    const view = renderUI(<FocusPagePicker pages={fixture.pages} onSelect={() => {}} />);
    await userEvent.click(screen.getByTestId('focus-page-picker'));
    await userEvent.type(screen.getByLabelText('Search focus pages'), 'not-found');
    expect(screen.getByText(/No pages match/)).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('focus-page-picker')).toHaveAttribute('aria-expanded', 'false');
    view.unmount();
    renderUI(<FocusPagePicker pages={[]} onSelect={() => {}} />);
    expect(screen.getByTestId('focus-page-picker')).toBeDisabled();
  });
});

describe('Graph controls', () => {
  it('changes zoom within bounds, resets it, expands nodes, and restores filters from URL', async () => {
    history.replaceState(null, '', '/sites/alpha/ego?path=%2F&hops=2&direction=outgoing');
    const { fixture } = createDataset();
    renderUI(<EgoNetwork />, { ...fixture, source: 'synthetic' } as Fixture);
    expect(screen.getByTestId('hop-filter-2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('direction-filter-outgoing')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('slider', { name: 'Diagram zoom' })).toHaveValue('1.25');
    await userEvent.click(screen.getByRole('button', { name: 'Reset zoom' }));
    expect(screen.getByRole('slider', { name: 'Diagram zoom' })).toHaveValue('1');
    expect(screen.getByTestId('show-more-direct')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('show-all-direct'));
    expect(screen.queryByTestId('show-more-direct')).not.toBeInTheDocument();
  });
});
