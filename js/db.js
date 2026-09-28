// IndexedDB：持久化参数设置（开关、数值、缩放档位）。
const DB_NAME = 'postfx-demo';
const STORE = 'settings';
const KEY = 'current';

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function loadSettings() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('IndexedDB 读取失败，使用默认设置:', err);
    return null;
  }
}

export async function persistSettings(settings) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(settings, KEY);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('IndexedDB 写入失败:', err);
  }
}
