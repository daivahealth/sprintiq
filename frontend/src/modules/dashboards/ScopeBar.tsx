import { useState } from "react";
import { MultiSelect } from "../../components/multi-select";
import { FilterBar, SegmentedControl } from "../../components/ui";
import { TIME_PRESETS, useScope } from "../../lib/scope";
import { FreshnessNote } from "./FreshnessNote";
import { useProjects, useRepos } from "./useCatalog";

/**
 * The global Scope Bar (DASHBOARDS.md §3): projects × repos × time, URL-synced.
 * Selecting projects cross-filters the repo picker via the delivery graph.
 */
export function ScopeBar({ showGroupBy = true }: { showGroupBy?: boolean }) {
  const { scope, setScope } = useScope();
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

      <SegmentedControl
        label="Time range"
        value={scope.days}
        onChange={(days) => setScope({ days })}
        options={TIME_PRESETS.map((days) => ({ value: days, label: `${days}d` }))}
      />

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

      {repos.data?.crossFiltered && (
        <p className="pb-2 text-xs text-fg-faint">
          Repos narrowed to those linked to the selected projects (delivery
          graph)
        </p>
      )}

      {/* Every board renders the Scope Bar, so freshness lands on all of them
          from one place rather than being threaded through each read model. */}
      <FreshnessNote />
    </FilterBar>
  );
}
