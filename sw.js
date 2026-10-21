// network-first so updates show up; cache is the offline fallback
const C = 'ankidote';
addEventListener('install', e => { skipWaiting(); e.waitUntil(caches.open(C).then(c => c.addAll(['./', 'index.html', 'app.js', 'theme.js', 'pdf.min.js', 'pdf.worker.min.js', 'manifest.json', 'icon.png', 'icon-192.png', 'icon-512.png', 'favicon-32.png', 'favicon-64.png'])));});
addEventListener('activate', e => e.waitUntil(clients.claim()));
addEventListener('fetch', e => e.respondWith(
  fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(C).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request))
));
