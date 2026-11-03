import { useState } from 'react';
import { SearchSelect, type SearchSelectOption } from '../../components/search-select';
import { useRepositorySearch } from './api';
import { dataErrorMessage } from './graph-status';
import { repositoryOption, searchEmptyText } from './presentation';

/**
 * The explorer's entry point: repositories the knowledge graph actually
 * holds, from `GET /repositories/search`. Nothing is listed that the search
 * did not return, so a repository configured in GitHub but absent from the
 * graph simply does not appear.
 */
export function RepositorySearch({
  value,
  currentLabel,
  onSelect,
  disabled,
}: {
  value: string | null;
  /** The selected repository's name, shown when it is not in the current results. */
  currentLabel: string | null;
  onSelect: (repoId: string, fullName: string) => void;
  disabled?: boolean;
}) {
  const [term, setTerm] = useState('');
  const search = useRepositorySearch(term, !disabled);
  const items = term.trim() ? (search.data?.items ?? []) : [];
  // With no term, the only option is the current selection: it lets the
  // closed box name a repository reached from elsewhere (a developer's list),
  // which no search returned.
  const options: SearchSelectOption[] = term.trim()
    ? items.map(repositoryOption)
    : value && currentLabel
      ? [{ value, label: currentLabel }]
      : [];

  return (
    <SearchSelect
      label="GitHub repository"
      value={value}
      options={options}
      onSearch={setTerm}
      onSelect={(id) => {
        const repo = items.find((r) => r.id === id);
        onSelect(id, repo?.fullName ?? currentLabel ?? id);
      }}
      loading={search.isFetching}
      placeholder="Search by name or URL…"
      emptyText={searchEmptyText(term, search.error ? dataErrorMessage(search.error) : null)}
    />
  );
}
