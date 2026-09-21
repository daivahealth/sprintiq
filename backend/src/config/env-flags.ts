/**
 * Parsing for tri-state deployment kill-switch environment variables —
 * unset/empty, an accepted truthy spelling, or an accepted falsey spelling.
 *
 * `Boolean(process.env.X)` is wrong for this shape: the string `'false'` is
 * truthy, so a deployment that sets `X=false` meaning "off" would silently
 * get "on" instead. A tri-state flag also cannot collapse unset to `false`
 * (`process.env.X === 'true'`) — that reads as "off" for every deployment
 * that has never heard of the variable, which is exactly the upgrade this
 * kind of flag must not break.
 *
 * The accepted spellings are shared between the config-time parser
 * (`parseTriStateFlag`, used in `configuration.ts`) and the boot-time
 * validator (`isValidTriStateFlagValue`, used in `env.validation.ts`) so the
 * two cannot drift — a value `validateEnv` accepts must be a value this
 * parser can turn into `true`/`false`, and vice versa.
 */
const TRUTHY_VALUES: ReadonlySet<string> = new Set(['true', '1', 'on']);
const FALSEY_VALUES: ReadonlySet<string> = new Set(['false', '0', 'off']);

/** Whether a raw env string is one of the accepted tri-state spellings (case-insensitive). */
export function isValidTriStateFlagValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return TRUTHY_VALUES.has(normalized) || FALSEY_VALUES.has(normalized);
}

/**
 * Parses a tri-state env flag: `undefined` for unset/empty (callers must
 * treat this as "no opinion", never as `false`), `true`/`false` for an
 * accepted spelling, case-insensitive.
 *
 * Throws on anything else rather than guessing — for a flag whose falsey
 * state disarms a notification cron, a typo (`DIGEST_CRON_ENABLED=flase`)
 * silently landing on the truthy/no-opinion side would mean the cron stays
 * armed when an operator believed they had disarmed it. `env.validation.ts`
 * is expected to catch this at boot before it reaches here, but the parser
 * throws too, defensively, so this function is never the one place that
 * "makes a typo work".
 */
export function parseTriStateFlag(
  name: string,
  value: string | undefined,
): boolean | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) {
    return true;
  }
  if (FALSEY_VALUES.has(normalized)) {
    return false;
  }
  throw new Error(
    `Invalid ${name} "${value}". Expected one of: true | false | 1 | 0 | on | off (case-insensitive), or unset.`,
  );
}
