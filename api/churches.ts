// Which church a request is for, and who may do what there.
//
// Every church has its own database (a ChurchDB Durable Object named after its slug). A request
// names its church with a path prefix: /api/churches/<slug>/ministries is /api/ministries for that
// church. A path without the prefix is the demo church, Grace Community, so older builds of the
// site keep working unchanged.
//
// Churches, their names and their staff passwords live in the giving Worker (api-giving/), which
// is the one registry and the one staff login for the whole site. This Worker asks it, over the
// GIVING service binding, whether a church exists and whether a staff session is valid.

import type { AppEnv } from './notes';

export const DEMO_SLUG = 'grace-community';
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DEMO: Church = { slug: DEMO_SLUG, name: 'Grace Community', city: 'Springfield', demo: true };
const FOUND_TTL = 60_000;
const MISSING_TTL = 15_000;
const STAFF_TTL = 60_000;

export type Church = { slug: string; name: string; city: string; demo: boolean };

export const validSlug = (slug: string) => SLUG_RE.test(slug);

/** The church slug and the plain /api/... path, or null when the slug is malformed. */
export function churchPath(pathname: string): { slug: string; path: string } | null {
	const m = /^\/api\/churches\/([^/]+)(\/.*)?$/.exec(pathname);
	if (!m) return { slug: DEMO_SLUG, path: pathname };
	if (!validSlug(m[1])) return null;
	return { slug: m[1], path: '/api' + (m[2] && m[2] !== '/' ? m[2] : '/church') };
}

// Small per-isolate caches so a page load does not ask the registry on every call.
const directory = new Map<string, { until: number; church: Church | null }>();
const sessions = new Map<string, number>();

/** The church, null when no church has that slug, or 'unavailable' when the registry cannot be asked. */
export async function findChurch(env: AppEnv, slug: string): Promise<Church | null | 'unavailable'> {
	if (slug === DEMO_SLUG) return DEMO;
	const hit = directory.get(slug);
	if (hit && hit.until > Date.now()) return hit.church;
	if (!env.GIVING) return 'unavailable';
	let response: Response;
	try {
		response = await env.GIVING.fetch('https://giving.internal/api/directory/' + slug);
	} catch {
		return 'unavailable';
	}
	// An older giving service has no /api/directory route, so a 404 there is not proof the church is
	// missing. Its public church page carries the same name and city, so ask that before giving up.
	if (response.status === 404) {
		try {
			response = await env.GIVING.fetch('https://giving.internal/api/churches/' + slug);
		} catch {
			return 'unavailable';
		}
	}
	if (response.status === 404) {
		directory.set(slug, { until: Date.now() + MISSING_TTL, church: null });
		return null;
	}
	if (!response.ok) return 'unavailable';
	const row = await response.json<{ name?: string; city?: string }>();
	const church = { slug, name: String(row.name || slug), city: String(row.city || ''), demo: false };
	if (directory.size > 1000) directory.clear();
	directory.set(slug, { until: Date.now() + FOUND_TTL, church });
	return church;
}

/** Forget a cached listing, after staff rename their church. */
export const forgetChurch = (slug: string) => directory.delete(slug);

async function sha256(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when the request carries a valid staff session for this church (Authorization: Bearer <token>). */
export async function isStaff(request: Request, env: AppEnv, slug: string): Promise<boolean> {
	const auth = request.headers.get('Authorization') ?? '';
	if (!/^Bearer [A-Za-z0-9_-]{20,100}$/.test(auth) || !env.GIVING) return false;
	const key = slug + ':' + (await sha256(auth));
	if ((sessions.get(key) ?? 0) > Date.now()) return true;
	try {
		let response = await env.GIVING.fetch(`https://giving.internal/api/churches/${slug}/admin/session`, { headers: { Authorization: auth } });
		// An older giving service has no session route; its staff overview needs the same login.
		if (response.status === 404) response = await env.GIVING.fetch(`https://giving.internal/api/churches/${slug}/admin`, { headers: { Authorization: auth } });
		if (!response.ok) return false;
		const body = await response.json<{ slug?: string; church?: { slug?: string } }>();
		if ((body.slug ?? body.church?.slug) !== slug) return false;
	} catch {
		return false;
	}
	if (sessions.size > 500) sessions.clear();
	sessions.set(key, Date.now() + STAFF_TTL);
	return true;
}

type Route = [string, RegExp];
const matches = (routes: Route[], method: string, path: string) => routes.some(([m, re]) => m === method && re.test(path));

// Open to everyone, like the church website they sit on.
const PUBLIC_ROUTES: Route[] = [
	['GET', /^\/api\/(health|church|info|ministries|events|chat\/status|ai\/status|ollama\/status|regions|news)$/],
	['GET', /^\/api\/visits\/[A-Za-z0-9_-]+$/],
	['GET', /^\/api\/verse$/],
	['GET', /^\/api\/events\/\d+$/],
	['GET', /^\/api\/regions\/\d+\/prayer-angles$/],
	['POST', /^\/api\/(matches|connections|chat|visits)$/],
	['POST', /^\/api\/visits\/[A-Za-z0-9_-]+\/arrive$/],
	['POST', /^\/api\/regions\/\d+\/prayer-angles$/],
];

// Staff work: the welcome team queue, chat requests, saved connections and adding to the calendar.
// The demo church leaves these open, because it is a shared demo workspace with no login. Every
// other church needs its own staff session, since these show guests' names and contact details.
const DEMO_OPEN_ROUTES: Route[] = [
	['GET', /^\/api\/(connections|requests|visits)$/],
	['POST', /^\/api\/visits\/\d+\/(claim|met)$/],
	['POST', /^\/api\/events$/],
	['POST', /^\/api\/events\/\d+\/summarize$/],
	['POST', /^\/api\/events\/summarize-all$/],
	['DELETE', /^\/api\/(connections|requests)\/\d+$/],
	['PATCH', /^\/api\/requests\/\d+$/],
];

// Settings shared by every church (the AI model). Open on the demo church as before; otherwise the API key.
const OPERATOR_ROUTES: Route[] = [['POST', /^\/api\/(ai|ollama)\/model$/]];

// Church setup and content import: that church's staff, on every church. (The demo church's staff
// password is ADMIN_KEY in api-giving.)
const STAFF_ROUTES: Route[] = [['GET', /^\/api\/church\/content$/], ['PUT', /^\/api\/church\/content$/]];

export type Access = 'public' | 'staff' | 'key' | 'key-or-staff';

/** Who may call a route. Anything not listed (Sermon Notes, the chat log) takes the API key or a staff session. */
export function access(method: string, path: string, demo: boolean): Access {
	if (matches(STAFF_ROUTES, method, path)) return 'staff';
	if (matches(PUBLIC_ROUTES, method, path)) return 'public';
	if (matches(DEMO_OPEN_ROUTES, method, path)) return demo ? 'public' : 'staff';
	if (matches(OPERATOR_ROUTES, method, path)) return demo ? 'public' : 'key';
	return 'key-or-staff';
}

/** Headers the container uses to pick the church database. Anything a browser sent under these names is replaced. */
export function churchHeaders(headers: Headers, church: Church): Headers {
	const out = new Headers(headers);
	for (const name of [...out.keys()]) if (name.startsWith('x-church')) out.delete(name);
	out.delete('Authorization');
	out.set('X-Church', church.slug);
	out.set('X-Church-Name', encodeURIComponent(church.name));
	out.set('X-Church-City', encodeURIComponent(church.city));
	return out;
}

/** True for https://<base> and https://<one-label>.<base> when BASE_DOMAIN (e.g. belong.example.org) is set. */
export function onBaseDomain(origin: string, base: string | undefined): boolean {
	const domain = String(base || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
	if (!domain || !origin.startsWith('https://')) return false;
	const host = origin.slice('https://'.length).toLowerCase();
	return host === domain || (host.endsWith('.' + domain) && validSlug(host.slice(0, -domain.length - 1)));
}
