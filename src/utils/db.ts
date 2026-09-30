import type { PersistedEnvelope } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'current';

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function readEnvelope(): Promise<PersistedEnvelope | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve((request.result as PersistedEnvelope | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function writeEnvelope(envelope: PersistedEnvelope): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(envelope, SNAPSHOT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
