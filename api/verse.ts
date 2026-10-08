import { json, type AppEnv } from './notes.ts';

// Berean Standard Bible, free to display with attribution.
export const DEFAULT_BIBLE_ID = '3034';
const YV_API = 'https://api.youversion.com/v1';
const PD_API = 'https://bible-api.com';
// One chapter, or a verse, or a range inside one chapter, e.g. JHN.3, JHN.3.16, JHN.3.16-17.
const USFM = /^[1-3A-Z][A-Z0-9]{2}\.\d{1,3}(\.\d{1,3}(-\d{1,3})?)?$/;
const HOUR = 3600;
const DAY = 24 * HOUR;
// The version list changes rarely; passages never do.
const LIST_TTL = 6 * HOUR;
const PASSAGE_TTL = 7 * DAY;
const MAX_LIST_PAGES = 5;

type Version = { abbreviation: string; title: string; copyright: string };
export type VersionInfo = Version & { id: string; language: string; source: 'youversion' | 'public-domain' };

// Public-domain translations bible-api.com serves, with their bible.com ids for the "Read on YouVersion" link.
export const PUBLIC_DOMAIN: Record<string, VersionInfo & { bibleCom: string }> = {
	web: { id: 'web', abbreviation: 'WEB', title: 'World English Bible', copyright: 'Public domain', language: 'en', source: 'public-domain', bibleCom: '206' },
	kjv: { id: 'kjv', abbreviation: 'KJV', title: 'King James Version', copyright: 'Public domain', language: 'en', source: 'public-domain', bibleCom: '1' },
};
// A YouVersion version whose text is also public domain falls back to the same translation, not WEB.
const PD_BY_ABBREVIATION: Record<string, string> = { WEB: 'web', WEBUS: 'web', KJV: 'kjv' };

// Offered when the listing call fails: the default version is always allowed.
const BUILT_IN: VersionInfo = { id: DEFAULT_BIBLE_ID, abbreviation: 'BSB', title: 'Berean Standard Bible', copyright: '', language: 'en', source: 'youversion' };

async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
	const cache = caches.default;
	const request = new Request('https://verse-cache.internal/' + key);
	const hit = await cache.match(request);
	if (hit) return hit.json<T>();
	const value = await load();
	await cache.put(request, Response.json(value, { headers: { 'Cache-Control': `max-age=${ttl}` } }));
	return value;
}

async function youversion(path: string, key: string): Promise<any> {
	const response = await fetch(YV_API + path, { headers: { 'X-YVP-App-Key': key, Accept: 'application/json' } });
	if (!response.ok) throw new Error(`YouVersion ${response.status}`);
	return response.json();
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const copyrightOf = (v: any) => (typeof v?.copyright === 'string' ? v.copyright : text(v?.copyright?.text));
const configuredId = (env: AppEnv) => (/^\d+$/.test(env.YOUVERSION_BIBLE_ID ?? '') ? env.YOUVERSION_BIBLE_ID! : DEFAULT_BIBLE_ID);
const builtIn = (id: string): VersionInfo => (id === BUILT_IN.id ? BUILT_IN : { ...BUILT_IN, id, abbreviation: '', title: '' });

/** The English Bibles this app key is licensed for. YouVersion lists only those unless all_available is set. */
async function listYouVersion(key: string): Promise<VersionInfo[]> {
	const out: VersionInfo[] = [];
	let token = '';
	for (let page = 0; page < MAX_LIST_PAGES; page++) {
		const query = 'language_ranges[]=en&page_size=99' + (token ? '&page_token=' + encodeURIComponent(token) : '');
		const body = await youversion('/bibles?' + query, key);
		for (const v of Array.isArray(body?.data) ? body.data : []) {
			const id = String(v?.id ?? '');
			if (!/^\d+$/.test(id)) continue;
			out.push({
				id,
				abbreviation: text(v.abbreviation) || text(v.local_abbreviation),
				title: text(v.localized_title) || text(v.title),
				copyright: copyrightOf(v),
				language: text(v.language_tag) || 'en',
				source: 'youversion',
			});
		}
		token = text(body?.next_page_token);
		if (!token) break;
	}
	if (!out.length) throw new Error('YouVersion listed no Bibles');
	return out;
}

/** The YouVersion versions to offer and accept; just the default when listing fails (a failure is not cached). */
async function youversionVersions(env: AppEnv): Promise<{ versions: VersionInfo[]; listed: boolean }> {
	if (!env.YOUVERSION_APP_KEY) return { versions: [], listed: false };
	const id = configuredId(env);
	try {
		const versions = await cached('yv/versions/en', LIST_TTL, () => listYouVersion(env.YOUVERSION_APP_KEY!));
		// The configured default is always offered, even if the listing left it out.
		return { versions: versions.some(v => v.id === id) ? versions : [builtIn(id), ...versions], listed: true };
	} catch (err) {
		console.error('version listing failed:', String(err));
		return { versions: [builtIn(id)], listed: false };
	}
}

/** GET /api/verse/versions: the key's YouVersion Bibles, then public-domain ones not already listed. */
export async function handleVersions(env: AppEnv): Promise<Response> {
	const { versions, listed } = await youversionVersions(env);
	const have = new Set(versions.map(v => v.abbreviation.toUpperCase()));
	const pd = Object.values(PUBLIC_DOMAIN).filter(v => !have.has(v.abbreviation)).map(({ bibleCom, ...v }) => v);
	const defaultId = env.YOUVERSION_APP_KEY ? configuredId(env) : 'web';
	return Response.json({ default: defaultId, versions: [...versions, ...pd], listed }, {
		headers: { 'Cache-Control': `public, max-age=${listed ? LIST_TTL : 300}` },
	});
}

/** "JHN.3.16-17" as bible-api.com reads it: "JHN 3:16-17". */
const pdReference = (usfm: string) => {
	const [book, chapter, verses] = usfm.split('.');
	return `${book} ${chapter}` + (verses ? ':' + verses : '');
};

async function publicDomain(id: string, usfm: string) {
	const { bibleCom, source, language, ...version } = PUBLIC_DOMAIN[id];
	const passage = await cached(`pd/${id}/${usfm}`, PASSAGE_TTL, async () => {
		const response = await fetch(`${PD_API}/${encodeURIComponent(pdReference(usfm))}?translation=${id}`, { headers: { Accept: 'application/json' } });
		if (!response.ok) throw new Error(`bible-api ${response.status}`);
		const body: any = await response.json();
		const passageText = text(body?.text).replace(/\s+/g, ' ').trim();
		if (!passageText) throw new Error('bible-api returned no text');
		return { reference: text(body?.reference) || usfm, text: passageText };
	});
	return { ...passage, version, link: `https://www.bible.com/bible/${bibleCom}/${usfm}.${version.abbreviation}`, source: 'public-domain' as const };
}

async function fromYouVersion(bibleId: string, usfm: string, key: string) {
	const [version, passage] = await Promise.all([
		cached<Version>(`yv/${bibleId}/version`, PASSAGE_TTL, async () => {
			const v = await youversion(`/bibles/${bibleId}`, key);
			return { abbreviation: text(v.abbreviation) || text(v.local_abbreviation), title: text(v.localized_title) || text(v.title), copyright: copyrightOf(v) };
		}),
		cached<{ reference: string; text: string }>(`yv/${bibleId}/${usfm}`, PASSAGE_TTL, async () => {
			const p = await youversion(`/bibles/${bibleId}/passages/${usfm}?format=text`, key);
			return { reference: p.reference ?? usfm, text: String(p.content ?? '').trim() };
		}),
	]);
	const link = `https://www.bible.com/bible/${bibleId}/${usfm}${version.abbreviation ? '.' + version.abbreviation : ''}`;
	return { ...passage, version: { id: bibleId, ...version }, link, source: 'youversion' as const };
}

/**
 * GET /api/verse?usfm=JHN.3.16-17&version=<id> returns the passage. `version` is a YouVersion id the key may use or a
 * public-domain id (web, kjv); anything else gets the default. When YouVersion fails, the passage comes from bible-api.com
 * in the matching public-domain translation, else WEB, with `fallback: true` and `version` naming what was returned.
 * 404 when no app key is set and a YouVersion version is asked for, so the page can fall back.
 */
export async function handleVerse(url: URL, env: AppEnv): Promise<Response> {
	const usfm = url.searchParams.get('usfm') ?? '';
	if (!USFM.test(usfm)) return json({ detail: 'Bad reference' }, 400);
	const asked = (url.searchParams.get('version') ?? '').trim().toLowerCase();
	const pd = Object.hasOwn(PUBLIC_DOMAIN, asked) ? asked : null;
	const key = env.YOUVERSION_APP_KEY;
	if (!pd && !key) return json({ detail: 'YouVersion is not configured' }, 404);

	// Only an id the key's own listing returned is passed to YouVersion; anything else is the default.
	let chosen = builtIn(configuredId(env));
	if (!pd && asked && asked !== chosen.id && /^\d{1,6}$/.test(asked)) {
		const match = (await youversionVersions(env)).versions.find(v => v.id === asked);
		if (match) chosen = match;
	}
	const requested = pd ?? chosen.id;
	try {
		const passage = pd ? await publicDomain(pd, usfm) : await fromYouVersion(chosen.id, usfm, key!);
		return json({ ...passage, requested, fallback: false });
	} catch (err) {
		console.error('verse lookup failed:', String(err));
	}
	const fallbackId = pd ? 'web' : PD_BY_ABBREVIATION[chosen.abbreviation.toUpperCase()] ?? 'web';
	if (pd !== fallbackId) {
		try {
			return json({ ...(await publicDomain(fallbackId, usfm)), requested, fallback: true });
		} catch (err) {
			console.error('public-domain verse lookup failed:', String(err));
		}
	}
	return json({ detail: 'Verse lookup failed' }, 502);
}
