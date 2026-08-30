import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import {
  createRuntimeRepositoryStore,
  readProtocolBootstrap,
} from './runtime-repository-store.js';
import './overview.css';
import './styles.css';

const rootElement = document.querySelector('#root');

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Missing #root element');
}

const bootstrap = readProtocolBootstrap();
const store =
  bootstrap === undefined ? undefined : createRuntimeRepositoryStore(bootstrap);

createRoot(rootElement).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

if (import.meta.hot !== undefined && store !== undefined) {
  import.meta.hot.dispose(() => store.dispose());
}
