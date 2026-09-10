/**
 * The admin-stated DEV/QA/OTH classification of a developer.
 *
 * Mirrors `DEVELOPER_ROLES` in `backend/src/metrics/developer-activity.service.ts`.
 * Deliberately a local constant rather than a fetched list: three values do not
 * justify a request on every page load, and the server validates the write
 * regardless — a frontend that drifted ahead of its API gets a 400 rather than
 * a bad row.
 */
export const DEVELOPER_ROLES = ['DEV', 'QA', 'OTH'] as const;

export type DeveloperRoleValue = (typeof DEVELOPER_ROLES)[number];

/** Long form for a tooltip; the badge itself stays the three-letter code. */
export const DEVELOPER_ROLE_LABEL: Record<DeveloperRoleValue, string> = {
  DEV: 'Developer',
  QA: 'Quality assurance',
  OTH: 'Other',
};

/**
 * What to render when there is no classification.
 *
 * One symbol for both `null` (the server says nobody has classified them) and
 * `undefined` (an API too old to have the field). They differ in provenance but
 * not in what the reader should conclude: nobody has said. What must never
 * appear here is `OTH`, which is a decision somebody actually made.
 */
export const UNCLASSIFIED_LABEL = '—';
