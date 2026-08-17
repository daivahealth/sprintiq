import { Injectable, Logger } from '@nestjs/common';
import { Connection } from '@prisma/client';
import {
  PlanningSprintRef,
  PlanningSprintChangeRef,
  PlanningStoryPayload,
  PlanningTransitionRef,
} from '../../../common/events/contracts';
import { EventTypes } from '../../../common/events/event-types';
import { newId } from '../../../common/id';
import { SecretsService } from '../../../common/secrets/secrets.service';
import { ConnectionsService } from '../../../modules/connections/connections.service';
import {
  CanonicalEnvelope,
  CollectionMode,
  EnvelopeActor,
} from '../../ingestion/canonical-envelope';
import {
  BaseSourceCollector,
  PollResult,
} from '../../framework/source-collector';
import {
  BASE_SEARCH_FIELDS,
  JiraChangelogEntry,
  JiraClient,
  JiraSearchIssue,
} from './jira.client';

/** Jira Software's Sprint field always carries this custom-field schema type, regardless of its per-site numeric id. */
const SPRINT_FIELD_CUSTOM_TYPE = 'com.pyxis.greenhopper.jira:gh-sprint';

/**
 * Story points have no single stable identity on Jira Cloud: team-managed
 * projects use "Story point estimate" (`jsw-story-points`), classic projects a
 * plain numeric custom field conventionally named "Story Points". A site with
 * both — the common case for an org that migrated — has one populated and the
 * other permanently empty, and WHICH one varies per project. So we resolve
 * every plausible candidate and read the first one actually set on each issue,
 * rather than betting the whole integration on picking correctly up front.
 */
const STORY_POINTS_CUSTOM_TYPE = 'com.pyxis.greenhopper.jira:jsw-story-points';
const STORY_POINTS_FIELD_NAMES = ['story points', 'story point estimate'];

const TYPE_MAP: Record<string, string> = {
  Story: 'story',
  Bug: 'bug',
  Task: 'task',
  Spike: 'spike',
  Epic: 'epic',
  'Sub-task': 'subtask',
  Subtask: 'subtask',
};

/**
 * Bounds how much work one scheduler tick does — large projects catch up over
 * several ticks.
 *
 * Jira tolerates a far bigger budget than GitHub does: a search page returns
 * whole issues, so there is no per-issue detail call (contrast GitHub's
 * COMMIT/PR_ENRICH_BUDGET_PER_TICK, which is what really bounds a tick there).
 * One tick is therefore ~20 requests, not ~2000, and a 90-day window for a
 * busy site (~12k issues) catches up in a handful of ticks instead of hours.
 */
const PAGE_BUDGET_PER_TICK = 20;
/** Jira Cloud's `/search/jql` hard-caps `maxResults` at 100 — asking for more silently returns 100. */
const PAGE_SIZE = 100;
/** Default historical lookback when a connection doesn't set `config.backfillSince`. */
const DEFAULT_BACKFILL_DAYS = 90;

interface JiraSyncCursors {
  /** `nextPageToken` to resume from within the current cursor's JQL pass. */
  resumePageToken?: string;
  /** Watermark: `updated >=` floor for the JQL search; advances once a full pass completes. */
  updatedCursor?: string;
}

/**
 * Native Jira collector (BC-1): normalizes issue webhooks AND runs the
 * scheduled sync (backfill on first runs, then incremental reconciliation via
 * JQL `updated >=`) into the canonical `planning.issue.*` envelope, including
 * the detailing dimensions — epic/parent hierarchy, sprint, fixVersions
 * (releases), assignee, priority, resolution.
 */
@Injectable()
export class JiraCollector extends BaseSourceCollector {
  readonly source = 'jira';
  private readonly logger = new Logger(JiraCollector.name);

  constructor(
    private readonly client: JiraClient,
    private readonly connections: ConnectionsService,
    private readonly secrets: SecretsService,
  ) {
    super();
  }

  async normalizeWebhook(
    connection: Connection,
    rawBody: Buffer,
    _headers: Record<string, unknown>,
  ): Promise<CanonicalEnvelope[]> {
    const body = JSON.parse(rawBody.toString('utf8'));
    const webhookEvent: string = body.webhookEvent ?? '';
    const issue = body.issue;
    if (!issue?.key) {
      return [];
    }
    const eventType =
      webhookEvent === 'jira:issue_created'
        ? EventTypes.PLANNING_STORY_CREATED
        : EventTypes.PLANNING_STORY_UPDATED;

    const cachedFields = connection.config as {
      sprintFieldId?: string | null;
      storyPointsFieldIds?: string[];
      statusCategories?: Record<string, string>;
    } | null;
    // An issue webhook carries the single change-log entry for THIS edit
    // (`body.changelog`), not the issue's whole history — which is exactly the
    // transition that just happened. Keyed on the same changelog id as the
    // poller's, so webhook and poll converge on one row.
    const webhookChangelog: JiraChangelogEntry[] = body.changelog?.id
      ? [
          {
            id: String(body.changelog.id),
            created: issue.fields?.updated ?? this.nowIso(),
            author: body.user,
            items: body.changelog.items,
          },
        ]
      : [];
    const payload = this.mapIssueToPayload(
      issue.key,
      issue.fields ?? {},
      cachedFields?.sprintFieldId,
      cachedFields?.storyPointsFieldIds ?? [],
      webhookChangelog,
      cachedFields?.statusCategories ?? {},
    );
    const occurredAt: string = issue.fields?.updated ?? this.nowIso();

    return [
      this.envelope(
        connection,
        'webhook',
        eventType,
        issue.key,
        occurredAt,
        payload,
        {
          sourceLogin: body.user?.name,
          displayName: body.user?.displayName,
        },
      ),
    ];
  }

  /**
   * Scheduled sync: JQL `updated >= <cursor>` ORDER BY updated ASC, paginated
   * by `startAt`. The same query shape covers both the initial backfill
   * (cursor = the bounded lookback floor) and incremental reconciliation
   * (cursor = the last-synced watermark) — no separate code paths needed,
   * since Jira's search API (unlike GitHub's PR list) filters by date natively.
   */
  /**
   * `PollOptions.peersDue` is accepted and ignored: Jira's cost profile does
   * not multiply by fleet size the way GitHub's does. A Jira tenant has one
   * connection per site (not per repo), and a search page returns whole issues
   * with no per-issue detail call — so a tick is ~20 requests regardless, and
   * there is no fleet budget to divide.
   */
  async poll(connection: Connection): Promise<PollResult> {
    const config = (connection.config ?? {}) as {
      siteUrl?: string;
      email?: string;
      projectKey?: string;
      backfillSince?: string;
      /** Site-specific custom-field id for Sprint; `null` once resolved as absent. */
      sprintFieldId?: string | null;
      /** Site-specific story-point custom-field ids, best-first; `[]` once resolved as absent. */
      storyPointsFieldIds?: string[];
      /** Cached `status name -> category` for classifying transitions. */
      statusCategories?: Record<string, string>;
    };
    if (!config.siteUrl || !config.email) {
      return { envelopes: [], skipped: 'not-configured' };
    }

    const rateLimitState = (connection.rateLimitState ?? {}) as {
      resetAt?: string;
    };
    if (
      rateLimitState.resetAt &&
      new Date(rateLimitState.resetAt).getTime() > Date.now()
    ) {
      // Reported as skipped, not as an empty success: this pass never called
      // Jira, so it is not evidence the connection is up to date.
      return { envelopes: [], skipped: 'rate-limited' };
    }

    const apiToken = await this.secrets.resolve(
      connection.tenantId,
      connection.secretRef,
    );
    if (!apiToken) {
      // Recorded, not silent: with no credential every pass returns zero events
      // forever, which is indistinguishable from a healthy idle connection.
      await this.connections.setSyncHealth(
        connection.id,
        `No credential resolved for secret ref "${connection.secretRef ?? '(unset)'}" — set it in admin/configuration or as an environment variable.`,
      );
      return { envelopes: [], skipped: 'no-credential' };
    }

    const { sprintFieldId, storyPointsFieldIds } =
      await this.resolveCustomFieldIds(connection, config, apiToken);
    const statusCategories = await this.resolveStatusCategories(
      connection,
      config,
      apiToken,
    );
    const fields = [
      ...BASE_SEARCH_FIELDS,
      ...(sprintFieldId ? [sprintFieldId] : []),
      ...storyPointsFieldIds,
    ];

    const cursors: JiraSyncCursors = {
      ...((connection.syncCursors as JiraSyncCursors | null) ?? {}),
    };
    const floor = cursors.updatedCursor
      ? new Date(cursors.updatedCursor)
      : await this.resolveBackfillFloor(connection, config);
    const mode: CollectionMode = cursors.updatedCursor ? 'poll' : 'backfill';

    const jqlParts = [`updated >= "${toJqlDate(floor)}"`];
    if (config.projectKey) {
      jqlParts.unshift(`project = "${config.projectKey}"`);
    }
    const jql = `${jqlParts.join(' AND ')} ORDER BY updated ASC`;

    const envelopes: CanonicalEnvelope[] = [];
    let pageToken = cursors.resumePageToken;
    let lastSeenUpdatedAt: string | undefined;
    let rateLimitedUntil: Date | undefined;
    let passComplete = false;
    let passFailure: string | undefined;

    for (let fetched = 0; fetched < PAGE_BUDGET_PER_TICK; fetched++) {
      const page = await this.client.searchIssues(
        config.siteUrl,
        config.email,
        apiToken,
        { jql, maxResults: PAGE_SIZE, fields, pageToken, withChangelog: true },
      );
      if (page.rateLimitedUntil) {
        rateLimitedUntil = page.rateLimitedUntil;
        break;
      }
      if (page.failed) {
        // The resume request itself failed (e.g. a `pageToken` rejected as
        // expired) — this must never be read as "no more results." Stop the
        // tick and resume from the same `pageToken` next time (handled by
        // the "budget exhausted" branch below, since `pageToken` here still
        // holds the token that was just attempted, not `page.nextPageToken`).
        this.logger.error(
          `Jira search failed for connection ${connection.id} — will retry the same page next tick instead of concluding the backfill is complete.`,
        );
        passFailure =
          'Jira rejected the search request (check the API token, site URL and account permissions).';
        break;
      }
      for (const issue of page.issues) {
        const histories = await this.resolveChangelog(
          config.siteUrl,
          config.email,
          apiToken,
          issue,
        );
        envelopes.push(
          this.fromPolledIssue(
            connection,
            issue,
            mode,
            sprintFieldId,
            storyPointsFieldIds,
            histories,
            statusCategories,
          ),
        );
        const updated = issue.fields?.updated;
        if (typeof updated === 'string') {
          lastSeenUpdatedAt = updated;
        }
      }
      pageToken = page.nextPageToken;
      if (!pageToken) {
        passComplete = true;
        break;
      }
    }

    if (rateLimitedUntil) {
      cursors.resumePageToken = pageToken;
    } else if (passComplete) {
      cursors.resumePageToken = undefined;
      // A `>=` floor re-includes the boundary issue next pass — harmless,
      // the idempotency key on (issueKey, eventType, updated) dedupes it.
      cursors.updatedCursor = lastSeenUpdatedAt ?? new Date().toISOString();
    } else {
      cursors.resumePageToken = pageToken; // budget exhausted — resume next tick
    }

    await this.connections.setSyncCursors(
      connection.id,
      cursors as unknown as Record<string, unknown>,
    );
    await this.connections.setRateLimitState(
      connection.id,
      rateLimitedUntil ? { resetAt: rateLimitedUntil.toISOString() } : {},
    );
    // Cleared on a clean pass so a connection recovers by itself.
    await this.connections.setSyncHealth(connection.id, passFailure ?? null);

    // Checked against the PERSISTED flag (not an in-memory before/after cursor
    // snapshot) so this self-heals connections that already reached poll mode
    // before backfillCompletedAt tracking existed — an in-memory transition
    // check would only ever fire once, at the moment the DB column was added,
    // and permanently miss any connection already past that point by then.
    if (cursors.updatedCursor && !connection.backfillCompletedAt) {
      await this.connections.setBackfillCompletedAt(connection.id);
    }

    // `updatedCursor` is only ever advanced by a pass that ran to completion
    // (`passComplete`) — a budget-exhausted or rate-limited tick leaves it at
    // the previous value. That is exactly the "complete through" guarantee, so
    // it can be reported as one directly.
    return {
      envelopes,
      // Same reason as the GitHub collector: a search Jira rejected must not
      // be recorded as a successful sync (§12 #29).
      failed: passFailure ? true : undefined,
      // Reported from the last issue actually seen, NOT from `updatedCursor`.
      // Jira walks `ORDER BY updated ASC`, so everything between the floor and
      // wherever it has paged to is collected and can be claimed right away —
      // but `updatedCursor` may only advance on a completed pass, because it
      // keys the resume token and moving it mid-pass changes the JQL and
      // invalidates that token. Keeping the reported watermark separate from
      // the resume cursor is what lets a long backfill be honest as it goes
      // instead of silent until it finishes.
      collectedThroughAt:
        parseDate(lastSeenUpdatedAt) ?? parseDate(cursors.updatedCursor),
      // Ascending walk, so coverage starts at the floor from the first pass.
      collectedBackTo: floor,
    };
  }

  /**
   * Resolves and caches (on `connection.config`) the site-specific custom-
   * field ids backing Sprint and Story Points. Both differ per site (e.g.
   * `customfield_10020`), so literal ids like `"sprint"` or `"storyPoints"`
   * never match on a real Jira Cloud instance.
   *
   * Crucially, a FAILED field lookup caches nothing. `getFields` returns
   * `null` on failure (vs `[]` for a genuinely empty catalog) precisely so a
   * transient 401/429 can't be mistaken for "this site has no sprint field"
   * and cached permanently — which would silently disable sprint and
   * story-point collection forever, with no error surfaced anywhere.
   */
  private async resolveCustomFieldIds(
    connection: Connection,
    config: {
      siteUrl?: string;
      email?: string;
      sprintFieldId?: string | null;
      storyPointsFieldIds?: string[];
    },
    apiToken: string,
  ): Promise<{ sprintFieldId: string | null; storyPointsFieldIds: string[] }> {
    const known = {
      sprintFieldId: config.sprintFieldId ?? null,
      storyPointsFieldIds: config.storyPointsFieldIds ?? [],
    };
    if (
      config.sprintFieldId !== undefined &&
      config.storyPointsFieldIds !== undefined
    ) {
      return known;
    }

    const allFields = await this.client.getFields(
      config.siteUrl as string,
      config.email as string,
      apiToken,
    );
    if (allFields === null) {
      this.logger.warn(
        `Jira field lookup failed for ${config.siteUrl} — leaving custom-field ids unresolved and retrying next tick rather than caching "not present".`,
      );
      return known;
    }

    const sprintCandidates = allFields.filter(
      (f) => f.schema?.custom === SPRINT_FIELD_CUSTOM_TYPE,
    );
    const sprintFieldId =
      config.sprintFieldId !== undefined
        ? config.sprintFieldId
        : (sprintCandidates[0]?.id ??
          allFields.find((f) => f.name?.toLowerCase() === 'sprint')?.id ??
          null);

    // Every plausible story-point field, deduped and best-first: the typed
    // team-managed one, then any conventionally-named numeric field.
    const storyPointsFieldIds =
      config.storyPointsFieldIds !== undefined
        ? config.storyPointsFieldIds
        : [
            ...new Set(
              [
                ...allFields.filter(
                  (f) => f.schema?.custom === STORY_POINTS_CUSTOM_TYPE,
                ),
                ...allFields.filter((f) =>
                  STORY_POINTS_FIELD_NAMES.includes(
                    f.name?.toLowerCase() ?? '',
                  ),
                ),
              ].map((f) => f.id),
            ),
          ];

    this.logger.log(
      `Resolved Jira custom fields for ${config.siteUrl}: sprint=${sprintFieldId ?? 'none found'}, storyPoints=[${storyPointsFieldIds.join(', ') || 'none found'}]` +
        (sprintCandidates.length > 1
          ? ` (${sprintCandidates.length} sprint-type fields present — using the first)`
          : ''),
    );
    await this.connections.updateConfig(connection.id, {
      config: {
        ...((connection.config as Record<string, unknown>) ?? {}),
        sprintFieldId,
        storyPointsFieldIds,
      },
      status: connection.status,
    });
    return { sprintFieldId, storyPointsFieldIds };
  }

  /**
   * Pins the backfill floor ONCE, on the first poll of a backfill pass, and
   * caches it onto `connection.config.backfillSince` — same self-heal shape
   * as `resolveSprintFieldId` above. Without this, an unset `backfillSince`
   * would recompute `now - N days` fresh on every tick, drifting the JQL
   * `updated >=` literal between ticks; Jira Cloud's `nextPageToken` is bound
   * to the exact JQL text that produced it, so a resumed page fetched under a
   * drifted floor gets rejected — see the `page.failed` handling in `poll()`.
   */
  private async resolveBackfillFloor(
    connection: Connection,
    config: { backfillSince?: string },
  ): Promise<Date> {
    if (config.backfillSince) {
      const parsed = new Date(config.backfillSince);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    const floor = new Date(
      Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.connections.updateConfig(connection.id, {
      config: {
        ...((connection.config as Record<string, unknown>) ?? {}),
        backfillSince: floor.toISOString(),
      },
      status: connection.status,
    });
    return floor;
  }

  /**
   * The site's `status name -> category` map, cached on `connection.config`.
   *
   * Refreshed whenever a poll sees a status name the cache doesn't cover, so a
   * workflow gaining a status doesn't permanently leave its transitions
   * unclassified — the map is a snapshot of a mutable catalog, unlike the
   * custom-field ids which are effectively fixed per site.
   *
   * A failed fetch keeps whatever is cached rather than overwriting it with
   * nothing (the same reasoning as `resolveCustomFieldIds`).
   */
  private async resolveStatusCategories(
    connection: Connection,
    config: {
      siteUrl?: string;
      email?: string;
      statusCategories?: Record<string, string>;
    },
    apiToken: string,
  ): Promise<Record<string, string>> {
    if (config.statusCategories) {
      return config.statusCategories;
    }
    const fetched = await this.client.getStatusCategories(
      config.siteUrl as string,
      config.email as string,
      apiToken,
    );
    if (!fetched) {
      return {};
    }
    this.logger.log(
      `Resolved ${Object.keys(fetched).length} Jira status categories for ${config.siteUrl}.`,
    );
    await this.connections.updateConfig(connection.id, {
      config: {
        ...((connection.config as Record<string, unknown>) ?? {}),
        statusCategories: fetched,
      },
      status: connection.status,
    });
    return fetched;
  }

  /**
   * The change log embedded by `expand=changelog`, completed via a per-issue
   * fetch when the search returned only part of it (`total` exceeds what came
   * back). Truncation is rare — it needs a long-lived, heavily-worked issue —
   * so this stays a bounded exception rather than an N+1 across the backfill.
   *
   * A failed completion fetch keeps the partial history we already have: some
   * transitions beat silently dropping the issue's timeline entirely.
   */
  private async resolveChangelog(
    siteUrl: string,
    email: string,
    apiToken: string,
    issue: JiraSearchIssue,
  ): Promise<JiraChangelogEntry[]> {
    const embedded = issue.changelog?.histories ?? [];
    const total = issue.changelog?.total ?? embedded.length;
    if (total <= embedded.length) {
      return embedded;
    }
    this.logger.log(
      `Change log for ${issue.key} truncated in search (${embedded.length}/${total}) — fetching the full history.`,
    );
    const full = await this.client.getIssueChangelog(
      siteUrl,
      email,
      apiToken,
      issue.key,
    );
    return full ?? embedded;
  }

  private fromPolledIssue(
    connection: Connection,
    issue: JiraSearchIssue,
    mode: CollectionMode,
    sprintFieldId?: string | null,
    storyPointsFieldIds: string[] = [],
    changelog: JiraChangelogEntry[] = [],
    statusCategories: Record<string, string> = {},
  ): CanonicalEnvelope {
    const payload = this.mapIssueToPayload(
      issue.key,
      issue.fields ?? {},
      sprintFieldId,
      storyPointsFieldIds,
      changelog,
      statusCategories,
    );
    const occurredAt =
      typeof issue.fields?.updated === 'string'
        ? issue.fields.updated
        : this.nowIso();
    // Poll never distinguishes "created" from "updated" from a search result alone.
    return this.envelope(
      connection,
      mode,
      EventTypes.PLANNING_STORY_UPDATED,
      issue.key,
      occurredAt,
      payload,
    );
  }

  private envelope(
    connection: Connection,
    mode: CollectionMode,
    eventType: string,
    issueKey: string,
    occurredAt: string,
    payload: PlanningStoryPayload,
    actor?: EnvelopeActor,
  ): CanonicalEnvelope {
    return {
      schemaVersion: '1.0',
      eventId: newId(),
      // Deterministic so webhook + poll converge on one persisted record.
      //
      // `v2` is a payload-schema generation, bumped when the payload gains a
      // field that only a re-walk can retro-fill (v2: `sprintChanges`). Under
      // the unversioned key, re-collecting an issue UNCHANGED at the source
      // produced the identical key and was dropped before the projector — so
      // already-stored issues could never receive the new field, precisely on
      // the history a re-backfill exists to recover. One re-ingestion wave per
      // bump: v1 raw events stay (append-only log), every projector write is
      // idempotent on natural keys, and future webhook/poll duplicates still
      // converge within v2.
      idempotencyKey: `jira:v2:${issueKey}:${eventType}:${occurredAt}`,
      sourceSystem: 'jira',
      connectionId: connection.id,
      collectionMode: mode,
      eventType,
      occurredAt,
      collectedAt: this.nowIso(),
      externalRefs: { issue_key: issueKey, project: payload.projectKey },
      actor,
      data: payload as unknown as Record<string, unknown>,
    };
  }

  private mapIssueToPayload(
    issueKey: string,
    fields: Record<string, unknown>,
    sprintFieldId?: string | null,
    storyPointsFieldIds: string[] = [],
    changelog: JiraChangelogEntry[] = [],
    statusCategories: Record<string, string> = {},
  ): PlanningStoryPayload {
    const project = fields.project as { key?: string } | undefined;
    const issuetype = fields.issuetype as
      { name?: string; subtask?: boolean } | undefined;
    const projectKey: string = project?.key ?? 'UNKNOWN';
    const issueTypeName: string = issuetype?.name ?? 'Story';
    const isSubtask = Boolean(issuetype?.subtask);
    const type = isSubtask ? 'subtask' : (TYPE_MAP[issueTypeName] ?? 'story');

    // Parent resolution: Jira's `parent` is the epic for stories (team-managed)
    // or the parent story for subtasks; classic epics arrive via `epic` field.
    const parent = fields.parent as
      { key?: string; fields?: { issuetype?: { name?: string } } } | undefined;
    const parentIsEpic =
      parent?.fields?.issuetype?.name === 'Epic' ||
      TYPE_MAP[parent?.fields?.issuetype?.name ?? ''] === 'epic';
    const epic = fields.epic as { key?: string } | undefined;
    const epicKey: string | undefined =
      epic?.key ??
      (typeof fields.epicKey === 'string' ? fields.epicKey : undefined) ??
      (parentIsEpic ? parent?.key : undefined);
    const parentKey: string | undefined =
      isSubtask && parent?.key ? parent.key : undefined;

    const status = fields.status as
      { name?: string; statusCategory?: { key?: string } } | undefined;
    const assignee = fields.assignee as
      { name?: string; accountId?: string; displayName?: string } | undefined;
    const priority = fields.priority as { name?: string } | undefined;
    const fixVersions = fields.fixVersions;

    return {
      externalKey: issueKey,
      projectKey,
      type,
      status: status?.name ?? 'unknown',
      statusCategory: status?.statusCategory?.key ?? undefined,
      transitions: parseTransitions(changelog, statusCategories),
      sprintChanges: parseSprintChanges(changelog, sprintFieldId),
      storyPoints: firstNumeric(fields, storyPointsFieldIds),
      title: typeof fields.summary === 'string' ? fields.summary : '',
      epicKey,
      parentKey,
      sprint: parseSprint(sprintFieldId ? fields[sprintFieldId] : undefined),
      releases: Array.isArray(fixVersions)
        ? fixVersions
            .map((v: { name?: string }) => v?.name)
            .filter((n: unknown): n is string => typeof n === 'string')
        : undefined,
      assigneeLogin: assignee?.name ?? assignee?.accountId ?? undefined,
      assigneeName: assignee?.displayName ?? undefined,
      priority: priority?.name ?? undefined,
      sourceCreatedAt:
        typeof fields.created === 'string' ? fields.created : undefined,
      resolvedAt:
        typeof fields.resolutiondate === 'string'
          ? fields.resolutiondate
          : undefined,
    };
  }
}

/**
 * Status changes out of a Jira change log, oldest first.
 *
 * A change-log entry groups every field edited in one action, so an entry that
 * changed assignee AND status yields exactly one transition here — the others
 * are ignored. Matching is on `field === 'status'` (the display name) OR
 * `fieldId === 'status'`, since Jira populates them inconsistently across
 * classic and team-managed projects.
 */
function parseTransitions(
  changelog: JiraChangelogEntry[],
  statusCategories: Record<string, string> = {},
): PlanningTransitionRef[] {
  const transitions: PlanningTransitionRef[] = [];
  for (const entry of changelog) {
    const item = (entry.items ?? []).find(
      (i) => i.field === 'status' || i.fieldId === 'status',
    );
    // `toString` is the status NAME. An entry without one isn't a usable
    // transition — recording it would put a null target in the timeline.
    if (!item || typeof item.toString !== 'string' || !item.toString) {
      continue;
    }
    if (!entry.id || typeof entry.created !== 'string') {
      continue;
    }
    const fromStatus =
      typeof item.fromString === 'string' && item.fromString
        ? item.fromString
        : undefined;
    transitions.push({
      changelogId: String(entry.id),
      fromStatus,
      toStatus: item.toString,
      fromCategory: fromStatus ? statusCategories[fromStatus] : undefined,
      toCategory: statusCategories[item.toString],
      at: entry.created,
      authorLogin: entry.author?.accountId ?? undefined,
      authorName: entry.author?.displayName ?? undefined,
    });
  }
  return transitions.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Sprint-membership changes out of a Jira change log, oldest first.
 *
 * Jira's Sprint field ACCRETES history: moving a story to the next sprint
 * appends the new sprint's id to a comma-separated list rather than replacing
 * it, and removal (back to backlog) drops an id. So the usable event is the
 * DIFF between `from` and `to`, not either value — and it is taken over the
 * raw id lists, never `fromString`/`toString`, because sprint names may
 * themselves contain commas and an unsplittable name list would corrupt the
 * diff. Matching mirrors `parseTransitions`: the display name `Sprint` OR the
 * site's resolved custom-field id, since Jira populates them inconsistently.
 *
 * A story created directly INTO a sprint produces no changelog entry at all —
 * membership-from-birth is inferred at read time from the story's
 * `sourceCreatedAt` plus the absence of an `added` event (DATA-MODEL.md §4).
 */
function parseSprintChanges(
  changelog: JiraChangelogEntry[],
  sprintFieldId?: string | null,
): PlanningSprintChangeRef[] {
  const changes: PlanningSprintChangeRef[] = [];
  for (const entry of changelog) {
    const item = (entry.items ?? []).find(
      (i) =>
        i.field === 'Sprint' ||
        (sprintFieldId ? i.fieldId === sprintFieldId : false),
    );
    if (!item || !entry.id || typeof entry.created !== 'string') {
      continue;
    }
    const fromIds = splitIdList(item.from);
    const toIds = splitIdList(item.to);
    const addedSprintIds = toIds.filter((id) => !fromIds.includes(id));
    const removedSprintIds = fromIds.filter((id) => !toIds.includes(id));
    // An entry that changed nothing (or whose ids were unparseable) carries no
    // event — recording it would put an empty change in the timeline.
    if (addedSprintIds.length === 0 && removedSprintIds.length === 0) {
      continue;
    }
    changes.push({
      changelogId: String(entry.id),
      addedSprintIds,
      removedSprintIds,
      at: entry.created,
      authorLogin: entry.author?.accountId ?? undefined,
      authorName: entry.author?.displayName ?? undefined,
    });
  }
  return changes.sort((a, b) => a.at.localeCompare(b.at));
}

/** ISO string → Date, or undefined when absent/unparseable. */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Comma-separated id list ("5, 7") → trimmed non-empty ids. */
function splitIdList(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * First numeric value among the candidate field ids — a site can expose more
 * than one story-point field (classic vs team-managed) with only one of them
 * actually populated, and which one varies per project.
 */
function firstNumeric(
  fields: Record<string, unknown>,
  fieldIds: string[],
): number | undefined {
  for (const id of fieldIds) {
    const value = fields[id];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** JQL date-time literal format: `yyyy/MM/dd HH:mm`, evaluated in the Jira instance's timezone. */
function toJqlDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Accepts the normalized `fields.sprint` object (id/name/state/dates). */
/**
 * Jira's Sprint custom field is an array (an issue can carry the history of
 * every sprint it's passed through) — pick the active one if present,
 * otherwise the most recent (last) entry.
 */
function parseSprint(raw: unknown): PlanningSprintRef | undefined {
  const value = Array.isArray(raw)
    ? (raw.find((s) => (s as Record<string, unknown>)?.state === 'active') ??
      raw[raw.length - 1])
    : raw;
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const s = value as Record<string, unknown>;
  if (s.id === undefined || typeof s.name !== 'string') {
    return undefined;
  }
  return {
    externalId: String(s.id),
    name: s.name,
    state: typeof s.state === 'string' ? s.state : undefined,
    startAt: typeof s.startDate === 'string' ? s.startDate : undefined,
    endAt: typeof s.endDate === 'string' ? s.endDate : undefined,
    goal: typeof s.goal === 'string' ? s.goal : undefined,
  };
}
