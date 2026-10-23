import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BranchesSection, type DeveloperBranchRow } from './BranchesSection';

const row = (over: Partial<DeveloperBranchRow>): DeveloperBranchRow => ({
  repoFullName: 'athmahealth/ehr',
  branch: 'ACT-92445-aot-pre-anesthesia-assessment',
  commits: 2,
  locChanged: 1250,
  lastCommitAt: '2026-10-12T10:51:29.000Z',
  prStatus: 'none',
  ...over,
});

const render = (props: Parameters<typeof BranchesSection>[0]) =>
  renderToStaticMarkup(createElement(BranchesSection, props));

describe('BranchesSection', () => {
  it('lists each branch with its repo, PR badge, commits and lines', () => {
    const html = render({
      branches: [row({}), row({ branch: 'release-1', prStatus: 'merged', commits: 1, locChanged: 7 })],
      branchesTotal: 2,
    });
    expect(html).toContain('ACT-92445-aot-pre-anesthesia-assessment');
    expect(html).toContain('>ehr<');
    expect(html).toContain('No PR');
    expect(html).toContain('PR merged');
    expect(html).toContain('1,250');
    expect(html).toContain('not a');
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('says how many are shown when the list is capped', () => {
    expect(render({ branches: [row({})], branchesTotal: 73 })).toContain(
      'Showing the 1 most recently active of 73.',
    );
  });

  it('explains an empty window instead of rendering an empty table', () => {
    const html = render({ branches: [], branchesTotal: 0 });
    expect(html).toContain('audit-log route in ingest mode');
    expect(html).not.toContain('<table');
  });

  it('reads an older API as "not available", never as "no branches"', () => {
    expect(render({})).toContain('not available');
  });
});
