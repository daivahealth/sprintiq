import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/client';
import type { PrCycleTime } from '../../lib/api/types';

export function usePrCycleTime(repo: string) {
  return useQuery({
    queryKey: ['pr-cycle-time', repo],
    queryFn: () =>
      api.get<PrCycleTime>(
        `/api/dashboards/pr-cycle-time?repo=${encodeURIComponent(repo)}`,
      ),
    enabled: repo.trim().length > 0,
  });
}
