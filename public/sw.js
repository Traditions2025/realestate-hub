// MST Hub service worker - smart caching for fast loads
const CACHE_NAME = 'mst-hub-v4'

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    await clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
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

  // HTML and everything else: network-first with cache fallback
  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request)
      const cache = await caches.open(CACHE_NAME)
      cache.put(event.request, fresh.clone())
      return fresh
    } catch (err) {
      const cached = await caches.match(event.request)
      if (cached) return cached
      throw err
    }
  })())
})
