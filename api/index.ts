import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { DurableObject } from 'cloudflare:workers';
import { handleVerse } from './verse';
import { aiBridge, authorize, churchDb, handleNotes, json, mediaBridge, notesBusy, tooLarge, type AppEnv } from './notes';
import { DEMO_SLUG, STAFF_SESSION_INVALID, access, churchHeaders, churchPath, findChurch, isStaff, requireStaff, sentStaffToken, onBaseDomain, validSlug } from './churches';
import { TEAM_AI_HOST, teamAiBridge, teamAiEnvVars } from './teamai';
import { YT_HELPER_HOST, ytHelperBridge, ytHelperEnvVars } from './ythelper';

// Outbound interception needs ContainerProxy exported from the entrypoint.
export { ContainerProxy };

type Statement = { sql: string; params?: (string | number | null)[] };

/** One church's database: SQLite in a Durable Object. Each POST /sql batch runs as one transaction. */
export class ChurchDB extends DurableObject<AppEnv> {
	// The demo church's object also remembers which other churches have Sermon Notes, so the
	// container can be kept awake while any of them is transcribing.
	async rememberNotesChurch(slug: string): Promise<void> {
		await this.ctx.storage.put('notes-church:' + slug, Date.now());
	}

	async notesChurches(): Promise<string[]> {
		const found = await this.ctx.storage.list({ prefix: 'notes-church:', limit: 1000 });
		return [...found.keys()].map((k) => k.slice('notes-church:'.length));
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'POST' || new URL(request.url).pathname !== '/sql') {
			return new Response('Not found', { status: 404 });
		}
		const { batch } = await request.json<{ batch: Statement[] }>();
		try {
			const results = this.ctx.storage.transactionSync(() =>
				batch.map(({ sql, params = [] }) => {
					const cursor = this.ctx.storage.sql.exec(sql, ...params);
					const rows = cursor.toArray();
					return { rows, rowsWritten: cursor.rowsWritten };
				}),
			);
			return Response.json({ results });
		} catch (err) {
			console.error("church-db batch failed:", String(err));
			return Response.json({ error: String(err) }, { status: 400 });
		}
	}
}

// The direct yt-dlp fallback talks to these; with no outbound handler they fall through to the internet.
// YouTube links go to the YouTube helper (YT_HELPER_HOST, see ythelper.ts) first.
const YOUTUBE_HOSTS = ['youtube.com', '*.youtube.com', 'youtu.be', '*.googlevideo.com', '*.ytimg.com', '*.googleapis.com'];
// The website chat (backend/app/chat.py) calls these AI providers when a key is set.
const AI_PROVIDER_HOSTS = ['platform.ai.gloo.com', 'api.openai.com', 'api.anthropic.com'];
// POST /api/news/refresh pulls Prayer Map headlines from NewsData.io when NEWSDATA_API_KEY is set.
const NEWS_HOSTS = ['newsdata.io'];

/** The FastAPI backend (backend/Dockerfile). */
export class ChurchAPI extends Container<AppEnv> {
	defaultPort = 8000;
	sleepAfter = '20m';
	enableInternet = false;
	// Outbound HTTPS goes through the Worker; start.sh makes the container trust its CA.
	interceptHttps = true;
	// allowedHosts gates everything, including outboundByHost, so the bridge hosts must be listed.
	allowedHosts = ['church-db', 'notes-media', 'workers-ai', TEAM_AI_HOST, YT_HELPER_HOST, ...YOUTUBE_HOSTS, ...AI_PROVIDER_HOSTS, ...NEWS_HOSTS];

	// The container and the Worker's /ask share each church's database.
	// Assigned (not declared as a class field) so the library's static setter registers it.
	static {
		this.outboundByHost = {
			// The container names the church in X-Church; each church has its own database.
			'church-db': (request: Request, env: AppEnv) => {
				const slug = request.headers.get('X-Church') || DEMO_SLUG;
				return validSlug(slug) ? churchDb(env, slug).fetch(request) : new Response('Bad church', { status: 400 });
			},
			'notes-media': (request: Request, env: AppEnv) => mediaBridge(request, env),
			'workers-ai': (request: Request, env: AppEnv) => aiBridge(request, env),
			// The team's HPC model through scripts/team-ai-bridge (a stopgap until the Gloo key); see teamai.ts.
			[TEAM_AI_HOST]: (request: Request, env: AppEnv) => teamAiBridge(request, env),
			// YouTube downloads from Jaron's dev server (scripts/youtube-helper); the handler adds the key.
			[YT_HELPER_HOST]: (request: Request, env: AppEnv) => ytHelperBridge(request, env),
		};
	}

	constructor(ctx: DurableObjectState<{}>, env: AppEnv) {
		super(ctx, env);
		this.envVars = {
			CHURCH_DB_URL: 'http://church-db',
			NOTES_MEDIA_URL: 'http://notes-media',
			WORKERS_AI_URL: 'http://workers-ai',
			MAX_DURATION_SEC: env.MAX_DURATION_SEC,
			YTDLP_COOKIES: env.YTDLP_COOKIES ?? '',
			// Chat runs in demo mode until one of these secrets is set, or the team AI bridge is (TEAM_AI_URL + TEAM_AI_KEY).
			GLOO_API_KEY: env.GLOO_API_KEY ?? '',
			// Optional. Which Gloo model to use; the backend's default (gloo-qwen-3.7-flash) applies when it is empty.
			GLOO_MODEL: env.GLOO_MODEL ?? '',
			// Optional. The Gloo embedding model (default gloo-baai-bge-base-en-v1.5). Ingest embeds through the Worker's
			// /embed bridge, which reads the same value, so the chunks are tagged with the model the Worker queries.
			GLOO_EMBED_MODEL: env.GLOO_EMBED_MODEL ?? '',
			// Optional. The Gloo model that tags sermon highlights; GLOO_MODEL (then gloo-qwen-3.7-flash) when it is empty.
			GLOO_NOTES_MODEL: env.GLOO_NOTES_MODEL ?? '',
			// Optional. Find a place's model; the backend uses a fast non-reasoning default when empty.
			GLOO_MATCH_MODEL: env.GLOO_MATCH_MODEL ?? '',
			OPENAI_API_KEY: env.OPENAI_API_KEY ?? '',
			ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY ?? '',
			// Optional. Without it the news refresh answers 503 and the Prayer Map keeps the shipped snapshot.
			NEWSDATA_API_KEY: env.NEWSDATA_API_KEY ?? '',
			...teamAiEnvVars(env),
			// http://youtube-helper when YT_HELPER_URL and YT_HELPER_KEY are set; the key stays in the Worker.
			...ytHelperEnvVars(env),
		};
	}

	// Long transcriptions get no inbound traffic; stay awake while any note is queued or processing.
	override async onActivityExpired(): Promise<void> {
		if (await notesBusy(this.env)) {
			this.renewActivityTimeout();
			return;
		}
		await super.onActivityExpired();
	}
}

/** ALLOWED_ORIGIN is a comma-separated list. The Origin of a request is allowed when it is on it,
 * or when it is a church subdomain of BASE_DOMAIN. */
function allowOrigin(request: Request, env: AppEnv): string {
	const list = (env.ALLOWED_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
	if (!list.length) return '*';
	const origin = request.headers.get('Origin') ?? '';
	return list.includes(origin) || onBaseDomain(origin, env.BASE_DOMAIN) ? origin : list[0];
}

function withCors(response: Response, env: AppEnv, request: Request): Response {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', allowOrigin(request, env));
	headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key, Authorization');
	headers.set('Vary', 'Origin');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Notes routes that can start a transcription; the container is kept awake for that church.
const STARTS_NOTE = /^\/api\/notes(\/upload|\/[0-9a-f-]{36}\/retry)?$/;
// The content import carries a whole church (FAQs, ministries, calendar), so it may be larger.
const MAX_IMPORT_BYTES = 512 * 1024;

async function route(request: Request, env: AppEnv, url: URL): Promise<Response> {
	// /api/churches/<slug>/... is that church; a bare /api/... is the demo church.
	const target = churchPath(url.pathname);
	if (!target) return json({ detail: 'Church not found' }, 404);
	const path = target.path;
	// Internal routes are only called by this Worker.
	if (path.startsWith('/api/internal/')) return json({ detail: 'Not Found' }, 404);
	if (path === '/api/verse' && request.method === 'GET') return handleVerse(url, env);

	const church = await findChurch(env, target.slug);
	if (church === 'unavailable') return json({ detail: 'The church directory is unavailable right now. Please try again.' }, 503);
	if (!church) return json({ detail: 'Church not found' }, 404);

	const rule = access(request.method, path, church.demo);
	if (rule === 'staff') {
		const denied = await requireStaff(request, env, church.slug);
		if (denied) return denied;
	}
	if (rule === 'key') {
		const denied = await authorize(request, env);
		if (denied) return denied;
	}
	if (rule === 'key-or-staff') {
		const staff = await isStaff(request, env, church.slug);
		if (staff !== true) {
			const denied = await authorize(request, env);
			if (denied && staff === 'unavailable') return json({ detail: 'The staff sign-in service is unavailable right now. Please try again.' }, 503);
			// A rejected staff session: say so, so the browser drops it (a missing API key alone never does).
			if (denied?.status === 401 && sentStaffToken(request)) return json({ ...(await denied.json<Record<string, unknown>>()), code: STAFF_SESSION_INVALID }, 401);
			if (denied) return denied;
		}
	}
	if (path !== '/api/notes/upload') {
		const rejected = tooLarge(request, path === '/api/church/content' ? MAX_IMPORT_BYTES : undefined);
		if (rejected) return rejected;
	}

	// One named instance, so every request hits the same container. It reads the church from X-Church.
	const container = getContainer(env.CHURCH_API, 'main');
	const plain = new URL(url);
	plain.pathname = path;
	// A redirect from the container goes back to the browser, so its next request is authorized again here.
	const forwarded = new Request(plain, { method: request.method, headers: churchHeaders(request.headers, church), body: request.body, redirect: 'manual' });
	if (!church.demo && request.method === 'POST' && STARTS_NOTE.test(path)) {
		await churchDb(env).rememberNotesChurch(church.slug).catch(() => {});
	}
	const handled = await handleNotes(forwarded, env, plain, container, church);
	if (handled) return handled;
	const response = await container.fetch(forwarded);
	// Builds of the site check this to know the API serves more than the demo church.
	if (path === '/api/health' && response.ok) return json({ ...(await response.json<object>()), churches: true });
	return response;
}

export default {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/api/')) {
			return new Response('Not found', { status: 404 });
		}
		if (request.method === 'OPTIONS') {
			return withCors(new Response(null, { status: 204 }), env, request);
		}
		return withCors(await route(request, env, url), env, request);
	},
} satisfies ExportedHandler<AppEnv>;
