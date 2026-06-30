import { Injectable } from '@nestjs/common';
import { GithubCollector } from '../sources/github/github.collector';
import { JiraCollector } from '../sources/jira/jira.collector';
import { SourceCollector } from './source-collector';

/**
 * Registry of native source collectors (BC-1). The webhook receiver and the
 * pollers resolve the right collector by source here. New sources register by
 * being added to the constructor.
 */
@Injectable()
export class CollectorRegistry {
  private readonly collectors = new Map<string, SourceCollector>();

  constructor(github: GithubCollector, jira: JiraCollector) {
    this.register(github);
    this.register(jira);
  }

  private register(collector: SourceCollector): void {
    this.collectors.set(collector.source, collector);
  }

  get(source: string): SourceCollector | undefined {
    return this.collectors.get(source);
  }
}
