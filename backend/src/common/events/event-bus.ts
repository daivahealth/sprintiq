import { Injectable, Logger } from '@nestjs/common';
import { DomainEvent, DomainEventHandler } from './domain-event';

/**
 * Internal event bus abstraction. The scaffold ships an in-process implementation
 * (synchronous fan-out) suitable for the modular monolith. The same interface
 * maps onto Redis Streams / a broker after service extraction, so consumers do
 * not change (ADR-0001 §3).
 *
 * Handlers must be tenant-safe: the event carries `tenantId`; a handler that
 * persists should run within the corresponding tenant context.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  /** Subscribe to an event type (exact match). Returns an unsubscribe fn. */
  subscribe<T>(type: string, handler: DomainEventHandler<T>): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as DomainEventHandler);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type) ?? [];
      this.handlers.set(
        type,
        current.filter((h) => h !== (handler as DomainEventHandler)),
      );
    };
  }

  /** Publish an event to all subscribers. Handler failures are isolated + logged. */
  async publish<T>(event: DomainEvent<T>): Promise<void> {
    const list = this.handlers.get(event.type) ?? [];
    await Promise.all(
      list.map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          this.logger.error(
            `Handler for "${event.type}" failed (tenant=${event.tenantId}): ${
              (err as Error).message
            }`,
          );
        }
      }),
    );
  }
}
