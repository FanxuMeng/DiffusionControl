/** Preserve the exact original workspace before replacing browser storage.
 * Resolves only after IndexedDB confirms the write transaction committed.
 */
export function saveRecoveryBackup(key: string, raw: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined;
    let settled = false;
    const fail = (error: unknown) => {
      database?.close();
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('恢复备份写入失败。'));
    };
    try {
      if (typeof indexedDB === 'undefined') throw new Error('当前浏览器无法使用 IndexedDB 恢复备份。');
      const request = indexedDB.open('diffusioncontrol-recovery', 1);
      request.onblocked = () => fail(new Error('恢复备份数据库被其他页面占用，请关闭旧页面后重试。'));
      request.onerror = () => fail(request.error ?? new Error('无法打开恢复备份数据库。'));
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        try {
          if (!request.result.objectStoreNames.contains('workspaces')) {
            request.result.createObjectStore('workspaces', { keyPath: 'key' });
          }
        } catch (error) {
          request.transaction?.abort();
          fail(error);
        }
      };
      request.onsuccess = () => {
        database = request.result;
        if (settled) { database.close(); return; }
        let transaction: IDBTransaction | undefined;
        try {
          transaction = database.transaction('workspaces', 'readwrite');
          transaction.onerror = () => fail(transaction?.error ?? new Error('恢复备份事务写入失败。'));
          transaction.onabort = () => fail(transaction?.error ?? new Error('恢复备份事务已中止。'));
          transaction.oncomplete = () => {
            database?.close();
            if (settled) return;
            settled = true;
            resolve();
          };
          transaction.objectStore('workspaces').put({ key, raw, createdAt: new Date().toISOString() });
        } catch (error) {
          transaction?.abort();
          fail(error);
        }
      };
    } catch (error) { fail(error); }
  });
}
