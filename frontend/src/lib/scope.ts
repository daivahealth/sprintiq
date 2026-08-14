import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { istWindowFloor } from "./utils";

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
  /**
   * Selected sprint (externalId), when a board has a sprint dimension.
   *
   * In the URL like every other scope axis, so a sprint can be linked to —
   * which is what lets Velocity send you to that sprint's detail on Sprint
   * Health instead of leaving you to find it in a dropdown.
   */
  sprint: string | null;
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

  const scope: Scope = useMemo(() => scopeFromParams(params), [params]);

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
          syncParam(out, "sprint", merged.sprint ?? "");
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  /**
   * ISO window start (sent to the API), aligned to IST calendar days.
   *
   * Calendar-aligned, not a rolling `now - days*86400000`: the activity boards
   * have always bucketed by IST day, so a rolling window meant the same "last
   * 30 days" covered a different range here than there, and two boards could
   * disagree about the same question by a day's work at each edge. One
   * definition now, shared with the backend's `istWindowFloor`.
   */
  const from = useMemo(
    () => istWindowFloor(scope.days).toISOString(),
    [scope.days],
  );

  return { scope, setScope, from };
}

/** The single place the URL is read into a Scope — used by both the hook and its setter. */
function scopeFromParams(params: URLSearchParams): Scope {
  const days = parseInt(params.get("days") ?? "", 10);
  return {
    projects: parseList(params.get("projects")),
    repos: parseList(params.get("repos")),
    groupBy: parseGroupBy(params.get("groupBy")),
    days: TIME_PRESETS.includes(days as (typeof TIME_PRESETS)[number])
      ? days
      : DEFAULT_DAYS,
    sprint: params.get("sprint") || null,
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
