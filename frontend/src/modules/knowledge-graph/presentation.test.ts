import { describe, expect, it } from 'vitest';
import { engineeringIntelligenceLinks } from '../../components/layout/nav-groups';
import { DRAWABLE_ENTITIES, ENTITY_REGISTRY } from './entity-registry';
import { developersResponse } from './fixtures';
import { alphabetical, repositoryOption, searchEmptyText } from './presentation';

describe('repository dropdown', () => {
  it('shows owner/name with commit and PR counts, and passes the repository id', () => {
    expect(
      repositoryOption({
        id: 'acme/invoice-service',
        fullName: 'Acme/Invoice-Service',
        url: 'https://github.com/Acme/Invoice-Service',
        commitCount: 1214,
        pullRequestCount: 61,
      }),
    ).toEqual({
      value: 'acme/invoice-service',
      label: 'Acme/Invoice-Service',
      hint: '1,214 commits · 61 PRs',
    });
  });

  it('asks for a term before searching, and explains an empty result', () => {
    expect(searchEmptyText('', null)).toBe('Type part of a repository name or URL');
    expect(searchEmptyText('ledger', null)).toContain('Only repositories with activity in the loaded window are indexed');
    expect(searchEmptyText('ledger', 'The knowledge graph is still being built.')).toBe(
      'The knowledge graph is still being built.',
    );
  });
});

describe('alphabetical', () => {
  it('orders people by name, never by activity', () => {
    const view = developersResponse();
    const busiestFirst = [...view.developers].sort((a, b) => b.commitCount - a.commitCount);
    expect(alphabetical(busiestFirst).map((d) => d.displayName)).toEqual(['Asha Rao', 'Dev Kumar']);
  });
});

describe('admin-only navigation', () => {
  it('shows the Knowledge Graph link to admins only', () => {
    expect(engineeringIntelligenceLinks(['admin']).map((l) => l.to)).toEqual([
      '/engineering-intelligence/knowledge-graph',
    ]);
    expect(engineeringIntelligenceLinks(['eng_manager', 'cto'])).toEqual([]);
    expect(engineeringIntelligenceLinks([])).toEqual([]);
  });
});

describe('entity registry', () => {
  it('draws only entities the backend serves; TEAM and FEATURE are known but never drawn', () => {
    expect(DRAWABLE_ENTITIES.map((e) => e.type)).toEqual([
      'REPOSITORY',
      'DEVELOPER',
      'COMMIT',
      'PULL_REQUEST',
      'REVIEW',
      'JIRA_ISSUE',
    ]);
    expect(ENTITY_REGISTRY.TEAM.available).toBe(false);
    expect(ENTITY_REGISTRY.FEATURE.available).toBe(false);
  });

  it('gives every drawable type a distinct shape and colour token', () => {
    expect(new Set(DRAWABLE_ENTITIES.map((e) => e.shape)).size).toBe(DRAWABLE_ENTITIES.length);
    expect(new Set(DRAWABLE_ENTITIES.map((e) => e.colorToken)).size).toBe(DRAWABLE_ENTITIES.length);
  });
});
