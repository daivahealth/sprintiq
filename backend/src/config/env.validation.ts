import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  registerDecorator,
  validateSync,
  ValidationOptions,
} from 'class-validator';
import { AppRole } from './app-role';
import { isValidTriStateFlagValue } from './env-flags';
import { readGithubAuditConfig } from '../collectors/sources/github/github-audit.config';

/**
 * class-validator decorator for a tri-state deployment flag env var: valid
 * when unset (paired with `@IsOptional`, which only skips `null`/
 * `undefined`), when present but empty (an `X=` line in an env file sets
 * `process.env.X` to `''`, not `undefined` — `parseTriStateFlag` treats that
 * the same as unset, so this decorator must accept it too rather than
 * rejecting a value `configuration.ts` would happily parse), or one of the
 * accepted true/false spellings from `env-flags.ts`, case-insensitive.
 *
 * Rejecting anything else here is what makes a typo like
 * `DIGEST_CRON_ENABLED=flase` fail boot instead of silently being parsed as
 * "unset" (armed) by `parseTriStateFlag` downstream — for a flag whose
 * falsey state is a notification kill switch, that failure mode is a real
 * person's name reaching a channel because an operator believed the cron
 * was disarmed.
 */
function IsTriStateFlag(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isTriStateFlag',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') {
            return false;
          }
          return value.trim() === '' || isValidTriStateFlagValue(value);
        },
      },
    });
  };
}

/**
 * Fail-fast validation of the environment at boot. Anything required to run
 * safely is asserted here so misconfiguration surfaces immediately.
 */
class EnvironmentVariables {
  @IsOptional()
  @IsEnum(AppRole)
  APP_ROLE?: AppRole;

  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;

  @IsOptional()
  @IsNumber()
  PORT?: number;

  @IsString()
  DATABASE_URL: string;

  @IsString()
  JWT_SECRET: string;

  /**
   * Deployment-wide kill switch for the daily commit digest cron. See the
   * `notifications.digestCronEnabled` docblock in `configuration.ts` for the
   * full tri-state contract and why it is asymmetric — unset/truthy both
   * defer to the per-tenant flag, only falsey disarms.
   */
  @IsOptional()
  @IsTriStateFlag({
    message:
      'DIGEST_CRON_ENABLED must be one of: true | false | 1 | 0 | on | off (case-insensitive), or unset',
  })
  DIGEST_CRON_ENABLED?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  // Parsed by the same function the sync uses, so boot and runtime can never
  // disagree about what a value means.
  try {
    readGithubAuditConfig(config as NodeJS.ProcessEnv);
  } catch (err) {
    throw new Error(
      `Environment validation failed:\n  - ${(err as Error).message}`,
    );
  }

  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors
        .map(
          (e) =>
            `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
        )
        .join('\n')}`,
    );
  }
  return validated;
}
