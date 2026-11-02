import { Injectable, Logger } from '@nestjs/common';
import { GraphSourceReader } from './graph-source.reader';
import { TenantGraph } from './tenant-graph';

/** Builds one tenant's graph from Postgres, off to the side of the live one. */
@Injectable()
export class KnowledgeGraphLoader {
  private readonly logger = new Logger(KnowledgeGraphLoader.name);

  constructor(private readonly reader: GraphSourceReader) {}

  async build(tenantId: string, since: Date): Promise<TenantGraph> {
    const started = Date.now();
    const directory = await this.reader.directory(tenantId);
    const snapshot = await this.reader.loadSnapshot(tenantId, since, directory);
    const graph = new TenantGraph(tenantId);
    graph.load(snapshot);

    const stats = graph.stats();
    const byType = Object.entries(stats.nodesByType)
      .filter(([, n]) => n > 0)
      .map(([type, n]) => `${type}=${n}`)
      .join(' ');
    this.logger.log(
      `tenant=${tenantId} graph built since ${since.toISOString()}: ` +
        `${stats.nodes} nodes, ${stats.edges} edges (${byType || 'empty'}) ` +
        `in ${Date.now() - started}ms`,
    );
    return graph;
  }
}
