import {
  indexLoginsByNormalizedKey,
  isMachineEmail,
  normalizeIdentityKey,
  resolveIdentity,
  sourceKeyOf,
} from './developer-identity.util';

describe('normalizeIdentityKey', () => {
  it('strips the enterprise shortcode so an EMU login can match a git name', () => {
    // GitHub Enterprise Managed User logins are `<name>_<shortcode>`; no git
    // user.name ever carries the suffix, so without stripping it these two
    // spellings of one person could never meet.
    expect(normalizeIdentityKey('Sangeetha-S_athma')).toBe('sangeethas');
    expect(normalizeIdentityKey('sangeethas')).toBe('sangeethas');
  });

  it('ignores separators and case', () => {
    expect(normalizeIdentityKey('Sanjay Kumar Yadav')).toBe('sanjaykumaryadav');
    expect(normalizeIdentityKey('Sanjay-Kumar-Yadav_athma')).toBe(
      'sanjaykumaryadav',
    );
  });

  it('is empty for absent names, so nothing matches on nothing', () => {
    expect(normalizeIdentityKey(null)).toBe('');
    expect(normalizeIdentityKey('')).toBe('');
    expect(normalizeIdentityKey('___')).toBe('');
  });

  it('does not match merely similar people', () => {
    // The guard against the failure that matters most: crediting one
    // colleague's commits to another.
    expect(normalizeIdentityKey('Junaid Haneef')).not.toBe(
      normalizeIdentityKey('Mohammed Junaid Haneef'),
    );
    expect(normalizeIdentityKey('Vijay Kumar Yadav')).not.toBe(
      normalizeIdentityKey('Sanjay Kumar Yadav'),
    );
  });
});

describe('isMachineEmail', () => {
  it('rejects addresses that identify a platform rather than a person', () => {
    expect(isMachineEmail('noreply@github.com')).toBe(true);
    expect(isMachineEmail('12345+jdoe@users.noreply.github.com')).toBe(true);
    expect(isMachineEmail('renovate[bot]@users.example.com')).toBe(true);
  });

  it('accepts ordinary corporate addresses', () => {
    expect(isMachineEmail('372281@example.org')).toBe(false);
    expect(isMachineEmail(null)).toBe(false);
  });
});

describe('sourceKeyOf', () => {
  it('prefers the login, falls back to the email, and refuses to key on nothing', () => {
    expect(sourceKeyOf({ login: 'jdoe', email: 'j@x.io' })).toBe('login:jdoe');
    expect(sourceKeyOf({ email: 'J@X.io' })).toBe('email:j@x.io');
    expect(sourceKeyOf({ name: 'J Doe' })).toBeNull();
  });
});

describe('indexLoginsByNormalizedKey', () => {
  it('keeps colliding logins together rather than picking one', () => {
    const index = indexLoginsByNormalizedKey(['Jo-Bloggs_acme', 'JoBloggs']);
    expect(index.get('jobloggs')).toEqual(['Jo-Bloggs_acme', 'JoBloggs']);
  });
});

describe('resolveIdentity', () => {
  const noEmails = new Map<string, string>();
  const noNames = new Map<string, string[]>();

  it('takes the source login as fact when there is one', () => {
    const match = resolveIdentity({ login: 'jdoe' }, noEmails, noNames);
    expect(match).toMatchObject({
      canonicalDeveloperId: 'jdoe',
      method: 'github_login',
      confidence: 1,
    });
  });

  it('recovers an unattributed commit via an email GitHub itself verified', () => {
    const byEmail = new Map([['j@x.io', 'jdoe']]);
    const match = resolveIdentity(
      { email: 'J@X.io', name: 'John Doe' },
      byEmail,
      noNames,
    );
    expect(match).toMatchObject({
      canonicalDeveloperId: 'jdoe',
      method: 'email_exact',
    });
  });

  it('recovers the real case: unverified corporate email, name matching an EMU login', () => {
    const byName = indexLoginsByNormalizedKey(['Sangeetha-S_athma']);
    const match = resolveIdentity(
      { email: '372281@example.org', name: 'sangeethas' },
      noEmails,
      byName,
    );
    expect(match).toMatchObject({
      canonicalDeveloperId: 'Sangeetha-S_athma',
      method: 'name_normalized',
      confidence: 0.8,
    });
  });

  it('refuses to choose when a name normalizes to several logins', () => {
    const byName = indexLoginsByNormalizedKey(['Jo-Bloggs_acme', 'JoBloggs']);
    expect(resolveIdentity({ name: 'Jo Bloggs' }, noEmails, byName)).toBeNull();
  });

  it('never lets a weaker rung override a stronger one', () => {
    // A login is present, so a name that points elsewhere must be ignored.
    const byName = indexLoginsByNormalizedKey(['someone-else']);
    const match = resolveIdentity(
      { login: 'jdoe', name: 'someone-else' },
      new Map([['j@x.io', 'other']]),
      byName,
    );
    expect(match?.canonicalDeveloperId).toBe('jdoe');
  });

  it('ignores a machine email rather than merging everyone who used it', () => {
    const byEmail = new Map([['noreply@github.com', 'first-person']]);
    const match = resolveIdentity(
      { email: 'noreply@github.com', name: 'Someone' },
      byEmail,
      noNames,
    );
    expect(match?.method).toBe('unresolved');
  });

  it('leaves an unmatchable identity unresolved but still counted', () => {
    const match = resolveIdentity(
      { email: 'nobody@example.org', name: 'Nobody Known' },
      noEmails,
      noNames,
    );
    expect(match).toMatchObject({
      canonicalDeveloperId: 'email:nobody@example.org',
      method: 'unresolved',
      confidence: 0,
    });
  });
});
