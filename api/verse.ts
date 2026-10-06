import { json, type AppEnv } from './notes';

// Berean Standard Bible, free to display with attribution.
const DEFAULT_BIBLE_ID = '3034';
const YV_API = 'https://api.youversion.com/v1';
// One chapter, or a verse, or a range inside one chapter, e.g. JHN.3, JHN.3.16, JHN.3.16-17.
const USFM = /^[1-3A-Z][A-Z0-9]{2}\.\d{1,3}(\.\d{1,3}(-\d{1,3})?)?$/;
const DAY = 86400;

type Version = { abbreviation: string; title: string; copyright: string };

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
	const cache = caches.default;
	const request = new Request('https://verse-cache.internal/' + key);
	const hit = await cache.match(request);
	if (hit) return hit.json<T>();
	const value = await load();
	await cache.put(request, Response.json(value, { headers: { 'Cache-Control': `max-age=${7 * DAY}` } }));
	return value;
}

async function youversion(path: string, key: string): Promise<any> {
	const response = await fetch(YV_API + path, { headers: { 'X-YVP-App-Key': key, Accept: 'application/json' } });
	if (!response.ok) throw new Error(`YouVersion ${response.status}`);
	return response.json();
}

/** GET /api/verse?usfm=JHN.3.16-17 returns the passage from YouVersion. 404 when no app key is set, so the page can fall back. */
export async function handleVerse(url: URL, env: AppEnv): Promise<Response> {
	const usfm = url.searchParams.get('usfm') ?? '';
	if (!USFM.test(usfm)) return json({ detail: 'Bad reference' }, 400);
	if (!env.YOUVERSION_APP_KEY) return json({ detail: 'YouVersion is not configured' }, 404);
	const key = env.YOUVERSION_APP_KEY;
	const bibleId = /^\d+$/.test(env.YOUVERSION_BIBLE_ID ?? '') ? env.YOUVERSION_BIBLE_ID! : DEFAULT_BIBLE_ID;
	try {
		const [version, passage] = await Promise.all([
			cached<Version>(`yv/${bibleId}/version`, async () => {
				const v = await youversion(`/bibles/${bibleId}`, key);
				return {
					abbreviation: v.abbreviation ?? v.local_abbreviation ?? '',
					title: v.localized_title ?? v.title ?? '',
					copyright: typeof v.copyright === 'string' ? v.copyright : v.copyright?.text ?? '',
				};
			}),
			cached<{ reference: string; text: string }>(`yv/${bibleId}/${usfm}`, async () => {
				const p = await youversion(`/bibles/${bibleId}/passages/${usfm}?format=text`, key);
				return { reference: p.reference ?? usfm, text: String(p.content ?? '').trim() };
			}),
		]);
		const link = `https://www.bible.com/bible/${bibleId}/${usfm}${version.abbreviation ? '.' + version.abbreviation : ''}`;
		return json({ ...passage, version, link, source: 'youversion' });
	} catch (err) {
		console.error('verse lookup failed:', String(err));
		return json({ detail: 'Verse lookup failed' }, 502);
	}
}
