import { describe, expect, it } from 'vitest';
import type { SprintTicketRow } from '../useInsights';
import { NO_EPIC, filterTickets, needsUpdate, sortTickets } from './ticket-view';

function ticket(key: string, over: Partial<SprintTicketRow> = {}): SprintTicketRow {
  return {
    key,
    title: key,
    type: 'story',
    status: 'In Development',
    bucket: 'in-progress',
    storyPoints: 3,
    assigneeName: 'Asha',
    epicKey: 'NHC-1',
    subtasks: { total: 0, done: 0 },
    code: { state: 'none', prs: [], commits: 0, lastCommitAt: null },
    clash: null,
    gaps: [],
    ...over,
  };
}

const TICKETS = [
  ticket('NHC-10', {
    code: { state: 'merged', prs: [], commits: 4, lastCommitAt: null },
    gaps: ['jira-not-updated'],
  }),
  ticket('NHC-9', { bucket: 'todo', storyPoints: null, epicKey: null }),
  ticket('NHC-11', {
    bucket: 'done',
    storyPoints: 8,
    code: { state: 'merged', prs: [], commits: 1, lastCommitAt: null },
    gaps: ['in-qa'],
  }),
];

describe('filterTickets', () => {
  it('combines axes with AND, and "no epic" matches tickets without one', () => {
    expect(
      filterTickets(TICKETS, { code: 'merged', bucket: 'done' }).map((t) => t.key),
    ).toEqual(['NHC-11']);
    expect(filterTickets(TICKETS, { epic: NO_EPIC }).map((t) => t.key)).toEqual([
      'NHC-9',
    ]);
  });

  it('counts only gaps to fix as "needs update" — notes are not', () => {
    expect(TICKETS.filter(needsUpdate).map((t) => t.key)).toEqual(['NHC-10']);
    expect(filterTickets(TICKETS, { gap: 'in-qa' }).map((t) => t.key)).toEqual([
      'NHC-11',
    ]);
  });
});

describe('sortTickets', () => {
  it('keeps the backend order by default', () => {
    expect(sortTickets(TICKETS, { key: 'default', desc: false })).toBe(TICKETS);
  });

  it('sorts keys by issue number, and unestimated below zero points', () => {
    expect(sortTickets(TICKETS, { key: 'key', desc: false }).map((t) => t.key)).toEqual([
      'NHC-9',
      'NHC-10',
      'NHC-11',
    ]);
    expect(sortTickets(TICKETS, { key: 'points', desc: true }).map((t) => t.key)).toEqual(
      ['NHC-11', 'NHC-10', 'NHC-9'],
    );
  });

  it('breaks ties by key ascending in both directions', () => {
    // NHC-10 and NHC-11 are both merged.
    expect(sortTickets(TICKETS, { key: 'code', desc: true }).map((t) => t.key)).toEqual([
      'NHC-9',
      'NHC-10',
      'NHC-11',
    ]);
  });
});
