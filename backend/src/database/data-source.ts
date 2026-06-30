import 'reflect-metadata';
import { DataSource } from 'typeorm';

/**
 * Standalone DataSource for the TypeORM CLI (migrations). Mirrors the runtime
 * connection in database.module.ts but is resolved from env directly so it works
 * outside the Nest DI container.
 *
 *   npm run migration:generate -- src/database/migrations/<Name>
 *   npm run migration:run
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'sprintiq',
  password: process.env.DATABASE_PASSWORD ?? 'sprintiq',
  database: process.env.DATABASE_NAME ?? 'sprintiq',
  // Entities/migrations are discovered by glob so new contexts are picked up
  // without editing this file.
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
});
