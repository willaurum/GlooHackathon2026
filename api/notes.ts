// Keys are Workers secrets (`wrangler secret put`). Only NOTES_API_KEY is required.
type Secrets = {
	NOTES_API_KEY?: string; NOTES_ADMIN_KEY?: string; GEMINI_API_KEY?: string; YTDLP_COOKIES?: string;
	GLOO_API_KEY?: string; OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string;
};
export type AppEnv = Env & Secrets;

type Statement = { sql: string; params?: (string | number | null)[] };
type Chunk = { idx: number; start: number; end: number; seg_from: number; seg_to: number; text: string; embedding: string };
type Segment = { idx: number; start: number; end: number; text: string };
type Scored = Omit<Chunk, 'embedding'> & { score: number };
type Citation = { chunk: number; start: number; end: number; timestamp: string; quote: string; url?: string };
type Answer = { found: boolean; answer: string; citations: Citation[] };

export const ASR_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
// cls pooling must match between ingest (/embed bridge) and questions.
const POOLING = 'cls';
const NOT_FOUND = 'Not found in this note.';
const TOP_K = 5;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_ASR_BYTES = 8 * 1024 * 1024;
const MAX_LLM_PROMPT_CHARS = 64 * 1024;
const MEDIA_KEY = /^notes\/[0-9a-f-]{36}\/source$/;

export const json = (body: unknown, status = 200) => Response.json(body, { status });
const detail = (message: string, status: number) => json({ detail: message }, status);

// --- The church database (same /sql batch contract the container uses) ---

export const churchDb = (env: AppEnv) => env.CHURCH_DB.get(env.CHURCH_DB.idFromName('church'));

async function sql(env: AppEnv, ...batch: Statement[]): Promise<{ rows: any[] }[]> {
	const response = await churchDb(env).fetch('http://church-db/sql', { method: 'POST', body: JSON.stringify({ batch }) });
	if (!response.ok) throw new Error(await response.text());
	return (await response.json<{ results: { rows: any[] }[] }>()).results;
}

/** True while a note is queued or being processed; keeps the container awake. */
export async function notesBusy(env: AppEnv): Promise<boolean> {
	try {
		const [{ rows }] = await sql(env, { sql: "SELECT 1 AS x FROM notes WHERE status IN ('queued', 'processing') LIMIT 1" });
		return rows.length > 0;
	} catch {
		return false;
	}
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
export function tooLarge(request: Request): Response | null {
	const length = Number(request.headers.get('Content-Length') ?? 0);
	return length > MAX_JSON_BYTES ? detail('Request body too large', 413) : null;
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
			const { texts } = await request.json<{ texts: unknown }>();
			if (!Array.isArray(texts) || !texts.length || texts.length > 100 || !texts.every((t) => typeof t === 'string' && t))
				return new Response('texts must be 1-100 non-empty strings', { status: 400 });
			return json({ vectors: await embed(env, texts) });
		}
		if (request.method === 'POST' && path === '/llm') {
			// Transcript categorization: one window of numbered segments per call.
			const { prompt } = await request.json<{ prompt: unknown }>();
			if (typeof prompt !== 'string' || !prompt || prompt.length > MAX_LLM_PROMPT_CHARS)
				return new Response(`prompt must be 1-${MAX_LLM_PROMPT_CHARS} characters`, { status: 400 });
			const out: any = await env.AI.run(env.NOTES_LLM_MODEL as any, {
				messages: [{ role: 'user', content: prompt }],
				temperature: 0,
				max_tokens: 2048,
			} as any);
			return json({ text: typeof out.response === 'string' ? out.response : JSON.stringify(out.response ?? '') });
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

async function embed(env: AppEnv, texts: string[]): Promise<number[][]> {
	const out: any = await env.AI.run(EMBED_MODEL as any, { text: texts, pooling: POOLING } as any);
	return out.data;
}

// --- Routes the Worker handles itself ---

type ContainerStub = { fetch(request: Request): Promise<Response> };

const internal = (container: ContainerStub, method: string, path: string, body?: unknown) =>
	container.fetch(new Request('http://container' + path, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	}));

/** Handles upload, ask, admin config and delete. Returns null for routes the container serves. */
export async function handleNotes(request: Request, env: AppEnv, url: URL, container: ContainerStub): Promise<Response | null> {
	const path = url.pathname;
	if (request.method === 'POST' && path === '/api/notes/upload') return upload(request, env, url, container);
	if (request.method === 'PUT' && path === '/api/admin/config') {
		const denied = await authorizeAdmin(request, env);
		if (denied) return denied;
		let body;
		try {
			body = await readJson(request);
		} catch {
			return detail('Body must be JSON', 400);
		}
		return internal(container, 'PUT', '/api/internal/config', body);
	}
	const ask = path.match(/^\/api\/notes\/([0-9a-f-]{36})\/ask$/);
	if (request.method === 'POST' && ask) return answer(request, env, url, ask[1]);
	const note = path.match(/^\/api\/notes\/([0-9a-f-]{36})$/);
	if (request.method === 'DELETE' && note) {
		const response = await internal(container, 'DELETE', `/api/internal/notes/${note[1]}`);
		if (!response.ok) return response;
		const { r2_key } = await response.json<{ r2_key: string | null }>();
		if (r2_key) await env.MEDIA.delete(r2_key);
		return new Response(null, { status: 204 });
	}
	return null;
}

async function upload(request: Request, env: AppEnv, url: URL, container: ContainerStub): Promise<Response> {
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
	const response = await internal(container, 'POST', '/api/internal/notes', { title, r2_key: key, note_id: noteId });
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

function cosine(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function timestamp(seconds: number): string {
	const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
	const mmss = `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
	return h ? `${h}:${mmss}` : mmss;
}

async function answer(request: Request, env: AppEnv, url: URL, noteId: string): Promise<Response> {
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
		results = await sql(env,
			{ sql: 'SELECT status, source_kind, source_url FROM notes WHERE id = ?', params: [noteId] },
			{ sql: 'SELECT idx, start, "end", seg_from, seg_to, text, embedding FROM chunks WHERE note_id = ? ORDER BY idx', params: [noteId] },
			{ sql: "SELECT data FROM config WHERE key = 'church'" },
			{ sql: 'SELECT idx, start, "end", text FROM segments WHERE note_id = ? ORDER BY idx', params: [noteId] });
	} catch {
		return detail('Note not found', 404); // tables don't exist until the container has started once
	}
	const [[note], chunks, [config], segments] = results.map((r) => r.rows) as [any[], Chunk[], any[], Segment[]];
	if (!note) return detail('Note not found', 404);
	if (note.status !== 'ready') return detail(`Note is ${note.status}, not ready`, 409);
	const churchName = config ? JSON.parse(config.data).name : 'the church';

	const [questionVector] = await embed(env, [question]);
	const questionStems = contentStems(question);
	const minScore = Number(env.NOTES_MIN_SCORE);
	const ranked: Scored[] = chunks
		.map(({ embedding, ...chunk }) => ({ ...chunk, score: cosine(questionVector, JSON.parse(embedding)) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, TOP_K);
	// A passage supports the question only if it is semantically close AND shares a topic word with it.
	const supported = ranked.filter((c) => c.score >= minScore && [...contentStems(c.text)].some((s) => questionStems.has(s)));
	const debug = url.searchParams.get('debug') === '1'
		? { min_score: minScore, question_terms: [...questionStems], top: ranked.map((c) => ({ chunk: c.idx, score: Number(c.score.toFixed(4)), text: c.text.slice(0, 120) })) }
		: undefined;

	const cite = (c: Scored | Segment, quote = c.text, chunk = c.idx): Citation => ({
		chunk, start: c.start, end: c.end, timestamp: timestamp(c.start), quote,
		...(note.source_kind === 'youtube' && note.source_url ? { url: `${note.source_url}&t=${Math.floor(c.start)}s` } : {}),
	});
	const reply = (result: Answer, engine: string, extra: Record<string, unknown> = {}) => json({ ...result, engine, ...extra, ...(debug ? { debug } : {}) });

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
		[raw, label] = await askModel(env, engine, churchName, question, supported);
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

function pickEngine(env: AppEnv, requested: unknown): 'extractive' | 'gemini' | 'workers-ai' {
	if (requested === 'extractive') return 'extractive';
	if (env.GEMINI_API_KEY) return 'gemini';
	if (env.NOTES_ANSWER_ENGINE === 'workers-ai') return 'workers-ai';
	return 'extractive';
}

const SYSTEM_PROMPT = `You answer questions about one sermon or teaching from {church}, using ONLY the transcript passages provided.

Rules:
- Use only facts stated in the passages. Do not add Bible verses, background knowledge, or interpretation that the passages do not contain.
- Every claim needs a citation: the passage id and an exact quote copied word for word from that passage.
- If the passages do not answer the question, return found=false with an empty answer and no citations.
- Keep the answer to one to three plain sentences.

Return JSON only: {"found": boolean, "answer": string, "citations": [{"id": "C1", "quote": "exact words from C1"}]}`;

/** The first JSON object in a model reply (small models sometimes wrap it in prose or a code fence). */
function parseModelJson(reply: unknown): unknown {
	if (typeof reply !== 'string') return reply;
	const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
	return start >= 0 && end > start ? JSON.parse(reply.slice(start, end + 1)) : null;
}

async function askModel(env: AppEnv, engine: 'gemini' | 'workers-ai', church: string, question: string, passages: Scored[]): Promise<[unknown, string]> {
	const system = SYSTEM_PROMPT.replace('{church}', church);
	const user = passages.map((c, i) => `[C${i + 1}] (${timestamp(c.start)}) ${c.text}`).join('\n\n') + `\n\nQuestion: ${question}`;
	if (engine === 'gemini') {
		const model = env.GEMINI_MODEL;
		const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY! },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: system }] },
				contents: [{ role: 'user', parts: [{ text: user }] }],
				generationConfig: { temperature: 0, responseMimeType: 'application/json' },
			}),
		});
		if (!response.ok) throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const out = await response.json<any>();
		return [parseModelJson(out.candidates?.[0]?.content?.parts?.[0]?.text ?? ''), `gemini:${model}`];
	}
	const model = env.NOTES_LLM_MODEL;
	const out: any = await env.AI.run(model as any, {
		// No response_format: llama-3.1-8b-instruct-fp8 rejects JSON Schema mode (AiError 5025).
		messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
		temperature: 0,
		max_tokens: 600,
	} as any);
	return [parseModelJson(out.response), `workers-ai:${model}`];
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
