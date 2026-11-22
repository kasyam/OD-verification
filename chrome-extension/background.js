/**
 * PRICE 3.0 Helper — MV3 Background Service Worker
 *
 * Hosts extension-origin IndexedDB persistence via db.js and processes
 * allowlisted P3H_DB_RPC requests from authorized PRICE 3.0 content scripts.
 */
'use strict';

importScripts('db.js', 'extractor.js');

(function () {
  const P3H = self.__P3H__ || {};
  const db = P3H.db;
  const extractor = P3H.extractor;
  const ALLOWED_ORIGIN = 'https://price3.kerala.gov.in';
  const ALLOWED_PATH_PREFIX = '/price3_pwd/';

  function isAuthorizedSender(sender) {
    if (!sender || !chrome.runtime || sender.id !== chrome.runtime.id) return false;
    const rawUrl = sender.url || (sender.tab && sender.tab.url) || '';
    if (!rawUrl) return false;
    try {
      const parsed = new URL(rawUrl);
      return parsed.origin === ALLOWED_ORIGIN && parsed.pathname.startsWith(ALLOWED_PATH_PREFIX);
    } catch (e) {
      return false;
    }
  }

  function toPlainSafeMap(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    Object.keys(obj).forEach((k) => {
      if (db && typeof db.isSafeKey === 'function' ? db.isSafeKey(k) : k !== '__proto__') {
        out[k] = obj[k];
      }
    });
    return out;
  }

  const RPC_HANDLERS = Object.assign(Object.create(null), {
    init: async () => {
      await db.init();
      return true;
    },
    getSetting: (args) => db.getSetting(args[0], args[1]),
    setSetting: (args) => db.setSetting(args[0], args[1]),
    getCounts: () => db.getCounts(),
    getWork: (args) => db.getWork(args[0]),
    getWorksByFileIds: async (args) => {
      const res = await db.getWorksByFileIds(args[0]);
      return {
        worksByFileId: toPlainSafeMap(res && res.worksByFileId),
        archivedIds: Array.from((res && res.archivedIds) || []),
      };
    },
    getWorksByScope: (args) => db.getWorksByScope(args[0], args[1]),
    putWork: (args) => db.putWork(args[0], args[1], extractor.analyzeWorkRecord),
    updateWorkUserData: (args) => {
      if (!args[1] || typeof args[1] !== 'object' || Array.isArray(args[1])) {
        throw new Error('Invalid updateWorkUserData patch payload');
      }
      const opts =
        args[2] && typeof args[2] === 'object'
          ? {
              reevaluateStore: Boolean(args[2].reevaluateStore),
              analyzeFn: extractor.analyzeWorkRecord,
            }
          : { analyzeFn: extractor.analyzeWorkRecord };
      return db.updateWorkUserData(args[0], args[1], opts);
    },
    patchWorkUserTracking: (args) => {
      const opts =
        args[3] && typeof args[3] === 'object'
          ? {
              reevaluateStore: Boolean(args[3].reevaluateStore),
              analyzeFn: extractor.analyzeWorkRecord,
            }
          : { analyzeFn: extractor.analyzeWorkRecord };
      return db.patchWorkUserTracking(args[0], args[1], args[2], opts);
    },
    setWorkManualArchive: (args) =>
      db.setWorkManualArchive(args[0], args[1], extractor.analyzeWorkRecord),
    setActivityManualArchive: (args) =>
      db.setActivityManualArchive(args[0], args[1], args[2], extractor.analyzeWorkRecord),
    addProgressHistoryEntry: (args) => db.addProgressHistoryEntry(args[0], args[1], args[2]),
    deleteProgressHistoryEntry: (args) =>
      db.deleteProgressHistoryEntry(args[0], args[1], args[2]),
    reconcileArchiveStoresIfNeeded: () =>
      db.reconcileArchiveStoresIfNeeded(extractor.analyzeWorkRecord),
    putWorksBatch: async (args) => {
      const opts =
        args[1] && typeof args[1] === 'object' && args[1].returnRecords
          ? { returnRecords: true }
          : undefined;
      const res = await db.putWorksBatch(args[0], extractor.analyzeWorkRecord, opts);
      if (opts && opts.returnRecords) {
        return {
          inserted: res ? res.inserted : 0,
          activePlaced: res ? res.activePlaced : 0,
          archivedPlaced: res ? res.archivedPlaced : 0,
          recordsByFileId: toPlainSafeMap(res && res.recordsByFileId),
        };
      }
      return res;
    },
    clearWorks: (args) => db.clearWorks(args[0]),
    exportDatabasePayload: (args) => db.exportDatabasePayload(args[0]),
    importDatabasePayload: (args) =>
      db.importDatabasePayload(args[0], extractor.analyzeWorkRecord),
  });

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'P3H_DB_RPC') return false;
      if (!isAuthorizedSender(sender)) {
        sendResponse({ ok: false, error: 'Unauthorized RPC sender' });
        return false;
      }
      const method = typeof msg.method === 'string' ? msg.method : '';
      if (!method || !Object.hasOwn(RPC_HANDLERS, method)) {
        sendResponse({ ok: false, error: `Unsupported DB RPC method: ${method}` });
        return false;
      }
      const args = Array.isArray(msg.args) ? msg.args : [];
      Promise.resolve()
        .then(() => RPC_HANDLERS[method](args))
        .then((result) => {
          sendResponse({ ok: true, result });
        })
        .catch((err) => {
          sendResponse({
            ok: false,
            error: err && err.message ? err.message : String(err),
          });
        });
      return true;
    });
  }
})();
