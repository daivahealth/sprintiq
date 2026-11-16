import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type { GithubOrganization } from '../../lib/api/types';

export const ORGS_KEY = ['admin', 'configurations', 'github-organizations'];

export function useGithubOrganizations() {
  return useQuery({
    queryKey: ORGS_KEY,
    queryFn: () =>
      api.get<{ organizations: GithubOrganization[] }>(
        '/api/admin/configurations/github/organizations',
      ),
  });
}
