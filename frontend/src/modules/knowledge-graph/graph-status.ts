import { ApiError } from '../../lib/api/client';
import type { KgStatus } from './api';

export type ExplorerPhase =
  | 'loading'
  | 'forbidden'
  | 'disabled'
  | 'initializing'
  | 'failed'
  | 'error'
  | 'ready';

export interface ExplorerReadiness {
  phase: ExplorerPhase;
  /** What to tell the reader. Empty when ready and current. */
  message: string;
  stale: boolean;
  /** A rebuild is running behind a graph that is already being served. */
  rebuilding: boolean;
}

/**
 * Whether the explorer can be used, read from `GET /status`.
 *
 * Ready means *this tenant's* graph exists — the server serves it from that
 * moment, even while a scheduled rebuild runs behind it. Until then the page
 * shows why it is waiting, never an empty canvas dressed as a result.
 */
export function graphReadiness(
  status: KgStatus | undefined,
  error: unknown,
): ExplorerReadiness {
  const base = { stale: false, rebuilding: false };
  if (error) {
    if (error instanceof ApiError && error.status === 403) {
      return {
        ...base,
        phase: 'forbidden',
        message: 'The Knowledge Graph is available to administrators only.',
      };
    }
    if (error instanceof ApiError && error.status === 503) {
      return {
        ...base,
        phase: 'initializing',
        message: 'The knowledge graph is still being built. This page will update when it is ready.',
      };
    }
    return {
      ...base,
      phase: 'error',
      message: `Could not reach the knowledge graph: ${messageOf(error)}`,
    };
  }
  if (!status) {
    return { ...base, phase: 'loading', message: 'Checking the knowledge graph…' };
  }
  if (status.status === 'disabled') {
    return {
      ...base,
      phase: 'disabled',
      message:
        'The knowledge graph is turned off on this server (KNOWLEDGE_GRAPH_ENABLED).',
    };
  }
  const { tenant } = status;
  if (tenant.builtAt) {
    return {
      phase: 'ready',
      stale: tenant.stale,
      rebuilding: tenant.state === 'building',
      message: tenant.stale
        ? 'The last incremental update failed, so some recent activity may be missing until the next scheduled rebuild.'
        : '',
    };
  }
  if (tenant.state === 'failed' || status.status === 'failed') {
    return {
      ...base,
      phase: 'failed',
      message: `The knowledge graph could not be built${
        tenant.error ? `: ${tenant.error}` : '.'
      } It is retried on the next scheduled rebuild.`,
    };
  }
  return {
    ...base,
    phase: 'initializing',
    message:
      'The knowledge graph for this tenant is being built from the database. This usually takes a few seconds.',
  };
}

/** A data read's error, as the reader should see it. */
export function dataErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 403:
        return 'The Knowledge Graph is available to administrators only.';
      case 503:
        return 'The knowledge graph is still being built. Try again in a moment.';
      default:
        // 404 and 409 carry a sentence written for the reader.
        return error.message;
    }
  }
  return messageOf(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
