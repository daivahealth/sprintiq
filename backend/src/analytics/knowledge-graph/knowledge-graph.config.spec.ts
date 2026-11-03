import {
  DEFAULT_REBUILD_MINUTES,
  DEFAULT_WINDOW_DAYS,
  readKnowledgeGraphConfig,
} from './knowledge-graph.config';

describe('readKnowledgeGraphConfig', () => {
  it('defaults to on, a 90-day window and a 30-minute rebuild', () => {
    expect(readKnowledgeGraphConfig({})).toEqual({
      enabled: true,
      windowDays: DEFAULT_WINDOW_DAYS,
      rebuildMinutes: DEFAULT_REBUILD_MINUTES,
    });
  });

  it('reads explicit values, and an empty value as unset', () => {
    expect(
      readKnowledgeGraphConfig({
        KNOWLEDGE_GRAPH_ENABLED: 'off',
        KNOWLEDGE_GRAPH_WINDOW_DAYS: '30',
        KNOWLEDGE_GRAPH_REBUILD_MINUTES: '',
      }),
    ).toEqual({ enabled: false, windowDays: 30, rebuildMinutes: 30 });
  });

  it.each([
    ['KNOWLEDGE_GRAPH_ENABLED', 'flase'],
    ['KNOWLEDGE_GRAPH_WINDOW_DAYS', '0'],
    ['KNOWLEDGE_GRAPH_WINDOW_DAYS', '7.5'],
    ['KNOWLEDGE_GRAPH_WINDOW_DAYS', '9999'],
    ['KNOWLEDGE_GRAPH_REBUILD_MINUTES', '1'],
  ])('fails boot on %s=%s rather than guessing', (name, value) => {
    expect(() => readKnowledgeGraphConfig({ [name]: value })).toThrow(name);
  });
});
