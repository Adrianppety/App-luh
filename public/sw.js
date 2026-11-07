const CACHE = 'app-v1'
const APP_SHELL = ['/', '/manifest.webmanifest', '/LOGOTIPO_2-icon.png', '/font/BricolageGrotesque-VariableFont_opsz,wdth,wght.ttf']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(APP_SHELL)
    const response = await fetch('/')
    const html = await response.text()
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => path.startsWith('/') && !path.startsWith('//'))
    await cache.addAll([...new Set(assets)])
  })())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith('atelie-app-') && key !== CACHE).map((key) => caches.delete(key))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
      .catch(async () => (await caches.match(event.request)) || caches.match('/')),
  )
})
