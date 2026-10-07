// Builder fetch bridge. The agentic builder (backend/app/builder.py) reads a church's existing website, but the
// container can only reach the hosts in allowedHosts and church sites can be anywhere. So the container asks
// http://builder-fetch/fetch (BUILDER_FETCH_URL) and this handler fetches the page from the Worker.
//
// The URL comes from an anonymous visitor, so every address and every redirect is checked here before it is fetched:
// http(s) only, the default ports, no credentials, no local or private names, and no private, loopback, link-local,
// metadata or reserved IP, whether written in the URL or returned by DNS (looked up over DNS-over-HTTPS).
// Bodies are capped (1 MB per page, 4 MB per image) and each fetch is bounded in time.

export const BUILDER_FETCH_HOST = 'builder-fetch';

/** Container environment: the builder fetches through this bridge instead of directly. */
export function builderFetchEnvVars(): Record<string, string> {
	return { BUILDER_FETCH_URL: `http://${BUILDER_FETCH_HOST}` };
}

type Kind = 'page' | 'image';
const LIMITS: Record<Kind, number> = { page: 1_000_000, image: 4_000_000 };
const MAX_REQUEST_BYTES = 4096;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 3_000;
const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const USER_AGENT = 'TektonBuilder/0.1 (+church site builder)';
// Names that only mean something inside a network.
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'arpa', 'test', 'invalid', 'example'];

const NOT_FOUND = 'That website address could not be found.';
const PRIVATE = 'That address is on a private network and cannot be imported.';
const BAD_URL = 'Enter a website address starting with http:// or https://';

const refuse = (detail: string, status = 400) => Response.json({ detail }, { status });

function ipv4(text: string): number[] | null {
	const parts = text.split('.');
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
	const nums = parts.map(Number);
	return nums.every((n) => n <= 255) ? nums : null;
}

function privateV4([a, b, c]: number[]): boolean {
	return a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved
		|| (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
		|| (a === 169 && b === 254) // link-local, including 169.254.169.254 metadata
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF assignments, TEST-NET-1
		|| (a === 192 && b === 88 && c === 99) // 6to4 relay
		|| (a === 198 && (b === 18 || b === 19)) // benchmarking
		|| (a === 198 && b === 51 && c === 100) // TEST-NET-2
		|| (a === 203 && b === 0 && c === 113); // TEST-NET-3
}

/** The eight 16-bit groups of an IPv6 address, or null. Accepts :: and a dotted IPv4 tail. */
function ipv6(text: string): number[] | null {
	let address = text.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0];
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
	if (tail) {
		const v4 = ipv4(tail[1]);
		if (!v4) return null;
		address = address.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
	}
	const halves = address.split('::');
	if (halves.length > 2) return null;
	const parse = (s: string) => (s ? s.split(':') : []);
	const head = parse(halves[0]), rest = halves.length === 2 ? parse(halves[1]) : [];
	if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	return [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
}

/** True for any address a church website should never be on. IPv6 must be global unicast (2000::/3). */
export function privateIp(text: string): boolean {
	const v4 = ipv4(text);
	if (v4) return privateV4(v4);
	const v6 = ipv6(text);
	if (!v6) return true; // not an address we understand: refuse
	const [g0, g1] = v6;
	if (g0 < 0x2000 || g0 > 0x3fff) return true; // ::, ::1, mapped and NAT64 IPv4, ULA fc00::/7, link-local, multicast
	if (g0 === 0x2001 && (g1 === 0x0db8 || g1 < 0x0200)) return true; // documentation, Teredo and IETF protocol space
	if (g0 === 0x2002) return true; // 6to4 carries an IPv4 address of any kind
	return false;
}

/** The URL when its shape is acceptable, or the message for the church. Says nothing about DNS yet. */
export function checkUrl(raw: unknown): URL | string {
	if (typeof raw !== 'string' || raw.length > 2000) return BAD_URL;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return BAD_URL;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return BAD_URL;
	if (url.username || url.password) return BAD_URL;
	if (url.port && url.port !== '80' && url.port !== '443') return PRIVATE;
	const host = url.hostname.replace(/\.$/, '').toLowerCase();
	if (!host) return BAD_URL;
	if (host.startsWith('[') || ipv4(host)) return privateIp(host) ? PRIVATE : url;
	const labels = host.split('.');
	// A name with no dot (intranet), or under a suffix that only exists on a local network.
	if (labels.length < 2 || LOCAL_SUFFIXES.includes(labels[labels.length - 1])) return PRIVATE;
	return url;
}

type DohAnswer = { type: number; data: string };

/** Null when every A and AAAA record of the name is public; otherwise the message for the church. */
export async function checkDns(hostname: string, fetcher: typeof fetch = fetch): Promise<string | null> {
	const host = hostname.replace(/^\[|\]$/g, '');
	if (ipv4(host) || host.includes(':')) return privateIp(host) ? PRIVATE : null;
	const addresses: string[] = [];
	for (const type of ['A', 'AAAA']) {
		let answers: DohAnswer[] = [];
		try {
			const response = await fetcher(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, {
				headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
			});
			if (!response.ok) return NOT_FOUND;
			answers = ((await response.json()) as { Answer?: DohAnswer[] }).Answer ?? [];
		} catch {
			return NOT_FOUND; // fail closed
		}
		addresses.push(...answers.filter((a) => a.type === 1 || a.type === 28).map((a) => a.data));
	}
	if (!addresses.length) return NOT_FOUND;
	return addresses.some(privateIp) ? PRIVATE : null;
}

/** Read at most `limit` bytes. Pages over the limit are cut (the backend cuts them too); images are refused. */
async function readCapped(response: Response, limit: number, cut: boolean): Promise<Uint8Array | null> {
	const declared = Number(response.headers.get('content-length') ?? 0);
	if (declared > limit && !cut) return null;
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (size + value.byteLength > limit) {
			await reader.cancel();
			if (!cut) return null;
			chunks.push(value.subarray(0, limit - size));
			size = limit;
			break;
		}
		chunks.push(value);
		size += value.byteLength;
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

/** Outbound handler for http://builder-fetch from the container. Only POST /fetch {url, kind} is served. */
export async function builderFetchBridge(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
	if (request.method !== 'POST' || new URL(request.url).pathname !== '/fetch') return refuse('Not found', 404);
	const raw = await request.arrayBuffer();
	if (raw.byteLength > MAX_REQUEST_BYTES) return refuse('Request too large', 413);
	let body: { url?: unknown; kind?: unknown };
	try {
		body = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return refuse(BAD_URL);
	}
	const kind: Kind = body.kind === 'image' ? 'image' : 'page';
	let current = checkUrl(body.url);
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (typeof current === 'string') return refuse(current, current === PRIVATE ? 403 : 400);
		const dns = await checkDns(current.hostname, fetcher);
		if (dns) return refuse(dns, dns === PRIVATE ? 403 : 400);
		let response: Response;
		try {
			response = await fetcher(current.href, {
				redirect: 'manual',
				headers: { 'User-Agent': USER_AGENT, Accept: kind === 'image' ? 'image/*' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch {
			return refuse('That page did not answer in time.', 504);
		}
		if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
			await response.body?.cancel();
			let next: string;
			try {
				next = new URL(response.headers.get('location')!, current).href;
			} catch {
				return refuse('That page redirected to an invalid address.', 502);
			}
			current = checkUrl(next); // a redirect must not lead into a private network either
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			return refuse(`That page answered ${response.status}.`, 502);
		}
		const contentType = response.headers.get('content-type') ?? '';
		if (kind === 'image' ? !contentType.startsWith('image/') : !/html|text\//i.test(contentType)) {
			await response.body?.cancel();
			return refuse('Not a web page or image.', 415);
		}
		const data = await readCapped(response, LIMITS[kind], kind === 'page');
		if (!data) return refuse('That image is too large.', 413);
		return new Response(data, { headers: { 'Content-Type': contentType, 'X-Final-Url': current.href } });
	}
	return refuse('That page redirected too many times.', 502);
}
