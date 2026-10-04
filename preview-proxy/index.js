// Branch previews of the Cloudflare app. Only main deploys as the live site;
// every other branch gets its own Worker, which serves the built frontend and
// forwards API calls to the live APIs from its own origin. The live APIs only
// accept the live site's origin, so the forwarded call carries that origin.
// Cloudflare does not let a Worker fetch another workers.dev Worker on the
// same account by URL, so the calls go through service bindings (CHURCH_API,
// GIVING_API). Set by the workflow: those bindings, LIVE_API,
// LIVE_GIVING_API and LIVE_ORIGIN.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let target = null, service = null;
    if (url.pathname.startsWith('/api/')) {
      target = env.LIVE_API + url.pathname + url.search; service = env.CHURCH_API;
    } else if (url.pathname.startsWith('/giving-api/')) {
      target = env.LIVE_GIVING_API + url.pathname.slice('/giving-api'.length) + url.search; service = env.GIVING_API;
    }
    if (!target) return env.ASSETS.fetch(request);
    const headers = new Headers(request.headers);
    headers.set('Origin', env.LIVE_ORIGIN);
    // Lets the giving API send a donor back to this preview after Stripe Checkout.
    headers.set('X-Return-Origin', url.origin);
    headers.delete('Host');
    const upstream = await service.fetch(target, {
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
