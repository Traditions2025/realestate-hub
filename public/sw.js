// MST Hub service worker — instant-load caching for slow mobile networks
const CACHE_NAME = 'mst-hub-v7'
const PRECACHE_URLS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']

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

  // HTML / navigation (the app shell): NETWORK-FIRST so a new deploy loads on
  // the very next visit. index.html is tiny; fetching it fresh costs almost
  // nothing but guarantees the newest /assets/*.js hashes are referenced. Falls
  // back to cache only when offline. (Was stale-while-revalidate, which needed
  // TWO refreshes to pick up a deploy — the first served the stale shell.)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    try {
      const fresh = await fetch(event.request)
      if (fresh && fresh.status === 200) cache.put(event.request, fresh.clone())
      return fresh
    } catch (e) {
      const cached = await cache.match(event.request)
      return cached || (await cache.match('/index.html')) || new Response('Offline', { status: 503 })
    }
  })())
})

// ---- P2-3: web push ----
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { title: 'Matt Smith Team Hub', body: event.data ? event.data.text() : '' } }
  const title = d.title || 'Matt Smith Team Hub'
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.type || 'hub',
    data: { link: d.link || '/' },
    icon: '/logo.png',
    badge: '/logo.png',
  }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || '/'
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) { if ('focus' in c) { c.navigate(link); return c.focus() } }
    if (clients.openWindow) return clients.openWindow(link)
  })())
})
