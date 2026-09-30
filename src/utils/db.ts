import type { MergeCheckpoint, PersistedEnvelope } from '../types';

const DB_NAME = 'sologsb-1019-coding';
const DB_VERSION = 2;
const STORE_NAME = 'snapshots';
const CHECKPOINT_STORE = 'merge-checkpoints';
const SNAPSHOT_KEY = 'current';
const PENDING_KEY = 'pending';

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) db.createObjectStore(CHECKPOINT_STORE);
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

/* ---------- 合并检查点（完整快照，存 IndexedDB 以免撑爆 localStorage） ---------- */

export const saveCheckpointRecord = async (checkpoint: MergeCheckpoint): Promise<void> => {
  if (!('indexedDB' in window)) {
    localStorage.setItem('sologsb-1019-checkpoint-fallback', JSON.stringify(checkpoint));
    return;
  }
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    tx.objectStore(CHECKPOINT_STORE).put(checkpoint, PENDING_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};

export const readCheckpointRecord = async (): Promise<MergeCheckpoint | null> => {
  if (!('indexedDB' in window)) {
    const raw = localStorage.getItem('sologsb-1019-checkpoint-fallback');
    return raw ? JSON.parse(raw) as MergeCheckpoint : null;
  }
  const db = await openDatabase();
  const checkpoint = await new Promise<MergeCheckpoint | null>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readonly');
    const request = tx.objectStore(CHECKPOINT_STORE).get(PENDING_KEY);
    request.onsuccess = () => resolve((request.result as MergeCheckpoint | undefined) ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
  return checkpoint;
};

export const deleteCheckpointRecord = async (): Promise<void> => {
  if (!('indexedDB' in window)) {
    localStorage.removeItem('sologsb-1019-checkpoint-fallback');
    return;
  }
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    tx.objectStore(CHECKPOINT_STORE).delete(PENDING_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
};
