import { RepositoryOverview } from './RepositoryOverview.js';
import type { RepositoryStore } from './repository-store.js';
import { createRepositoryStore } from './repository-store.js';

const loadingStore = createRepositoryStore({
  getSnapshot: () => ({ kind: 'loading', message: 'Loading Repository…' }),
  subscribe: () => () => undefined,
  requestRefresh: () => undefined,
  requestFetch: () => undefined,
});

export function App({
  store = loadingStore,
}: {
  readonly store?: RepositoryStore;
}) {
  return <RepositoryOverview store={store} />;
}

export { RepositoryOverview } from './RepositoryOverview.js';
