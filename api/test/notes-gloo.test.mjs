// Sermon-note answers are Gloo only (no Gemini, no Workers AI text model), and the /llm bridge is just the
// highlight fallback. Run: node --test test/*.test.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DEFAULT_EMBED_MODEL, GLOO_EMBED_URL } from '../embed.ts';
import { access } from '../churches.ts';
import { GLOO_CHAT_URL, GLOO_TIMEOUT_MS, aiBridge, handleNotes, parseModelJson } from '../notes.ts';

const KEY = { GLOO_API_KEY: 'test-key' };
const NOTE = '11111111-2222-3333-4444-555555555555';
const QUOTE = 'Forgiveness is not a feeling, it is a choice you make every day';
const SEGMENTS = ['Welcome everyone to the service this morning.', QUOTE + '.', 'The early church shared meals and prayed together.'];
const ANSWER = { found: true, answer: 'Forgiveness is a choice you make every day.', citations: [{ id: 'C1', quote: QUOTE }] };

/** A church database with one ready note, its chunks already on the current Gloo embedding model. */
function church() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, source_kind TEXT, source_url TEXT, status TEXT);
    CREATE TABLE segments (note_id TEXT, idx INTEGER, start REAL, "end" REAL, text TEXT, PRIMARY KEY (note_id, idx));
    CREATE TABLE chunks (note_id TEXT, idx INTEGER, start REAL, "end" REAL, seg_from INTEGER, seg_to INTEGER,
      text TEXT NOT NULL, embedding TEXT NOT NULL, embed_model TEXT NOT NULL DEFAULT '', PRIMARY KEY (note_id, idx));`);
  db.prepare("INSERT INTO config VALUES ('church', ?)").run(JSON.stringify({ name: 'Grace Community' }));
  db.prepare("INSERT INTO notes VALUES (?, 'Sunday', 'upload', NULL, 'ready')").run(NOTE);
  SEGMENTS.forEach((text, i) => db.prepare('INSERT INTO segments VALUES (?, ?, ?, ?, ?)').run(NOTE, i, i * 10, i * 10 + 9, text));
  const chunk = db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  chunk.run(NOTE, 0, 0, 19, 0, 1, SEGMENTS[0] + ' ' + SEGMENTS[1], '[1,0]', 'gloo:' + DEFAULT_EMBED_MODEL);
  chunk.run(NOTE, 1, 20, 29, 2, 2, SEGMENTS[2], '[0,1]', 'gloo:' + DEFAULT_EMBED_MODEL);
  return db;
}

const envFor = (db, extra = {}) => ({
  NOTES_MIN_SCORE: '0.45',
  AI: { run: () => assert.fail('Workers AI must not be called') },
  CHURCH_DB: {
    idFromName: (name) => name,
    get: () => ({
      async fetch(_url, init) {
        const { batch } = JSON.parse(init.body);
        return Response.json({ results: batch.map(({ sql, params = [] }) => ({ rows: db.prepare(sql).all(...params) })) });
      },
    }),
  },
  ...extra,
});

/** Gloo: the question embeds next to chunk 0; the chat replies with `content` (or fails with `status`). */
function fakeGloo({ content = JSON.stringify(ANSWER), status = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    if (String(url) === GLOO_EMBED_URL) return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) });
    if (String(url) === GLOO_CHAT_URL) return status === 200 ? Response.json({ choices: [{ message: { content } }] }) : new Response('nope', { status });
    throw new Error('unexpected fetch ' + url);
  };
  return { calls, fetcher, chat: () => calls.filter((c) => c.url === GLOO_CHAT_URL) };
}

async function ask(env, fetcher, question = 'What is forgiveness?') {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const url = new URL(`http://api/api/notes/${NOTE}/ask`);
    const container = { fetch: () => assert.fail('the container is not needed') };
    const church = { slug: 'grace-community', name: 'Grace Community', city: '', demo: true };
    const response = await handleNotes(new Request(url, { method: 'POST', body: JSON.stringify({ question }) }), env, url, container, church);
    return { status: response.status, body: await response.json() };
  } finally {
    globalThis.fetch = original;
  }
}

test('the answer request is the chat completions shape Gloo documents, with a timeout', async () => {
  const gloo = fakeGloo();
  const { body } = await ask(envFor(church(), KEY), gloo.fetcher);
  assert.equal(body.engine, 'gloo:gloo-qwen-3.7-flash');
  assert.equal(body.found, true);
  const [call] = gloo.chat();
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer test-key');
  assert.equal(call.body.auto_routing, false);
  assert.equal(call.body.model, 'gloo-qwen-3.7-flash');
  assert.equal(call.body.messages[0].role, 'system');
  assert.match(call.body.messages[1].content, /Question: What is forgiveness\?/);
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.ok(GLOO_TIMEOUT_MS >= 30_000 && GLOO_TIMEOUT_MS < 100_000, 'room for a reasoning model, under the 100 s proxy cap');
});

test('GLOO_MODEL picks the answer model', async () => {
  const gloo = fakeGloo();
  const { body } = await ask(envFor(church(), { ...KEY, GLOO_MODEL: 'gloo-other' }), gloo.fetcher);
  assert.equal(body.engine, 'gloo:gloo-other');
  assert.equal(gloo.chat()[0].body.model, 'gloo-other');
});

test('a Gemini key or the old workers-ai setting no longer picks a model: without Gloo the answer is extractive', async () => {
  const env = envFor(church(), { GEMINI_API_KEY: 'g', GEMINI_MODEL: 'gemini-2.5-flash', NOTES_ANSWER_ENGINE: 'workers-ai' });
  const { status, body } = await ask(env, () => assert.fail('no model may be called'));
  assert.equal(status, 200);
  assert.equal(body.engine, 'extractive');
  assert.equal(body.found, true);
});

test('a failed Gloo answer falls back to the verbatim answer', async () => {
  const { status, body } = await ask(envFor(church(), KEY), fakeGloo({ status: 500 }).fetcher);
  assert.equal(status, 200);
  assert.equal(body.engine, 'extractive');
  assert.equal(body.fallback_reason, 'model_error');
  assert.ok(body.citations.length);
});

test('a reasoning reply with thinking and prose around the JSON is still a Gloo answer', async () => {
  const content = `<think>They ask about {forgiveness}; C1 says so.</think>\nSure, here it is: ${JSON.stringify(ANSWER)}\nHope that helps {:)}`;
  const { body } = await ask(envFor(church(), KEY), fakeGloo({ content }).fetcher);
  assert.equal(body.engine, 'gloo:gloo-qwen-3.7-flash');
  assert.equal(body.answer, ANSWER.answer);
});

test('parseModelJson takes the JSON out of thinking, fences and prose, and gives null when there is none', () => {
  const obj = { found: false, answer: '', citations: [] };
  const raw = JSON.stringify(obj);
  for (const reply of [raw, '```json\n' + raw + '\n```', `<think>maybe {x}</think>${raw}`, `Here {you go}: ${raw}`])
    assert.deepEqual(parseModelJson(reply), obj, reply);
  for (const reply of ['', 'no json here', '<think>cut off {"found": true', '{not json}'])
    assert.equal(parseModelJson(reply), null, reply);
});

test('the /llm highlight fallback runs NOTES_LLM_MODEL on Workers AI and names it', async () => {
  const runs = [];
  const env = {
    NOTES_LLM_MODEL: '@cf/meta/llama-3.1-8b-instruct-fp8',
    AI: { run: async (model, input) => (runs.push({ model, input }), { response: '{"annotations": []}' }) },
  };
  const llm = (prompt) => aiBridge(new Request('http://workers-ai/llm', { method: 'POST', body: JSON.stringify({ prompt }) }), env);
  const response = await llm('Segments:\n[0] hi');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: '{"annotations": []}', model: 'workers-ai:@cf/meta/llama-3.1-8b-instruct-fp8' });
  assert.equal(runs[0].model, '@cf/meta/llama-3.1-8b-instruct-fp8');
  assert.equal((await llm('')).status, 400);
});

test('re-categorizing a note takes the API key or a staff session, on every church', () => {
  for (const demo of [true, false]) assert.equal(access('POST', `/api/notes/${NOTE}/recategorize`, demo), 'key-or-staff');
});
