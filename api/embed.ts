// Text embeddings for Sermon Notes search. Every vector comes from one Gloo embedding model
// (GLOO_EMBED_MODEL, default gloo-baai-bge-base-en-v1.5), through Gloo's OpenAI-shaped endpoint:
// https://docs.gloo.com/api-guides/embeddings
//
// Each stored chunk carries the tag of the model that embedded it (chunks.embed_model), and a question
// is only ever compared with chunks that carry the current tag. Vectors from different models (or the
// same model with different pooling) are not comparable, so chunks with another tag are re-embedded
// from their stored text, never re-transcribed.
//
// Nothing here imports Worker-only modules, so the tests run it under plain Node.

export type EmbedEnv = { GLOO_API_KEY?: string; GLOO_EMBED_MODEL?: string };
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export type Statement = { sql: string; params?: (string | number | null)[] };
/** Runs one batch of statements in one church's database (the ChurchDB /sql contract). */
export type RunSql = (...batch: Statement[]) => Promise<{ rows: any[] }[]>;
export type EmbedOptions = { fetcher?: Fetcher; timeoutMs?: number; retryDelayMs?: number };

export const GLOO_EMBED_URL = 'https://platform.ai.gloo.com/ai/v2/direct/embeddings';
export const DEFAULT_EMBED_MODEL = 'gloo-baai-bge-base-en-v1.5';
// What every chunk stored before this change was embedded with: Workers AI, cls pooling.
export const LEGACY_EMBED_TAG = 'workers-ai:@cf/baai/bge-base-en-v1.5:cls';
// A chunk saved while embeddings were unavailable: empty embedding, empty tag. It is embedded later.
export const UNEMBEDDED = '';
// Gloo accepts up to 2048 strings per call; smaller batches keep each call well inside the timeout,
// and the backfill saves its progress after every batch.
export const EMBED_BATCH = 64;
// bge-base-en-v1.5 takes at most 512 tokens per string (a longer one is a 400). Chunks are about 50 words;
// this only clips a pathological whisper segment.
const MAX_EMBED_CHARS = 1500;
const TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 750;
export const BACKFILL_DEFAULT = 256;
export const BACKFILL_MAX = 1024;

export const embedModel = (env: EmbedEnv) => (env.GLOO_EMBED_MODEL ?? '').trim() || DEFAULT_EMBED_MODEL;
/** The tag stored with a vector: which provider and model made it. */
export const embedTag = (env: EmbedEnv) => 'gloo:' + embedModel(env);

export class EmbedError extends Error {
	code: 'no_key' | 'http' | 'timeout' | 'bad_response';
	constructor(code: EmbedError['code'], message?: string) {
		super(message ?? code);
		this.code = code;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function embedBatch(env: EmbedEnv, model: string, input: string[], options: EmbedOptions): Promise<number[][]> {
	const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
	let lastError: EmbedError | null = null;
	// One retry, only for what Gloo calls retryable: a 503 or a dropped/timed-out connection.
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt) await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
		let response: Response;
		try {
			response = await fetcher(GLOO_EMBED_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GLOO_API_KEY}` },
				// No pooling option: Gloo documents none for this endpoint and forwards unknown fields to the provider.
				body: JSON.stringify({ model, input, encoding_format: 'float' }),
				signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
			});
		} catch (err) {
			lastError = new EmbedError(String((err as Error)?.name).includes('Timeout') ? 'timeout' : 'http', String(err));
			continue;
		}
		if (response.status === 503) {
			lastError = new EmbedError('http', `gloo embeddings 503: ${(await response.text()).slice(0, 200)}`);
			continue;
		}
		if (!response.ok) throw new EmbedError('http', `gloo embeddings ${response.status}: ${(await response.text()).slice(0, 300)}`);
		const out = await response.json<any>().catch(() => null);
		const data: any[] = Array.isArray(out?.data) ? out.data : [];
		if (data.length !== input.length) throw new EmbedError('bad_response', `expected ${input.length} vectors, got ${data.length}`);
		const vectors = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
		const size = vectors[0]?.length;
		if (!size || !vectors.every((v) => Array.isArray(v) && v.length === size && v.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))))
			throw new EmbedError('bad_response', 'vectors are missing, not numbers, or of different sizes');
		return vectors;
	}
	throw lastError ?? new EmbedError('http');
}

/** Embeds texts with Gloo, in batches, in order. Throws EmbedError; never falls back to another model. */
export async function embedTexts(env: EmbedEnv, texts: string[], options: EmbedOptions = {}): Promise<{ tag: string; vectors: number[][] }> {
	if (!env.GLOO_API_KEY) throw new EmbedError('no_key', 'GLOO_API_KEY is not set');
	const model = embedModel(env);
	const input = texts.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, MAX_EMBED_CHARS) || '.');
	const vectors: number[][] = [];
	for (let i = 0; i < input.length; i += EMBED_BATCH) vectors.push(...(await embedBatch(env, model, input.slice(i, i + EMBED_BATCH), options)));
	return { tag: 'gloo:' + model, vectors };
}

/** Five decimals is plenty for cosine ranking and keeps the stored JSON small. */
export const vectorJson = (v: number[]) => JSON.stringify(v.map((x) => Math.round(x * 1e5) / 1e5));

// --- Storage ---

/** Adds chunks.embed_model to a database made before it existed, tagging its rows as the legacy model.
 * Returns false when there is no chunks table yet (the container creates it on first start). */
export async function ensureEmbedColumn(run: RunSql): Promise<boolean> {
	const has = () => run({ sql: 'SELECT embed_model FROM chunks LIMIT 0' }).then(() => true, () => false);
	if (await has()) return true;
	try {
		await run({ sql: `ALTER TABLE chunks ADD COLUMN embed_model TEXT NOT NULL DEFAULT '${LEGACY_EMBED_TAG}'` });
		return true;
	} catch {
		return has(); // the container added it first, or there is no chunks table
	}
}

type ChunkText = { note_id: string; idx: number; text: string };

/** Embeds chunks from their stored text and saves each batch as soon as it is done. Returns how many were saved;
 * if a batch fails, the error carries `saved` so a caller can report partial progress. */
export async function embedChunks(run: RunSql, env: EmbedEnv, chunks: ChunkText[], options: EmbedOptions = {}): Promise<{ tag: string; saved: number; vectors: number[][] }> {
	let saved = 0;
	const all: number[][] = [];
	let tag = embedTag(env);
	for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
		const batch = chunks.slice(i, i + EMBED_BATCH);
		try {
			const out = await embedTexts(env, batch.map((c) => c.text), options);
			tag = out.tag;
			await run(...batch.map((c, j) => ({
				sql: 'UPDATE chunks SET embedding = ?, embed_model = ? WHERE note_id = ? AND idx = ?',
				params: [vectorJson(out.vectors[j]), out.tag, c.note_id, c.idx],
			})));
			all.push(...out.vectors);
			saved += batch.length;
		} catch (err) {
			throw Object.assign(err instanceof Error ? err : new Error(String(err)), { saved });
		}
	}
	return { tag, saved, vectors: all };
}

const STALE = "(embed_model != ? OR embedding = '')";

/** Re-embeds the next `limit` chunks of this church whose vectors are not from the current model (or missing).
 * Call it again until done: each call picks up where the last stopped, since finished chunks no longer match. */
export async function backfillChurch(run: RunSql, env: EmbedEnv, limit = BACKFILL_DEFAULT, options: EmbedOptions = {}) {
	const tag = embedTag(env);
	const take = Math.max(1, Math.min(BACKFILL_MAX, Math.floor(limit) || BACKFILL_DEFAULT));
	const count = async () => Number((await run({ sql: `SELECT COUNT(*) AS n FROM chunks WHERE ${STALE}`, params: [tag] }))[0].rows[0]?.n ?? 0);
	if (!(await ensureEmbedColumn(run))) return { model: tag, embedded: 0, remaining: 0, done: true };
	const [{ rows }] = await run({ sql: `SELECT note_id, idx, text FROM chunks WHERE ${STALE} ORDER BY note_id, idx LIMIT ?`, params: [tag, take] });
	let embedded = 0, error: string | undefined;
	try {
		embedded = (await embedChunks(run, env, rows, options)).saved;
	} catch (err: any) {
		embedded = err?.saved ?? 0;
		error = err instanceof EmbedError ? err.code : 'failed';
		console.error('embedding backfill failed:', String(err));
	}
	const remaining = await count();
	return { model: tag, embedded, remaining, done: remaining === 0, ...(error ? { error } : {}) };
}

// --- Retrieval ---

export function cosine(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb && a.length === b.length ? dot / Math.sqrt(na * nb) : 0;
}

/** Chunks a question vector may be compared with: those embedded by the current model. */
export const comparable = <T extends { embedding: string; embed_model: string }>(chunks: T[], tag: string) =>
	chunks.filter((c) => c.embed_model === tag && c.embedding);
