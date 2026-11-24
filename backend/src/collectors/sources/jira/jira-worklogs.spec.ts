import {
  toWorklogRefs,
  worklogEnvelope,
  worklogSetSignature,
} from './jira-worklogs';

const w = (
  id: string,
  seconds = 3600,
  started = '2026-11-20T09:30:00.000+0530',
) => ({
  id,
  author: { accountId: `acc-${id}`, displayName: `P${id}` },
  started,
  timeSpentSeconds: seconds,
  updated: '2026-11-20T10:00:00.000+0530',
});

describe('jira-worklogs', () => {
  it('the poller and the reconciler converge on one key for the same set, whatever the order', () => {
    // The poller reads the embedded field; the reconciler reads it again via
    // `key in (...)`. Jira does not promise an order, so the hash must not
    // depend on one — otherwise the second read is a new raw event, not a
    // duplicate.
    const polled = worklogEnvelope(
      'conn_1',
      'poll',
      'PAY-1',
      'PAY',
      { worklogs: toWorklogRefs([w('2'), w('1')]), complete: true, total: 2 },
      '2026-11-21T00:00:00.000Z',
    );
    const backfilled = worklogEnvelope(
      'conn_1',
      'backfill',
      'PAY-1',
      'PAY',
      { worklogs: toWorklogRefs([w('1'), w('2')]), complete: true, total: 2 },
      '2026-11-23T00:00:00.000Z',
    );
    expect(polled.idempotencyKey).toBe(backfilled.idempotencyKey);
  });

  it('a changed set is a new event — an edit, a deletion or a new entry', () => {
    const base = {
      worklogs: toWorklogRefs([w('1'), w('2')]),
      complete: true,
      total: 2,
    };
    const edited = { ...base, worklogs: toWorklogRefs([w('1', 7200), w('2')]) };
    const deleted = {
      worklogs: toWorklogRefs([w('1')]),
      complete: true,
      total: 1,
    };
    const sig = worklogSetSignature(base);
    expect(worklogSetSignature(edited)).not.toBe(sig);
    expect(worklogSetSignature(deleted)).not.toBe(sig);
  });

  it('a set read in part and later in full are different events, so the full read is not dropped', () => {
    const refs = toWorklogRefs([w('1')]);
    expect(
      worklogSetSignature({ worklogs: refs, complete: false, total: 5 }),
    ).not.toBe(
      worklogSetSignature({ worklogs: refs, complete: true, total: 5 }),
    );
  });

  it('drops entries the projector cannot use rather than guessing', () => {
    const refs = toWorklogRefs([
      w('1'),
      { id: '2', started: undefined, timeSpentSeconds: 60 },
      { id: '3', started: '2026-11-20T09:30:00.000+0530' },
    ] as never);
    expect(refs.map((r) => r.id)).toEqual(['1']);
  });

  it('keys the author like the assignee — Server username first, Cloud accountId otherwise', () => {
    const [server] = toWorklogRefs([
      { ...w('1'), author: { name: 'asha', accountId: 'acc-1' } },
    ]);
    expect(server.authorLogin).toBe('asha');
  });
});
