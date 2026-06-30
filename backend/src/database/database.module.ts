import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

/**
 * Database wiring (TypeORM over PostgreSQL). Entities are auto-loaded from the
 * context modules that register them via TypeOrmModule.forFeature([...]).
 *
 * `synchronize` is config-gated and must remain false outside throwaway local
 * dev — schema changes go through migrations (ADR-0004). Per-context schemas are
 * declared on each entity (see database/schemas.ts).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('database.host'),
        port: config.get<number>('database.port'),
        username: config.get<string>('database.user'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.name'),
        autoLoadEntities: true,
        synchronize: config.get<boolean>('database.synchronize') ?? false,
        logging: config.get<boolean>('database.logging') ?? false,
      }),
    }),
  ],
})
export class DatabaseModule {}
