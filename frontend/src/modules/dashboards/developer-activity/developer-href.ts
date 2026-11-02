import { rangeParams, type ActivityRange } from '../activity-range';

/**
 * A link to one person's page that carries the window with it.
 *
 * The range lives in the URL, so a bare `?developer=` drops it and `parseRange`
 * falls back to the default — landing the reader on real numbers for a range
 * they did not choose. That is the one failure this section is built to
 * prevent, so every link out of it goes through here.
 *
 * `developer` is the canonical developer id, never a raw login: the Developer
 * page resolves a person's aliases from their canonical id, so a login an
 * admin merged into someone else opens a profile missing half their work.
 */
export function developerHref(developer: string, range: ActivityRange): string {
  const params = rangeParams(range);
  params.set('developer', developer);
  return `../developer?${params.toString()}`;
}
