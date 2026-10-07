import { DEMO_SLUG, churchHeaders, type Church } from './churches.ts';
import { EmbedError, backfillChurch, comparable, cosine, embedChunks, embedTag, embedTexts, ensureEmbedColumn, vectorJson, type RunSql } from './embed.ts';

// Keys are Workers secrets (`wrangler secret put`). Only NOTES_API_KEY is required.
type Secrets = {
	NOTES_API_KEY?: string; NOTES_ADMIN_KEY?: string; YTDLP_COOKIES?: string;
	GLOO_API_KEY?: string; GLOO_MODEL?: string; GLOO_MATCH_MODEL?: string; GLOO_EMBED_MODEL?: string; GLOO_NOTES_MODEL?: string; GLOO_BUILDER_MODEL?: string; OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string; NEWSDATA_API_KEY?: string;
	// Optional: the team AI bridge (scripts/team-ai-bridge), and which provider the chat tries first.
	TEAM_AI_URL?: string; TEAM_AI_KEY?: string; TEAM_AI_MODEL?: string; AI_PROVIDER?: string;
	// Optional: the YouTube helper (scripts/youtube-helper) that downloads YouTube audio from a home connection.
	YT_HELPER_URL?: string; YT_HELPER_KEY?: string;
	YOUVERSION_APP_KEY?: string; YOUVERSION_BIBLE_ID?: string;
	// Optional: the base domain once churches have subdomains (grace.<BASE_DOMAIN>).
	BASE_DOMAIN?: string;
};
// GIVING is a service binding to the giving Worker: the church registry and staff sign-in.
export type AppEnv = Env & Secrets & { GIVING?: Fetcher };

type Statement = { sql: string; params?: (string | number | null)[] };
type Chunk = { idx: number; start: number; end: number; seg_from: number; seg_to: number; text: string; embedding: string; embed_model: string };
type Segment = { idx: number; start: number; end: number; text: string };
type Scored = Omit<Chunk, 'embedding' | 'embed_model'> & { score: number };
type Citation = { chunk: number; start: number; end: number; timestamp: string; quote: string; url?: string };
type Answer = { found: boolean; answer: string; citations: Citation[] };

// Transcription is the one model hosted on Workers AI: Gloo has no speech-to-text. Embeddings come from Gloo (embed.ts).
export const ASR_MODEL = '@cf/openai/whisper-large-v3-turbo';
// Sermon-note answers go to Gloo, like the chat. Keep in step with backend/app/chat.py.
export const GLOO_CHAT_URL = 'https://platform.ai.gloo.com/ai/v2/guarded/chat/completions';
export const GLOO_DEFAULT_MODEL = 'gloo-qwen-3.7-flash';
// gloo-qwen-3.7-flash reasons before it answers and can take 30+ seconds; Cloudflare ends a proxied request at about 100.
export const GLOO_TIMEOUT_MS = 60_000;
const NOT_FOUND = 'Not found in this note.';
const TOP_K = 5;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_ASR_BYTES = 8 * 1024 * 1024;
const MAX_LLM_PROMPT_CHARS = 64 * 1024;
const MEDIA_KEY = /^notes\/[0-9a-f-]{36}\/source$/;

export const json = (body: unknown, status = 200) => Response.json(body, { status });
const detail = (message: string, status: number) => json({ detail: message }, status);

// --- The church database (same /sql batch contract the container uses) ---

// One database per church. The demo church keeps the original database ('church'), so its data stays put.
export const churchDb = (env: AppEnv, slug = DEMO_SLUG) =>
	env.CHURCH_DB.get(env.CHURCH_DB.idFromName(slug === DEMO_SLUG ? 'church' : 'church:' + slug));

async function sql(env: AppEnv, slug: string, ...batch: Statement[]): Promise<{ rows: any[] }[]> {
	const response = await churchDb(env, slug).fetch('http://church-db/sql', { method: 'POST', body: JSON.stringify({ batch }) });
	if (!response.ok) throw new Error(await response.text());
	return (await response.json<{ results: { rows: any[] }[] }>()).results;
}

const dbFor = (env: AppEnv, slug: string): RunSql => (...batch) => sql(env, slug, ...batch);

// Churches whose chunks table is known to have embed_model, so the check runs about once per isolate.
const embedColumnReady = new WeakMap<object, Set<string>>();

async function ensureChunkTags(env: AppEnv, slug: string): Promise<void> {
	const ready = embedColumnReady.get(env.CHURCH_DB) ?? new Set<string>();
	embedColumnReady.set(env.CHURCH_DB, ready);
	if (!ready.has(slug) && (await ensureEmbedColumn(dbFor(env, slug)))) ready.add(slug);
}

/** True while any church has a note queued or being processed; keeps the container awake. */
export async function notesBusy(env: AppEnv): Promise<boolean> {
	let slugs = [DEMO_SLUG];
	try {
		slugs = [DEMO_SLUG, ...(await churchDb(env).notesChurches())];
	} catch {
		/* just the demo church */
	}
	for (const slug of slugs) {
		try {
			const [{ rows }] = await sql(env, slug, { sql: "SELECT 1 AS x FROM notes WHERE status IN ('queued', 'processing') LIMIT 1" });
			if (rows.length) return true;
		} catch {
			/* that church has no notes table yet */
		}
	}
	return false;
}

// --- Auth ---

const encoder = new TextEncoder();

async function sameSecret(given: string, expected: string): Promise<boolean> {
	// Hash both so the comparison is constant-time regardless of length.
	const [a, b] = await Promise.all([given, expected].map((v) => crypto.subtle.digest('SHA-256', encoder.encode(v))));
	return crypto.subtle.timingSafeEqual(a, b);
}

/** null when the request carries the API key; otherwise the error response. */
export async function authorize(request: Request, env: AppEnv): Promise<Response | null> {
	if (!env.NOTES_API_KEY) return detail('API key not configured', 503);
	if (!(await sameSecret(request.headers.get('X-API-Key') ?? '', env.NOTES_API_KEY))) return detail('Missing or invalid API key', 401);
	return null;
}

async function authorizeAdmin(request: Request, env: AppEnv): Promise<Response | null> {
	if (!env.NOTES_ADMIN_KEY) return detail('Config changes are disabled on this deploy', 403);
	if (!(await sameSecret(request.headers.get('X-Admin-Key') ?? '', env.NOTES_ADMIN_KEY))) return detail('Missing or invalid admin key', 401);
	return null;
}

/** Rejects oversized JSON bodies before they reach the container. */
export function tooLarge(request: Request, max = MAX_JSON_BYTES): Response | null {
	const length = Number(request.headers.get('Content-Length') ?? 0);
	return length > max ? detail('Request body too large', 413) : null;
}

async function readJson(request: Request): Promise<any> {
	const text = await request.text();
	if (text.length > MAX_JSON_BYTES) throw new Error('too large');
	return JSON.parse(text || '{}');
}

// --- Container egress bridges (the container never holds a binding or key) ---

export async function mediaBridge(request: Request, env: AppEnv): Promise<Response> {
	const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
	if (request.method !== 'GET' || !MEDIA_KEY.test(key)) return new Response('Not found', { status: 404 });
	const object = await env.MEDIA.get(key);
	if (!object) return new Response('Not found', { status: 404 });
	return new Response(object.body, { headers: { 'Content-Length': String(object.size) } });
}

export async function aiBridge(request: Request, env: AppEnv): Promise<Response> {
	const path = new URL(request.url).pathname;
	try {
		if (request.method === 'POST' && path === '/asr') {
			const audio = await request.arrayBuffer();
			if (!audio.byteLength || audio.byteLength > MAX_ASR_BYTES) return new Response('Bad audio size', { status: 413 });
			const out: any = await env.AI.run(ASR_MODEL as any, {
				audio: toBase64(audio),
				vad_filter: true,
				condition_on_previous_text: false,
			} as any);
			return json({
				text: out.text ?? '',
				segments: (out.segments ?? []).map((s: any) => ({ start: s.start, end: s.end, text: s.text })),
				duration: out.transcription_info?.duration ?? null,
			});
		}
		if (request.method === 'POST' && path === '/embed') {
			// Ingest embeddings, from Gloo. The container tags the chunks with `model`, or saves them unembedded on an error.
			const { texts } = await request.json<{ texts: unknown }>();
			if (!Array.isArray(texts) || !texts.length || texts.length > 100 || !texts.every((t) => typeof t === 'string' && t))
				return new Response('texts must be 1-100 non-empty strings', { status: 400 });
			try {
				const { tag, vectors } = await embedTexts(env, texts);
				return json({ vectors, model: tag });
			} catch (err) {
				console.error('gloo embeddings failed:', String(err));
				const noKey = err instanceof EmbedError && err.code === 'no_key';
				return new Response(noKey ? 'GLOO_API_KEY is not set' : 'Gloo embeddings failed', { status: noKey ? 503 : 502 });
			}
		}
		if (request.method === 'POST' && path === '/llm') {
			// Highlight fallback only: the container tags transcript windows with Gloo itself
			// (backend/app/pastor_notes.py) and asks here for a window Gloo could not tag.
			const { prompt } = await request.json<{ prompt: unknown }>();
			if (typeof prompt !== 'string' || !prompt || prompt.length > MAX_LLM_PROMPT_CHARS)
				return new Response(`prompt must be 1-${MAX_LLM_PROMPT_CHARS} characters`, { status: 400 });
			const out: any = await env.AI.run(env.NOTES_LLM_MODEL as any, {
				messages: [{ role: 'user', content: prompt }],
				temperature: 0,
				max_tokens: 2048,
			} as any);
			return json({
				text: typeof out.response === 'string' ? out.response : JSON.stringify(out.response ?? ''),
				model: `workers-ai:${env.NOTES_LLM_MODEL}`,
			});
		}
	} catch (err) {
		console.error('workers-ai bridge failed:', String(err));
		return new Response('Workers AI call failed', { status: 502 });
	}
	return new Response('Not found', { status: 404 });
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

// --- Routes the Worker handles itself ---

type ContainerStub = { fetch(request: Request): Promise<Response> };

// Internal calls carry the church headers, so the container works in that church's database.
const internal = (container: ContainerStub, church: Church, method: string, path: string, body?: unknown) =>
	container.fetch(new Request('http://container' + path, {
		method,
		headers: churchHeaders(new Headers({ 'Content-Type': 'application/json' }), church),
		body: body === undefined ? undefined : JSON.stringify(body),
	}));

/** Handles upload, ask, admin config and delete. Returns null for routes the container serves.
 * `url` has the plain /api/... path; `church` is the church the request is for. */
export async function handleNotes(request: Request, env: AppEnv, url: URL, container: ContainerStub, church: Church): Promise<Response | null> {
	const path = url.pathname;
	if (request.method === 'POST' && path === '/api/notes/upload') return upload(request, env, url, container, church);
	if (request.method === 'PUT' && path === '/api/admin/config') {
		const denied = await authorizeAdmin(request, env);
		if (denied) return denied;
		let body;
		try {
			body = await readJson(request);
		} catch {
			return detail('Body must be JSON', 400);
		}
		return internal(container, church, 'PUT', '/api/internal/config', body);
	}
	if (request.method === 'POST' && path === '/api/notes/reembed') return reembed(env, url, church.slug);
	const ask = path.match(/^\/api\/notes\/([0-9a-f-]{36})\/ask$/);
	if (request.method === 'POST' && ask) return answer(request, env, url, ask[1], church.slug);
	const note = path.match(/^\/api\/notes\/([0-9a-f-]{36})$/);
	if (request.method === 'DELETE' && note) {
		const response = await internal(container, church, 'DELETE', `/api/internal/notes/${note[1]}`);
		if (!response.ok) return response;
		const { r2_key } = await response.json<{ r2_key: string | null }>();
		if (r2_key) await env.MEDIA.delete(r2_key);
		return new Response(null, { status: 204 });
	}
	return null;
}

async function upload(request: Request, env: AppEnv, url: URL, container: ContainerStub, church: Church): Promise<Response> {
	const lengthHeader = request.headers.get('Content-Length');
	const length = Number(lengthHeader);
	if (!lengthHeader || !Number.isFinite(length)) return detail('Content-Length is required', 411);
	if (length > Number(env.MAX_UPLOAD_BYTES)) return detail(`File is larger than ${Math.floor(Number(env.MAX_UPLOAD_BYTES) / 1048576)} MB`, 413);
	if (length === 0 || !request.body) return detail('File is empty', 400);
	const contentType = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
	if (!/^(video|audio)\/[\w.+-]+$/.test(contentType)) return detail('Content-Type must be video/* or audio/*', 415);
	const title = (url.searchParams.get('title') ?? '').trim();
	if (!title || title.length > 200) return detail('title query parameter is required (max 200 characters)', 400);

	const noteId = crypto.randomUUID();
	const key = `notes/${noteId}/source`;
	await env.MEDIA.put(key, request.body, { httpMetadata: { contentType } });
	const response = await internal(container, church, 'POST', '/api/internal/notes', { title, r2_key: key, note_id: noteId });
	if (!response.ok) await env.MEDIA.delete(key);
	return response;
}

// --- Grounded Q&A ---

// Words that carry no topic: question words, filler, and words about the sermon itself.
const STOPWORDS = new Set(`a about above after again all also am an and any are as at be been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it
its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their
them then there these they this those through to too under until up very was we were what when where which while who whom why will with
would you your yours many much tell said say says saying talk talked talks mention mentioned speak spoke pastor preacher speaker sermon
message note notes video church thing things get got going go really like one`.split(/\s+/));

function stem(word: string): string {
	for (const suffix of ['ingly', 'edly', 'ness', 'ers', 'ing', 'ies', 'er', 'ed', 'es', 'ly', 's']) {
		if (word.length - suffix.length >= 3 && word.endsWith(suffix)) return suffix === 'ies' ? word.slice(0, -3) + 'y' : word.slice(0, -suffix.length);
	}
	return word;
}

const normalize = (text: string) =>
	text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const contentStems = (text: string) =>
	new Set(normalize(text).split(' ').map((w) => w.replace(/'/g, '')).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map(stem));

/** Without vectors: rank passages by how many of the question's topic words they contain. */
function keywordRank(chunks: Chunk[], questionStems: Set<string>): Scored[] {
	if (!questionStems.size) return [];
	return chunks
		.map(({ embedding, embed_model, ...chunk }) => {
			const stems = contentStems(chunk.text);
			return { ...chunk, score: [...questionStems].filter((s) => stems.has(s)).length / questionStems.size };
		})
		.filter((c) => c.score > 0)
		.sort((a, b) => b.score - a.score || a.idx - b.idx)
		.slice(0, TOP_K);
}

/** Staff or API key: re-embed this church's chunks that are not on the current Gloo model, one batch per call.
 * Repeat until `done`; it resumes where the last call stopped. Never re-transcribes. */
async function reembed(env: AppEnv, url: URL, slug: string): Promise<Response> {
	if (!env.GLOO_API_KEY) return detail('GLOO_API_KEY is not set on this deploy', 503);
	const limit = Number(url.searchParams.get('limit') ?? '') || undefined;
	let result;
	try {
		result = await backfillChurch(dbFor(env, slug), env, limit);
	} catch (err) {
		console.error('embedding backfill failed:', String(err));
		return detail('Backfill failed', 500);
	}
	return json({ church: slug, ...result }, result.error && !result.embedded ? 502 : 200);
}

export function timestamp(seconds: number): string {
	const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
	const mmss = `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
	return h ? `${h}:${mmss}` : mmss;
}

async function answer(request: Request, env: AppEnv, url: URL, noteId: string, slug: string): Promise<Response> {
	let body;
	try {
		body = await readJson(request);
	} catch {
		return detail('Body must be JSON', 400);
	}
	const question = typeof body.question === 'string' ? body.question.trim() : '';
	if (!question || question.length > 500) return detail('question is required (max 500 characters)', 400);

	let results;
	try {
		await ensureChunkTags(env, slug);
		results = await sql(env, slug,
			{ sql: 'SELECT status, source_kind, source_url FROM notes WHERE id = ?', params: [noteId] },
			{ sql: 'SELECT idx, start, "end", seg_from, seg_to, text, embedding, embed_model FROM chunks WHERE note_id = ? ORDER BY idx', params: [noteId] },
			{ sql: "SELECT data FROM config WHERE key = 'church'" },
			{ sql: 'SELECT idx, start, "end", text FROM segments WHERE note_id = ? ORDER BY idx', params: [noteId] });
	} catch {
		return detail('Note not found', 404); // tables don't exist until the container has started once
	}
	const [[note], chunks, [config], segments] = results.map((r) => r.rows) as [any[], Chunk[], any[], Segment[]];
	if (!note) return detail('Note not found', 404);
	if (note.status !== 'ready') return detail(`Note is ${note.status}, not ready`, 409);
	const churchName = config ? JSON.parse(config.data).name : 'the church';

	const questionStems = contentStems(question);
	const minScore = Number(env.NOTES_MIN_SCORE);
	const tag = embedTag(env);
	let ranked: Scored[], retrieval: 'vector' | 'keyword', retrievalReason: string | undefined, reembedded = 0;
	try {
		// Chunks embedded by another model (or not at all) are re-embedded from their stored text first.
		const stale = chunks.filter((c) => c.embed_model !== tag || !c.embedding);
		if (stale.length) {
			const out = await embedChunks(dbFor(env, slug), env, stale.map((c) => ({ note_id: noteId, idx: c.idx, text: c.text })));
			stale.forEach((c, i) => Object.assign(c, { embedding: vectorJson(out.vectors[i]), embed_model: out.tag }));
			reembedded = out.saved;
		}
		const { vectors: [questionVector] } = await embedTexts(env, [question]);
		ranked = comparable(chunks, tag)
			.map(({ embedding, embed_model, ...chunk }) => ({ ...chunk, score: cosine(questionVector, JSON.parse(embedding)) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, TOP_K);
		retrieval = 'vector';
	} catch (err) {
		// No key or Gloo is down: keyword search over the same passages, never an error and never another model's vectors.
		retrievalReason = err instanceof EmbedError ? `embeddings_${err.code}` : 'embeddings_failed';
		if (retrievalReason !== 'embeddings_no_key') console.error('question embedding failed:', String(err));
		ranked = keywordRank(chunks, questionStems);
		retrieval = 'keyword';
	}
	// A passage supports the question only if it shares a topic word with it AND (with vectors) is semantically close.
	const sharesTopic = (c: Scored) => [...contentStems(c.text)].some((s) => questionStems.has(s));
	const supported = ranked.filter((c) => sharesTopic(c) && (retrieval === 'keyword' || c.score >= minScore));
	const debug = url.searchParams.get('debug') === '1'
		? { min_score: minScore, embed_model: tag, reembedded, question_terms: [...questionStems], top: ranked.map((c) => ({ chunk: c.idx, score: Number(c.score.toFixed(4)), text: c.text.slice(0, 120) })) }
		: undefined;

	const cite = (c: Scored | Segment, quote = c.text, chunk = c.idx): Citation => ({
		chunk, start: c.start, end: c.end, timestamp: timestamp(c.start), quote,
		...(note.source_kind === 'youtube' && note.source_url ? { url: `${note.source_url}&t=${Math.floor(c.start)}s` } : {}),
	});
	const reply = (result: Answer, engine: string, extra: Record<string, unknown> = {}) =>
		json({ ...result, engine, retrieval, ...(retrievalReason ? { retrieval_reason: retrievalReason } : {}), ...extra, ...(debug ? { debug } : {}) });

	if (!supported.length) return reply({ found: false, answer: NOT_FOUND, citations: [] }, 'extractive');

	// Verbatim answer: the segments of the best passages that contain a question word, in time order.
	const extractive = (): Answer => {
		const picked = new Map<number, Citation>();
		for (const c of supported.slice(0, 2)) {
			for (const seg of segments.slice(c.seg_from, c.seg_to + 1)) {
				if (!picked.has(seg.idx) && [...contentStems(seg.text)].some((s) => questionStems.has(s))) picked.set(seg.idx, cite(seg, seg.text, c.idx));
			}
		}
		const citations = [...picked.values()].sort((a, b) => a.start - b.start).slice(0, 3);
		if (!citations.length) citations.push(cite(supported[0]));
		return { found: true, answer: citations.map((c) => `"${c.quote}" [${c.timestamp}]`).join('\n\n'), citations };
	};

	const engine = pickEngine(env, body.engine);
	if (engine === 'extractive') return reply(extractive(), 'extractive');

	let raw: unknown, label: string;
	try {
		[raw, label] = await askModel(env, churchName, question, supported);
	} catch (err) {
		console.error('answer model failed:', String(err));
		return reply(extractive(), 'extractive', { fallback_reason: 'model_error' });
	}
	// A verified quote is cited at the segment it comes from, so the timestamp points at the words.
	const citeQuote = (c: Scored, quote: string): Citation => {
		const needle = normalize(quote);
		const seg = segments.slice(c.seg_from, c.seg_to + 1).find((s) => normalize(s.text).includes(needle) || needle.includes(normalize(s.text)));
		return seg ? cite(seg, quote, c.idx) : cite(c, quote);
	};
	const checked = verify(raw, supported, citeQuote);
	if (typeof checked === 'string') return reply(extractive(), 'extractive', { fallback_reason: checked });
	// The gate found support; a model that finds nothing can't make the answer worse than verbatim.
	if (!checked.found) return reply(extractive(), 'extractive', { fallback_reason: 'model_found_nothing' });
	return reply(checked, label);
}

function pickEngine(env: AppEnv, requested: unknown): 'extractive' | 'gloo' {
	// Gloo answers the questions. Without a key (or when asked) the extractive answerer, which uses no model.
	return requested !== 'extractive' && env.GLOO_API_KEY ? 'gloo' : 'extractive';
}

const SYSTEM_PROMPT = `You answer questions about one sermon or teaching from {church}, using ONLY the transcript passages provided.

Rules:
- Use only facts stated in the passages. Do not add Bible verses, background knowledge, or interpretation that the passages do not contain.
- Every claim needs a citation: the passage id and an exact quote copied word for word from that passage.
- If the passages do not answer the question, return found=false with an empty answer and no citations.
- Keep the answer to one to three plain sentences.

Return JSON only: {"found": boolean, "answer": string, "citations": [{"id": "C1", "quote": "exact words from C1"}]}`;

/** The JSON object in a model reply. Reasoning models may put a <think> block, a code fence or prose (with
 * braces of its own) around it, so reasoning is dropped and each balanced {...} is tried in turn. */
export function parseModelJson(reply: unknown): unknown {
	if (typeof reply !== 'string') return reply;
	let text = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
	const open = text.toLowerCase().indexOf('<think>');
	if (open >= 0) text = text.slice(0, open); // thinking cut off before it closed
	for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
		const end = balancedEnd(text, start);
		if (end < 0) continue;
		try {
			const value = JSON.parse(text.slice(start, end + 1));
			if (value && typeof value === 'object') return value;
		} catch {
			/* not JSON; try the next '{' */
		}
	}
	return null;
}

/** Index of the '}' that closes the '{' at `start` (braces inside JSON strings are ignored), or -1. */
function balancedEnd(text: string, start: number): number {
	let depth = 0, inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) return i;
	}
	return -1;
}

async function askModel(env: AppEnv, church: string, question: string, passages: Scored[]): Promise<[unknown, string]> {
	const system = SYSTEM_PROMPT.replace('{church}', church);
	const user = passages.map((c, i) => `[C${i + 1}] (${timestamp(c.start)}) ${c.text}`).join('\n\n') + `\n\nQuestion: ${question}`;
	// Same endpoint and model the chat uses (backend/app/chat.py), over OpenAI chat completions.
	const model = (env.GLOO_MODEL ?? '').trim() || GLOO_DEFAULT_MODEL;
	const response = await fetch(GLOO_CHAT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GLOO_API_KEY}` },
		body: JSON.stringify({
			auto_routing: false,
			model,
			messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
			temperature: 0,
			max_tokens: 600,
		}),
		signal: AbortSignal.timeout(GLOO_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`gloo ${response.status}: ${(await response.text()).slice(0, 300)}`);
	const out = await response.json<any>();
	return [parseModelJson(out.choices?.[0]?.message?.content ?? ''), `gloo:${model}`];
}

/** Accept the model's answer only if every quote is really in its passage and the answer's
 * topic words come from the cited passages. Otherwise return the reason it was rejected. */
function verify(raw: any, passages: Scored[], cite: (c: Scored, quote: string) => Citation): Answer | string {
	if (!raw || typeof raw.found !== 'boolean') return 'bad_model_output';
	if (!raw.found) return { found: false, answer: NOT_FOUND, citations: [] };
	if (typeof raw.answer !== 'string' || !raw.answer.trim()) return 'bad_model_output';
	if (!Array.isArray(raw.citations) || !raw.citations.length) return 'no_citations';
	const citations: Citation[] = [];
	const cited = new Set<Scored>();
	for (const c of raw.citations) {
		const passage = passages[Number(/^C(\d+)$/.exec(String(c?.id ?? ''))?.[1]) - 1];
		if (!passage) return 'unknown_citation';
		const quote = normalize(String(c.quote ?? ''));
		if (quote.length < 8 || !normalize(passage.text).includes(quote)) return 'quote_not_in_transcript';
		citations.push(cite(passage, String(c.quote).trim()));
		cited.add(passage);
	}
	const sourceStems = new Set([...cited].flatMap((p) => [...contentStems(p.text)]));
	const answerStems = [...contentStems(raw.answer)];
	const grounded = answerStems.filter((s) => sourceStems.has(s)).length;
	if (answerStems.length && grounded / answerStems.length < 0.8) return 'answer_not_grounded';
	return { found: true, answer: raw.answer.trim(), citations };
}
