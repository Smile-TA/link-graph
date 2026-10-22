import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import { Router } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@workspace/link-graph-ui/components/ui/tooltip';
import { FixtureProvider } from '@workspace/link-graph-ui/components/fixture-context';
import type { Fixture } from '@workspace/link-graph-ui/data/fixtureRegistry';
import { createDataset } from '../fixtures/dataset.mjs';

export function renderUI(ui: ReactNode, fixture = createDataset().fixture as Fixture) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return {
    ...render(<QueryClientProvider client={client}><Router>
      <TooltipProvider><FixtureProvider fixture={fixture}>{ui}</FixtureProvider></TooltipProvider>
    </Router></QueryClientProvider>),
    client,
  };
}
