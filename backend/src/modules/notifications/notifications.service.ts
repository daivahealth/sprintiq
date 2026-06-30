import { Injectable } from '@nestjs/common';

/**
 * BC-15 Notifications & Action. Resolves audience/throttling/quiet-hours, then
 * delivers natively to Slack/Teams/email (delivery clients live in the Collector
 * context). SprintIQ decides *whether* to notify; the client decides *how*.
 * (Scaffold stub.)
 */
@Injectable()
export class NotificationsService {}
