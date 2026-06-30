import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { ConnectionsService } from '../../modules/connections/connections.service';
import { CollectorRegistry } from '../framework/collector.registry';
import { IngestionService } from '../ingestion/ingestion.service';
import { SignatureVerifierRegistry } from './signature-verifier.registry';

/**
 * Public webhook receivers (BC-1): POST /webhooks/:source. Authenticated NOT by
 * user JWT but by per-provider signature verification. The resolved connection
 * determines the tenant; the event then enters the single ingestion pipeline.
 *
 * NOTE: the scaffold resolves the connection from a header and acknowledges the
 * delivery; payload normalization into canonical envelopes is implemented by the
 * per-source collector (built with the first vertical slice).
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly verifiers: SignatureVerifierRegistry,
    private readonly collectors: CollectorRegistry,
    private readonly connections: ConnectionsService,
    private readonly ingestion: IngestionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Public()
  @Post(':source')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(
    @Param('source') source: string,
    @Headers('x-sprintiq-connection') connectionId: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const verifier = this.verifiers.get(source);
    if (!verifier) {
      throw new BadRequestException(`Unknown source "${source}".`);
    }
    if (!connectionId) {
      throw new BadRequestException('Missing connection routing header.');
    }

    const connection = await this.connections.findById(connectionId);
    if (!connection || connection.sourceSystem !== source) {
      // 404/409 semantics — do not reveal which; treat as unresolved.
      throw new BadRequestException(
        'Connection not resolvable for this source.',
      );
    }

    // Per-provider signature verification over the raw body. The secret is
    // resolved from the secret store via connection.webhookSecretRef; the
    // scaffold reads it from config/env (SECRETS_PROVIDER=env).
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const secret = this.resolveWebhookSecret(connection.webhookSecretRef);
    if (!verifier.verify(rawBody, req.headers, secret)) {
      throw new UnauthorizedException('Signature verification failed.');
    }

    // Normalize via the source collector, then run each canonical envelope
    // through the single ingestion pipeline within the resolved tenant context.
    const collector = this.collectors.get(source);
    if (!collector) {
      // Verified but no collector yet for this source — ack without ingesting.
      return {
        status: 'accepted',
        source,
        connectionId: connection.id,
        ingested: 0,
      };
    }

    const envelopes = await collector.normalizeWebhook(
      connection,
      rawBody,
      req.headers as Record<string, unknown>,
    );

    return this.tenantContext.runWithTenant(connection.tenantId, async () => {
      let ingested = 0;
      for (const envelope of envelopes) {
        const result = await this.ingestion.ingest(
          connection.tenantId,
          envelope,
        );
        if (result.status === 'accepted') {
          ingested++;
        }
      }
      return {
        status: 'accepted',
        source,
        connectionId: connection.id,
        ingested,
      };
    });
  }

  private resolveWebhookSecret(ref?: string | null): string {
    // Scaffold: env-backed secret resolution. Production resolves `ref` from
    // vault/KMS (SECRETS_PROVIDER). Never log the resolved value.
    if (!ref) {
      return '';
    }
    return process.env[ref] ?? '';
  }
}
