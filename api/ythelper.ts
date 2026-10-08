// YouTube helper bridge. YouTube refuses downloads from Cloudflare's IPs, so YouTube links are fetched by
// scripts/youtube-helper, which runs on Jaron's dev server (a home connection) behind a key at YT_HELPER_URL.
// The container calls http://youtube-helper/fetch; this handler adds the key, so the container never sees it.
// When the helper is down or not set up, the container downloads directly and, failing that, asks for a file upload.

export type YtHelperEnv = { YT_HELPER_URL?: string; YT_HELPER_KEY?: string };

export const YT_HELPER_HOST = 'youtube-helper';
const MAX_BODY_BYTES = 4096;
// The helper downloads the whole file before it answers (a 90-minute sermon takes about half a minute),
// then the audio (up to about 95 MB) streams back. Generous, but bounded.
const TIMEOUT_MS = 15 * 60_000;

/** The helper origin (https only, no path; a port such as :8443 is kept), or null when it is not set up. */
export function ytHelperOrigin(env: YtHelperEnv): string | null {
	if (!env.YT_HELPER_URL?.trim() || !env.YT_HELPER_KEY?.trim()) return null;
	try {
		const url = new URL(env.YT_HELPER_URL.trim());
		return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
	} catch {
		return null;
	}
}

/** Container environment: the backend tries the helper only when YT_HELPER_URL is set. */
export function ytHelperEnvVars(env: YtHelperEnv): Record<string, string> {
	return { YT_HELPER_URL: ytHelperOrigin(env) ? `http://${YT_HELPER_HOST}` : '' };
}

const failure = (error: string, status: number) => Response.json({ error, detail: error.replace(/_/g, ' ') }, { status });

/** Outbound handler for http://youtube-helper from the container. Only POST /fetch is forwarded. */
export async function ytHelperBridge(request: Request, env: YtHelperEnv, fetcher: typeof fetch = fetch): Promise<Response> {
	const origin = ytHelperOrigin(env);
	if (!origin) return failure('helper_not_configured', 503);
	if (request.method !== 'POST' || new URL(request.url).pathname !== '/fetch') return failure('not_found', 404);
	const body = await request.arrayBuffer();
	if (body.byteLength > MAX_BODY_BYTES) return failure('too_large_request', 413);
	try {
		return await fetcher(origin + '/fetch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.YT_HELPER_KEY!.trim()}` },
			body,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		console.warn('YouTube helper unreachable:', String(err).slice(0, 200));
		return failure('helper_offline', 502);
	}
}
