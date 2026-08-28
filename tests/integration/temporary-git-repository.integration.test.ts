import { afterEach, describe, expect, it } from 'vitest';

import {
  createTemporaryGitRepository,
  type TemporaryGitRepository,
} from '../fixtures/temporary-git-repository.js';

const repositories: TemporaryGitRepository[] = [];

afterEach(async () => {
  await Promise.all(
    repositories.splice(0).map((repository) => repository.dispose()),
  );
});

describe('temporary Git Repository fixture', () => {
  it('creates a Repository accepted by the system Git executable', async () => {
    const repository = await createTemporaryGitRepository();
    repositories.push(repository);

    const result = await repository.git('rev-parse', '--is-inside-work-tree');

    expect(result.stdout.trim()).toBe('true');
  });
});
