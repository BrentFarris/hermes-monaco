import type { Draft } from './types';

export interface DraftStore { load(key: string): Promise<Draft[]>; save(key: string, drafts: Draft[]): Promise<void> }

export class IndexedDraftStore implements DraftStore {
  private queue: Promise<unknown> = Promise.resolve();
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('hermes-monaco-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Draft storage is unavailable.'));
    });
  }
  async load(key: string): Promise<Draft[]> {
    await this.queue.catch(() => {});
    const db = await this.database();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('workspaces').objectStore('workspaces').get(key);
        request.onsuccess = () => resolve(request.result?.version === 1 ? request.result.drafts : []);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }
  save(key: string, drafts: Draft[]): Promise<void> {
    const snapshot = structuredClone(drafts);
    const operation = this.queue.catch(() => {}).then(async () => {
      const db = await this.database();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('workspaces', 'readwrite');
          const store = transaction.objectStore('workspaces');
          if (snapshot.length) store.put({ version: 1, drafts: snapshot }, key);
          else store.delete(key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error || new Error('Draft write was aborted.'));
        });
      } finally { db.close(); }
    });
    this.queue = operation;
    return operation;
  }
}

