import { describe, expect, it } from 'vitest';
import { StreamSequence } from '../streamSequence';

describe('StreamSequence', () => {
  it('counts each key on its own, under the daemon\'s one stream', () => {
    const sequence = new StreamSequence('d1');

    expect(sequence.position('s1')).toEqual({ stream: 'd1', seq: 0 });
    expect(sequence.next('s1')).toEqual({ stream: 'd1', seq: 1 });
    expect(sequence.next('s1')).toEqual({ stream: 'd1', seq: 2 });
    expect(sequence.next('s1\0child')).toEqual({ stream: 'd1', seq: 1 });
    expect(sequence.position('s1')).toEqual({ stream: 'd1', seq: 2 });
  });
});
