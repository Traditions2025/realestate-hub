// MST Hub service worker — instant-load caching for slow mobile networks
const CACHE_NAME = 'mst-hub-v5'
const PRECACHE_URLS = ['/', '/index.html', '/manifest.json', '/logo.png', '/logo-dark.png']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    // Precache critical assets so the very next visit paints instantly
    try { await cache.addAll(PRECACHE_URLS) } catch {}
    self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    await clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)

  // API calls: always go to network, never cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request))
    return
  }

  // Hashed assets (Vite output: /assets/index-AbC123.js): cache-first, never expire
  // (filename changes on every deploy, so old cache is automatically obsolete)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request)
      if (cached) return cached
      const fresh = await fetch(event.request)
      const cache = await caches.open(CACHE_NAME)
      cache.put(event.request, fresh.clone())
      return fresh
    })())
    return
  }

  // Fonts and images: cache-first
  if (url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('fonts.googleapis.com') ||
      url.pathname.match(/\.(jpg|jpeg|png|gif|svg|webp|ico|woff2?|ttf)$/)) {
    event.respondWith((async () => {
      const cached = await caches.match(event.request)
      if (cached) return cached
      try {
        const fresh = await fetch(event.request)
        const cache = await caches.open(CACHE_NAME)
        cache.put(event.request, fresh.clone())
        return fresh
      } catch (e) {
        return cached || new Response('', { status: 504 })
      }
    })())
    return
  }

  // HTML and everything else: stale-while-revalidate
  // Serve cached version IMMEDIATELY (instant paint), then update cache in the background.
  // Next visit gets the freshly fetched version. Massive speed boost on slow mobile.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(event.request)
    const fetchPromise = fetch(event.request).then(fresh => {
      if (fresh && fresh.status === 200) cache.put(event.request, fresh.clone())
      return fresh
    }).catch(() => null)
    return cached || (await fetchPromise) || new Response('Offline', { status: 503 })
  })())
})
