// MST Hub service worker - network-first for everything except fonts/images
const CACHE_NAME = 'mst-hub-v3'

self.addEventListener('install', (event) => {
  // Activate this worker immediately, replacing any old one
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Clear ALL old caches
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    await clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // API calls: always go to network, no cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request))
    return
  }

  // Network-first for HTML/JS/CSS - so new deploys reach users immediately
  // Fall back to cache only if offline
  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request)
      // Cache the fresh response for offline fallback
      const cache = await caches.open(CACHE_NAME)
      cache.put(event.request, fresh.clone())
      return fresh
    } catch (err) {
      // Offline fallback
      const cached = await caches.match(event.request)
      if (cached) return cached
      throw err
    }
  })())
})
