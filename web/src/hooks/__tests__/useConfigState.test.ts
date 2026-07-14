import { describe, expect, it } from 'vitest';

import { mergeSavedConfigInput } from '../useConfigState';

describe('mergeSavedConfigInput', () => {
  it('preserves unsaved edits in other fields after saving one key', () => {
    const localInputs = {
      'agent.model': 'local-model',
      'agent.temperature': '0.8',
      'agent.max_tokens': '4096',
    };

    expect(mergeSavedConfigInput(localInputs, 'agent.model', ' saved-model ')).toEqual({
      'agent.model': 'saved-model',
      'agent.temperature': '0.8',
      'agent.max_tokens': '4096',
    });
  });
});
