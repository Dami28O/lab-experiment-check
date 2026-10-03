/* Static offline shell. Videos are local assets; partial Range responses stay on the local server.
 * Full video bytes are cached during install. Browser-generated range requests are served explicitly.
 */
const CACHE = 'lens-offline-v3';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/'); const html = await response.clone().text();
    await cache.put('/', response);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(m => m[1]);
    await cache.addAll(['/favicon.svg', ...assets, ...['DJI_10', 'DJI_16', 'DJI_08', 'DJI_17', 'DJI_23'].flatMap(id => [`/demo/${id}.mp4`, `/demo/${id}-0.jpg`])]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => { event.waitUntil((async () => { for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key); await self.clients.claim(); })()); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const full = await cache.match(url.pathname);
    // Refresh the shell online so a new deployment can load its new hashed assets.
    if (event.request.mode === 'navigate') {
      try { const response = await fetch(event.request); if (response.ok) await cache.put('/', response.clone()); return response; }
      catch { return full || await cache.match('/') || Response.error(); }
    }
    const range = event.request.headers.get('range');
    if (full && range && url.pathname.endsWith('.mp4')) {
      const buffer = await full.arrayBuffer(); const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) { const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), buffer.byteLength - 1) : buffer.byteLength - 1;
        if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buffer.byteLength}` } });
        return new Response(buffer.slice(start, end + 1), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${buffer.byteLength}`, 'Content-Length': String(end - start + 1) } });
      }
    }
    if (full) return full;
    try { const response = await fetch(event.request); if (response.ok && response.status === 200) await cache.put(event.request, response.clone()); return response; }
    catch { if (event.request.mode === 'navigate') return await cache.match('/') || Response.error(); return Response.error(); }
  })());
});
