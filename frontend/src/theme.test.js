import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTheme, mix, themeFontsUrl, themeVariables } from './theme.js';

test('a primary color becomes the whole green scale', () => {
  const vars = themeVariables({ primary: '#1F4E5F', text: '#2b2b2b', body_font: 'Lato', heading_font: 'Playfair Display' });
  assert.equal(vars['--green-700'], '#1f4e5f');
  assert.equal(vars['--green-50'], mix('#1f4e5f', '#ffffff', 0.94));
  assert.equal(vars['--text'], '#2b2b2b');
  assert.equal(vars['--font'], "'Lato', system-ui, -apple-system, sans-serif");
  assert.equal(vars['--display'], "'Playfair Display', Georgia, serif");
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

test('values that are not plain colors or font names are ignored', () => {
  assert.deepEqual(themeVariables({ primary: 'red;}body{display:none', text: '#12', body_font: "x';}*{", heading_font: '' }), {});
  assert.deepEqual(themeVariables(null), {});
});

test('fonts load from one stylesheet; apply and undo', () => {
  assert.equal(themeFontsUrl({ heading_font: 'Playfair Display', body_font: 'Lato' }),
    'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Lato:wght@400;700&display=swap');
  assert.equal(themeFontsUrl({}), '');
  const props = new Map([['--green-700', '#2b6248']]);
  const root = { style: {
    getPropertyValue: n => props.get(n) || '', setProperty: (n, v) => props.set(n, v), removeProperty: n => props.delete(n) } };
  const undo = applyTheme({ primary: '#1f4e5f' }, root);
  assert.equal(props.get('--green-700'), '#1f4e5f');
  undo();
  assert.equal(props.get('--green-700'), '#2b6248');
  assert.equal(props.has('--green-50'), false);
});
