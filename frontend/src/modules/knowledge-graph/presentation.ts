import type { SearchSelectOption } from '../../components/search-select';
import type { RepositorySummary } from './api';
import { formatCount } from './format';

/** Alphabetical by display name — never by any count (ADR-0013). */
export function alphabetical<T extends { displayName: string; developerId: string }>(
  people: T[],
): T[] {
  return [...people].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.developerId.localeCompare(b.developerId),
  );
}

/** A search result as a dropdown option: `owner/name`, with its counts. */
export function repositoryOption(repo: RepositorySummary): SearchSelectOption {
  return {
    value: repo.id,
    label: repo.fullName,
    hint: `${formatCount(repo.commitCount)} commits · ${formatCount(repo.pullRequestCount)} PRs`,
  };
}

/** What the open dropdown says when it has no options to show. */
export function searchEmptyText(term: string, errorMessage: string | null): string {
  if (errorMessage) {
    return errorMessage;
  }
  return term.trim()
    ? 'No repository in the knowledge graph matches. Only repositories with activity in the loaded window are indexed.'
    : 'Type part of a repository name or URL';
}
