import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/client';
import { statusResponse } from './fixtures';
import { dataErrorMessage, graphReadiness } from './graph-status';

describe('graphReadiness', () => {
  it('is ready once the tenant graph exists', () => {
    expect(graphReadiness(statusResponse(), null)).toMatchObject({
      phase: 'ready',
      stale: false,
      message: '',
    });
  });

  it('is initializing, not an empty success, while the tenant graph is building', () => {
    const r = graphReadiness(
      statusResponse({ state: 'building', builtAt: null, totalNodes: 0 }, 'initializing'),
      null,
    );
    expect(r.phase).toBe('initializing');
  });

  it('keeps serving a built graph while a scheduled rebuild runs', () => {
    expect(graphReadiness(statusResponse({ state: 'building' }), null)).toMatchObject({
      phase: 'ready',
      rebuilding: true,
    });
  });

  it('reports a failed build with the server reason', () => {
    const r = graphReadiness(
      statusResponse({ state: 'failed', builtAt: null, error: 'timeout' }),
      null,
    );
    expect(r.phase).toBe('failed');
    expect(r.message).toContain('timeout');
  });

  it('reports a disabled graph', () => {
    expect(graphReadiness(statusResponse({}, 'disabled'), null).phase).toBe('disabled');
  });

  it('warns when the graph is stale', () => {
    const r = graphReadiness(statusResponse({ stale: true }), null);
    expect(r).toMatchObject({ phase: 'ready', stale: true });
    expect(r.message).toContain('next scheduled rebuild');
  });

  it('maps 403 to admin-only and 503 to initializing', () => {
    expect(graphReadiness(undefined, new ApiError(403, 'Forbidden')).phase).toBe('forbidden');
    expect(graphReadiness(undefined, new ApiError(503, 'x')).phase).toBe('initializing');
    expect(graphReadiness(undefined, new Error('network down'))).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('network down'),
    });
  });

  it('is loading before the first answer', () => {
    expect(graphReadiness(undefined, null).phase).toBe('loading');
  });
});

describe('dataErrorMessage', () => {
  it("passes the server's own sentence through for 404 and 409", () => {
    const msg = '"billing" matches more than one repository (a/billing, b/billing); use owner/name.';
    expect(dataErrorMessage(new ApiError(409, msg))).toBe(msg);
  });

  it('explains 503 and 403 in plain words', () => {
    expect(dataErrorMessage(new ApiError(503, 'Knowledge graph initializing'))).toContain('still being built');
    expect(dataErrorMessage(new ApiError(403, 'Forbidden'))).toContain('administrators only');
  });
});
