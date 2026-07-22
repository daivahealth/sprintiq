import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { newId } from '../id';
import { PrismaService } from '../../database/prisma.service';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Encrypted, tenant-scoped secret store (BC-0). Lets an admin paste a real
 * GitHub/Jira token into the UI instead of setting a deploy-time env var,
 * without violating "secrets never in plaintext columns, never logged"
 * (docs/security/AUTH-AND-RBAC.md §7): values are AES-256-GCM encrypted with
 * an app-level master key (SECRETS_ENCRYPTION_KEY) before they ever reach
 * Postgres.
 *
 * `resolve()` checks the DB first, then falls back to `process.env[ref]` —
 * existing env-var-based deployments keep working untouched; the DB value
 * only takes over once an admin actually sets one via the UI.
 */
@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /** Whether SECRETS_ENCRYPTION_KEY is present and the right length — i.e. whether setSecret() will work. */
  isEnabled(): boolean {
    return this.resolveKey() !== null;
  }

  async setSecret(tenantId: string, ref: string, value: string): Promise<void> {
    const ciphertext = this.encrypt(value);
    await this.prisma.tenantSecret.upsert({
      where: { tenantId_ref: { tenantId, ref } },
      create: { id: newId(), tenantId, ref, ciphertext },
      update: { ciphertext },
    });
  }

  async deleteSecret(tenantId: string, ref: string): Promise<void> {
    await this.prisma.tenantSecret.deleteMany({ where: { tenantId, ref } });
  }

  async hasSecret(tenantId: string, ref: string): Promise<boolean> {
    const row = await this.prisma.tenantSecret.findUnique({
      where: { tenantId_ref: { tenantId, ref } },
      select: { id: true },
    });
    return Boolean(row);
  }

  async resolve(
    tenantId: string,
    ref: string | null | undefined,
  ): Promise<string> {
    if (!ref) {
      return '';
    }
    const row = await this.prisma.tenantSecret.findUnique({
      where: { tenantId_ref: { tenantId, ref } },
    });
    if (row) {
      try {
        return this.decrypt(row.ciphertext);
      } catch (err) {
        this.logger.error(
          `Failed to decrypt secret "${ref}" for tenant ${tenantId}: ${(err as Error).message}`,
        );
        return '';
      }
    }
    return process.env[ref] ?? '';
  }

  private resolveKey(): Buffer | null {
    const raw = this.configService.get<string>('secrets.encryptionKey');
    if (!raw) {
      return null;
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_LENGTH) {
      this.logger.error(
        `SECRETS_ENCRYPTION_KEY must base64-decode to ${KEY_LENGTH} bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
      );
      return null;
    }
    return key;
  }

  private encrypt(plaintext: string): string {
    const key = this.resolveKey();
    if (!key) {
      throw new Error(
        'SECRETS_ENCRYPTION_KEY is not configured — cannot store a secret value in the database. Set it (openssl rand -base64 32) or use an env-var-backed secret ref instead.',
      );
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  private decrypt(encoded: string): string {
    const key = this.resolveKey();
    if (!key) {
      throw new Error(
        'SECRETS_ENCRYPTION_KEY is not configured — cannot decrypt stored secrets.',
      );
    }
    const raw = Buffer.from(encoded, 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }
}
