import { isGithubApiUrl, nextLinkUrl, redactUrl } from './github-link';

describe('github-link', () => {
  it('returns the rel="next" URL verbatim, including cursors', () => {
    const header =
      '<https://api.github.com/organizations/96329559/audit-log?include=git&phrase=action%3Agit.push&order=desc&per_page=100&after=abc%3D%3D&before=>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(nextLinkUrl(header)).toBe(
      'https://api.github.com/organizations/96329559/audit-log?include=git&phrase=action%3Agit.push&order=desc&per_page=100&after=abc%3D%3D&before=',
    );
  });

  it('returns undefined when there is no next relation or no header', () => {
    expect(
      nextLinkUrl('<https://api.github.com/x?page=1>; rel="prev"'),
    ).toBeUndefined();
    expect(nextLinkUrl(null)).toBeUndefined();
    expect(nextLinkUrl('')).toBeUndefined();
  });

  it('accepts only https://api.github.com as a token-bearing origin', () => {
    expect(isGithubApiUrl('https://api.github.com/orgs/a/audit-log')).toBe(
      true,
    );
    expect(isGithubApiUrl('https://evil.example.com/orgs/a')).toBe(false);
    expect(isGithubApiUrl('http://api.github.com/orgs/a')).toBe(false);
    expect(isGithubApiUrl('not a url')).toBe(false);
  });

  it('redacts the query string so cursors never reach a log', () => {
    expect(
      redactUrl('https://api.github.com/orgs/a/audit-log?after=SECRET'),
    ).toBe('https://api.github.com/orgs/a/audit-log');
    expect(redactUrl('garbage')).toBe('<invalid-url>');
  });
});
