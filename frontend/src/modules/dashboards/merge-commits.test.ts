import { describe, expect, it } from 'vitest';
import { mergeExclusionNote } from './merge-commits';

describe('mergeExclusionNote', () => {
  it('says nothing when no merges were excluded, or the API cannot tell', () => {
    expect(mergeExclusionNote(0)).toBeNull();
    expect(mergeExclusionNote(undefined)).toBeNull();
  });

  it('states the count, singular and plural', () => {
    expect(mergeExclusionNote(1)).toMatch(/^1 merge commit is not counted/);
    expect(mergeExclusionNote(34)).toMatch(/^34 merge commits are not counted/);
  });
});
