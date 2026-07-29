/** Supported source systems (BC-0). The Connection row's `sourceSystem` column. */
export type SourceSystem =
  | 'jira'
  | 'github'
  | 'gitlab'
  | 'azure-devops'
  | 'sonarqube'
  | 'jenkins'
  | 'github-actions';

/**
 * Default per-source scheduler poll interval when a connection doesn't set
 * its own `config.syncIntervalMinutes` — 4 hours. Each source is ticked and
 * configured independently (docs/api/README.md §3).
 */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 240;

/** Source systems that currently have a registered collector + scheduled tick. */
export const SCHEDULED_SOURCE_SYSTEMS: SourceSystem[] = ['github', 'jira'];
