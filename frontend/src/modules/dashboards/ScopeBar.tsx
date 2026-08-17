import { useState } from "react";
import { MultiSelect } from "../../components/multi-select";
import { FilterBar, SegmentedControl } from "../../components/ui";
import { TIME_PRESETS, useScope } from "../../lib/scope";
import { FreshnessNote } from "./FreshnessNote";
import { useProjects, useRepos } from "./useCatalog";

/**
 * The global Scope Bar (DASHBOARDS.md §3): projects × repos × time, URL-synced.
 * Selecting projects cross-filters the repo picker via the delivery graph.
 *
 * Each axis is opt-out because not every board consumes the whole scope, and a
 * control that silently does nothing is worse than an absent one — it looks
 * like a filter and reads as though the number below it responded. The
 * Jira-only boards (Velocity, Forecasting, Flow) send `projects` and nothing
 * else, so they turn the rest off rather than offering dead controls.
 */
export function ScopeBar({
  showRepos = true,
  showTime = true,
  showGroupBy = true,
}: {
  showRepos?: boolean;
  showTime?: boolean;
  showGroupBy?: boolean;
}) {
  const { scope, setScope, from } = useScope();
  const [projectSearch, setProjectSearch] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  const projects = useProjects(projectSearch);
  const repos = useRepos(repoSearch, scope.projects);

  return (
    <FilterBar>
      <MultiSelect
        label="Projects"
        options={(projects.data?.items ?? []).map((p) => p.key)}
        selected={scope.projects}
        onChange={(next) =>
          // Changing projects invalidates any repo selection outside them —
          // simplest correct behavior: reset repos to "all in scope".
          setScope({ projects: next, repos: [] })
        }
        onSearch={setProjectSearch}
        loading={projects.isLoading}
        emptyText="No projects found"
      />

      {showRepos && (
        <MultiSelect
          label="Repositories"
          options={(repos.data?.items ?? []).map((r) => r.name)}
          selected={scope.repos}
          onChange={(next) => setScope({ repos: next })}
          onSearch={setRepoSearch}
          loading={repos.isLoading}
          emptyText={
            scope.projects.length > 0
              ? "No repos linked to the selected projects"
              : "No repos found"
          }
        />
      )}

      {showTime && (
        <SegmentedControl
          label="Time range"
          value={scope.days}
          onChange={(days) => setScope({ days })}
          options={TIME_PRESETS.map((days) => ({
            value: days,
            label: `${days}d`,
          }))}
        />
      )}

      {showGroupBy && (
        <SegmentedControl
          label="Group by"
          value={scope.groupBy}
          onChange={(groupBy) => setScope({ groupBy })}
          optionClassName="capitalize"
          options={(["repo", "project", "developer", "day"] as const).map((groupBy) => ({
            value: groupBy,
            label: groupBy,
          }))}
        />
      )}

      {showRepos && repos.data?.crossFiltered && (
        <p className="pb-2 text-xs text-fg-faint">
          Repos narrowed to those linked to the selected projects (delivery
          graph)
        </p>
      )}

      {/* Every board renders the Scope Bar, so freshness lands on all of them
          from one place rather than being threaded through each read model.
          `from` is handed over so the note judges THIS board's window rather
          than the whole dataset — a 7-day board over a complete 7 days is
          complete, whatever a 12-month backfill is still doing. Boards that
          send no time range (`showTime={false}`) pass none, and get the plain
          statement. */}
      <FreshnessNote windowFrom={showTime ? from : undefined} />
    </FilterBar>
  );
}
