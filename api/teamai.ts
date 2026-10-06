// Team AI bridge: a stopgap until the Gloo AI key arrives. A teammate runs scripts/team-ai-bridge/,
// which puts the club's HPC Ollama behind a key on a fixed Cloudflare Tunnel hostname (TEAM_AI_URL).
// The container calls http://team-ai/v1/...; this handler adds the key, so the container never sees it.

export type TeamAiEnv = { TEAM_AI_URL?: string; TEAM_AI_KEY?: string; TEAM_AI_MODEL?: string; AI_PROVIDER?: string };

export const TEAM_AI_HOST = 'team-ai';
export const TEAM_AI_DEFAULT_MODEL = 'qwen3.8:27b';
// Only what the chat, Find a place and calendar summaries use.
const PATHS: Record<string, string> = { '/v1/models': 'GET', '/api/tags': 'GET', '/v1/chat/completions': 'POST' };
const MAX_BODY_BYTES = 256 * 1024;
// Cloudflare closes a proxied request after about 100 seconds without a response.
const TIMEOUT_MS = 98_000;

/** The bridge origin (https only, no path), or null when the bridge is not set up. */
export function teamAiOrigin(env: TeamAiEnv): string | null {
	if (!env.TEAM_AI_URL || !env.TEAM_AI_KEY) return null;
	try {
		const url = new URL(env.TEAM_AI_URL.trim());
		return url.protocol === 'https:' ? url.origin : null;
	} catch {
		return null;
	}
}

/** Container environment for the AI providers. With the bridge set up, the chat tries AI_PROVIDER
 * (Gloo by default, skipped until GLOO_API_KEY is set) and then the bridge. */
export function teamAiEnvVars(env: TeamAiEnv): Record<string, string> {
	const on = teamAiOrigin(env) !== null;
	return {
		AI_PROVIDER: env.AI_PROVIDER || 'gloo',
		AI_FALLBACK: on ? 'ollama' : '',
		OLLAMA_BASE_URL: on ? `http://${TEAM_AI_HOST}/v1` : '',
		OLLAMA_MODEL: env.TEAM_AI_MODEL || TEAM_AI_DEFAULT_MODEL,
		TEAM_AI_BRIDGE: on ? '1' : '',
	};
}

const failure = (message: string, status: number) => Response.json({ error: { message } }, { status });

/** Outbound handler for http://team-ai from the container. */
export async function teamAiBridge(request: Request, env: TeamAiEnv, fetcher: typeof fetch = fetch): Promise<Response> {
	const origin = teamAiOrigin(env);
	if (!origin) return failure('The team AI bridge is not configured.', 503);
	const path = new URL(request.url).pathname;
	if (PATHS[path] !== request.method) return failure('Not found', 404);
	let body: ArrayBuffer | undefined;
	if (request.method === 'POST') {
		body = await request.arrayBuffer();
		if (body.byteLength > MAX_BODY_BYTES) return failure('Request too large', 413);
	}
	try {
		return await fetcher(origin + path, {
			method: request.method,
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TEAM_AI_KEY}` },
			body,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		console.warn('team AI bridge unreachable:', String(err).slice(0, 200));
		return failure('The team AI bridge is offline.', 502);
	}
}
