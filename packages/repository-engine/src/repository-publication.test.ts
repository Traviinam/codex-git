import { describe, expect, it } from 'vitest';

import type {
  DiscoveredWorktree,
  RepositoryDiscovery,
} from './repository-engine.js';
import { publishDiscovery } from './repository-publication.js';

describe('Repository snapshot revision ownership', () => {
  it('advances Repository but not topology when only selection changes', () => {
    const main = worktree('worktree_main', 'main');
    const linked = worktree('worktree_linked', 'linked');
    const discovery: RepositoryDiscovery = {
      repositoryId: 'repository_fixture' as RepositoryDiscovery['repositoryId'],
      commonGitDirectory:
        '/fixture/.git' as RepositoryDiscovery['commonGitDirectory'],
      selectedWorktreeId: main.worktreeId,
      worktrees: [main, linked],
    };
    const initial = publishDiscovery(discovery);

    const changed = publishDiscovery(
      { ...discovery, selectedWorktreeId: linked.worktreeId },
      initial,
    );

    expect(changed.repositoryRevision).toBe(initial.repositoryRevision + 1);
    expect(changed.topologyRevision).toBe(initial.topologyRevision);
    expect(
      changed.worktrees.map(({ worktreeRevision }) => worktreeRevision),
    ).toEqual(
      initial.worktrees.map(({ worktreeRevision }) => worktreeRevision),
    );
  });
});

function worktree(
  id: string,
  role: DiscoveredWorktree['role'],
): DiscoveredWorktree {
  const canonicalPath = `/fixture/${role}`;
  return {
    worktreeId: id as DiscoveredWorktree['worktreeId'],
    generation: `generation_${role}` as DiscoveredWorktree['generation'],
    displayPath: canonicalPath,
    canonicalPath: canonicalPath as DiscoveredWorktree['canonicalPath'],
    canonicalPathBytes: Buffer.from(canonicalPath),
    role,
    head: {
      kind: 'local_branch',
      fullName: 'refs/heads/main',
      displayName: 'main',
      objectId: null,
    },
    gitLock: { kind: 'unlocked' },
    availability: { kind: 'available' },
  };
}
