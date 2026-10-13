import { EventTypes } from '../../../common/events/event-types';
import {
  buildCommitEnvelope,
  commitIdempotencyKey,
} from './github-commit-envelope';

describe('buildCommitEnvelope', () => {
  const payload = {
    repoFullName: 'acme/ehr',
    sha: '0defa5a6e4',
    message: 'm',
    authorEmail: 'a@x.org',
    authoredAt: '2026-09-25T10:00:00Z',
  };

  it('mints the key every route converges on', () => {
    const e = buildCommitEnvelope({
      connectionId: 'c1',
      mode: 'poll',
      repoFullName: 'acme/ehr',
      payload,
    });
    expect(e.idempotencyKey).toBe('github:acme/ehr:commit:0defa5a6e4');
    expect(commitIdempotencyKey('acme/ehr', '0defa5a6e4')).toBe(
      e.idempotencyKey,
    );
    expect(e).toMatchObject({
      sourceSystem: 'github',
      connectionId: 'c1',
      collectionMode: 'poll',
      eventType: EventTypes.CODE_COMMIT_PUSHED,
      occurredAt: '2026-09-25T10:00:00Z',
      externalRefs: { repo: 'acme/ehr', sha: '0defa5a6e4' },
    });
  });

  it('adds lineage refs without changing the key', () => {
    const e = buildCommitEnvelope({
      connectionId: 'c1',
      mode: 'poll',
      repoFullName: 'acme/ehr',
      payload,
      extraRefs: {
        ref: 'ACT-92441-aot-induction',
        discoveredBy: 'github-audit-compare',
      },
    });
    expect(e.externalRefs).toEqual({
      repo: 'acme/ehr',
      sha: '0defa5a6e4',
      ref: 'ACT-92441-aot-induction',
      discoveredBy: 'github-audit-compare',
    });
    expect(e.idempotencyKey).toBe('github:acme/ehr:commit:0defa5a6e4');
  });
});
