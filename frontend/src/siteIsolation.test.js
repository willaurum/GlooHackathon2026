import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cacheDir = mkdtempSync(join(tmpdir(), 'tekton-site-tests-'));
const server = await createServer({ configFile: false, cacheDir, esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true }, appType: 'custom' });
after(async () => { await server.close(); rmSync(cacheDir, { recursive: true, force: true }); });
const { ChurchContext } = await server.ssrLoadModule('/src/ChurchContext.js');
const { default: Give, LoadError } = await server.ssrLoadModule('/src/Give.jsx');
const { default: Home } = await server.ssrLoadModule('/src/Home.jsx');
const { SiteNav } = await server.ssrLoadModule('/src/Layout.jsx');
const { default: ChatWidget } = await server.ssrLoadModule('/src/ChatWidget.jsx');

const church = { slug: 'cedar-hollow', name: 'Cedar Hollow Community Church', demo: false, ready: true,
  pages: [], site: null, go() {}, choose() { assert.fail('Switched church'); } };
const render = (component, props, context = church) => renderToStaticMarkup(
  React.createElement(ChurchContext.Provider, { value: context }, React.createElement(component, props)));

test('imported church pages and giving errors contain no demo church identity or links', () => {
  for (const html of [render(Home, { go() {}, onAsk() {} }), render(SiteNav, { route: '', go() {} }),
    render(ChatWidget, { open: true, setOpen() {} }), render(Give, { route: 'give', go() {} }),
    render(LoadError, { err: { status: 404 } }), render(LoadError, { err: new Error('Offline') })])
    assert.doesNotMatch(html, /Grace Community|grace-community/);
});

test('preview giving shows its imported link or the creation message', () => {
  const preview = { ...church, slug: 'builder-preview', preview: true };
  let html = render(Give, { route: 'give', go() {} }, preview);
  assert.match(html, /Online giving opens after your church is created\./);
  assert.doesNotMatch(html, /Grace Community|grace-community|Giving is unavailable/);
  html = render(Give, { route: 'give', go() {} }, { ...preview,
    site: { links: [{ kind: 'giving', text: 'Cedar Hollow gifts', url: 'https://cedar-hollow.example/give' }] } });
  assert.match(html, /https:\/\/cedar-hollow.example\/give/);
  assert.doesNotMatch(html, /Grace Community|grace-community|Online giving opens|Giving is unavailable/);
});
