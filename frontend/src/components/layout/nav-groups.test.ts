import { describe, expect, it } from "vitest";
import type { DashboardAssignment } from "../../modules/dashboards/useInsights";
import { isInGroup, splitNav } from "./nav-groups";

function entry(
  key: string,
  path: string,
  group?: "later",
): DashboardAssignment {
  return { key, title: key, path, description: "", ...(group ? { group } : {}) };
}

const NAV = [
  entry("developer-activity", "/engineering-activity/overview"),
  entry("sprint-health", "/sprint-health"),
  entry("delivery", "/delivery-explorer", "later"),
  entry("sprint-risk", "/sprint-risk", "later"),
];

describe("splitNav", () => {
  it("separates primary entries from the Later group, keeping order", () => {
    const { primary, later } = splitNav(NAV);
    expect(primary.map((d) => d.key)).toEqual([
      "developer-activity",
      "sprint-health",
    ]);
    expect(later.map((d) => d.key)).toEqual(["delivery", "sprint-risk"]);
  });

  it("treats every entry as primary when the API sends no group", () => {
    const old = NAV.map((d) => entry(d.key, d.path));
    expect(splitNav(old).later).toEqual([]);
    expect(splitNav(old).primary).toHaveLength(4);
  });
});

describe("isInGroup", () => {
  const { later } = splitNav(NAV);

  it("is true on a Later board", () => {
    expect(isInGroup(later, "/sprint-risk")).toBe(true);
    expect(isInGroup(later, "/delivery-explorer")).toBe(true);
  });

  it("is false on a primary board, and on a path that merely shares a prefix", () => {
    expect(isInGroup(later, "/sprint-health")).toBe(false);
    expect(isInGroup(later, "/sprint-risk-archive")).toBe(false);
  });
});
