import { createOpaqueIdAuthority } from '@codex-git/protocol';
import { describe, expect, it } from 'vitest';

import {
  createRemoteIdentityState,
  observeRemotes,
  type RemoteGitReader,
} from './remote-observation.js';

describe('effective Remote URL observation', () => {
  it('uses narrow local-only recipes without putting raw push URLs in argv', async () => {
    const calls: Array<{
      readonly args: readonly string[];
      readonly allowLargeOutput: boolean;
      readonly acceptedEmptyExitCode?: 1;
    }> = [];
    const read: RemoteGitReader = async (
      args,
      allowLargeOutput,
      acceptedEmptyExitCode,
    ) => {
      calls.push({ args, allowLargeOutput, acceptedEmptyExitCode });
      if (args.at(-1) === 'remote') {
        return Buffer.from('origin\n');
      }
      if (args.includes('config')) {
        return Buffer.from(
          args.at(-1)?.startsWith('^url\\.') === true
            ? [
                'url.ssh://push.example/general/.pushinsteadof\nalias:',
                'url.ssh://push.example/team/.pushinsteadof\nalias:team/',
                '',
              ].join('\0')
            : [
                'remote.origin.url\nalias:team/one.git',
                'remote.origin.url\nalias:two.git',
                '',
              ].join('\0'),
        );
      }
      if (args.includes('ls-remote')) {
        return Buffer.from(
          'https://user:fetch-secret@fetch.example/repository.git\n',
        );
      }
      throw new Error('Unexpected Git recipe.');
    };
    let issued = 0;
    const ids = createOpaqueIdAuthority({
      randomBytes: () => new Uint8Array(16).fill((issued += 1)),
    });

    const observed = await observeRemotes(
      ['-C', '/fixture/- odd/雪\nworktree'],
      read,
      createRemoteIdentityState(),
      ids,
    );

    expect(calls).toEqual([
      recipe(['-C', '/fixture/- odd/雪\nworktree', 'remote'], false),
      recipe(
        [
          '-C',
          '/fixture/- odd/雪\nworktree',
          'config',
          '--includes',
          '--null',
          '--get-regexp',
          '^remote\\..+\\.(url|pushurl|fetch|push|mirror|prune|prunetags|tagopt|skipdefaultupdate|skipfetchall)$',
        ],
        true,
        1,
      ),
      recipe(
        [
          '-C',
          '/fixture/- odd/雪\nworktree',
          'config',
          '--includes',
          '--null',
          '--get-regexp',
          '^url\\..*\\.(insteadof|pushinsteadof)$',
        ],
        true,
        1,
      ),
      recipe(
        [
          '-C',
          '/fixture/- odd/雪\nworktree',
          'ls-remote',
          '--get-url',
          '--',
          'origin',
        ],
        true,
      ),
    ]);
    expect(observed.remotes[0]).toMatchObject({
      displayName: 'origin',
      host: 'fetch.example',
    });
    expect(JSON.stringify(observed)).not.toMatch(
      /secret|alias:|push\.example/u,
    );
  });
});

function recipe(
  args: readonly string[],
  allowLargeOutput: boolean,
  acceptedEmptyExitCode?: 1,
) {
  return { args, allowLargeOutput, acceptedEmptyExitCode };
}
