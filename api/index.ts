import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { DurableObject } from 'cloudflare:workers';
import { aiBridge, authorize, churchDb, handleNotes, json, mediaBridge, notesBusy, tooLarge, type AppEnv } from './notes';

// Outbound interception needs ContainerProxy exported from the entrypoint.
export { ContainerProxy };

type Statement = { sql: string; params?: (string | number | null)[] };

/** The church database: SQLite in a Durable Object. Each POST /sql batch runs as one transaction. */
export class ChurchDB extends DurableObject<AppEnv> {
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

// yt-dlp talks to these directly; with no outbound handler they fall through to the internet.
const YOUTUBE_HOSTS = ['youtube.com', '*.youtube.com', 'youtu.be', '*.googlevideo.com', '*.ytimg.com', '*.googleapis.com'];

/** The FastAPI backend (backend/Dockerfile). */
export class ChurchAPI extends Container<AppEnv> {
	defaultPort = 8000;
	sleepAfter = '20m';
	enableInternet = false;
	// Outbound HTTPS goes through the Worker; start.sh makes the container trust its CA.
	interceptHttps = true;
	// allowedHosts gates everything, including outboundByHost, so the bridge hosts must be listed.
	allowedHosts = ['church-db', 'notes-media', 'workers-ai', ...YOUTUBE_HOSTS];

	// Every instance shares one database, so the Worker's /ask reads what the container wrote.
	// Assigned (not declared as a class field) so the library's static setter registers it.
	static {
		this.outboundByHost = {
			'church-db': (request: Request, env: AppEnv) => churchDb(env).fetch(request),
			'notes-media': (request: Request, env: AppEnv) => mediaBridge(request, env),
			'workers-ai': (request: Request, env: AppEnv) => aiBridge(request, env),
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

function withCors(response: Response, env: AppEnv): Response {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
	headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key');
	headers.set('Vary', 'Origin');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
	async fetch(request: Request, env: AppEnv): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith('/api/')) {
			return new Response('Not found', { status: 404 });
		}
		if (request.method === 'OPTIONS') {
			return withCors(new Response(null, { status: 204 }), env);
		}
		// Internal routes are only called by this Worker.
		if (url.pathname.startsWith('/api/internal/')) {
			return withCors(json({ detail: 'Not Found' }, 404), env);
		}
		if (url.pathname !== '/api/health') {
			const denied = await authorize(request, env);
			if (denied) return withCors(denied, env);
		}
		if (url.pathname !== '/api/notes/upload') {
			const rejected = tooLarge(request);
			if (rejected) return withCors(rejected, env);
		}
		// One named instance, so every request hits the same container.
		const container = getContainer(env.CHURCH_API, 'main');
		const handled = await handleNotes(request, env, url, container);
		return withCors(handled ?? (await container.fetch(request)), env);
	},
} satisfies ExportedHandler<AppEnv>;
