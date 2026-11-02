import {
  AttributionIndex,
  JiraAssigneeIndex,
} from '../../correlation/developer-identity.service';
import { resolveDisplayName } from '../../correlation/developer-identity.util';
import { attributeCommit } from '../../metrics/developer-activity.service';
import { DeveloperRef } from './knowledge-graph.types';

/**
 * Resolves the author fields on source rows to canonical developers, using
 * BC-5's identity resolution rather than a second copy of it.
 *
 * The rules are the boards' own: a commit resolves through `attributeCommit`
 * (login first, else email); a PR author or reviewer login resolves through
 * the same login index, falling back to the login itself — a login is an
 * identity even before resolution has run; a Jira assignee resolves through
 * the assignee bridge, and an unmatched one resolves to nobody rather than to
 * a guess.
 */
export class DeveloperDirectory {
  private readonly jiraByLogin = new Map<string, string>();
  private readonly jiraByName = new Map<string, string>();

  constructor(
    private readonly attribution: AttributionIndex,
    jira: JiraAssigneeIndex,
  ) {
    for (const [developer, refs] of jira.byDeveloper) {
      refs.logins.forEach((login) => this.jiraByLogin.set(login, developer));
      refs.names.forEach((name) => this.jiraByName.set(name, developer));
    }
  }

  commitAuthor(commit: {
    authorLogin: string | null;
    authorEmail: string | null;
  }): DeveloperRef | undefined {
    const id = attributeCommit(commit, this.attribution);
    return id ? this.ref(id) : undefined;
  }

  /** A PR author or reviewer, known only by GitHub login. */
  loginAuthor(login: string | null | undefined): DeveloperRef | undefined {
    if (!login) {
      return undefined;
    }
    return this.ref(this.attribution.byLogin.get(login) ?? login);
  }

  assignee(story: {
    assigneeLogin: string | null;
    assigneeName: string | null;
  }): DeveloperRef | undefined {
    const id =
      (story.assigneeLogin
        ? this.jiraByLogin.get(story.assigneeLogin)
        : undefined) ??
      (story.assigneeName
        ? this.jiraByName.get(story.assigneeName)
        : undefined);
    return id ? this.ref(id) : undefined;
  }

  private ref(developerId: string): DeveloperRef {
    return {
      developerId,
      displayName:
        this.attribution.displayNames.get(developerId) ??
        resolveDisplayName({
          canonicalDeveloperId: developerId,
          githubLogin: developerId.includes(':') ? undefined : developerId,
        }),
      excluded: this.attribution.excluded.has(developerId),
    };
  }
}
