import type { PersistedEnvelope } from '../types';
import type { MergeCheckpoint } from '../merge/types';

const DB_NAME = 'sologsb-1019-coding';
const STORE_NAME = 'snapshots';
const CHECKPOINT_STORE = 'merge-checkpoints';
const SNAPSHOT_KEY = 'current';
const CHECKPOINT_KEY = 'latest';

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
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

/** 读取最近一次合并检查点（重开页面时据此提示“继续应用 / 撤回整包”） */
export async function readCheckpoint(): Promise<MergeCheckpoint | null> {
  if (!('indexedDB' in window)) return null;
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, 'readonly');
      const request = tx.objectStore(CHECKPOINT_STORE).get(CHECKPOINT_KEY);
      request.onsuccess = () => resolve((request.result as MergeCheckpoint | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** 原子写入合并检查点：先落盘“合并前快照+计划”，确认持久化后才开始改写内存状态 */
export async function writeCheckpoint(checkpoint: MergeCheckpoint): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
      tx.objectStore(CHECKPOINT_STORE).put(checkpoint, CHECKPOINT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function clearCheckpoint(): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
      tx.objectStore(CHECKPOINT_STORE).delete(CHECKPOINT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
