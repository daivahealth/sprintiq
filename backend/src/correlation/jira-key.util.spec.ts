import { extractJiraKeys } from './jira-key.util';

describe('extractJiraKeys', () => {
  it('extracts a key from the PR title', () => {
    const keys = extractJiraKeys({ title: 'PAY-2231 fix capture' });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key: 'PAY-2231', projectKey: 'PAY' });
    expect(keys[0].foundIn).toEqual(['title']);
  });

  it('dedupes the same key across inputs and records provenance', () => {
    const keys = extractJiraKeys({
      title: 'PAY-2231 fix capture',
      branch: 'feature/PAY-2231-idempotent',
      commit: 'PAY-2231 guard duplicate',
    });
    expect(keys).toHaveLength(1);
    expect(keys[0].foundIn.sort()).toEqual(['branch', 'commit', 'title']);
  });

  it('returns multiple distinct keys (ambiguous)', () => {
    const keys = extractJiraKeys({ title: 'PAY-1 and OPS-99 together' });
    expect(keys.map((k) => k.key).sort()).toEqual(['OPS-99', 'PAY-1']);
  });

  it('returns nothing when no key is present', () => {
    expect(
      extractJiraKeys({ title: 'just a refactor', branch: 'cleanup' }),
    ).toEqual([]);
  });

  it('ignores lowercase / malformed keys', () => {
    expect(extractJiraKeys({ title: 'pay-1 and ABC- and -123' })).toEqual([]);
  });
});
