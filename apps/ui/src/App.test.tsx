import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';

describe('standalone surface', () => {
  it('identifies itself as an initial scaffold with no Git features', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('Codex Git');
    expect(markup).toContain('Git features are not implemented yet.');
  });
});
