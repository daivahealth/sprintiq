import { ulid } from 'ulid';

/**
 * Internal surrogate id — ULID (string, time-sortable). Generated in app code
 * and supplied on create (Prisma has no native ULID default — ADR-0005).
 */
export const newId = (): string => ulid();
