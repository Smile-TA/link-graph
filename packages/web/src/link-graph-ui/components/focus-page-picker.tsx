import { useId, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import type { Page } from '.././data/sampleData';
import { focusPageLabel, searchFocusPages } from '.././data/focusPageSearch';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import './focus-page-picker.css';

const MAX_OPTIONS = 100;

export function FocusPagePicker({ pages, focus, onSelect }: {
  pages: Page[]; focus?: Page; onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const labelId = useId();
  const valueId = useId();
  const hintId = useId();
  const matches = useMemo(() => searchFocusPages(pages, query), [pages, query]);
  const options = matches.slice(0, MAX_OPTIONS);
  if (!query.trim() && focus && !options.includes(focus)) {
    options.unshift(focus);
    options.splice(MAX_OPTIONS);
  }
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) setQuery('');
  };
  return <div className="focus-page-picker">
    <span id={labelId}>Focus page</span>
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="focus-page-picker__trigger" role="combobox"
          aria-labelledby={`${labelId} ${valueId}`} aria-expanded={open}
          disabled={!pages.length} data-testid="focus-page-picker">
          <Search size={15} aria-hidden="true" />
          <span id={valueId}>{focus ? focusPageLabel(focus) : pages.length ? 'Search and select a page…' : 'No page records available'}</span>
          <ChevronsUpDown size={14} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="focus-page-picker__popover" align="start">
        <Command shouldFilter={false} className="focus-page-picker__command" loop>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search paths, titles, or URLs…"
            aria-label="Search focus pages" aria-describedby={hintId} data-testid="input-focus-page-search" />
          <p id={hintId} className="focus-page-picker__count" role="status">
            {matches.length} {matches.length === 1 ? 'match' : 'matches'}{matches.length > MAX_OPTIONS ? ` · showing first ${MAX_OPTIONS}; type more to narrow results` : ''}
          </p>
          <CommandList aria-label="Focus page results">
            <CommandEmpty>No pages match “{query}”. Try another path or title.</CommandEmpty>
            <CommandGroup>
              {options.map(page => <CommandItem key={page.url} value={page.url}
                data-testid={`focus-page-option-${encodeURIComponent(page.path)}`}
                onSelect={() => { changeOpen(false); onSelect(page.path); }}>
                <Check size={14} aria-hidden="true" style={{ visibility: focus?.url === page.url ? 'visible' : 'hidden', flexShrink: 0 }} />
                <span>{focusPageLabel(page)}{focus?.url === page.url && <span className="sr-only"> (current focus)</span>}</span>
              </CommandItem>)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  </div>;
}
