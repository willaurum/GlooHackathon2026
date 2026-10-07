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

export type Church = { slug: string; name: string; city: string; demo: boolean };

export const validSlug = (slug: string) => SLUG_RE.test(slug);

/** The church slug and the plain /api/... path, or null when the slug or path is malformed. */
export function churchPath(pathname: string): { slug: string; path: string } | null {
	// Access is decided on the path as written here, so it must be the path the container will run. The container
	// decodes percent-escapes (/api/ai/%6dodel runs as /api/ai/model, /api/int%65rnal/... as internal) and redirects
	// a trailing slash (/api/visits/ to /api/visits). No API path needs an escape, a trailing slash or an empty segment.
	if (pathname.includes('%')) return null;
	const m = /^\/api\/churches\/([^/]+)(\/.*)?$/.exec(pathname);
	const target = !m ? { slug: DEMO_SLUG, path: pathname }
		: validSlug(m[1]) ? { slug: m[1], path: '/api' + (m[2] && m[2] !== '/' ? m[2] : '/church') } : null;
	return target && !/\/\/|\/$/.test(target.path) ? target : null;
}

// Small per-isolate caches so a page load does not ask the registry on every call.
const directory = new Map<string, { until: number; church: Church | null }>();

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

/** Validate a church session without treating service outages as invalid credentials. */
export async function isStaff(request: Request, env: AppEnv, slug: string): Promise<boolean | 'unavailable'> {
	const auth = request.headers.get('Authorization') ?? '';
	if (!/^Bearer [A-Za-z0-9_-]{20,100}$/.test(auth)) return false;
	if (!env.GIVING) return 'unavailable';
	try {
		let response = await env.GIVING.fetch(`https://giving.internal/api/churches/${slug}/admin/session`, { headers: { Authorization: auth } });
		// An older giving service has no session route; its staff overview needs the same login.
		if (response.status === 404) response = await env.GIVING.fetch(`https://giving.internal/api/churches/${slug}/admin`, { headers: { Authorization: auth } });
		if ([401, 403, 404].includes(response.status)) return false;
		if (!response.ok) return 'unavailable';
		const body = await response.json<{ slug?: string; church?: { slug?: string } }>();
		if ((body.slug ?? body.church?.slug) !== slug) return false;
	} catch {
		return 'unavailable';
	}
	return true;
}

/** On a 401, tells the browser its stored staff session was rejected and should be dropped. */
export const STAFF_SESSION_INVALID = 'staff_session_invalid';

/** Whether the caller presented a staff session at all, valid or not. */
export const sentStaffToken = (request: Request) => /^Bearer /.test(request.headers.get('Authorization') ?? '');

/** Staff-only endpoints deny access during an outage but preserve the caller's session. */
export async function requireStaff(request: Request, env: AppEnv, slug: string): Promise<Response | null> {
	const result = await isStaff(request, env, slug);
	if (result === true) return null;
	if (result === 'unavailable') return Response.json({ detail: 'The staff sign-in service is unavailable right now. Please try again.' }, { status: 503 });
	return Response.json({ detail: 'Please sign in as church staff.', ...(sentStaffToken(request) && { code: STAFF_SESSION_INVALID }) }, { status: 401 });
}

type Route = [string, RegExp];
const matches = (routes: Route[], method: string, path: string) => routes.some(([m, re]) => m === method && re.test(path));

// Open to everyone, like the church website they sit on.
const PUBLIC_ROUTES: Route[] = [
	['GET', /^\/api\/(health|church|info|ministries|events|chat\/status|ai\/status|ollama\/status|regions|news)$/],
	['GET', /^\/api\/visits\/[A-Za-z0-9_-]+$/],
	['GET', /^\/api\/verse$/],
	['GET', /^\/api\/blog(?:\/(categories|\d+))?$/],
	['GET', /^\/api\/events\/\d+$/],
	['POST', /^\/api\/(matches|connections|chat|visits)$/],
	['POST', /^\/api\/visits\/[A-Za-z0-9_-]+\/arrive$/],
];

// Staff-only ids match any segment, not just digits: the container also accepts forms like +1 or 01 for 1,
// so a digits-only pattern would let those fall through to a weaker rule. A bad id is the container's 404.
const ID = '[^/]+';

// Public imports use capability ids; malformed ids are the container's 404.
const PUBLIC_BUILDER_ROUTES: Route[] = [
	['POST', /^\/api\/builder\/drafts$/],
	['POST', /^\/api\/builder\/drafts\/(blank|upload)$/],
	['GET', new RegExp(`^/api/builder/drafts/${ID}$`)],
	['GET', new RegExp(`^/api/builder/drafts/${ID}/site$`)],
	['POST', new RegExp(`^/api/builder/drafts/${ID}/(answers|items|preview)$`)],
];

// Staff work requires a church session, including on the demo church.
const STAFF_WORK_ROUTES: Route[] = [
	['GET', /^\/api\/(connections|requests|visits)$/],
	['POST', new RegExp(`^/api/visits/${ID}/(claim|met)$`)],
	['POST', /^\/api\/events$/],
	['POST', new RegExp(`^/api/events/${ID}/summarize$`)],
	['POST', /^\/api\/events\/summarize-all$/],
	['DELETE', new RegExp(`^/api/(connections|requests|events)/${ID}$`)],
	['PATCH', new RegExp(`^/api/requests/${ID}$`)],
];

// Settings shared by every church (the AI model) require the operator API key.
const OPERATOR_ROUTES: Route[] = [['POST', /^\/api\/(ai|ollama)\/model$/]];

// Church setup and content import: that church's staff, on every church. (The demo church's staff
// password is ADMIN_KEY in api-giving.)
const STAFF_ROUTES: Route[] = [
	['GET', /^\/api\/church\/content$/],
	['PUT', /^\/api\/church\/content$/],
	// Blog routes match Ben's PR #52; drafting and approval workflows must filter drafts separately.
	['POST', /^\/api\/blog(?:\/.*)?$/],
	['PUT', /^\/api\/blog(?:\/.*)?$/],
	['PATCH', /^\/api\/blog(?:\/.*)?$/],
	['DELETE', /^\/api\/blog(?:\/.*)?$/],
	['POST', new RegExp(`^/api/builder/drafts/${ID}/apply$`)],
];

export type Access = 'public' | 'staff' | 'key' | 'key-or-staff';

/** Who may call a route. Anything not listed (Sermon Notes, the chat log) takes the API key or a staff session. */
export function access(method: string, path: string, demo: boolean): Access {
	if (matches(STAFF_ROUTES, method, path)) return 'staff';
	if (matches(PUBLIC_BUILDER_ROUTES, method, path)) return 'public';
	// All other builder paths and methods stay staff only.
	if (/^\/api\/builder(?:\/.*)?$/.test(path)) return 'staff';
	if (matches(PUBLIC_ROUTES, method, path)) return 'public';
	if (matches(STAFF_WORK_ROUTES, method, path)) return 'staff';
	if (matches(OPERATOR_ROUTES, method, path)) return 'key';
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
