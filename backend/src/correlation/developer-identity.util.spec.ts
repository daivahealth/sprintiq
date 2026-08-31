import {
  indexLoginsByNormalizedKey,
  buildDeveloperEmailIndex,
  isAnonymizedAccount,
  isBotDeveloper,
  isMachineEmail,
  jiraSourceKeyOf,
  resolveDisplayName,
  suggestMatches,
  normalizeIdentityKey,
  resolveIdentity,
  resolveJiraIdentity,
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

describe('jiraSourceKeyOf', () => {
  it('keys on the account reference when Jira supplied one', () => {
    expect(jiraSourceKeyOf({ login: '5b10a2', name: 'Priya Iyer' })).toBe(
      'login:5b10a2',
    );
  });

  it('keys a login-less assignee on the NORMALIZED name', () => {
    // "Priya Iyer" and "priya.iyer" are one assignee to every matching rung,
    // so keying them separately would upsert two rows for one person and
    // double-count them in any assignee roll-up.
    expect(jiraSourceKeyOf({ name: 'Priya Iyer' })).toBe(
      jiraSourceKeyOf({ name: 'priya.iyer' }),
    );
  });

  it('has nothing to key an empty assignee on', () => {
    expect(jiraSourceKeyOf({})).toBeNull();
  });
});

describe('resolveJiraIdentity', () => {
  const noNames = new Map<string, string[]>();

  it('bridges a Jira assignee to the GitHub developer of the same name', () => {
    const byName = indexLoginsByNormalizedKey(['Priya-Iyer_athma']);
    const match = resolveJiraIdentity(
      { login: '5b10a2', name: 'Priya Iyer' },
      byName,
    );

    expect(match).toMatchObject({
      canonicalDeveloperId: 'Priya-Iyer_athma',
      method: 'name_normalized',
    });
    expect(match?.evidence).toMatchObject({
      source: 'jira',
      matchedOn: 'name',
    });
  });

  it('falls back to the account reference when the display name misses', () => {
    // Jira Server instances often use the corporate username as the account
    // reference, which can be the GitHub login verbatim.
    const byName = indexLoginsByNormalizedKey(['rvenugopal']);
    const match = resolveJiraIdentity(
      { login: 'rvenugopal', name: 'R. V.' },
      byName,
    );

    expect(match?.canonicalDeveloperId).toBe('rvenugopal');
    expect(match?.evidence).toMatchObject({ matchedOn: 'login' });
  });

  it('refuses to pick when two colleagues normalize to one key', () => {
    // This feeds the "committing without assigned work" list: guessing here
    // would credit one person's tickets to another AND report the wronged
    // party as working off-plan.
    const byName = indexLoginsByNormalizedKey(['Priya-Iyer', 'priya.iyer']);
    expect(resolveJiraIdentity({ name: 'Priya Iyer' }, byName)).toBeNull();
  });

  it('keeps an unmatched assignee countable under a namespaced id', () => {
    const match = resolveJiraIdentity(
      { login: '5b10a2', name: 'Nobody Known' },
      noNames,
    );

    expect(match).toMatchObject({
      canonicalDeveloperId: 'jira:5b10a2',
      method: 'unresolved',
      confidence: 0,
    });
  });

  it('never mints a canonical id that could collide with a GitHub login', () => {
    const match = resolveJiraIdentity({ login: 'octocat' }, noNames);
    // Without the namespace this would BE the GitHub developer `octocat`,
    // silently merging a Jira account into a developer it never matched.
    expect(match?.canonicalDeveloperId).toBe('jira:octocat');
  });
});

describe('buildDeveloperEmailIndex', () => {
  it('maps a corporate address to the developer who commits under it', () => {
    const index = buildDeveloperEmailIndex([
      {
        canonicalDeveloperId: 'Priya-Iyer_athma',
        email: 'Priya.Iyer@Corp.Example',
      },
    ]);
    // Lowercased on both sides: git config casing is arbitrary and real data
    // carries RA...@NARAYANAHEALTH.ORG beside ra...@narayanahealth.org.
    expect(index.get('priya.iyer@corp.example')).toBe('Priya-Iyer_athma');
  });

  it('drops an address shared by two developers rather than merging them', () => {
    // A team mailbox identifies nobody in particular. Keeping it would let the
    // Jira bridge fuse two colleagues into one person.
    const index = buildDeveloperEmailIndex([
      { canonicalDeveloperId: 'dev-a', email: 'team@corp.example' },
      { canonicalDeveloperId: 'dev-b', email: 'team@corp.example' },
    ]);
    expect(index.has('team@corp.example')).toBe(false);
  });

  it('excludes machine addresses', () => {
    const index = buildDeveloperEmailIndex([
      { canonicalDeveloperId: 'dev', email: 'noreply@github.com' },
      { canonicalDeveloperId: 'dev', email: '1+dev@users.noreply.github.com' },
    ]);
    expect(index.size).toBe(0);
  });

  it('ignores identities carrying no email', () => {
    expect(
      buildDeveloperEmailIndex([{ canonicalDeveloperId: 'dev', email: null }])
        .size,
    ).toBe(0);
  });
});

describe('resolveJiraIdentity — email rung', () => {
  const noNames = new Map<string, string[]>();

  it('matches on the Atlassian email even when the display name would not', () => {
    // The case that motivates the whole rung: Jira shows "R. V." while the
    // person commits as `rvenugopal`, so no name rung can bridge them — but
    // both accounts sit on the same corporate address.
    const byEmail = new Map([['rv@corp.example', 'rvenugopal']]);
    const match = resolveJiraIdentity(
      { login: '5b10a2', name: 'R. V.', email: 'RV@Corp.Example' },
      noNames,
      byEmail,
    );

    expect(match).toMatchObject({
      canonicalDeveloperId: 'rvenugopal',
      method: 'email_exact',
      confidence: 0.95,
    });
  });

  it('prefers the email over a display name pointing elsewhere', () => {
    // Strongest evidence wins, exactly as in resolveIdentity: a name collision
    // must never override a matched unique key.
    const byName = indexLoginsByNormalizedKey(['someone-else']);
    const match = resolveJiraIdentity(
      { name: 'someone-else', email: 'real@corp.example' },
      byName,
      new Map([['real@corp.example', 'the-real-person']]),
    );
    expect(match?.canonicalDeveloperId).toBe('the-real-person');
  });

  it('ignores a machine address rather than merging everyone who used it', () => {
    const match = resolveJiraIdentity(
      { login: 'acct', email: 'noreply@github.com' },
      noNames,
      new Map([['noreply@github.com', 'first-person']]),
    );
    expect(match?.method).toBe('unresolved');
  });

  it('falls back to the name rungs when no email was disclosed', () => {
    // Jira Cloud withholds emailAddress unless profile visibility permits, so
    // this is the DEFAULT path, not an edge case — it must behave exactly as
    // it did before emails were collected at all.
    const byName = indexLoginsByNormalizedKey(['Priya-Iyer_athma']);
    const match = resolveJiraIdentity(
      { login: '5b10a2', name: 'Priya Iyer', email: null },
      byName,
      new Map(),
    );
    expect(match).toMatchObject({
      canonicalDeveloperId: 'Priya-Iyer_athma',
      method: 'name_normalized',
    });
  });

  it('falls back to names when the email matches no developer', () => {
    const byName = indexLoginsByNormalizedKey(['Priya-Iyer_athma']);
    const match = resolveJiraIdentity(
      { name: 'Priya Iyer', email: 'contractor@elsewhere.example' },
      byName,
      new Map([['someone@corp.example', 'other']]),
    );
    expect(match?.method).toBe('name_normalized');
  });
});

describe('isBotDeveloper', () => {
  it('recognises the [bot] login convention', () => {
    expect(isBotDeveloper('dependabot[bot]')).toBe(true);
    expect(isBotDeveloper('github-actions[bot]')).toBe(true);
    expect(isBotDeveloper('renovate[bot]')).toBe(true);
  });

  it('recognises first-party accounts that do not follow it', () => {
    // Observed on the reference tenant committing alongside people.
    expect(isBotDeveloper('Copilot')).toBe(true);
    expect(isBotDeveloper('dependabot')).toBe(true);
  });

  it('does not mistake a person for automation', () => {
    expect(isBotDeveloper('Vijay-Kumar-Yadav_athma')).toBe(false);
    expect(isBotDeveloper('Junaid Haneef')).toBe(false);
    // Substring safety: the suffix is anchored, so a name merely containing
    // "bot" is a person.
    expect(isBotDeveloper('Abbott-Kumar_athma')).toBe(false);
    expect(isBotDeveloper('robotics-team_athma')).toBe(false);
  });

  it('treats a missing id as a person rather than guessing', () => {
    expect(isBotDeveloper(null)).toBe(false);
    expect(isBotDeveloper('')).toBe(false);
  });
});

describe('resolveDisplayName', () => {
  it('prefers the Jira display name — the only curated source', () => {
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'Gnanesh-Gowda-NS_athma',
        jiraDisplayName: 'Gnanesh Gowda NS',
        githubLogin: 'Gnanesh-Gowda-NS_athma',
        gitName: 'Gnanesh-Gowda-NS_a',
      }),
    ).toBe('Gnanesh Gowda NS');
  });

  it('renders the GitHub login as a name when Jira has none', () => {
    // 14 of 111 GitHub entities on the reference tenant have no Jira link.
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'Ram-Kumar_athma',
        githubLogin: 'Ram-Kumar_athma',
      }),
    ).toBe('Ram Kumar');
  });

  it('falls back to the git name, then to the id', () => {
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'x',
        gitName: 'Junaid Haneef',
      }),
    ).toBe('Junaid Haneef');
    expect(resolveDisplayName({ canonicalDeveloperId: 'email:a@b.io' })).toBe(
      'email:a@b.io',
    );
  });

  it('never produces an empty name from a degenerate login', () => {
    // `loginToDisplayName('_athma')` strips to nothing; the ladder must fall
    // through rather than render a blank cell.
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'fallback-id',
        githubLogin: '_athma',
        gitName: 'Real Name',
      }),
    ).toBe('Real Name');
  });
});

describe('suggestMatches', () => {
  const jira = [
    { id: 'a1', name: 'Mohammed Junaid Haneef' },
    { id: 'a2', name: 'Nithin N' },
    { id: 'a3', name: 'Saravanakumar N' },
    { id: 'a4', name: 'Sanjay Kumar Yadav' },
    { id: 'a5', name: 'RamKumar AK' },
  ];

  it('suggests the real match for a name-prefix difference', () => {
    const s = suggestMatches('Junaid Haneef', jira);
    expect(s[0]).toMatchObject({
      candidateName: 'Mohammed Junaid Haneef',
      basis: 'token_subset',
    });
  });

  it('suggests across an added initial', () => {
    expect(suggestMatches('nithin', jira)[0].candidateName).toBe('Nithin N');
    expect(suggestMatches('saravanakumar', jira)[0].candidateName).toBe(
      'Saravanakumar N',
    );
  });

  it('REFUSES two colleagues who merely share surnames', () => {
    // The guard that matters. {vijay,kumar,yadav} and {sanjay,kumar,yadav}
    // overlap 2/3 — identical to the Junaid case under plain overlap scoring —
    // but neither contains the other, and they are different people.
    const s = suggestMatches('Vijay Kumar Yadav', jira);
    expect(s.map((x) => x.candidateName)).not.toContain('Sanjay Kumar Yadav');
  });

  it('catches a compacted spelling via the substring rung', () => {
    const s = suggestMatches('Ram Kumar', jira);
    expect(s[0]).toMatchObject({
      candidateName: 'RamKumar AK',
      basis: 'substring',
    });
  });

  it('does not match on a short key that would fit half the roster', () => {
    // "ram" is 3 chars — below the floor, so it cannot substring-match.
    expect(
      suggestMatches('Ram', [{ id: 'x', name: 'Ramkumar Something' }]),
    ).toEqual([]);
  });

  it('returns every plausible candidate rather than picking one', () => {
    const ambiguous = [
      { id: 'p1', name: 'Nithin Kumar' },
      { id: 'p2', name: 'Nithin Raj' },
    ];
    // Showing both is what stops a reader treating a coin flip as an answer.
    expect(suggestMatches('Nithin', ambiguous)).toHaveLength(2);
  });

  it('ignores an exact self-match and empty input', () => {
    expect(
      suggestMatches('Nithin N', jira).map((s) => s.candidateName),
    ).not.toContain('Nithin N');
    expect(suggestMatches(null, jira)).toEqual([]);
  });
});

describe('resolveDisplayName — real-data defects', () => {
  it('renders a git name that is really a login, not the raw shortcode', () => {
    // `saravanakumar_athma` arrives in git `user.name` verbatim on the
    // reference tenant, and rendered as an EMU shortcode on screen.
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'saravanakumar_athma',
        gitName: 'saravanakumar_athma',
      }),
    ).toBe('saravanakumar');
  });

  it('trims a dangling initial from a hand-entered Jira name', () => {
    // Real value: "Shivam ." — rendered exactly like that.
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'x',
        jiraDisplayName: 'Shivam .',
      }),
    ).toBe('Shivam');
  });

  it('keeps an interior initial intact', () => {
    // Only TRAILING separators go; "S." here is a real part of the name.
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'x',
        jiraDisplayName: 'Rohit S. Patwardhan',
      }),
    ).toBe('Rohit S. Patwardhan');
  });

  it('leaves an ordinary git name alone', () => {
    expect(
      resolveDisplayName({
        canonicalDeveloperId: 'x',
        gitName: 'Junaid Haneef',
      }),
    ).toBe('Junaid Haneef');
  });
});

describe('isAnonymizedAccount', () => {
  it('recognises a deprovisioned EMU login', () => {
    // Both real, from the reference tenant.
    expect(isAnonymizedAccount('1a824967e10493200d5a7ee2d91b87_athma')).toBe(
      true,
    );
    expect(isAnonymizedAccount('27708e63c906f2114404f70224cfb74bf_athma')).toBe(
      true,
    );
  });

  it('recognises one with no enterprise shortcode', () => {
    expect(isAnonymizedAccount('27708e63c906f2114404f70224cfb74bf')).toBe(true);
  });

  it('leaves real people alone', () => {
    expect(isAnonymizedAccount('Vijay-Kumar-Yadav_athma')).toBe(false);
    expect(isAnonymizedAccount('saravanakumar_athma')).toBe(false);
    expect(isAnonymizedAccount('Junaid Haneef')).toBe(false);
    // An employee-number id is a person with odd git config, not a ghost.
    expect(isAnonymizedAccount('379031')).toBe(false);
  });

  it('does not fire on a short or mixed string that could be a chosen login', () => {
    // The narrowness is the point: removing a real person from this board is
    // far worse than leaving one odd-looking row in it.
    expect(isAnonymizedAccount('deadbeef')).toBe(false);
    expect(isAnonymizedAccount('cafe1234_athma')).toBe(false);
    expect(isAnonymizedAccount('abcdef0123456789abcdefg')).toBe(false);
  });

  it('treats a missing id as a person rather than guessing', () => {
    expect(isAnonymizedAccount(null)).toBe(false);
    expect(isAnonymizedAccount('')).toBe(false);
  });
});
