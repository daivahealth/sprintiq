import { describe, expect, it } from "vitest";
import { rangesNeedingAttention, type AuditRange } from "./audit-ranges";

function range(over: Partial<AuditRange>): AuditRange {
  return {
    id: "r",
    repoFullName: "athmahealth/ehr",
    ref: "main",
    kind: "moved",
    status: "done",
    attempts: 0,
    truncated: false,
    commitsFound: 0,
    ingested: 0,
    lastError: null,
    lastAttemptAt: null,
    createdAt: "2026-10-19T00:00:00.000Z",
    ...over,
  };
}

describe("rangesNeedingAttention", () => {
  it("keeps failed, truncated and retrying ranges, and drops healthy ones", () => {
    const out = rangesNeedingAttention([
      range({ id: "ok" }),
      range({ id: "queued", status: "pending" }),
      range({ id: "retrying", status: "pending", attempts: 2 }),
      range({ id: "trunc", truncated: true }),
      range({ id: "fail", status: "failed", attempts: 9 }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["fail", "trunc", "retrying"]);
  });

  it("orders newest first within a kind and shows each range once", () => {
    const a = range({ id: "a", status: "failed", createdAt: "2026-10-18T00:00:00.000Z" });
    const b = range({ id: "b", status: "failed", createdAt: "2026-10-19T00:00:00.000Z" });
    expect(rangesNeedingAttention([a, b, a]).map((r) => r.id)).toEqual(["b", "a"]);
  });
});
