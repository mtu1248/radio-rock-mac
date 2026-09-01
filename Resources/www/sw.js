/* Obsluga trybu offline: trzymamy kopie plikow aplikacji, zeby dzialala
   po dodaniu do ekranu glownego takze przy slabym zasiegu.
   Same strumienie radiowe wymagaja oczywiscie internetu. */

const WERSJA = 'radio-rock-6';
const PLIKI = [
  './', './index.html', './style.css', './app.js', './stacje.js',
  './manifest.webmanifest', './ikona-180.png', './ikona-192.png', './ikona-512.png'
];

self.addEventListener('install', zdarzenie => {
  zdarzenie.waitUntil(
    caches.open(WERSJA).then(magazyn => magazyn.addAll(PLIKI)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', zdarzenie => {
  zdarzenie.waitUntil(
    caches.keys()
      .then(klucze => Promise.all(klucze.filter(k => k !== WERSJA).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', zdarzenie => {
  const adres = new URL(zdarzenie.request.url);
  // zapytania do bazy stacji i strumienie zawsze prosto z sieci
  if (adres.origin !== location.origin) return;
  if (zdarzenie.request.method !== 'GET') return;

  zdarzenie.respondWith(
    fetch(zdarzenie.request)
      .then(odp => {
        const kopia = odp.clone();
        caches.open(WERSJA).then(magazyn => magazyn.put(zdarzenie.request, kopia)).catch(() => {});
        return odp;
      })
      .catch(() => caches.match(zdarzenie.request).then(z => z || caches.match('./index.html')))
  );
});
