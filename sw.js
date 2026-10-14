// network-first so updates show up; cache is the offline fallback
const C = 'ankidote';
addEventListener('install', e => e.waitUntil(caches.open(C).then(c => c.addAll(['./', 'index.html', 'app.js', 'manifest.json', 'icon.png']))));
addEventListener('fetch', e => e.respondWith(
  fetch(e.request).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request))
));
