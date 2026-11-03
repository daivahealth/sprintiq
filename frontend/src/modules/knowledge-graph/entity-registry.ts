import {
  FolderGit2,
  GitCommitHorizontal,
  GitPullRequest,
  Lightbulb,
  MessageSquareText,
  Ticket,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The explorer's single registry of entity and relationship types.
 *
 * The canvas, legend and details panel read everything type-specific from
 * here, so a new entity (FEATURE, TEAM, SERVICE…) is a registry entry plus a
 * details renderer — never a change to the canvas. An entry with
 * `available: false` is known to the model but has no backend source yet: it
 * is listed in Relationship Coverage and never drawn or offered in the UI.
 */

export type EntityType =
  | 'REPOSITORY'
  | 'DEVELOPER'
  | 'COMMIT'
  | 'PULL_REQUEST'
  | 'REVIEW'
  | 'JIRA_ISSUE'
  | 'TEAM'
  | 'FEATURE';

export type RelationType =
  | 'CONTRIBUTED_TO'
  | 'CREATED'
  | 'BELONGS_TO'
  | 'REFERENCES'
  | 'ASSIGNED_TO'
  | 'MEMBER_OF'
  | 'OWNS'
  | 'IMPLEMENTED_IN';

/** Cytoscape's node shapes that the registry uses. */
export type NodeShape =
  | 'round-rectangle'
  | 'ellipse'
  | 'diamond'
  | 'hexagon'
  | 'round-triangle'
  | 'round-tag'
  | 'octagon'
  | 'star';

export interface EntityConfig {
  type: EntityType;
  label: string;
  pluralLabel: string;
  icon: LucideIcon;
  /** A design token (`--chart-N`) resolved at runtime, so both themes follow. */
  colorToken: string;
  /** Shape as well as colour, so types stay distinguishable without colour. */
  shape: NodeShape;
  size: number;
  /** Whether the backend serves this entity today. */
  available: boolean;
  /** Relationships this entity takes part in (for the legend and details). */
  relations: RelationType[];
  /** What expanding the node does, or null when it cannot be expanded. */
  expansion: string | null;
}

export const ENTITY_REGISTRY: Record<EntityType, EntityConfig> = {
  REPOSITORY: {
    type: 'REPOSITORY',
    label: 'Repository',
    pluralLabel: 'Repositories',
    icon: FolderGit2,
    colorToken: '--chart-1',
    shape: 'round-rectangle',
    size: 46,
    available: true,
    relations: ['CONTRIBUTED_TO', 'BELONGS_TO'],
    expansion: 'Open this repository and its developers',
  },
  DEVELOPER: {
    type: 'DEVELOPER',
    label: 'Developer',
    pluralLabel: 'Developers',
    icon: User,
    colorToken: '--chart-2',
    shape: 'ellipse',
    size: 38,
    available: true,
    relations: ['CONTRIBUTED_TO', 'CREATED', 'ASSIGNED_TO'],
    expansion: 'Show their commits, PRs and reviews in this repository',
  },
  COMMIT: {
    type: 'COMMIT',
    label: 'Commit',
    pluralLabel: 'Commits',
    icon: GitCommitHorizontal,
    colorToken: '--chart-3',
    shape: 'diamond',
    size: 22,
    available: true,
    relations: ['CREATED', 'BELONGS_TO'],
    expansion: null,
  },
  PULL_REQUEST: {
    type: 'PULL_REQUEST',
    label: 'Pull request',
    pluralLabel: 'Pull requests',
    icon: GitPullRequest,
    colorToken: '--chart-4',
    shape: 'hexagon',
    size: 28,
    available: true,
    relations: ['CREATED', 'BELONGS_TO', 'REFERENCES'],
    expansion: 'Show its reviews and linked Jira issues',
  },
  REVIEW: {
    type: 'REVIEW',
    label: 'Review',
    pluralLabel: 'Reviews',
    icon: MessageSquareText,
    colorToken: '--chart-5',
    shape: 'round-triangle',
    size: 22,
    available: true,
    relations: ['CREATED', 'BELONGS_TO'],
    expansion: null,
  },
  JIRA_ISSUE: {
    type: 'JIRA_ISSUE',
    label: 'Jira issue',
    pluralLabel: 'Jira issues',
    icon: Ticket,
    colorToken: '--chart-6',
    shape: 'round-tag',
    size: 28,
    available: true,
    relations: ['REFERENCES', 'ASSIGNED_TO'],
    expansion: null,
  },
  // Known to the backend model, with no source data (ADR-0013). Never drawn.
  TEAM: {
    type: 'TEAM',
    label: 'Team',
    pluralLabel: 'Teams',
    icon: Users,
    colorToken: '--fg-muted',
    shape: 'octagon',
    size: 40,
    available: false,
    relations: ['MEMBER_OF', 'OWNS'],
    expansion: null,
  },
  // Reserved for feature discovery (features/ANALYTICS.md §6). Never drawn.
  FEATURE: {
    type: 'FEATURE',
    label: 'Feature',
    pluralLabel: 'Features',
    icon: Lightbulb,
    colorToken: '--fg-muted',
    shape: 'star',
    size: 40,
    available: false,
    relations: ['IMPLEMENTED_IN'],
    expansion: null,
  },
};

export interface RelationConfig {
  type: RelationType;
  /** Edge label, read source → target. */
  label: string;
  /** A dashed line marks an edge derived or inferred by the backend. */
  style: 'solid' | 'dashed';
  description: string;
}

export const RELATION_REGISTRY: Record<RelationType, RelationConfig> = {
  CONTRIBUTED_TO: {
    type: 'CONTRIBUTED_TO',
    label: 'contributed to',
    style: 'dashed',
    description:
      'Derived by the backend: the developer has at least one commit, PR or review in the repository inside the loaded window.',
  },
  CREATED: {
    type: 'CREATED',
    label: 'created',
    style: 'solid',
    description:
      'The developer authored the commit, opened the PR or submitted the review, as resolved by identity resolution.',
  },
  BELONGS_TO: {
    type: 'BELONGS_TO',
    label: 'belongs to',
    style: 'solid',
    description:
      'A commit or PR belongs to its repository; a review belongs to its PR. Recorded by the collectors.',
  },
  REFERENCES: {
    type: 'REFERENCES',
    label: 'references',
    style: 'dashed',
    description:
      'Inferred by correlation: a Jira key found in the PR title, branch or commit messages. Carries a confidence score.',
  },
  ASSIGNED_TO: {
    type: 'ASSIGNED_TO',
    label: 'assigned to',
    style: 'solid',
    description:
      'The Jira assignee, matched to a developer through the Jira identity bridge.',
  },
  MEMBER_OF: {
    type: 'MEMBER_OF',
    label: 'member of',
    style: 'solid',
    description: 'Not available: SprintIQ stores no team membership.',
  },
  OWNS: {
    type: 'OWNS',
    label: 'owns',
    style: 'solid',
    description: 'Not available: SprintIQ stores no repository ownership.',
  },
  IMPLEMENTED_IN: {
    type: 'IMPLEMENTED_IN',
    label: 'implemented in',
    style: 'dashed',
    description: 'Planned: feature discovery is not built yet.',
  },
};

/** Entity types the explorer may draw today, in legend order. */
export const DRAWABLE_ENTITIES: EntityConfig[] = Object.values(
  ENTITY_REGISTRY,
).filter((entity) => entity.available);
