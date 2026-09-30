// Branch previews of the Cloudflare app. Only main deploys as the live site;
// every other branch gets its own Worker, which serves the built frontend and
// forwards API calls to the live APIs from its own origin. The live APIs only
// accept the live site's origin, so the forwarded call carries that origin.
// Set by the workflow: LIVE_API, LIVE_GIVING_API, LIVE_ORIGIN.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let target = null;
    if (url.pathname.startsWith('/api/')) target = env.LIVE_API + url.pathname + url.search;
    else if (url.pathname.startsWith('/giving-api/')) target = env.LIVE_GIVING_API + url.pathname.slice('/giving-api'.length) + url.search;
    if (!target) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    headers.set('Origin', env.LIVE_ORIGIN);
    headers.delete('Host');
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
    // Same-origin for the browser now, so the upstream CORS headers are not needed.
    const out = new Response(upstream.body, upstream);
    for (const h of [...out.headers.keys()]) if (h.startsWith('access-control-')) out.headers.delete(h);
    return out;
  },
};
