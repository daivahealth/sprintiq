import { describe, expect, it } from 'vitest';
import { suggestedPrimary, type DuplicateGroup } from './identity-duplicates';

const member = (
  canonicalDeveloperId: string,
  hasLogin: boolean,
  keys = 1,
): DuplicateGroup['members'][number] => ({
  canonicalDeveloperId,
  displayName: canonicalDeveloperId,
  sourceKeys: Array.from({ length: keys }, (_, i) => `k${i}`),
  hasLogin,
});

describe('suggestedPrimary', () => {
  it('prefers the corporate org login over a personal account', () => {
    expect(
      suggestedPrimary({
        name: 'siddhantsaraf',
        members: [member('rocksolid911', true), member('Siddhant-Saraf_athma', true)],
      }),
    ).toBe('Siddhant-Saraf_athma');
  });

  it('prefers a login-backed developer over an email-only one', () => {
    expect(
      suggestedPrimary({
        name: 'shubhamjain',
        members: [member('Shubham Jain', false), member('SHUBHAM_JAIN', true)],
      }),
    ).toBe('SHUBHAM_JAIN');
  });

  it('falls back to the developer with more identities, then a stable order', () => {
    expect(
      suggestedPrimary({ name: 'x', members: [member('a', false, 1), member('b', false, 3)] }),
    ).toBe('b');
    expect(
      suggestedPrimary({ name: 'x', members: [member('b', false), member('a', false)] }),
    ).toBe('a');
  });
});
