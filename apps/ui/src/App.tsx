import { RepositoryOverview } from './RepositoryOverview.js';
import type { RepositoryStore } from './repository-store.js';
import { createRepositoryStore } from './repository-store.js';

const loadingStore = createRepositoryStore({
  getSnapshot: () => ({ kind: 'loading', message: 'Loading Repository…' }),
  subscribe: () => () => undefined,
  requestRefresh: () => undefined,
  requestFetch: () => undefined,
  requestDiff: () => Promise.reject(new Error('No Repository is loaded.')),
  requestNativeAction: () =>
    Promise.resolve({
      kind: 'unavailable',
      message: 'No Repository is loaded.',
    }),
  searchBranches: async () => ({ refsRevision: 0, candidates: [] }),
  switchBranch: async () => {
    throw new Error('Branch switching is unavailable while loading.');
  },
});

export function App({
  store = loadingStore,
}: {
  readonly store?: RepositoryStore;
}) {
  return <RepositoryOverview store={store} />;
}

export { RepositoryOverview } from './RepositoryOverview.js';
