
const CACHE_NAME = 'metronome-v4';

const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './manifest.json'
];

// インストール時に新しい Service Worker を即時適用
self.addEventListener('install', (event) => {
    // 待機せずに即時適用
    self.skipWaiting();

    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(urlsToCache);
        })
    );
});

// アクティベート時に古いキャッシュを削除
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cache) => {
                        if (cache !== CACHE_NAME) {
                            console.log('古いキャッシュを削除:', cache);
                            return caches.delete(cache);
                        }
                    })
                );
            })
            // 全タブに即座に制御を適用
            .then(() => self.clients.claim())
    );
});

// キャッシュがあればキャッシュを使用し、なければネットワークから取得
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
