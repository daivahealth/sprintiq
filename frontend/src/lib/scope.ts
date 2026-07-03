import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * The scope system (DASHBOARDS.md §3): one composable, URL-synced scope that
 * every dashboard reads. The URL is the source of truth — shareable links,
 * back/forward, and React Query cache keys all derive from it.
 */
export interface Scope {
  projects: string[];
  repos: string[];
  groupBy: "repo" | "project" | "developer" | "day";
  /** Rolling window in days (7 | 30 | 90). */
  days: number;
}

export const TIME_PRESETS = [7, 30, 90] as const;
const DEFAULT_DAYS = 30;

function parseList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function useScope() {
  const [params, setParams] = useSearchParams();

  const scope: Scope = useMemo(() => {
    const days = parseInt(params.get("days") ?? "", 10);
    return {
      projects: parseList(params.get("projects")),
      repos: parseList(params.get("repos")),
      groupBy: parseGroupBy(params.get("groupBy")),
      days: TIME_PRESETS.includes(days as (typeof TIME_PRESETS)[number])
        ? days
        : DEFAULT_DAYS,
    };
  }, [params]);

  const setScope = useCallback(
    (next: Partial<Scope>) => {
      setParams(
        (prev) => {
          const merged = { ...scopeFromParams(prev), ...next };
          const out = new URLSearchParams(prev);
          syncParam(out, "projects", merged.projects.join(","));
          syncParam(out, "repos", merged.repos.join(","));
          syncParam(
            out,
            "groupBy",
            merged.groupBy === "repo" ? "" : merged.groupBy,
          );
          syncParam(
            out,
            "days",
            merged.days === DEFAULT_DAYS ? "" : String(merged.days),
          );
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  /** ISO window derived from the rolling-days preset (sent to the API). */
  const from = useMemo(
    () => new Date(Date.now() - scope.days * 86_400_000).toISOString(),
    [scope.days],
  );

  return { scope, setScope, from };
}

function scopeFromParams(params: URLSearchParams): Scope {
  const days = parseInt(params.get("days") ?? "", 10);
  return {
    projects: parseList(params.get("projects")),
    repos: parseList(params.get("repos")),
    groupBy: parseGroupBy(params.get("groupBy")),
    days: TIME_PRESETS.includes(days as (typeof TIME_PRESETS)[number])
      ? days
      : DEFAULT_DAYS,
  };
}

function syncParam(params: URLSearchParams, key: string, value: string) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

function parseGroupBy(value: string | null): Scope["groupBy"] {
  if (value === "project" || value === "developer" || value === "day") {
    return value;
  }
  return "repo";
}
