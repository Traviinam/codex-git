import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { App } from './App.js';

describe('standalone surface', () => {
  it('identifies the product while Repository data is loading', () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('Codex Git');
    expect(markup).toContain('Loading Repository…');
  });
});
