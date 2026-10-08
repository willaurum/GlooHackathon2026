import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cacheDir = mkdtempSync(join(tmpdir(), 'tekton-editable-tests-'));
const server = await createServer({ configFile: false, cacheDir, esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true }, appType: 'custom' });
after(async () => { await server.close(); rmSync(cacheDir, { recursive: true, force: true }); });
const { ChurchContext } = await server.ssrLoadModule('/src/ChurchContext.js');
const { EditorContext } = await server.ssrLoadModule('/src/Editable.jsx');
const { default: Home } = await server.ssrLoadModule('/src/Home.jsx');
const { PageHeader } = await server.ssrLoadModule('/src/Layout.jsx');
const { readPath } = await server.ssrLoadModule('/src/siteDraft.js');

const site = { copy: { 'home.serve_title': 'Volunteer' }, layout: { hidden: ['home:leaders'] } };
const church = { slug: 'cedar-hollow', name: 'Cedar Hollow', demo: false, ready: true, pages: [], site, go() {}, choose() {} };
const content = { info: { name: 'Cedar Hollow', tagline: 'Draft headline' }, site };
const editor = { content, clean: false, setupHref: '#/c/cedar-hollow/setup', read: path => readPath(content, path),
  status: path => path === 'info.tagline' ? 'changed' : '', label: () => '', setText() {}, addOp() {}, notify() {}, toolbar() {} };
const render = (component, props, value = null) => renderToStaticMarkup(React.createElement(ChurchContext.Provider, { value: church },
  React.createElement(EditorContext.Provider, { value }, React.createElement(component, props))));

test('visitors get the plain site with the church wording and none of the editor', () => {
  const html = render(Home, { go() {}, onAsk() {} });
  assert.match(html, /<h2>Volunteer<\/h2>/);
  assert.match(html, /<h2>Sermon Notes<\/h2>/);
  assert.doesNotMatch(html, /editable|editor-|A big church can still feel personal/);
  assert.equal(render(PageHeader, { eyebrow: 'About', title: 'Who we are.', text: 'Hi', paths: { title: 'copy.header.about.title' } }),
    '<div class="page-header"><div><div class="eyebrow">About</div><h1>Who we are.</h1><p>Hi</p></div></div>');
});

test('in the editor text is editable, drafts show, and hidden sections stay as placeholders', () => {
  const html = render(Home, { go() {}, onAsk() {} }, editor);
  assert.match(html, /<h1 class="editable editable-changed"[^>]*>Draft headline<\/h1>/);
  assert.match(html, /<h2 class="editable"[^>]*>Volunteer<\/h2>/);
  assert.match(html, /Section: For church leaders/);
  assert.match(html, /“For church leaders” is hidden from visitors\./);
  assert.match(html, /class="eyebrow editable-fact"/);
  // With outlines hidden it is the visitors' page with the draft.
  const clean = render(Home, { go() {}, onAsk() {} }, { ...editor, clean: true });
  assert.doesNotMatch(clean, /editable|editor-|For church leaders/);
  assert.match(clean, /<h1>Draft headline<\/h1>/);
});
