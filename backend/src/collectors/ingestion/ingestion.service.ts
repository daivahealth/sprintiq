import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { EventBus } from '../../common/events/event-bus';
import { DomainEvent } from '../../common/events/domain-event';
import { newId } from '../../common/id';
import { CanonicalEnvelope } from './canonical-envelope';

export interface IngestResult {
  status: 'accepted' | 'duplicate';
  eventId: string;
}

/**
 * The single internal ingestion pipeline (BC-1). Every collected event — from a
 * webhook receiver or a poller — flows through here:
 *
 *   idempotency check → durable raw-event store → normalize → publish domain event
 *
 * Effectively-once persistence is guaranteed by the unique (tenant, idempotency)
 * key; normalization/correlation happen downstream off the event bus.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBus,
  ) {}

  async ingest(
    tenantId: string,
    envelope: CanonicalEnvelope,
  ): Promise<IngestResult> {
    // 1. Idempotency — webhook + poll converge to one persisted record.
    const existing = await this.prisma.rawEvent.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId,
          idempotencyKey: envelope.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { status: 'duplicate', eventId: existing.id };
    }

    // 2. Durable raw capture (ack happens after this — replay source of truth).
    const raw = await this.prisma.rawEvent.create({
      data: {
        id: newId(),
        tenantId,
        connectionId: envelope.connectionId,
        sourceSystem: envelope.sourceSystem,
        collectionMode: envelope.collectionMode,
        eventType: envelope.eventType,
        idempotencyKey: envelope.idempotencyKey,
        occurredAt: new Date(envelope.occurredAt),
        collectedAt: new Date(envelope.collectedAt),
        envelope: envelope as unknown as object,
        processingStatus: 'received',
      },
    });

    // 3. Normalize → domain event. (Scaffold: pass-through; per-type normalizers
    //    are registered as the planning/code/ci/quality contexts are built.)
    const domainEvent: DomainEvent = {
      type: envelope.eventType,
      tenantId,
      connectionId: envelope.connectionId,
      sourceEventIds: [raw.id],
      occurredAt: new Date(envelope.occurredAt),
      payload: envelope.data,
    };

    // 4. Publish for downstream consumers (correlation → metrics → rules → …).
    await this.eventBus.publish(domainEvent);

    await this.prisma.rawEvent.update({
      where: { id: raw.id },
      data: { processingStatus: 'normalized', processedAt: new Date() },
    });

    this.logger.debug(
      `ingested ${envelope.eventType} (tenant=${tenantId}, mode=${envelope.collectionMode})`,
    );
    return { status: 'accepted', eventId: raw.id };
  }
}
