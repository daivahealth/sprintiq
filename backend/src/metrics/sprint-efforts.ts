import { istDateKey } from '../common/time';
import {
  isAnonymizedAccount,
  isBotDeveloper,
  jiraSourceKeyOf,
} from '../correlation/developer-identity.util';

/**
 * Sprint Health → Efforts (ADR-0014): daily Jira check-ins — hours logged and
 * subtasks created — for the first ten tracked developers, A–Z.
 *
 * Pure, and kept apart from `SprintHealthDetailService` on purpose: the page is
 * expected to change, and the rules that make it acceptable at all (who may
 * appear, in what order, what is disclosed) should be testable without a
 * database and replaceable without touching the other panels.
 */

/** How many tracked developers the page shows (product decision 2026-11-23). */
export const EFFORTS_ROSTER_LIMIT = 10;

export interface EffortRow {
  developer: string;
  displayName: string;
  /**
   * Whether SprintIQ can connect this person to a Jira account at all. False
   * rows carry `null` series: "no Jira account linked" is a data gap, and a row
   * of zeros would assert that they logged nothing.
   */
  jiraLinked: boolean;
  /** Seconds logged per day, one entry per `EffortsView.days`. */
  effortSeconds: number[] | null;
  /** Subtasks created per day, one entry per `EffortsView.days`. */
  subtasksCreated: number[] | null;
}

export interface EffortsView {
  /** IST date keys, ascending. */
  days: string[];
  /** A–Z by display name. Never ordered by any figure. */
  rows: EffortRow[];
  /** Same meaning and unit as `CheckInsView.sprintFrom`/`sprintTo`. */
  sprintFrom: string | null;
  sprintTo: string | null;
  /** `EFFORTS_RULE_TEXT` — displayed with the figures (ADR-0014). */
  rule: string;
  roster: {
    /** Active tracked developers. */
    tracked: number;
    shown: number;
    /** Roster entries identity resolution does not know. Never named. */
    unresolved: number;
    /** Bots, anonymized accounts, admin exclusions, live Watchlist exclusions. */
    suppressed: number;
    /** Evaluable tracked developers past the first ten. */
    notShown: number;
  };
  disclosures: {
    /** Sprint items in scope (the sprint's items plus their subtasks). */
    itemsInScope: number;
    /** Of those, items never collected with a complete worklog set. */
    itemsWithoutWorklogSnapshot: number;
    /** Worklogs on the shown days whose author resolves to nobody. */
    unattributedWorklogs: number;
    /** Subtasks created on the shown days with no recorded creator. */
    subtasksWithoutCreator: number;
  };
}

export interface EffortsRosterEntry {
  canonicalDeveloperId: string;
}

export interface EffortsWorklog {
  authorLogin: string | null;
  authorName: string | null;
  authorEmail: string | null;
  startedAt: Date;
  timeSpentSeconds: number;
}

export interface EffortsSubtask {
  creatorLogin: string | null;
  creatorName: string | null;
  sourceCreatedAt: Date | null;
}

export interface BuildEffortsInput {
  days: string[];
  sprintFrom: string | null;
  sprintTo: string | null;
  rule: string;
  roster: EffortsRosterEntry[];
  displayNames: ReadonlyMap<string, string>;
  /** Identity overrides' exclusions plus live Watchlist exclusions. */
  excluded: ReadonlySet<string>;
  /** Developers the persisted Jira bridge knows an account for. */
  jiraLinkedDevelopers: ReadonlySet<string>;
  /** `jiraSourceKeyOf` → resolution, from `resolveJiraPeople`. */
  people: ReadonlyMap<string, { developer: string | null; excluded: boolean }>;
  worklogs: EffortsWorklog[];
  subtasks: EffortsSubtask[];
  itemsInScope: number;
  itemsWithoutWorklogSnapshot: number;
}

/**
 * Who appears, then what each of them logged.
 *
 * Roster order of operations mirrors the digest's `evaluateRoster`: an entry
 * identity resolution cannot place is a data problem, not a person, and is
 * counted, never named; suppression comes next; only then are the remaining
 * people sorted A–Z and cut at ten. The cut happens AFTER the sort so which
 * ten appear depends on names, never on any figure.
 */
export function buildEfforts(input: BuildEffortsInput): EffortsView {
  const known = new Set(input.displayNames.keys());
  let unresolved = 0;
  let suppressed = 0;
  const evaluable: { developer: string; displayName: string }[] = [];
  for (const entry of input.roster) {
    const developer = entry.canonicalDeveloperId;
    if (!known.has(developer)) {
      unresolved++;
      continue;
    }
    if (
      input.excluded.has(developer) ||
      isBotDeveloper(developer) ||
      isAnonymizedAccount(developer)
    ) {
      suppressed++;
      continue;
    }
    evaluable.push({
      developer,
      displayName: input.displayNames.get(developer) ?? developer,
    });
  }
  evaluable.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.developer.localeCompare(b.developer),
  );
  const shown = evaluable.slice(0, EFFORTS_ROSTER_LIMIT);
  const shownIds = new Set(shown.map((p) => p.developer));

  const dayIndex = new Map(input.days.map((key, i) => [key, i]));
  const effort = new Map<string, number[]>();
  const subtasks = new Map<string, number[]>();
  const seen = new Set<string>();
  const series = (map: Map<string, number[]>, developer: string) => {
    let s = map.get(developer);
    if (!s) {
      s = input.days.map(() => 0);
      map.set(developer, s);
    }
    return s;
  };
  const resolve = (
    login: string | null,
    name: string | null,
    email: string | null,
  ) => {
    const key = jiraSourceKeyOf({ login, name, email });
    const hit = key ? input.people.get(key) : undefined;
    return hit && hit.developer && !hit.excluded ? hit.developer : null;
  };

  let unattributedWorklogs = 0;
  for (const w of input.worklogs) {
    const idx = dayIndex.get(istDateKey(w.startedAt));
    if (idx === undefined) {
      continue;
    }
    const developer = resolve(w.authorLogin, w.authorName, w.authorEmail);
    if (!developer) {
      unattributedWorklogs++;
      continue;
    }
    seen.add(developer);
    if (shownIds.has(developer)) {
      series(effort, developer)[idx] += w.timeSpentSeconds;
    }
  }

  let subtasksWithoutCreator = 0;
  for (const s of input.subtasks) {
    if (!s.sourceCreatedAt) {
      continue;
    }
    const idx = dayIndex.get(istDateKey(s.sourceCreatedAt));
    if (idx === undefined) {
      continue;
    }
    if (!s.creatorLogin && !s.creatorName) {
      subtasksWithoutCreator++;
      continue;
    }
    const developer = resolve(s.creatorLogin, s.creatorName, null);
    if (!developer) {
      continue;
    }
    seen.add(developer);
    if (shownIds.has(developer)) {
      series(subtasks, developer)[idx] += 1;
    }
  }

  const rows: EffortRow[] = shown.map(({ developer, displayName }) => {
    // Linked if the persisted bridge knows them, or anything in this sprint
    // resolved to them — either way SprintIQ can see their Jira account, so
    // zeros mean zeros.
    const linked =
      input.jiraLinkedDevelopers.has(developer) || seen.has(developer);
    return {
      developer,
      displayName,
      jiraLinked: linked,
      effortSeconds: linked
        ? (effort.get(developer) ?? input.days.map(() => 0))
        : null,
      subtasksCreated: linked
        ? (subtasks.get(developer) ?? input.days.map(() => 0))
        : null,
    };
  });

  return {
    days: input.days,
    rows,
    sprintFrom: input.sprintFrom,
    sprintTo: input.sprintTo,
    rule: input.rule,
    roster: {
      tracked: input.roster.length,
      shown: shown.length,
      unresolved,
      suppressed,
      notShown: evaluable.length - shown.length,
    },
    disclosures: {
      itemsInScope: input.itemsInScope,
      itemsWithoutWorklogSnapshot: input.itemsWithoutWorklogSnapshot,
      unattributedWorklogs,
      subtasksWithoutCreator,
    },
  };
}
