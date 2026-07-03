import { useState } from "react";
import { MultiSelect } from "../../components/multi-select";
import { TIME_PRESETS, useScope } from "../../lib/scope";
import { cn } from "../../lib/utils";
import { useProjects, useRepos } from "./useCatalog";

/**
 * The global Scope Bar (DASHBOARDS.md §3): projects × repos × time, URL-synced.
 * Selecting projects cross-filters the repo picker via the delivery graph.
 */
export function ScopeBar() {
  const { scope, setScope } = useScope();
  const [projectSearch, setProjectSearch] = useState("");
  const [repoSearch, setRepoSearch] = useState("");

  const projects = useProjects(projectSearch);
  const repos = useRepos(repoSearch, scope.projects);

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
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

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Time range
        </span>
        <div className="flex overflow-hidden rounded-md border border-slate-300">
          {TIME_PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setScope({ days })}
              className={cn(
                "px-3 py-2 text-sm",
                scope.days === days
                  ? "bg-brand text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-slate-500">
          Group by
        </span>
        <div className="flex overflow-hidden rounded-md border border-slate-300">
          {(["repo", "project", "developer", "day"] as const).map((groupBy) => (
            <button
              key={groupBy}
              type="button"
              onClick={() => setScope({ groupBy })}
              className={cn(
                "px-3 py-2 text-sm capitalize",
                scope.groupBy === groupBy
                  ? "bg-brand text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50",
              )}
            >
              {groupBy}
            </button>
          ))}
        </div>
      </div>

      {repos.data?.crossFiltered && (
        <p className="pb-2 text-xs text-slate-400">
          Repos narrowed to those linked to the selected projects (delivery
          graph)
        </p>
      )}
    </div>
  );
}
