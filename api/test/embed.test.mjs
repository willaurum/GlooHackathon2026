// Gloo embeddings for Sermon Notes (api/embed.ts) and how /ask and the backfill use them. Run: node --test api/test/
// Each church database is an in-memory SQLite (node:sqlite) behind the same /sql batch contract as ChurchDB.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  DEFAULT_EMBED_MODEL, EMBED_BATCH, EmbedError, GLOO_EMBED_URL, LEGACY_EMBED_TAG,
  backfillChurch, comparable, embedTag, embedTexts, ensureEmbedColumn,
} from '../embed.ts';
import { aiBridge, handleNotes } from '../notes.ts';

const KEY = { GLOO_API_KEY: 'test-key' };
const GLOO_TAG = 'gloo:' + DEFAULT_EMBED_MODEL;
const NOTE = '11111111-2222-3333-4444-555555555555';
const NOTE2 = '66666666-2222-3333-4444-555555555555';

// --- A church database ---

function database() {
  const db = new DatabaseSync(':memory:');
  const run = async (...batch) => {
    db.exec('BEGIN');
    try {
      const results = batch.map(({ sql, params = [] }) => ({ rows: db.prepare(sql).all(...params) }));
      db.exec('COMMIT');
      return results;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return { db, run };
}

const SEGMENTS = [
  'Welcome everyone to the service this morning.',
  'Forgiveness is not a feeling, it is a choice you make every day.',
  'The early church shared meals and prayed together.',
  'Generosity flows from a grateful heart.',
];

/** A database as it was before embed_model existed: two chunks with Workers AI (cls) vectors. */
function legacyChurch() {
  const church = database();
  church.db.exec(`
    CREATE TABLE config (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, source_kind TEXT, source_url TEXT, status TEXT);
    CREATE TABLE segments (note_id TEXT, idx INTEGER, start REAL, "end" REAL, text TEXT, PRIMARY KEY (note_id, idx));
    CREATE TABLE chunks (note_id TEXT, idx INTEGER, start REAL, "end" REAL, seg_from INTEGER, seg_to INTEGER,
      text TEXT NOT NULL, embedding TEXT NOT NULL, PRIMARY KEY (note_id, idx));`);
  church.db.prepare("INSERT INTO config VALUES ('church', ?)").run(JSON.stringify({ name: 'Grace Community' }));
  church.db.prepare("INSERT INTO notes VALUES (?, 'Sunday', 'upload', NULL, 'ready')").run(NOTE);
  SEGMENTS.forEach((text, i) => church.db.prepare('INSERT INTO segments VALUES (?, ?, ?, ?, ?)').run(NOTE, i, i * 10, i * 10 + 9, text));
  const chunk = church.db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  chunk.run(NOTE, 0, 0, 19, 0, 1, SEGMENTS[0] + ' ' + SEGMENTS[1], '[0.9,0.1,0.2]');
  chunk.run(NOTE, 1, 20, 39, 2, 3, SEGMENTS[2] + ' ' + SEGMENTS[3], '[0.1,0.9,0.2]');
  return church;
}

const chunkRows = (church) => church.db.prepare('SELECT note_id, idx, embedding, embed_model FROM chunks ORDER BY note_id, idx').all();

// --- A fake Gloo: embeddings from topic words, and a chat that quotes the transcript ---

const TOPICS = ['forgiv', 'church', 'generos', 'welcome', 'meal', 'pray', 'grate', 'choice'];
const fakeVector = (text) => TOPICS.map((t) => (text.toLowerCase().includes(t) ? 1 : 0) + 0.1);

function fakeGloo({ embedStatus = 200, chat = true } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    if (String(url) === GLOO_EMBED_URL) {
      if (embedStatus !== 200) return new Response('{"detail":"down"}', { status: embedStatus });
      // Out of order on purpose: the client must sort by index.
      const data = body.input.map((text, index) => ({ object: 'embedding', index, embedding: fakeVector(text) })).reverse();
      return Response.json({ object: 'list', data, model: body.model });
    }
    if (String(url).endsWith('/chat/completions')) {
      if (!chat) return new Response('nope', { status: 500 });
      const content = JSON.stringify({ found: true, answer: 'Forgiveness is a choice you make every day.',
        citations: [{ id: 'C1', quote: 'Forgiveness is not a feeling, it is a choice you make every day' }] });
      return Response.json({ choices: [{ message: { content } }] });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { calls, fetcher, embedCalls: () => calls.filter((c) => c.url === GLOO_EMBED_URL) };
}

function withGlobalFetch(fetcher, fn) {
  return async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      await fn();
    } finally {
      globalThis.fetch = original;
    }
  };
}

// An env whose CHURCH_DB is the given database. Whisper (env.AI) must never run for any of this.
const envFor = (church, extra = {}) => ({
  NOTES_MIN_SCORE: '0.45',
  AI: { run: () => assert.fail('Workers AI must not be called') },
  CHURCH_DB: {
    idFromName: (name) => name,
    get: () => ({
      async fetch(_url, init) {
        const { batch } = JSON.parse(init.body);
        try {
          return Response.json({ results: await church.run(...batch) });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    }),
  },
  ...extra,
});

const CHURCH = { slug: 'grace-community', name: 'Grace Community', city: '', demo: true };
const container = { fetch: () => assert.fail('the container is not needed') };

async function ask(env, question, path = `/api/notes/${NOTE}/ask`) {
  const url = new URL('http://api' + path);
  const response = await handleNotes(new Request(url, { method: 'POST', body: JSON.stringify({ question }) }), env, url, container, CHURCH);
  return { status: response.status, body: await response.json() };
}

async function reembedCall(env, query = '') {
  const url = new URL('http://api/api/notes/reembed' + query);
  const response = await handleNotes(new Request(url, { method: 'POST' }), env, url, container, CHURCH);
  return { status: response.status, body: await response.json() };
}

// --- The embedding call ---

test('embedTexts sends the documented OpenAI-shaped request to Gloo, in batches, in order', async () => {
  const gloo = fakeGloo();
  const texts = Array.from({ length: EMBED_BATCH * 2 + 2 }, (_, i) => `passage ${i} about ${TOPICS[i % TOPICS.length]}`);
  const { tag, vectors } = await embedTexts(KEY, texts, { fetcher: gloo.fetcher });
  assert.equal(tag, GLOO_TAG);
  assert.equal(vectors.length, texts.length);
  assert.deepEqual(vectors[3], fakeVector(texts[3]));
  const calls = gloo.embedCalls();
  assert.deepEqual(calls.map((c) => c.body.input.length), [EMBED_BATCH, EMBED_BATCH, 2]);
  const [first] = calls;
  assert.equal(first.url, 'https://platform.ai.gloo.com/ai/v2/direct/embeddings');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.headers.Authorization, 'Bearer test-key');
  assert.equal(first.init.headers['Content-Type'], 'application/json');
  assert.ok(first.init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(first.body).sort(), ['encoding_format', 'input', 'model']);
  assert.equal(first.body.model, 'gloo-baai-bge-base-en-v1.5');
  assert.equal(first.body.encoding_format, 'float');
});

test('GLOO_EMBED_MODEL picks the model and the tag', async () => {
  const gloo = fakeGloo();
  const env = { ...KEY, GLOO_EMBED_MODEL: ' gloo-baai-bge-large-en-v1.5 ' };
  const { tag } = await embedTexts(env, ['x'], { fetcher: gloo.fetcher });
  assert.equal(tag, 'gloo:gloo-baai-bge-large-en-v1.5');
  assert.equal(embedTag(env), tag);
  assert.equal(gloo.embedCalls()[0].body.model, 'gloo-baai-bge-large-en-v1.5');
  assert.equal(embedTag({ GLOO_EMBED_MODEL: '' }), GLOO_TAG);
});

test('no key, errors, bad replies and timeouts throw an EmbedError; only retryable ones are retried', async () => {
  await assert.rejects(embedTexts({}, ['x'], { fetcher: () => assert.fail('no call without a key') }), (e) => e instanceof EmbedError && e.code === 'no_key');

  let n = 0;
  const flaky = async (url, init) => (++n === 1 ? new Response('busy', { status: 503 }) : fakeGloo().fetcher(url, init));
  assert.equal((await embedTexts(KEY, ['x'], { fetcher: flaky, retryDelayMs: 0 })).vectors.length, 1);
  assert.equal(n, 2);

  n = 0;
  const bad = async () => { n++; return new Response('bad input', { status: 400 }); };
  await assert.rejects(embedTexts(KEY, ['x'], { fetcher: bad, retryDelayMs: 0 }), (e) => e.code === 'http');
  assert.equal(n, 1, 'a 400 is not retried');

  const short = async () => Response.json({ data: [] });
  await assert.rejects(embedTexts(KEY, ['x'], { fetcher: short }), (e) => e.code === 'bad_response');

  // AbortSignal.timeout's timer does not hold the event loop open in Node; the keepalive does.
  const hang = (_url, init) => new Promise((_, reject) => {
    const keepalive = setTimeout(() => {}, 5000);
    init.signal.addEventListener('abort', () => { clearTimeout(keepalive); reject(init.signal.reason); });
  });
  await assert.rejects(embedTexts(KEY, ['x'], { fetcher: hang, timeoutMs: 10, retryDelayMs: 0 }), (e) => e.code === 'timeout');
});

// --- Tags and the migration ---

test('the migration tags existing chunks as the old Workers AI model, once', async () => {
  const church = legacyChurch();
  assert.equal(await ensureEmbedColumn(church.run), true);
  assert.deepEqual(chunkRows(church).map((r) => r.embed_model), [LEGACY_EMBED_TAG, LEGACY_EMBED_TAG]);
  assert.equal(await ensureEmbedColumn(church.run), true, 'running it again is harmless');
  assert.equal(await ensureEmbedColumn(database().run), false, 'no chunks table yet');
});

test('a question is only compared with chunks from the current model', () => {
  const chunks = [
    { idx: 0, embedding: '[1]', embed_model: GLOO_TAG },
    { idx: 1, embedding: '[1]', embed_model: LEGACY_EMBED_TAG },
    { idx: 2, embedding: '', embed_model: '' },
    { idx: 3, embedding: '[1]', embed_model: 'gloo:another-model' },
  ];
  assert.deepEqual(comparable(chunks, GLOO_TAG).map((c) => c.idx), [0]);
});

// --- Backfill ---

function manyChunks(count) {
  const church = legacyChurch();
  church.db.exec('DELETE FROM chunks');
  const insert = church.db.prepare("INSERT INTO chunks VALUES (?, ?, 0, 1, 0, 0, ?, '[0.5,0.5,0.5]')");
  for (let i = 0; i < count; i++) insert.run(i % 2 ? NOTE2 : NOTE, i, `passage ${i} about prayer`);
  return church;
}

test('the backfill re-embeds a church in batches and resumes where it stopped', async () => {
  const church = manyChunks(5);
  const gloo = fakeGloo();
  const first = await backfillChurch(church.run, KEY, 3, { fetcher: gloo.fetcher });
  assert.deepEqual(first, { model: GLOO_TAG, embedded: 3, remaining: 2, done: false });
  const second = await backfillChurch(church.run, KEY, 3, { fetcher: gloo.fetcher });
  assert.deepEqual(second, { model: GLOO_TAG, embedded: 2, remaining: 0, done: true });
  assert.ok(chunkRows(church).every((r) => r.embed_model === GLOO_TAG && JSON.parse(r.embedding).length === TOPICS.length));
  const again = await backfillChurch(church.run, KEY, 3, { fetcher: gloo.fetcher });
  assert.deepEqual(again, { model: GLOO_TAG, embedded: 0, remaining: 0, done: true });
  assert.equal(gloo.embedCalls().length, 2, 'nothing left to embed on the third call');
});

test('a backfill that fails part way keeps the batches it finished', async () => {
  const church = manyChunks(EMBED_BATCH + 6);
  let n = 0;
  const failSecond = async (url, init) => (++n >= 2 ? new Response('no credit', { status: 402 }) : fakeGloo().fetcher(url, init));
  const result = await backfillChurch(church.run, KEY, 500, { fetcher: failSecond });
  assert.deepEqual(result, { model: GLOO_TAG, embedded: EMBED_BATCH, remaining: 6, done: false, error: 'http' });
  const resumed = await backfillChurch(church.run, KEY, 500, { fetcher: fakeGloo().fetcher });
  assert.deepEqual(resumed, { model: GLOO_TAG, embedded: 6, remaining: 0, done: true });
});

test('the backfill route takes a limit and needs the Gloo key', withGlobalFetch(fakeGloo().fetcher, async () => {
  const church = manyChunks(4);
  const one = await reembedCall(envFor(church, KEY), '?limit=3');
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, { church: 'grace-community', model: GLOO_TAG, embedded: 3, remaining: 1, done: false });
  assert.equal((await reembedCall(envFor(church, KEY))).body.done, true);
  const off = await reembedCall(envFor(church));
  assert.equal(off.status, 503);
}));

// --- Asking a question ---

test('an old-model note is re-embedded from its chunk text on the first question, then answered with real quotes',
  withGlobalFetch(fakeGloo().fetcher, async () => {
    const church = legacyChurch();
    const env = envFor(church, KEY);
    const { status, body } = await ask(env, 'What is forgiveness?');
    assert.equal(status, 200);
    assert.equal(body.retrieval, 'vector');
    assert.equal(body.engine, 'gloo:gloo-qwen-3.7-flash');
    assert.equal(body.found, true);
    assert.equal(body.citations[0].quote, 'Forgiveness is not a feeling, it is a choice you make every day');
    assert.equal(body.citations[0].timestamp, '00:10');
    assert.ok(SEGMENTS[1].includes(body.citations[0].quote));
    assert.ok(chunkRows(church).every((r) => r.embed_model === GLOO_TAG), 'chunks are now tagged with the Gloo model');
    // The segments (the transcript) are untouched: nothing was transcribed again.
    assert.equal(church.db.prepare('SELECT COUNT(*) AS n FROM segments').get().n, SEGMENTS.length);
  }));

test('a note already on the current model only embeds the question', async () => {
  const church = legacyChurch();
  const gloo = fakeGloo();
  await withGlobalFetch(gloo.fetcher, async () => {
    await ask(envFor(church, KEY), 'What is forgiveness?');
    const before = gloo.embedCalls().length;
    const { body } = await ask(envFor(church, KEY), 'What is forgiveness?');
    assert.equal(body.retrieval, 'vector');
    assert.equal(gloo.embedCalls().length - before, 1);
    assert.deepEqual(gloo.embedCalls().at(-1).body.input, ['What is forgiveness?']);
  })();
});

test('without a Gloo key a question still gets a keyword answer, and the stored vectors are left alone', async () => {
  const church = legacyChurch();
  const { status, body } = await ask(envFor(church), 'What is forgiveness?');
  assert.equal(status, 200);
  assert.equal(body.retrieval, 'keyword');
  assert.equal(body.retrieval_reason, 'embeddings_no_key');
  assert.equal(body.engine, 'extractive');
  assert.equal(body.found, true);
  assert.ok(body.citations.every((c) => SEGMENTS.includes(c.quote)));
  assert.ok(chunkRows(church).every((r) => r.embed_model === LEGACY_EMBED_TAG));
  const none = await ask(envFor(church), 'What about the parking lot?');
  assert.equal(none.status, 200);
  assert.equal(none.body.found, false);
});

test('when Gloo embeddings are down a question falls back to keywords instead of failing',
  withGlobalFetch(fakeGloo({ embedStatus: 503, chat: false }).fetcher, async () => {
    const church = legacyChurch();
    const { status, body } = await ask(envFor(church, KEY), 'What is forgiveness?');
    assert.equal(status, 200);
    assert.equal(body.retrieval, 'keyword');
    assert.equal(body.retrieval_reason, 'embeddings_http');
    assert.equal(body.engine, 'extractive');
    assert.equal(body.found, true);
    assert.ok(chunkRows(church).every((r) => r.embed_model === LEGACY_EMBED_TAG), 'never mixed with another model');
  }));

test('chunks saved unembedded at ingest are embedded on the first question', withGlobalFetch(fakeGloo().fetcher, async () => {
  const church = legacyChurch();
  await ensureEmbedColumn(church.run);
  church.db.exec("UPDATE chunks SET embedding = '', embed_model = ''");
  const { body } = await ask(envFor(church, KEY), 'What is forgiveness?');
  assert.equal(body.retrieval, 'vector');
  assert.ok(chunkRows(church).every((r) => r.embed_model === GLOO_TAG && r.embedding));
}));

// --- The container's /embed bridge ---

test('the /embed bridge answers with Gloo vectors and their model tag, and 503 without a key',
  withGlobalFetch(fakeGloo().fetcher, async () => {
    const request = () => new Request('http://workers-ai/embed', { method: 'POST', body: JSON.stringify({ texts: ['about prayer'] }) });
    const ok = await aiBridge(request(), envFor(legacyChurch(), KEY));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { vectors: [fakeVector('about prayer')], model: GLOO_TAG });
    const off = await aiBridge(request(), envFor(legacyChurch()));
    assert.equal(off.status, 503);
  }));
