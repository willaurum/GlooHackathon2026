// The team AI bridge handler (api/teamai.ts). Run: node --test api/test/
import assert from 'node:assert/strict';
import test from 'node:test';
import { teamAiBridge, teamAiEnvVars, teamAiOrigin } from '../teamai.ts';

const ON = { TEAM_AI_URL: 'https://team-ai.example.dev/v1', TEAM_AI_KEY: 'k'.repeat(40) };

test('the bridge is on only with an https URL and a key', () => {
  assert.equal(teamAiOrigin(ON), 'https://team-ai.example.dev');
  assert.equal(teamAiOrigin({ TEAM_AI_URL: ON.TEAM_AI_URL }), null);
  assert.equal(teamAiOrigin({ ...ON, TEAM_AI_URL: 'http://team-ai.example.dev' }), null);
  assert.equal(teamAiOrigin({ ...ON, TEAM_AI_URL: 'not a url' }), null);
});

test('container env: Gloo first, the bridge as fallback, nothing when off', () => {
  assert.deepEqual(teamAiEnvVars(ON), {
    AI_PROVIDER: 'gloo', AI_FALLBACK: 'ollama', OLLAMA_BASE_URL: 'http://team-ai/v1', OLLAMA_MODEL: 'qwen3.8:27b', TEAM_AI_BRIDGE: '1',
  });
  const off = teamAiEnvVars({});
  assert.equal(off.AI_FALLBACK, '');
  assert.equal(off.TEAM_AI_BRIDGE, '');
  assert.equal(teamAiEnvVars({ ...ON, TEAM_AI_MODEL: 'other:7b' }).OLLAMA_MODEL, 'other:7b');
});

test('forwards allowed paths with the key and nothing else', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true }); };
  const ok = await teamAiBridge(new Request('http://team-ai/v1/chat/completions', { method: 'POST', body: '{"model":"m"}' }), ON, fetcher);
  assert.equal(ok.status, 200);
  assert.equal(calls[0].url, 'https://team-ai.example.dev/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + ON.TEAM_AI_KEY);
  for (const [method, path] of [['GET', '/v1/chat/completions'], ['POST', '/api/generate'], ['DELETE', '/api/delete'], ['GET', '/admin']]) {
    const res = await teamAiBridge(new Request('http://team-ai' + path, { method }), ON, fetcher);
    assert.equal(res.status, 404, path);
  }
  assert.equal(calls.length, 1);
  const big = await teamAiBridge(new Request('http://team-ai/v1/chat/completions', { method: 'POST', body: 'x'.repeat(300 * 1024) }), ON, fetcher);
  assert.equal(big.status, 413);
});

test('off or unreachable gives an error response, never a throw', async () => {
  const off = await teamAiBridge(new Request('http://team-ai/v1/models'), {}, async () => assert.fail('no fetch when off'));
  assert.equal(off.status, 503);
  const down = await teamAiBridge(new Request('http://team-ai/v1/models'), ON, async () => { throw new Error('connect failed'); });
  assert.equal(down.status, 502);
});
