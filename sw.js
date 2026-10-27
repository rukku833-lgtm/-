
'use strict';

const CACHE_NAME = 'metronome-v5';

const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json'
];

// 新しいService Workerをインストール
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
            .then(() => self.skipWaiting())
    );
});

// 古いキャッシュを削除して新バージョンを有効化
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(cacheNames => Promise.all(
                cacheNames
                    .filter(name => name.startsWith('metronome-'))
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

// キャッシュを優先し、なければネットワークから取得
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(event.request)
            .then(cachedResponse => {
                if (cachedResponse) return cachedResponse;

                return fetch(event.request).then(response => {
                    if (
                        response.ok &&
                        response.type === 'basic'
                    ) {
                        const copy = response.clone();

                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(event.request, copy);
                        });
                    }

                    return response;
                });
            })
    );
});
