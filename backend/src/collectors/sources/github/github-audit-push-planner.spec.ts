import {
  countRanges,
  dedupePushes,
  diffTips,
  pushesByRepo,
} from './github-audit-push-planner';
import { GitPushAuditEvent } from './github-audit-log.client';

const ev = (id: string, repo: string, ms: number): GitPushAuditEvent => ({
  documentId: id,
  repoFullName: repo,
  timestamp: new Date(ms),
});

describe('dedupePushes', () => {
  it('keeps one event per _document_id (overlapping windows)', () => {
    const out = dedupePushes([
      ev('a', 'acme/ehr', 2),
      ev('a', 'acme/ehr', 2),
      ev('b', 'acme/ehr', 1),
    ]);
    expect(out.map((e) => e.documentId).sort()).toEqual(['a', 'b']);
  });
});

describe('pushesByRepo', () => {
  it('groups by repo and sorts each group chronologically', () => {
    const g = pushesByRepo([
      ev('c', 'acme/ehr', 3),
      ev('x', 'acme/amma', 5),
      ev('a', 'acme/ehr', 1),
    ]);
    expect([...g.keys()].sort()).toEqual(['acme/amma', 'acme/ehr']);
    expect(g.get('acme/ehr')!.map((e) => e.documentId)).toEqual(['a', 'c']);
  });
});

describe('diffTips', () => {
  const stored = new Map([
    ['master', 'm1'],
    ['feature-A', 'A'],
    ['feature-B', 'X'],
    ['old', 'o1'],
    ['same', 's1'],
  ]);

  it('plans one Compare per moved ref (A→B→C→D collapses to A...D)', () => {
    const current = new Map([
      ['master', 'm1'],
      ['feature-A', 'D'],
      ['feature-B', 'Z'],
      ['same', 's1'],
      ['old', 'o1'],
    ]);
    const d = diffTips('acme/ehr', stored, current, 'master');
    expect(d.ranges).toEqual([
      {
        repoFullName: 'acme/ehr',
        ref: 'feature-A',
        baseSha: 'A',
        headSha: 'D',
        kind: 'moved',
      },
      {
        repoFullName: 'acme/ehr',
        ref: 'feature-B',
        baseSha: 'X',
        headSha: 'Z',
        kind: 'moved',
      },
    ]);
    expect(d.upserts).toEqual([
      { ref: 'feature-A', sha: 'D' },
      { ref: 'feature-B', sha: 'Z' },
    ]);
    expect(d.deletes).toEqual([]);
  });

  it('compares a new ref against the default branch (the zero-before case)', () => {
    const current = new Map([
      ...stored,
      ['ACT-92441-aot-induction', '50b124b05b'],
    ]);
    const d = diffTips('acme/ehr', stored, current, 'master');
    expect(d.ranges).toEqual([
      {
        repoFullName: 'acme/ehr',
        ref: 'ACT-92441-aot-induction',
        baseRef: 'master',
        headSha: '50b124b05b',
        kind: 'new_ref',
      },
    ]);
  });

  it('records a deleted ref without planning a Compare (the zero-after case)', () => {
    const current = new Map(stored);
    current.delete('old');
    const d = diffTips('acme/ehr', stored, current, 'master');
    expect(d.ranges).toEqual([
      { repoFullName: 'acme/ehr', ref: 'old', baseSha: 'o1', kind: 'deleted' },
    ]);
    expect(d.deletes).toEqual(['old']);
  });

  it('plans nothing when no tip moved', () => {
    expect(
      diffTips('acme/ehr', stored, new Map(stored), 'master').ranges,
    ).toEqual([]);
  });

  it('never compares the default branch against itself when it is new', () => {
    const d = diffTips(
      'acme/new',
      new Map(),
      new Map([['main', 'h1']]),
      'main',
    );
    expect(d.ranges).toEqual([]);
    expect(d.upserts).toEqual([{ ref: 'main', sha: 'h1' }]);
  });
});

describe('countRanges', () => {
  it('counts only Compare-bearing ranges as requests', () => {
    expect(
      countRanges([
        {
          repoFullName: 'r',
          ref: 'a',
          kind: 'moved',
          baseSha: '1',
          headSha: '2',
        },
        {
          repoFullName: 'r',
          ref: 'b',
          kind: 'new_ref',
          baseRef: 'm',
          headSha: '3',
        },
        { repoFullName: 'r', ref: 'c', kind: 'deleted', baseSha: '4' },
      ]),
    ).toEqual({
      compareRequestsPlanned: 2,
      refsMoved: 1,
      refsNew: 1,
      refsDeleted: 1,
    });
  });
});
