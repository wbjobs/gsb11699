'use strict';

const DB_NAME = 'postfx-db';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
      if (!db.objectStoreNames.contains('timings')) {
        db.createObjectStore('timings', { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.min(15, Math.ceil(sigma * 3)));
  const weights = [1];
  let sum = 1;
  for (let i = 1; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights.push(w);
    sum += 2 * w;
  }
  return new Float32Array(weights.map((w) => w / sum));
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'kernel') {
      const weights = gaussianKernel(message.sigma);
      self.postMessage({ type: 'kernel', weights });
      return;
    }

    if (message.type === 'saveSettings') {
      const store = await tx('settings', 'readwrite');
      await promisifyRequest(store.put(message.settings, 'current'));
      self.postMessage({ type: 'settingsSaved' });
      return;
    }

    if (message.type === 'loadSettings') {
      const store = await tx('settings', 'readonly');
      const data = await promisifyRequest(store.get('current'));
      self.postMessage({ type: 'settings', data: data || null });
      return;
    }

    if (message.type === 'logTiming') {
      const store = await tx('timings', 'readwrite');
      await promisifyRequest(store.add(message.sample));
      return;
    }

    if (message.type === 'clearTimings') {
      const store = await tx('timings', 'readwrite');
      await promisifyRequest(store.clear());
      self.postMessage({ type: 'timingsCleared' });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

self.postMessage({ type: 'ready' });
