import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type { ProjectCatalog, RepoCatalog } from '../../lib/api/types';

/** Project picker options (server-side search over ~60 projects). */
export function useProjects(search: string) {
  return useQuery({
    queryKey: ['catalog', 'projects', search],
    queryFn: () =>
      api.get<ProjectCatalog>(
        `/api/catalog/projects${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      ),
    staleTime: 60_000,
  });
}

/**
 * Repo picker options. Cross-filtered by selected projects via the delivery
 * graph (DASHBOARDS.md §3.2) — never loads all ~200 eagerly.
 */
export function useRepos(search: string, projects: string[]) {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (projects.length > 0) params.set('projects', projects.join(','));
  const qs = params.toString();

  return useQuery({
    queryKey: ['catalog', 'repos', search, projects.join(',')],
    queryFn: () => api.get<RepoCatalog>(`/api/catalog/repos${qs ? `?${qs}` : ''}`),
    staleTime: 60_000,
  });
}
