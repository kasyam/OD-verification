/**
 * PRICE 3.0 Helper — Local IndexedDB Persistence Layer
 *
 * Splits works into two stores for 10,000+ project scalability:
 *   - active_works: ongoing, pre-tender, part-bill, M-Book closed without final, partial-final, or manually archived active works
 *   - archived_works: fully finalized works whose non-archived active bills are terminally submitted
 *     to EMILI / Non-EMLI and whose v2.1+ projectDetails are complete
 *   - settings: user preferences (visible columns, view mode, sort order, migration flags)
 */
(function (globalScope) {
  'use strict';

  const EXTENSION_VERSION = '2.4.0';
  const EXTRACTOR_VERSION = 3;

  const DB_NAME = 'p3h_price_db';
  const DB_VERSION = 4;
  const ARCHIVE_RECONCILE_VERSION = 2;
  const STORE_ACTIVE = 'active_works';
  const STORE_ARCHIVED = 'archived_works';
  const STORE_SETTINGS = 'settings';
  const MAX_PROGRESS_HISTORY = 200;
  const MAX_TEXT_LEN = 500;
  const BATCH_CHUNK_SIZE = 250;

  const RE_TERMINAL_BILL_STATUS =
    /submitted\s+to\s+em[il]+i|submitted\s+for\s+payment\s*\(\s*non[\s\-]*em[il]+i\s*\)/i;
  const RE_NON_TERMINAL_STATUS = /\b(pending|draft|passed)\b/i;
  const RE_DRAFT_STATUS = /\bdraft\b/i;

  const IS_SERVICE_WORKER = typeof importScripts === 'function';
  const IS_CONTENT_SCRIPT_RPC =
    !IS_SERVICE_WORKER &&
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime && typeof chrome.runtime.sendMessage === 'function');

  let dbPromise = null;

  function callBgDb(method, args) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'P3H_DB_RPC', method, args: args || [] }, (resp) => {
          const lastErr = chrome.runtime && chrome.runtime.lastError;
          if (lastErr) {
            reject(new Error(lastErr.message || `DB RPC ${method} failed`));
            return;
          }
          if (!resp || resp.ok !== true) {
            reject(new Error((resp && resp.error) || `DB RPC ${method} failed`));
            return;
          }
          resolve(resp.result);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function isSafeKey(k) {
    const s = String(k === null || k === undefined ? '' : k).trim();
    return Boolean(s && s !== '__proto__' && s !== 'constructor' && s !== 'prototype');
  }

  function toEpochMs(val) {
    const s = String(val || '').trim();
    if (!s) return 0;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : 0;
  }

  function normalizeIsoTimestamp(val) {
    const ms = toEpochMs(val);
    return ms > 0 ? new Date(ms).toISOString() : '';
  }

  function clampText(val, maxLen) {
    const s = String(val === null || val === undefined ? '' : val).trim();
    const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : MAX_TEXT_LEN;
    return s.length > limit ? s.slice(0, limit) : s;
  }

  function parseSafeNumber(val) {
    if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;
    const cleaned = String(val === null || val === undefined ? '' : val).replace(/,/g, '');
    const m = cleaned.match(/[+-]?\d+(?:\.\d+)?/);
    if (!m) return NaN;
    const num = Number(m[0]);
    return Number.isFinite(num) ? num : NaN;
  }

  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function csvEscape(val) {
    const raw = String(val === null || val === undefined ? '' : val);
    const safe =
      typeof val !== 'number' && /^[\t\r ]*[=+\-@]/.test(raw) ? "'" + raw : raw;
    if (/[",\r\n]/.test(safe)) {
      return '"' + safe.replace(/"/g, '""') + '"';
    }
    return safe;
  }

  function extractEstimateCode(label) {
    const matches = Array.from(String(label || '').matchAll(/\[\s*([A-Za-z0-9_/\-]+)\s*\]/g));
    return matches.length > 0 ? matches[matches.length - 1][1].trim() : '';
  }

  function getActivityKey(comp) {
    if (!comp || typeof comp !== 'object') return '';
    return String(
      comp.activityKey ||
        comp.estimateCode ||
        extractEstimateCode(comp.componentLabel) ||
        comp.estmainid ||
        comp.mbookActivityId ||
        comp.componentLabel ||
        ''
    ).trim();
  }

  function parseDateParts(str) {
    const raw = String(str || '').trim();
    if (!raw) return null;
    // ISO YYYY-MM-DD (e.g. from <input type="date"> or ISO timestamps)
    let m = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s|T|$)/);
    let year, month, day;
    if (m) {
      year = parseInt(m[1], 10);
      month = parseInt(m[2], 10);
      day = parseInt(m[3], 10);
    } else {
      m = raw.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})(?:\s|$)/);
      if (!m) return null;
      day = parseInt(m[1], 10);
      month = parseInt(m[2], 10);
      year = parseInt(m[3], 10);
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const utcMs = Date.UTC(year, month - 1, day);
    const dt = new Date(utcMs);
    if (
      dt.getUTCFullYear() !== year ||
      dt.getUTCMonth() !== month - 1 ||
      dt.getUTCDate() !== day
    ) {
      return null;
    }
    return { day, month, year, utcMs };
  }

  function normalizeDateToDmy(str) {
    const parts = parseDateParts(str);
    if (!parts) return '';
    return (
      String(parts.day).padStart(2, '0') +
      '-' +
      String(parts.month).padStart(2, '0') +
      '-' +
      String(parts.year).padStart(4, '0')
    );
  }

  function dmyToIso(dmyStr) {
    const norm = normalizeDateToDmy(dmyStr);
    if (!norm) return '';
    const parts = norm.split('-');
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  function formatOrdinal(n) {
    const num = parseInt(n, 10);
    if (!Number.isFinite(num) || num <= 0) return String(n || '');
    const mod100 = num % 100;
    if (mod100 >= 11 && mod100 <= 13) return num + 'th';
    const mod10 = num % 10;
    if (mod10 === 1) return num + 'st';
    if (mod10 === 2) return num + 'nd';
    if (mod10 === 3) return num + 'rd';
    return num + 'th';
  }

  function normalizeExtensionEntry(entry, idx) {
    const src = entry && typeof entry === 'object' ? entry : {};
    const parsedOrder = parseInt(src.order, 10);
    const order = Number.isFinite(parsedOrder) && parsedOrder > 0 ? parsedOrder : idx + 1;
    const extendedDate = normalizeDateToDmy(src.extendedDate || src.date || '');
    const rawFine = parseSafeNumber(src.fineAmount);
    const fineAmount =
      Number.isFinite(rawFine) && rawFine > 0 ? Math.round(rawFine * 100) / 100 : 0;
    const orderNo = clampText(src.orderNo, MAX_TEXT_LEN);
    const remarks = clampText(src.remarks, MAX_TEXT_LEN);
    return {
      order,
      extendedDate,
      fineAmount,
      orderNo,
      remarks,
    };
  }

  function normalizeExtensionList(list) {
    if (!Array.isArray(list)) return [];
    const normalized = list
      .map((item, idx) => normalizeExtensionEntry(item, idx))
      .filter((item) => item.extendedDate || item.fineAmount > 0 || item.orderNo || item.remarks);
    normalized.sort((a, b) => a.order - b.order);
    return normalized;
  }

  function normalizeProgressValue(val) {
    if (val === null || val === undefined || String(val).trim() === '') return null;
    const num = parseSafeNumber(val);
    if (!Number.isFinite(num)) return null;
    const clamped = Math.max(0, Math.min(100, num));
    return Math.round(clamped * 100) / 100;
  }

  function normalizeManualArchive(raw) {
    if (!raw || typeof raw !== 'object' || raw.archived !== true) return null;
    const validDt = normalizeIsoTimestamp(raw.archivedAt);
    return {
      archived: true,
      reason: clampText(raw.reason, MAX_TEXT_LEN),
      archivedAt: validDt || new Date().toISOString(),
    };
  }

  function normalizeProgressEntry(entry, idx) {
    const src = entry && typeof entry === 'object' ? entry : {};
    const timestamp = normalizeIsoTimestamp(src.timestamp);
    if (!timestamp) return null;
    const workStatus = clampText(src.workStatus, MAX_TEXT_LEN);
    const physicalProgress = normalizeProgressValue(src.physicalProgress);
    const remarks = clampText(src.remarks, MAX_TEXT_LEN);
    if (!workStatus && physicalProgress === null && !remarks) return null;
    const id = clampText(src.id, 120) || `p_${Date.parse(timestamp)}_${idx}`;
    return {
      id,
      timestamp,
      workStatus,
      physicalProgress,
      remarks,
    };
  }

  function normalizeProgressHistory(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seenIds = new Set();
    const seenKeys = new Set();
    list.forEach((item, idx) => {
      const norm = normalizeProgressEntry(item, idx);
      if (!norm) return;
      const semKey = `${norm.timestamp}|${norm.workStatus}|${
        norm.physicalProgress === null ? '' : norm.physicalProgress
      }|${norm.remarks}`;
      if (seenIds.has(norm.id) || seenKeys.has(semKey)) return;
      seenIds.add(norm.id);
      seenKeys.add(semKey);
      out.push(norm);
    });
    out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    return out.length > MAX_PROGRESS_HISTORY ? out.slice(-MAX_PROGRESS_HISTORY) : out;
  }

  function mergeProgressHistories(listA, listB) {
    return normalizeProgressHistory([
      ...(Array.isArray(listA) ? listA : []),
      ...(Array.isArray(listB) ? listB : []),
    ]);
  }

  function appendProgressHistoryEntry(history, { workStatus, physicalProgress, remarks, timestamp }) {
    const normHist = normalizeProgressHistory(history);
    const cleanStatus = clampText(workStatus, MAX_TEXT_LEN);
    const cleanProg = normalizeProgressValue(physicalProgress);
    const cleanRemarks = clampText(remarks, MAX_TEXT_LEN);
    if (!cleanStatus && cleanProg === null && !cleanRemarks) return normHist;

    const rawTs = timestamp ? String(timestamp).trim() : '';
    const ts = normalizeIsoTimestamp(rawTs) || new Date().toISOString();

    const last = normHist.length ? normHist[normHist.length - 1] : null;
    if (last && !cleanRemarks) {
      const sameStatus = last.workStatus === cleanStatus;
      const sameProg = last.physicalProgress === cleanProg;
      if (sameStatus && sameProg) {
        return normHist;
      }
      if (!last.remarks && !rawTs) {
        const diffMs = Math.abs(Date.parse(ts) - Date.parse(last.timestamp));
        const onlyFilledEmptyStatus = !last.workStatus && cleanStatus && sameProg;
        const onlyFilledEmptyProg = last.physicalProgress === null && cleanProg !== null && sameStatus;
        if (diffMs <= 60000 && (onlyFilledEmptyStatus || onlyFilledEmptyProg)) {
          const updated = {
            ...last,
            workStatus: cleanStatus,
            physicalProgress: cleanProg,
            timestamp: ts,
          };
          return normalizeProgressHistory([...normHist.slice(0, -1), updated]);
        }
      }
    }

    const entry = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: ts,
      workStatus: cleanStatus,
      physicalProgress: cleanProg,
      remarks: cleanRemarks,
    };
    return normalizeProgressHistory([...normHist, entry]);
  }

  function formatProgressTimestamp(isoStr) {
    if (!isoStr || Number.isNaN(Date.parse(isoStr))) return '';
    const dt = new Date(isoStr);
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    const hh = String(dt.getHours()).padStart(2, '0');
    const mi = String(dt.getMinutes()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${mi}`;
  }

  function formatProgressTimelineSummaryFromList(norm) {
    if (!Array.isArray(norm) || norm.length === 0) return '';
    return norm
      .map((e) => {
        const tsTxt = formatProgressTimestamp(e.timestamp);
        const body = [
          e.workStatus,
          e.physicalProgress !== null ? `${e.physicalProgress}%` : '',
          e.remarks ? `[${e.remarks}]` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return `${tsTxt}: ${body}`;
      })
      .join(' → ');
  }

  function formatProgressTimelineSummary(history) {
    return formatProgressTimelineSummaryFromList(normalizeProgressHistory(history));
  }

  function normalizeUserData(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const extensions = normalizeExtensionList(src.extensions);
    const workStatus = clampText(src.workStatus, MAX_TEXT_LEN);
    const physicalProgress = normalizeProgressValue(src.physicalProgress);
    const progressHistory = normalizeProgressHistory(src.progressHistory);
    const manualArchive = normalizeManualArchive(src.manualArchive);
    const activityOverrides = Object.create(null);

    if (
      src.activityOverrides &&
      typeof src.activityOverrides === 'object' &&
      !Array.isArray(src.activityOverrides)
    ) {
      Object.keys(src.activityOverrides).forEach((key) => {
        if (!isSafeKey(key)) return;
        const cleanKey = String(key).trim();
        if (!isSafeKey(cleanKey)) return;
        const ovSrc = src.activityOverrides[key];
        if (!ovSrc || typeof ovSrc !== 'object' || Array.isArray(ovSrc)) return;
        const ovExts = normalizeExtensionList(ovSrc.extensions);
        const ovStatus = clampText(ovSrc.workStatus, MAX_TEXT_LEN);
        const ovProgress = normalizeProgressValue(ovSrc.physicalProgress);
        const ovHistory = normalizeProgressHistory(ovSrc.progressHistory);
        const ovArchive = normalizeManualArchive(ovSrc.manualArchive);
        if (
          ovExts.length > 0 ||
          ovStatus ||
          ovProgress !== null ||
          ovHistory.length > 0 ||
          ovArchive
        ) {
          activityOverrides[cleanKey] = {
            extensions: ovExts,
            workStatus: ovStatus,
            physicalProgress: ovProgress,
            progressHistory: ovHistory,
            ...(ovArchive ? { manualArchive: ovArchive } : {}),
          };
        }
      });
    }

    return {
      extensions,
      workStatus,
      physicalProgress,
      progressHistory,
      ...(manualArchive ? { manualArchive } : {}),
      activityOverrides,
      updatedAt: normalizeIsoTimestamp(src.updatedAt),
    };
  }

  function resolveUserDataScope(workRecord, activityKey, activityCount) {
    if (Number.isFinite(Number(activityCount)) && Number(activityCount) <= 1) {
      return '';
    }
    const cleanKey = String(activityKey || '').trim();
    if (!cleanKey || !isSafeKey(cleanKey)) return '';
    if (workRecord && Array.isArray(workRecord.components) && activityCount === undefined) {
      const nonSuppressed = workRecord.components.filter(
        (c) => c && !c.isHelper && !c.isDeactivated && !c.isDeactivatedDpr
      );
      if (nonSuppressed.length <= 1) return '';
    }
    return cleanKey;
  }

  function hasAnyUserData(ud) {
    if (!ud || typeof ud !== 'object') return false;
    return (
      (Array.isArray(ud.extensions) && ud.extensions.length > 0) ||
      Boolean(ud.workStatus) ||
      (ud.physicalProgress !== null && ud.physicalProgress !== undefined) ||
      (Array.isArray(ud.progressHistory) && ud.progressHistory.length > 0) ||
      Boolean(ud.manualArchive && ud.manualArchive.archived) ||
      (ud.activityOverrides && Object.keys(ud.activityOverrides).length > 0)
    );
  }

  function getLatestExtensionFromList(extensions, activityOverrides, activityKey) {
    const ov =
      activityKey && isSafeKey(activityKey) && activityOverrides
        ? activityOverrides[activityKey]
        : null;
    const exts = ov && ov.extensions.length > 0 ? ov.extensions : extensions || [];
    const valid = exts.filter((e) => Boolean(dmyToIso(e.extendedDate)));
    if (valid.length === 0) return null;

    let best = valid[0];
    let bestIso = dmyToIso(best.extendedDate);
    for (let i = 1; i < valid.length; i++) {
      const cur = valid[i];
      const curIso = dmyToIso(cur.extendedDate);
      if (cur.order > best.order || (cur.order === best.order && curIso > bestIso)) {
        best = cur;
        bestIso = curIso;
      }
    }
    return {
      order: best.order,
      extendedDate: best.extendedDate,
      fineAmount: best.fineAmount,
      orderNo: best.orderNo,
      remarks: best.remarks,
      count: valid.length,
    };
  }

  function getLatestExtension(userData, activityKey) {
    const ud = normalizeUserData(userData);
    return getLatestExtensionFromList(ud.extensions, ud.activityOverrides, activityKey);
  }

  function getTotalExtensionFineFromList(extensions, activityOverrides, activityKey) {
    const ov =
      activityKey && isSafeKey(activityKey) && activityOverrides
        ? activityOverrides[activityKey]
        : null;
    const exts = ov && ov.extensions.length > 0 ? ov.extensions : extensions || [];
    const sum = exts.reduce((acc, e) => acc + (Number(e.fineAmount) || 0), 0);
    return Math.round(sum * 100) / 100;
  }

  function getTotalExtensionFine(userData, activityKey) {
    const ud = normalizeUserData(userData);
    return getTotalExtensionFineFromList(ud.extensions, ud.activityOverrides, activityKey);
  }

  function formatExtensionsSummaryFromList(exts) {
    if (!Array.isArray(exts) || exts.length === 0) return '';
    return exts
      .map((e) => {
        const ord = formatOrdinal(e.order);
        const dt = e.extendedDate || 'No date';
        const fineTxt =
          e.fineAmount > 0
            ? ` (Fine ₹${e.fineAmount.toLocaleString('en-IN', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })})`
            : '';
        const ordNoTxt = e.orderNo ? ` [${e.orderNo}]` : '';
        return `${ord}: ${dt}${fineTxt}${ordNoTxt}`;
      })
      .join('; ');
  }

  function formatExtensionsSummary(extensions) {
    return formatExtensionsSummaryFromList(normalizeExtensionList(extensions));
  }

  function getEffectiveUserFields(workRecord, activityKey) {
    const ud = normalizeUserData(workRecord && workRecord.userData);
    const cleanActKey = isSafeKey(activityKey) ? String(activityKey).trim() : '';
    let ov = cleanActKey && ud.activityOverrides ? ud.activityOverrides[cleanActKey] : null;
    if (!cleanActKey && !ov && ud.activityOverrides) {
      const ovKeys = Object.keys(ud.activityOverrides);
      const nonSuppressed = Array.isArray(workRecord && workRecord.components)
        ? workRecord.components.filter(
            (c) => c && !c.isHelper && !c.isDeactivated && !c.isDeactivatedDpr
          )
        : [];
      if (ovKeys.length === 1 && nonSuppressed.length <= 1) {
        ov = ud.activityOverrides[ovKeys[0]];
      }
    }

    const useExtOv = Boolean(ov && ov.extensions.length > 0);
    const extensions = useExtOv ? ov.extensions : ud.extensions;
    const latestExtension = getLatestExtensionFromList(extensions, null, '');
    const extendedCompletionDate = latestExtension ? latestExtension.extendedDate : '';
    const extensionOrder = latestExtension ? latestExtension.order : 0;
    const totalFine = getTotalExtensionFineFromList(extensions, null, '');
    const extensionsSummary = formatExtensionsSummaryFromList(extensions);
    const useStatusOv = Boolean(ov && ov.workStatus);
    const workStatus = useStatusOv ? ov.workStatus : ud.workStatus;
    const useProgOv = Boolean(ov && ov.physicalProgress !== null && ov.physicalProgress !== undefined);
    const physicalProgress = useProgOv ? ov.physicalProgress : ud.physicalProgress;
    const useHistOv = Boolean(
      ov && ((ov.progressHistory && ov.progressHistory.length > 0) || useStatusOv || useProgOv)
    );
    const progressHistory = useHistOv ? ov.progressHistory || [] : ud.progressHistory || [];
    const lastProgressUpdatedAt = progressHistory.length
      ? progressHistory[progressHistory.length - 1].timestamp
      : '';
    const progressHistorySummary = formatProgressTimelineSummaryFromList(progressHistory);
    const isWorkManuallyArchived = Boolean(ud.manualArchive && ud.manualArchive.archived);
    const isActivityManuallyArchived = Boolean(ov && ov.manualArchive && ov.manualArchive.archived);
    const manualArchive = isActivityManuallyArchived
      ? ov.manualArchive
      : isWorkManuallyArchived
      ? ud.manualArchive
      : null;

    return {
      extensions,
      latestExtension,
      extendedCompletionDate,
      extensionOrder,
      totalFine,
      extensionsSummary,
      workStatus,
      physicalProgress,
      progressHistory,
      lastProgressUpdatedAt,
      progressHistorySummary,
      isWorkManuallyArchived,
      isActivityManuallyArchived,
      manualArchive,
      hasOverride: Boolean(
        useExtOv || useStatusOv || useProgOv || useHistOv || isActivityManuallyArchived
      ),
    };
  }

  function isTerminalBillStatus(status) {
    const s = String(status || '').trim();
    if (!s) return false;
    return RE_TERMINAL_BILL_STATUS.test(s) && !RE_NON_TERMINAL_STATUS.test(s);
  }

  /**
   * Determines whether a work is finalized and immutable:
   * - Scanned, not manually archived at work level, and not 100% manually archived
   * - All non-helper, non-deactivated, non-manually-archived trackable activities are finalized
   * - No non-archived activity has M-Book closed without final bill
   * - All non-cancelled, non-draft, non-merged bills on non-archived components are terminally submitted
   * - v3+ projectDetails extracted and core fields complete
   */
  function isWorkArchivable(workRecord, summary) {
    if (!workRecord || !summary || !summary.scanned) return false;

    const ud = normalizeUserData(workRecord.userData);
    if (ud.manualArchive && ud.manualArchive.archived) return false;
    if (summary.isFullyManuallyArchived) return false;

    const isFullyFinal =
      typeof summary.isFullyFinalized === 'boolean'
        ? summary.isFullyFinalized
        : Boolean(
            summary.hasFinal &&
              summary.ebillCompCount > 0 &&
              summary.finalizedEBillCompCount >= summary.ebillCompCount
          );
    if (!isFullyFinal) return false;
    if (summary.hasMbookClosedNoFinal) return false;
    if (summary.hasAnyBillsFetchFailed) return false;

    const pd = workRecord.projectDetails;
    if (!pd || !pd.fetchedAt) return false;
    if (!pd.extractorVersion || pd.extractorVersion < EXTRACTOR_VERSION) return false;

    const ext = globalScope.__P3H__ && globalScope.__P3H__.extractor;
    if (ext && typeof ext.getMissingFields === 'function') {
      const mf = ext.getMissingFields(workRecord, summary);
      if (mf && mf.isIncomplete) return false;
    } else {
      const ctrName = pd.contractor && pd.contractor.name ? String(pd.contractor.name).trim() : '';
      if (
        !pd.constituency ||
        !pd.periodText ||
        !pd.asNo ||
        !pd.tsNo ||
        !ctrName ||
        !pd.shoDate ||
        (pd.hasLoa && !pd.agreementNo && !pd.isUrgentPreAgreement)
      ) {
        return false;
      }
    }

    const activeBillableBills = [];
    let anyFetchFailed = false;
    (summary.components || []).forEach((comp) => {
      if (!comp || comp.isHelper || comp.isDeactivated || comp.isDeactivatedDpr) return;
      const compKey = getActivityKey(comp);
      const compOv =
        compKey && isSafeKey(compKey) && ud.activityOverrides
          ? ud.activityOverrides[compKey]
          : null;
      if (comp.isManuallyArchived || (compOv && compOv.manualArchive && compOv.manualArchive.archived)) {
        return;
      }
      if (comp._billsFetchFailed) {
        anyFetchFailed = true;
      }
      (comp.bills || []).forEach((b) => {
        const isDraft = Boolean(b.isDraft) || RE_DRAFT_STATUS.test(b.status || '');
        if (!b.isCancelled && !isDraft && !b.isMergedIntoCompositeFinal) {
          activeBillableBills.push(b);
        }
      });
    });

    if (anyFetchFailed || activeBillableBills.length === 0) return false;
    return activeBillableBills.every((b) => isTerminalBillStatus(b.status));
  }

  function isNonEmptyValue(val) {
    return val !== undefined && val !== null && String(val).trim() !== '';
  }

  function mergeContractorNonDestructive(existingCtr, incomingCtr) {
    const ex = existingCtr && typeof existingCtr === 'object' ? existingCtr : {};
    const inc = incomingCtr && typeof incomingCtr === 'object' ? incomingCtr : {};
    const out = { ...ex };
    ['name', 'pan', 'mobile', 'email', 'applicantType', 'licenseSource'].forEach((k) => {
      if (isNonEmptyValue(inc[k])) {
        out[k] = inc[k];
      } else if (!(k in out)) {
        out[k] = '';
      }
    });
    return out;
  }

  function mergeProjectDetailsNonDestructive(existingPd, incomingPd) {
    if (!incomingPd) return existingPd || null;
    if (!existingPd || incomingPd._forceOverwrite) {
      const clean = { ...incomingPd };
      delete clean._forceOverwrite;
      return clean;
    }
    const out = { ...existingPd };
    const skipKeys = new Set([
      'contractor',
      'periodYears',
      'periodMonths',
      'periodDays',
      'periodText',
      '_forceOverwrite',
      'fetchedAt',
      'extractorVersion',
    ]);
    Object.keys(incomingPd).forEach((k) => {
      if (!isSafeKey(k) || skipKeys.has(k)) return;
      if (isNonEmptyValue(incomingPd[k])) {
        out[k] = incomingPd[k];
      }
    });

    // Preserve period tuple together so transient empty responses don't zero it out
    if (isNonEmptyValue(incomingPd.periodText) || !isNonEmptyValue(existingPd.periodText)) {
      out.periodYears = incomingPd.periodYears || 0;
      out.periodMonths = incomingPd.periodMonths || 0;
      out.periodDays = incomingPd.periodDays || 0;
      out.periodText = incomingPd.periodText || '';
    }

    out.contractor = mergeContractorNonDestructive(existingPd.contractor, incomingPd.contractor);
    const exFetchMs = toEpochMs(existingPd.fetchedAt);
    const incFetchMs = toEpochMs(incomingPd.fetchedAt);
    if (incFetchMs >= exFetchMs && incomingPd.fetchedAt) {
      out.fetchedAt = incomingPd.fetchedAt;
    } else if (existingPd.fetchedAt) {
      out.fetchedAt = existingPd.fetchedAt;
    } else if (incomingPd.fetchedAt) {
      out.fetchedAt = incomingPd.fetchedAt;
    }
    const exVer = Number(existingPd.extractorVersion) || 0;
    const incVer = Number(incomingPd.extractorVersion) || 0;
    const bestVer = Math.max(exVer, incVer);
    if (bestVer > 0) out.extractorVersion = bestVer;
    return out;
  }

  function mergeComponentsNonDestructive(existingComps, incomingComps) {
    if (!Array.isArray(incomingComps) || incomingComps.length === 0) {
      return Array.isArray(existingComps) ? existingComps : [];
    }
    if (!Array.isArray(existingComps) || existingComps.length === 0) {
      return incomingComps;
    }
    const byKey = new Map();
    existingComps.forEach((c) => {
      const key = getActivityKey(c);
      if (key) byKey.set(key, c);
    });
    return incomingComps.map((inc) => {
      const key = getActivityKey(inc);
      const ex = key ? byKey.get(key) : null;
      if (!ex) return inc;
      const merged = { ...inc };
      if (!merged.mbookStatus && ex.mbookStatus) merged.mbookStatus = ex.mbookStatus;
      if (!merged.wcaStage && ex.wcaStage) merged.wcaStage = ex.wcaStage;
      if (inc._billsFetchFailed) {
        if (Array.isArray(ex.bills) && ex.bills.length > 0) {
          merged.bills = ex.bills;
          delete merged._billsFetchFailed;
        } else {
          merged._billsFetchFailed = true;
        }
      }
      if (ex.details || inc.details) {
        merged.details = mergeProjectDetailsNonDestructive(ex.details, inc.details);
      }
      return merged;
    });
  }

  function pickNewerTimestamp(tsA, tsB, fallback) {
    const msA = toEpochMs(tsA);
    const msB = toEpochMs(tsB);
    if (msA >= msB && msA > 0) return normalizeIsoTimestamp(tsA);
    if (msB > 0) return normalizeIsoTimestamp(tsB);
    return tsA || tsB || normalizeIsoTimestamp(fallback) || fallback || '';
  }

  function mergeWorkRecords(existingRec, incomingRec, fallbackTimestamp) {
    if (!existingRec) return incomingRec;
    const mergedDetails = mergeProjectDetailsNonDestructive(
      existingRec.projectDetails,
      incomingRec.projectDetails
    );
    const mergedComponents = mergeComponentsNonDestructive(
      existingRec.components,
      incomingRec.components
    );

    const exUd = normalizeUserData(existingRec.userData);
    const incUd = normalizeUserData(incomingRec.userData);
    let finalUserData = null;
    if (hasAnyUserData(incUd) && !hasAnyUserData(exUd)) {
      finalUserData = incUd;
    } else if (hasAnyUserData(exUd) && !hasAnyUserData(incUd)) {
      finalUserData = exUd;
    } else if (hasAnyUserData(incUd) && hasAnyUserData(exUd)) {
      const incUdMs = toEpochMs(incUd.updatedAt);
      const exUdMs = toEpochMs(exUd.updatedAt);
      const incWins = incUdMs > 0 && (exUdMs === 0 || incUdMs >= exUdMs);
      const primary = incWins ? incUd : exUd;
      const secondary = incWins ? exUd : incUd;
      const primaryHasTs = toEpochMs(primary.updatedAt) > 0;

      const mergedOverrides = Object.create(null);
      const allOvKeys = new Set([
        ...Object.keys(primary.activityOverrides || {}),
        ...Object.keys(secondary.activityOverrides || {}),
      ]);
      allOvKeys.forEach((k) => {
        if (!isSafeKey(k)) return;
        const pOv = (primary.activityOverrides && primary.activityOverrides[k]) || null;
        const sOv = (secondary.activityOverrides && secondary.activityOverrides[k]) || null;
        if (pOv && !sOv) {
          mergedOverrides[k] = pOv;
        } else if (sOv && !pOv) {
          mergedOverrides[k] = sOv;
        } else if (pOv && sOv) {
          const ovHist = mergeProgressHistories(sOv.progressHistory, pOv.progressHistory);
          const ovArch = primaryHasTs
            ? pOv.manualArchive || null
            : pOv.manualArchive || sOv.manualArchive || null;
          mergedOverrides[k] = {
            extensions: pOv.extensions && pOv.extensions.length ? pOv.extensions : sOv.extensions || [],
            workStatus: pOv.workStatus || sOv.workStatus || '',
            physicalProgress:
              pOv.physicalProgress !== null && pOv.physicalProgress !== undefined
                ? pOv.physicalProgress
                : sOv.physicalProgress,
            progressHistory: ovHist,
            ...(ovArch ? { manualArchive: ovArch } : {}),
          };
        }
      });

      const mergedArchive = primaryHasTs
        ? primary.manualArchive || null
        : primary.manualArchive || secondary.manualArchive || null;
      finalUserData = {
        ...primary,
        progressHistory: mergeProgressHistories(secondary.progressHistory, primary.progressHistory),
        ...(mergedArchive ? { manualArchive: mergedArchive } : {}),
        activityOverrides: mergedOverrides,
      };
    }

    const scannedAt =
      pickNewerTimestamp(incomingRec.scannedAt, existingRec.scannedAt, fallbackTimestamp) ||
      new Date().toISOString();

    const out = {
      ...existingRec,
      ...incomingRec,
      fileId: String(incomingRec.fileId),
      fileNumber: incomingRec.fileNumber || existingRec.fileNumber || '',
      subject: incomingRec.subject || existingRec.subject || '',
      createdBy: incomingRec.createdBy || existingRec.createdBy || '',
      createdOn: incomingRec.createdOn || existingRec.createdOn || '',
      scannedAt,
      components: mergedComponents,
    };
    if (mergedDetails) {
      out.projectDetails = mergedDetails;
    }
    if (finalUserData) {
      out.userData = finalUserData;
    } else {
      delete out.userData;
    }
    out.updatedAt =
      pickNewerTimestamp(
        pickNewerTimestamp(incomingRec.updatedAt, existingRec.updatedAt, ''),
        finalUserData && finalUserData.updatedAt ? finalUserData.updatedAt : scannedAt,
        scannedAt
      ) || scannedAt;
    return out;
  }

  function prepareRecordForStore(workRecord, summary, isArchived) {
    if (!workRecord || !workRecord.fileId) {
      throw new Error('prepareRecordForStore requires a valid fileId');
    }
    const pd = (workRecord && workRecord.projectDetails) || null;
    const nowIso = new Date().toISOString();
    const ud = normalizeUserData(workRecord && workRecord.userData);
    const latestExt = getLatestExtensionFromList(ud.extensions, ud.activityOverrides, '');
    const hasWorkManual = Boolean(ud.manualArchive && ud.manualArchive.archived);
    const hasAnyOvManual = Object.values(ud.activityOverrides || {}).some(
      (ov) => ov && ov.manualArchive && ov.manualArchive.archived
    );
    const isManuallyArchived = Boolean(
      hasWorkManual || (summary && summary.isFullyManuallyArchived)
    );
    const hasManualArchive = Boolean(
      isManuallyArchived || hasAnyOvManual || (summary && summary.hasAnyManualArchive)
    );

    const bestUpdatedAt =
      pickNewerTimestamp(
        pickNewerTimestamp(workRecord.updatedAt, workRecord.scannedAt, ''),
        ud.updatedAt,
        nowIso
      ) || nowIso;

    const out = {
      ...workRecord,
      fileId: String(workRecord.fileId),
      constituency: pd && pd.constituency ? String(pd.constituency) : '',
      categoryKey:
        summary && summary.categoryKey
          ? String(summary.categoryKey)
          : workRecord.categoryKey || 'unscanned',
      agreementDateIso: pd && pd.agreementDate ? dmyToIso(pd.agreementDate) : '',
      completionDateIso: pd && pd.completionDate ? dmyToIso(pd.completionDate) : '',
      extendedCompletionDateIso: latestExt ? dmyToIso(latestExt.extendedDate) : '',
      isArchived: Boolean(isArchived),
      isManuallyArchived,
      hasManualArchive,
      isManuallyArchivedIdx: isManuallyArchived ? 1 : 0,
      hasManualArchiveIdx: hasManualArchive ? 1 : 0,
      updatedAt: bestUpdatedAt,
    };
    if (hasAnyUserData(ud)) {
      out.userData = ud;
    } else {
      delete out.userData;
    }
    return out;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        dbPromise = null;
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        const tx = event.target.transaction;
        [STORE_ACTIVE, STORE_ARCHIVED].forEach((storeName) => {
          let store;
          if (!db.objectStoreNames.contains(storeName)) {
            store = db.createObjectStore(storeName, { keyPath: 'fileId' });
            store.createIndex('constituency', 'constituency', { unique: false });
            store.createIndex('categoryKey', 'categoryKey', { unique: false });
            store.createIndex('agreementDateIso', 'agreementDateIso', { unique: false });
            store.createIndex('completionDateIso', 'completionDateIso', { unique: false });
            store.createIndex('extendedCompletionDateIso', 'extendedCompletionDateIso', {
              unique: false,
            });
            store.createIndex('isManuallyArchivedIdx', 'isManuallyArchivedIdx', { unique: false });
            store.createIndex('hasManualArchiveIdx', 'hasManualArchiveIdx', { unique: false });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
          } else {
            store = tx.objectStore(storeName);
            if (store.indexNames.contains('isManuallyArchived')) {
              store.deleteIndex('isManuallyArchived');
            }
            if (store.indexNames.contains('hasManualArchive')) {
              store.deleteIndex('hasManualArchive');
            }
            if (!store.indexNames.contains('extendedCompletionDateIso')) {
              store.createIndex('extendedCompletionDateIso', 'extendedCompletionDateIso', {
                unique: false,
              });
            }
            if (!store.indexNames.contains('isManuallyArchivedIdx')) {
              store.createIndex('isManuallyArchivedIdx', 'isManuallyArchivedIdx', { unique: false });
            }
            if (!store.indexNames.contains('hasManualArchiveIdx')) {
              store.createIndex('hasManualArchiveIdx', 'hasManualArchiveIdx', { unique: false });
            }
            if (event.oldVersion > 0 && event.oldVersion < 4) {
              const cursorReq = store.openCursor();
              cursorReq.onsuccess = (ev) => {
                const cursor = ev.target.result;
                if (!cursor) return;
                const val = cursor.value;
                if (
                  val &&
                  (typeof val.isManuallyArchivedIdx !== 'number' ||
                    typeof val.hasManualArchiveIdx !== 'number')
                ) {
                  val.isManuallyArchivedIdx = val.isManuallyArchived ? 1 : 0;
                  val.hasManualArchiveIdx =
                    val.isManuallyArchived || val.hasManualArchive ? 1 : 0;
                  cursor.update(val);
                }
                cursor.continue();
              };
            }
          }
        });
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };
      req.onblocked = () => {
        dbPromise = null;
        reject(new Error('IndexedDB upgrade blocked by another tab'));
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try {
            db.close();
          } catch (_e) {}
          dbPromise = null;
        };
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error || new Error('Failed to open local storage'));
      };
    });
    return dbPromise;
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Local storage request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Local storage transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted'));
    });
  }

  async function init() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('p3h_price_bills_cache_v1');
      }
    } catch (_e) {}
    return openDb();
  }

  async function getSetting(key, defaultValue) {
    const db = await openDb();
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const rec = await reqToPromise(tx.objectStore(STORE_SETTINGS).get(key));
    return rec && rec.value !== undefined ? rec.value : defaultValue;
  }

  async function setSetting(key, value) {
    const db = await openDb();
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    tx.objectStore(STORE_SETTINGS).put({
      key,
      value,
      updatedAt: new Date().toISOString(),
    });
    await txDone(tx);
  }

  function resolveAnalyzeFn(analyzeFn) {
    if (typeof analyzeFn === 'function') return analyzeFn;
    if (
      globalScope.__P3H__ &&
      globalScope.__P3H__.extractor &&
      typeof globalScope.__P3H__.extractor.analyzeWorkRecord === 'function'
    ) {
      return globalScope.__P3H__.extractor.analyzeWorkRecord;
    }
    return null;
  }

  async function getCounts() {
    const db = await openDb();
    const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED], 'readonly');
    const actStore = tx.objectStore(STORE_ACTIVE);
    const archStore = tx.objectStore(STORE_ARCHIVED);
    const [actTotal, archTotal, actManOnly, archManOnly, actAnyMan, archAnyMan] = await Promise.all([
      reqToPromise(actStore.count()),
      reqToPromise(archStore.count()),
      reqToPromise(actStore.index('isManuallyArchivedIdx').count(1)),
      reqToPromise(archStore.index('isManuallyArchivedIdx').count(1)),
      reqToPromise(actStore.index('hasManualArchiveIdx').count(1)),
      reqToPromise(archStore.index('hasManualArchiveIdx').count(1)),
    ]);
    return {
      activeCount: Math.max(0, (actTotal || 0) - (actManOnly || 0)),
      archivedCount: Math.max(0, (archTotal || 0) - (archManOnly || 0)),
      manualArchivedCount: (actAnyMan || 0) + (archAnyMan || 0),
      totalCount: (actTotal || 0) + (archTotal || 0),
    };
  }

  async function getWork(fileId) {
    const id = String(fileId || '');
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED], 'readonly');
    const [activeRec, archivedRec] = await Promise.all([
      reqToPromise(tx.objectStore(STORE_ACTIVE).get(id)),
      reqToPromise(tx.objectStore(STORE_ARCHIVED).get(id)),
    ]);
    return archivedRec || activeRec || null;
  }

  async function getWorksByFileIds(fileIds) {
    const ids = Array.from(new Set((fileIds || []).map((id) => String(id)).filter(Boolean)));
    const worksByFileId = Object.create(null);
    const archivedIds = new Set();
    if (ids.length === 0) return { worksByFileId, archivedIds };

    const db = await openDb();
    const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED], 'readonly');
    const activeStore = tx.objectStore(STORE_ACTIVE);
    const archivedStore = tx.objectStore(STORE_ARCHIVED);

    await Promise.all(
      ids.map(async (id) => {
        if (!isSafeKey(id)) return;
        const [activeRec, archivedRec] = await Promise.all([
          reqToPromise(activeStore.get(id)),
          reqToPromise(archivedStore.get(id)),
        ]);
        if (archivedRec) {
          worksByFileId[id] = archivedRec;
          archivedIds.add(id);
        } else if (activeRec) {
          worksByFileId[id] = activeRec;
        }
      })
    );

    return { worksByFileId, archivedIds };
  }

  async function getWorksByScope(scope, options) {
    const db = await openDb();
    const mode = scope || 'active';
    const opts = options || {};
    const includePartialForActivities = Boolean(opts.includePartialForActivities);

    if (mode === 'active') {
      const tx = db.transaction(STORE_ACTIVE, 'readonly');
      const activeList = (await reqToPromise(tx.objectStore(STORE_ACTIVE).getAll())) || [];
      return activeList.filter((r) => !r.isManuallyArchived);
    }
    if (mode === 'archived') {
      if (includePartialForActivities) {
        const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED], 'readonly');
        const [activeList, archivedList] = await Promise.all([
          reqToPromise(tx.objectStore(STORE_ACTIVE).getAll()),
          reqToPromise(tx.objectStore(STORE_ARCHIVED).getAll()),
        ]);
        return [...(activeList || []), ...(archivedList || [])];
      }
      const tx = db.transaction(STORE_ARCHIVED, 'readonly');
      const archivedList = (await reqToPromise(tx.objectStore(STORE_ARCHIVED).getAll())) || [];
      return archivedList.filter((r) => !r.isManuallyArchived);
    }
    if (mode === 'manually_archived') {
      const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED], 'readonly');
      const [activeMan, archivedMan] = await Promise.all([
        reqToPromise(tx.objectStore(STORE_ACTIVE).index('hasManualArchiveIdx').getAll(1)),
        reqToPromise(tx.objectStore(STORE_ARCHIVED).index('hasManualArchiveIdx').getAll(1)),
      ]);
      return [...(activeMan || []), ...(archivedMan || [])];
    }
    const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED], 'readonly');
    const [activeList, archivedList] = await Promise.all([
      reqToPromise(tx.objectStore(STORE_ACTIVE).getAll()),
      reqToPromise(tx.objectStore(STORE_ARCHIVED).getAll()),
    ]);
    return [...(activeList || []), ...(archivedList || [])];
  }

  async function putWork(workRecord, summary, analyzeFn) {
    if (!workRecord || !workRecord.fileId || !isSafeKey(workRecord.fileId)) {
      throw new Error('putWork requires a valid fileId');
    }
    const db = await openDb();
    const id = String(workRecord.fileId).trim();
    const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED, STORE_SETTINGS], 'readwrite');
    const activeStore = tx.objectStore(STORE_ACTIVE);
    const archivedStore = tx.objectStore(STORE_ARCHIVED);

    const [existingAct, existingArch] = await Promise.all([
      reqToPromise(activeStore.get(id)),
      reqToPromise(archivedStore.get(id)),
    ]);
    const existing = existingArch || existingAct || null;
    const merged = existing ? mergeWorkRecords(existing, workRecord, workRecord.scannedAt) : workRecord;
    const resolver = resolveAnalyzeFn(analyzeFn);
    const effectiveSummary = resolver ? resolver(merged) : summary;

    const archived = isWorkArchivable(merged, effectiveSummary);
    const prepared = prepareRecordForStore(merged, effectiveSummary, archived);

    if (archived) {
      archivedStore.put(prepared);
      activeStore.delete(prepared.fileId);
    } else {
      activeStore.put(prepared);
      archivedStore.delete(prepared.fileId);
    }
    tx.objectStore(STORE_SETTINGS).put({
      key: 'lastUpdatedAt',
      value: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await txDone(tx);
    return { record: prepared, archived };
  }

  /**
   * Saves user-entered tracking fields (extensions, fines, work status, physical progress,
   * progress history, manual archives) directly into the local store without re-fetching.
   */
  async function updateWorkUserData(fileId, updaterOrPatch, options) {
    const id = String(fileId || '').trim();
    if (!id || !isSafeKey(id)) return null;
    const opts = options || {};
    const db = await openDb();
    const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED, STORE_SETTINGS], 'readwrite');
    const activeStore = tx.objectStore(STORE_ACTIVE);
    const archivedStore = tx.objectStore(STORE_ARCHIVED);

    const [existingAct, existingArch] = await Promise.all([
      reqToPromise(activeStore.get(id)),
      reqToPromise(archivedStore.get(id)),
    ]);
    const existing = existingArch || existingAct;
    if (!existing) {
      await txDone(tx);
      return null;
    }

    const currentUd = normalizeUserData(existing.userData);
    const nextRaw =
      typeof updaterOrPatch === 'function'
        ? updaterOrPatch(currentUd, existing)
        : { ...currentUd, ...(updaterOrPatch || {}) };
    const nextUd = normalizeUserData(nextRaw);
    nextUd.updatedAt = new Date().toISOString();

    const latestExt = getLatestExtensionFromList(nextUd.extensions, nextUd.activityOverrides, '');
    const updatedBase = {
      ...existing,
      extendedCompletionDateIso: latestExt ? dmyToIso(latestExt.extendedDate) : '',
      updatedAt:
        pickNewerTimestamp(existing.updatedAt, nextUd.updatedAt, nextUd.updatedAt) ||
        nextUd.updatedAt,
    };
    if (hasAnyUserData(nextUd)) {
      updatedBase.userData = nextUd;
    } else {
      delete updatedBase.userData;
    }

    const resolver = resolveAnalyzeFn(opts.analyzeFn);
    const summary = resolver ? resolver(updatedBase) : null;
    const shouldReevalStore = Boolean(opts.reevaluateStore && summary);
    const shouldArchive = shouldReevalStore
      ? isWorkArchivable(updatedBase, summary)
      : Boolean(existingArch);
    const prepared = prepareRecordForStore(updatedBase, summary, shouldArchive);

    if (shouldArchive) {
      archivedStore.put(prepared);
      activeStore.delete(id);
    } else {
      activeStore.put(prepared);
      archivedStore.delete(id);
    }
    tx.objectStore(STORE_SETTINGS).put({
      key: 'lastUpdatedAt',
      value: nextUd.updatedAt,
      updatedAt: nextUd.updatedAt,
    });
    await txDone(tx);
    return prepared;
  }

  async function patchWorkUserTracking(fileId, activityKey, patch, options) {
    const cleanKey = isSafeKey(activityKey) ? String(activityKey).trim() : '';
    const srcPatch = patch && typeof patch === 'object' ? patch : {};
    return updateWorkUserData(
      fileId,
      (curUd) => {
        const next = {
          ...curUd,
          activityOverrides: Object.assign(Object.create(null), curUd.activityOverrides || {}),
        };
        const applyTarget = (targetObj) => {
          const out = { ...targetObj };
          if ('workStatus' in srcPatch) out.workStatus = srcPatch.workStatus;
          if ('physicalProgress' in srcPatch) out.physicalProgress = srcPatch.physicalProgress;
          if ('extensions' in srcPatch) out.extensions = srcPatch.extensions;
          if (
            srcPatch.logHistory ||
            'workStatus' in srcPatch ||
            'physicalProgress' in srcPatch ||
            srcPatch.remarks
          ) {
            out.progressHistory = appendProgressHistoryEntry(targetObj.progressHistory, {
              workStatus: out.workStatus,
              physicalProgress: out.physicalProgress,
              remarks: srcPatch.remarks || '',
            });
          }
          return out;
        };
        if (cleanKey) {
          const prevOv = next.activityOverrides[cleanKey] || {
            extensions: [],
            workStatus: '',
            physicalProgress: null,
            progressHistory: [],
          };
          next.activityOverrides[cleanKey] = applyTarget(prevOv);
        } else {
          Object.assign(next, applyTarget(next));
        }
        return next;
      },
      options
    );
  }

  async function setWorkManualArchive(fileId, { archived, reason, clearOverrides }, analyzeFn) {
    return updateWorkUserData(
      fileId,
      (curUd) => {
        const next = {
          ...curUd,
          activityOverrides: Object.assign(Object.create(null), curUd.activityOverrides || {}),
        };
        if (archived) {
          next.manualArchive = {
            archived: true,
            reason: clampText(reason, MAX_TEXT_LEN),
            archivedAt: new Date().toISOString(),
          };
        } else {
          delete next.manualArchive;
          if (clearOverrides) {
            Object.keys(next.activityOverrides).forEach((k) => {
              if (next.activityOverrides[k] && next.activityOverrides[k].manualArchive) {
                const copy = { ...next.activityOverrides[k] };
                delete copy.manualArchive;
                next.activityOverrides[k] = copy;
              }
            });
          }
        }
        return next;
      },
      { reevaluateStore: true, analyzeFn }
    );
  }

  async function setActivityManualArchive(
    fileId,
    activityKey,
    { archived, reason, clearWorkArchive },
    analyzeFn
  ) {
    const cleanKey = isSafeKey(activityKey) ? String(activityKey).trim() : '';
    if (!cleanKey) {
      return setWorkManualArchive(
        fileId,
        { archived, reason, clearOverrides: Boolean(!archived && clearWorkArchive) },
        analyzeFn
      );
    }
    return updateWorkUserData(
      fileId,
      (curUd) => {
        const next = {
          ...curUd,
          activityOverrides: Object.assign(Object.create(null), curUd.activityOverrides || {}),
        };
        const prevOv = next.activityOverrides[cleanKey]
          ? { ...next.activityOverrides[cleanKey] }
          : { extensions: [], workStatus: '', physicalProgress: null, progressHistory: [] };
        if (archived) {
          prevOv.manualArchive = {
            archived: true,
            reason: clampText(reason, MAX_TEXT_LEN),
            archivedAt: new Date().toISOString(),
          };
          next.activityOverrides[cleanKey] = prevOv;
        } else {
          delete prevOv.manualArchive;
          next.activityOverrides[cleanKey] = prevOv;
          if (clearWorkArchive) {
            delete next.manualArchive;
          }
        }
        return next;
      },
      { reevaluateStore: true, analyzeFn }
    );
  }

  async function addProgressHistoryEntry(
    fileId,
    activityKey,
    { workStatus, physicalProgress, remarks, timestamp }
  ) {
    const cleanKey = isSafeKey(activityKey) ? String(activityKey).trim() : '';
    return updateWorkUserData(fileId, (curUd) => {
      const next = {
        ...curUd,
        activityOverrides: Object.assign(Object.create(null), curUd.activityOverrides || {}),
      };
      if (cleanKey) {
        const prevOv = next.activityOverrides[cleanKey]
          ? { ...next.activityOverrides[cleanKey] }
          : { extensions: [], workStatus: '', physicalProgress: null, progressHistory: [] };
        const cleanStatus =
          workStatus !== undefined ? clampText(workStatus, MAX_TEXT_LEN) : prevOv.workStatus || '';
        const cleanProg =
          physicalProgress !== undefined
            ? normalizeProgressValue(physicalProgress)
            : prevOv.physicalProgress;
        const nextHist = appendProgressHistoryEntry(prevOv.progressHistory, {
          workStatus: cleanStatus,
          physicalProgress: cleanProg,
          remarks,
          timestamp,
        });
        const latest = nextHist.length ? nextHist[nextHist.length - 1] : null;
        next.activityOverrides[cleanKey] = {
          ...prevOv,
          workStatus: latest ? latest.workStatus : cleanStatus,
          physicalProgress: latest ? latest.physicalProgress : cleanProg,
          progressHistory: nextHist,
        };
      } else {
        const cleanStatus =
          workStatus !== undefined ? clampText(workStatus, MAX_TEXT_LEN) : next.workStatus || '';
        const cleanProg =
          physicalProgress !== undefined
            ? normalizeProgressValue(physicalProgress)
            : next.physicalProgress;
        const nextHist = appendProgressHistoryEntry(next.progressHistory, {
          workStatus: cleanStatus,
          physicalProgress: cleanProg,
          remarks,
          timestamp,
        });
        const latest = nextHist.length ? nextHist[nextHist.length - 1] : null;
        next.workStatus = latest ? latest.workStatus : cleanStatus;
        next.physicalProgress = latest ? latest.physicalProgress : cleanProg;
        next.progressHistory = nextHist;
      }
      return next;
    });
  }

  async function deleteProgressHistoryEntry(fileId, activityKey, entryId) {
    const cleanKey = isSafeKey(activityKey) ? String(activityKey).trim() : '';
    const targetId = String(entryId || '').trim();
    if (!targetId) return null;
    return updateWorkUserData(fileId, (curUd) => {
      const next = {
        ...curUd,
        activityOverrides: Object.assign(Object.create(null), curUd.activityOverrides || {}),
      };
      if (cleanKey) {
        const prevOv = next.activityOverrides[cleanKey];
        if (!prevOv) return next;
        const filtered = (prevOv.progressHistory || []).filter((e) => e.id !== targetId);
        const latest = filtered.length ? filtered[filtered.length - 1] : null;
        next.activityOverrides[cleanKey] = {
          ...prevOv,
          progressHistory: filtered,
          workStatus: latest ? latest.workStatus : '',
          physicalProgress: latest ? latest.physicalProgress : null,
        };
      } else {
        const filtered = (next.progressHistory || []).filter((e) => e.id !== targetId);
        const latest = filtered.length ? filtered[filtered.length - 1] : null;
        next.progressHistory = filtered;
        next.workStatus = latest ? latest.workStatus : '';
        next.physicalProgress = latest ? latest.physicalProgress : null;
      }
      return next;
    });
  }

  async function reconcileArchiveStoresIfNeeded(analyzeFn) {
    try {
      const resolver = resolveAnalyzeFn(analyzeFn);
      if (!resolver) return { reconciled: 0, movedToActive: 0, movedToArchived: 0 };
      const doneVersion = await getSetting('archive_reconcile_version', 0);
      if (Number(doneVersion) >= ARCHIVE_RECONCILE_VERSION) {
        return { reconciled: 0, movedToActive: 0, movedToArchived: 0 };
      }

      const db = await openDb();
      const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED, STORE_SETTINGS], 'readwrite');
      const activeStore = tx.objectStore(STORE_ACTIVE);
      const archivedStore = tx.objectStore(STORE_ARCHIVED);

      const [actList, archList] = await Promise.all([
        reqToPromise(activeStore.getAll()),
        reqToPromise(archivedStore.getAll()),
      ]);

      const actMap = new Map();
      const archMap = new Map();
      (actList || []).forEach((r) => {
        if (r && r.fileId && isSafeKey(r.fileId)) actMap.set(String(r.fileId), r);
      });
      (archList || []).forEach((r) => {
        if (r && r.fileId && isSafeKey(r.fileId)) archMap.set(String(r.fileId), r);
      });

      const allIds = new Set([...actMap.keys(), ...archMap.keys()]);
      let reconciled = 0;
      let movedToActive = 0;
      let movedToArchived = 0;

      allIds.forEach((id) => {
        const actRec = actMap.get(id) || null;
        const archRec = archMap.get(id) || null;
        const inBoth = Boolean(actRec && archRec);
        const wasInArchived = Boolean(archRec);
        const baseRec = inBoth ? mergeImportedRecord(actRec, archRec, archRec.scannedAt) : archRec || actRec;
        if (!baseRec) return;

        const sum = resolver(baseRec);
        const shouldBeArchived = isWorkArchivable(baseRec, sum);
        const prepared = prepareRecordForStore(baseRec, sum, shouldBeArchived);

        const changed =
          inBoth ||
          shouldBeArchived !== wasInArchived ||
          prepared.categoryKey !== baseRec.categoryKey ||
          prepared.isManuallyArchived !== baseRec.isManuallyArchived ||
          prepared.hasManualArchive !== baseRec.hasManualArchive ||
          prepared.isManuallyArchivedIdx !== baseRec.isManuallyArchivedIdx ||
          prepared.hasManualArchiveIdx !== baseRec.hasManualArchiveIdx;

        if (changed) {
          if (shouldBeArchived) {
            archivedStore.put(prepared);
            if (!wasInArchived || inBoth) {
              activeStore.delete(id);
              if (!wasInArchived) movedToArchived++;
            }
          } else {
            activeStore.put(prepared);
            if (wasInArchived) {
              archivedStore.delete(id);
              movedToActive++;
            }
          }
          reconciled++;
        }
      });

      tx.objectStore(STORE_SETTINGS).put({
        key: 'archive_reconcile_version',
        value: ARCHIVE_RECONCILE_VERSION,
        updatedAt: new Date().toISOString(),
      });
      await txDone(tx);
      return { reconciled, movedToActive, movedToArchived };
    } catch (err) {
      console.warn('[P3H] Archive reconciliation warning:', err);
      return { reconciled: 0, movedToActive: 0, movedToArchived: 0 };
    }
  }

  function mergeImportedRecord(existingRec, incomingRec, fallbackTimestamp) {
    if (!existingRec) return incomingRec;
    if (!incomingRec) return existingRec;
    const exScanMs = toEpochMs(existingRec.scannedAt);
    const incScanMs = toEpochMs(incomingRec.scannedAt || fallbackTimestamp);
    const exVer = (existingRec.projectDetails && Number(existingRec.projectDetails.extractorVersion)) || 0;
    const incVer = (incomingRec.projectDetails && Number(incomingRec.projectDetails.extractorVersion)) || 0;
    if (
      (exScanMs > 0 && incScanMs > 0 && exScanMs > incScanMs) ||
      (exScanMs === incScanMs && exVer > incVer)
    ) {
      return mergeWorkRecords(incomingRec, existingRec, fallbackTimestamp);
    }
    return mergeWorkRecords(existingRec, incomingRec, fallbackTimestamp);
  }

  async function putWorksBatch(records, analyzeFnOrOpts, maybeOpts) {
    const analyzeFn = typeof analyzeFnOrOpts === 'function' ? analyzeFnOrOpts : null;
    const options =
      typeof analyzeFnOrOpts === 'function'
        ? maybeOpts && typeof maybeOpts === 'object'
          ? maybeOpts
          : null
        : analyzeFnOrOpts && typeof analyzeFnOrOpts === 'object'
        ? analyzeFnOrOpts
        : null;
    const returnRecords = Boolean(options && options.returnRecords);
    const recordsByFileId = returnRecords ? Object.create(null) : null;

    if (!Array.isArray(records) || records.length === 0) {
      return returnRecords
        ? { inserted: 0, activePlaced: 0, archivedPlaced: 0, recordsByFileId }
        : { inserted: 0, activePlaced: 0, archivedPlaced: 0 };
    }
    const db = await openDb();
    const resolver = resolveAnalyzeFn(analyzeFn);

    let inserted = 0;
    let activePlaced = 0;
    let archivedPlaced = 0;

    for (let offset = 0; offset < records.length; offset += BATCH_CHUNK_SIZE) {
      const chunk = records.slice(offset, offset + BATCH_CHUNK_SIZE);
      const uniqueIds = Array.from(
        new Set(
          chunk
            .map((r) => (r && r.fileId ? String(r.fileId).trim() : ''))
            .filter((id) => id && isSafeKey(id))
        )
      );
      if (uniqueIds.length === 0) continue;

      const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED, STORE_SETTINGS], 'readwrite');
      const activeStore = tx.objectStore(STORE_ACTIVE);
      const archivedStore = tx.objectStore(STORE_ARCHIVED);

      const existingMap = new Map();
      await Promise.all(
        uniqueIds.map(async (id) => {
          const [a, r] = await Promise.all([
            reqToPromise(activeStore.get(id)),
            reqToPromise(archivedStore.get(id)),
          ]);
          if (r || a) existingMap.set(id, r || a);
        })
      );

      chunk.forEach((raw) => {
        if (!raw || !raw.fileId) return;
        const id = String(raw.fileId).trim();
        if (!id || !isSafeKey(id)) return;
        const existingRec = existingMap.get(id) || null;
        const merged = mergeImportedRecord(existingRec, raw, raw.scannedAt);
        const summary = resolver ? resolver(merged) : null;
        const archived = summary
          ? isWorkArchivable(merged, summary)
          : existingRec
          ? Boolean(existingRec.isArchived)
          : Boolean(merged.isArchived);
        const prepared = prepareRecordForStore(merged, summary, archived);

        if (archived) {
          archivedStore.put(prepared);
          activeStore.delete(id);
          archivedPlaced++;
        } else {
          activeStore.put(prepared);
          archivedStore.delete(id);
          activePlaced++;
        }
        existingMap.set(id, prepared);
        if (recordsByFileId) {
          recordsByFileId[id] = prepared;
        }
        inserted++;
      });

      tx.objectStore(STORE_SETTINGS).put({
        key: 'lastUpdatedAt',
        value: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await txDone(tx);
    }

    return returnRecords
      ? { inserted, activePlaced, archivedPlaced, recordsByFileId }
      : { inserted, activePlaced, archivedPlaced };
  }

  async function clearWorks(scope) {
    const db = await openDb();
    const mode = scope || 'all';
    const stores =
      mode === 'active'
        ? [STORE_ACTIVE]
        : mode === 'archived'
        ? [STORE_ARCHIVED]
        : [STORE_ACTIVE, STORE_ARCHIVED];
    const tx = db.transaction(stores, 'readwrite');
    stores.forEach((s) => tx.objectStore(s).clear());
    await txDone(tx);
  }

  async function exportDatabasePayload(scope) {
    const mode = scope || 'all';
    if (mode === 'all') {
      const db = await openDb();
      const tx = db.transaction([STORE_ACTIVE, STORE_ARCHIVED], 'readonly');
      const [actList, archList] = await Promise.all([
        reqToPromise(tx.objectStore(STORE_ACTIVE).getAll()),
        reqToPromise(tx.objectStore(STORE_ARCHIVED).getAll()),
      ]);
      const act = actList || [];
      const arch = archList || [];
      const works = [...act, ...arch];
      return {
        schemaVersion: 4,
        exportedAt: new Date().toISOString(),
        scope: mode,
        activeCount: act.filter((r) => !r.isManuallyArchived).length,
        archivedCount: arch.filter((r) => !r.isManuallyArchived).length,
        totalExported: works.length,
        works,
      };
    }
    const [counts, works] = await Promise.all([getCounts(), getWorksByScope(mode)]);
    return {
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      scope: mode,
      activeCount: counts.activeCount,
      archivedCount: counts.archivedCount,
      totalExported: works.length,
      works,
    };
  }

  const ALLOWED_WORK_KEYS = [
    'fileId',
    'rowNo',
    'fileNumber',
    'subject',
    'createdBy',
    'createdOn',
    'scannedAt',
    'updatedAt',
    'constituency',
    'categoryKey',
    'agreementDateIso',
    'completionDateIso',
    'extendedCompletionDateIso',
    'isArchived',
    'isManuallyArchived',
    'hasManualArchive',
  ];

  function copySafeKeys(rawObj) {
    if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) return null;
    const clean = {};
    Object.keys(rawObj).forEach((k) => {
      if (isSafeKey(k)) clean[k] = rawObj[k];
    });
    return clean;
  }

  function sanitizeImportedComponent(rawComp) {
    const out = copySafeKeys(rawComp);
    if (!out) return null;
    if (Object.hasOwn(rawComp, 'bills')) {
      out.bills = Array.isArray(rawComp.bills)
        ? rawComp.bills.map(copySafeKeys).filter(Boolean)
        : [];
    }
    if (Object.hasOwn(rawComp, 'details')) {
      const cleanDetails = copySafeKeys(rawComp.details);
      if (cleanDetails) {
        if (Object.hasOwn(rawComp.details, 'contractor')) {
          const cleanContractor = copySafeKeys(rawComp.details.contractor);
          if (cleanContractor) {
            cleanDetails.contractor = cleanContractor;
          } else {
            delete cleanDetails.contractor;
          }
        }
        out.details = cleanDetails;
      } else {
        delete out.details;
      }
    }
    if (!Array.isArray(out.bills)) out.bills = [];
    return out;
  }

  function sanitizeWorkRecord(raw, fallbackTs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.fileId) return null;
    const id = String(raw.fileId).trim();
    if (!id || !isSafeKey(id)) return null;
    const out = {};
    ALLOWED_WORK_KEYS.forEach((k) => {
      if (Object.hasOwn(raw, k) && raw[k] !== undefined) {
        out[k] = raw[k];
      }
    });
    out.fileId = id;
    out.scannedAt = normalizeIsoTimestamp(raw.scannedAt) || fallbackTs;
    out.updatedAt = normalizeIsoTimestamp(raw.updatedAt) || out.scannedAt;
    out.components = Array.isArray(raw.components)
      ? raw.components.map(sanitizeImportedComponent).filter(Boolean)
      : [];
    if (raw.projectDetails && typeof raw.projectDetails === 'object' && !Array.isArray(raw.projectDetails)) {
      const pdClean = {};
      Object.keys(raw.projectDetails).forEach((k) => {
        if (!isSafeKey(k)) return;
        pdClean[k] = raw.projectDetails[k];
      });
      if (
        raw.projectDetails.contractor &&
        typeof raw.projectDetails.contractor === 'object' &&
        !Array.isArray(raw.projectDetails.contractor)
      ) {
        const ctrClean = {};
        Object.keys(raw.projectDetails.contractor).forEach((k) => {
          if (isSafeKey(k)) ctrClean[k] = raw.projectDetails.contractor[k];
        });
        pdClean.contractor = ctrClean;
      }
      out.projectDetails = pdClean;
    }
    if (raw.userData && typeof raw.userData === 'object' && !Array.isArray(raw.userData)) {
      out.userData = normalizeUserData(raw.userData);
    }
    return out;
  }

  async function importDatabasePayload(parsed, analyzeFn) {
    const rawList = Array.isArray(parsed && parsed.works)
      ? parsed.works
      : Array.isArray(parsed)
      ? parsed
      : [];
    const fallbackTs = normalizeIsoTimestamp(parsed && parsed.exportedAt) || new Date().toISOString();
    const normalized = rawList.map((w) => sanitizeWorkRecord(w, fallbackTs)).filter(Boolean);
    return putWorksBatch(normalized, analyzeFn);
  }

  const asyncApi = IS_CONTENT_SCRIPT_RPC
    ? {
        init: async () => {
          try {
            if (typeof localStorage !== 'undefined') {
              localStorage.removeItem('p3h_price_bills_cache_v1');
            }
          } catch (_e) {}
          return callBgDb('init', []);
        },
        getSetting: (key, defaultValue) =>
          callBgDb('getSetting', defaultValue === undefined ? [key] : [key, defaultValue]),
        setSetting: (key, value) => callBgDb('setSetting', [key, value]),
        getCounts: () => callBgDb('getCounts', []),
        getWork: (fileId) => callBgDb('getWork', [fileId]),
        getWorksByFileIds: async (fileIds) => {
          const res = await callBgDb('getWorksByFileIds', [fileIds]);
          return {
            worksByFileId: (res && res.worksByFileId) || Object.create(null),
            archivedIds: new Set((res && res.archivedIds) || []),
          };
        },
        getWorksByScope: (scope, options) => callBgDb('getWorksByScope', [scope, options]),
        putWork: (workRecord) => callBgDb('putWork', [workRecord, null]),
        updateWorkUserData: (fileId, updaterOrPatch, options) => {
          if (typeof updaterOrPatch === 'function') {
            return Promise.reject(
              new Error('Function updater not supported over RPC; use patchWorkUserTracking')
            );
          }
          const cleanOpts =
            options && typeof options === 'object'
              ? { reevaluateStore: Boolean(options.reevaluateStore) }
              : undefined;
          return callBgDb('updateWorkUserData', [fileId, updaterOrPatch, cleanOpts]);
        },
        patchWorkUserTracking: (fileId, activityKey, patch, options) => {
          const cleanOpts =
            options && typeof options === 'object'
              ? { reevaluateStore: Boolean(options.reevaluateStore) }
              : undefined;
          return callBgDb('patchWorkUserTracking', [fileId, activityKey, patch, cleanOpts]);
        },
        setWorkManualArchive: (fileId, arg) => callBgDb('setWorkManualArchive', [fileId, arg]),
        setActivityManualArchive: (fileId, activityKey, arg) =>
          callBgDb('setActivityManualArchive', [fileId, activityKey, arg]),
        addProgressHistoryEntry: (fileId, activityKey, entry) =>
          callBgDb('addProgressHistoryEntry', [fileId, activityKey, entry]),
        deleteProgressHistoryEntry: (fileId, activityKey, entryId) =>
          callBgDb('deleteProgressHistoryEntry', [fileId, activityKey, entryId]),
        reconcileArchiveStoresIfNeeded: () => callBgDb('reconcileArchiveStoresIfNeeded', []),
        putWorksBatch: (records, analyzeFnOrOpts, maybeOpts) => {
          const opts =
            typeof analyzeFnOrOpts === 'function'
              ? maybeOpts && typeof maybeOpts === 'object'
                ? maybeOpts
                : null
              : analyzeFnOrOpts && typeof analyzeFnOrOpts === 'object'
              ? analyzeFnOrOpts
              : null;
          const cleanOpts = opts && opts.returnRecords ? { returnRecords: true } : undefined;
          return callBgDb('putWorksBatch', cleanOpts ? [records, cleanOpts] : [records]);
        },
        clearWorks: (scope) => callBgDb('clearWorks', [scope]),
        exportDatabasePayload: (scope) => callBgDb('exportDatabasePayload', [scope]),
        importDatabasePayload: (parsed) => callBgDb('importDatabasePayload', [parsed]),
      }
    : {
        init,
        getSetting,
        setSetting,
        getCounts,
        getWork,
        getWorksByFileIds,
        getWorksByScope,
        putWork,
        updateWorkUserData,
        patchWorkUserTracking,
        setWorkManualArchive,
        setActivityManualArchive,
        addProgressHistoryEntry,
        deleteProgressHistoryEntry,
        reconcileArchiveStoresIfNeeded,
        putWorksBatch,
        clearWorks,
        exportDatabasePayload,
        importDatabasePayload,
      };

  const dbApi = Object.freeze({
    EXTENSION_VERSION,
    EXTRACTOR_VERSION,
    DB_NAME,
    DB_VERSION,
    ARCHIVE_RECONCILE_VERSION,
    STORE_ACTIVE,
    STORE_ARCHIVED,
    STORE_SETTINGS,
    isSafeKey,
    parseSafeNumber,
    escapeHtml,
    csvEscape,
    extractEstimateCode,
    getActivityKey,
    parseDateParts,
    normalizeDateToDmy,
    dmyToIso,
    formatOrdinal,
    normalizeExtensionEntry,
    normalizeManualArchive,
    normalizeProgressEntry,
    normalizeProgressHistory,
    mergeProgressHistories,
    appendProgressHistoryEntry,
    formatProgressTimestamp,
    formatProgressTimelineSummary,
    normalizeUserData,
    resolveUserDataScope,
    hasAnyUserData,
    getLatestExtension,
    getTotalExtensionFine,
    formatExtensionsSummary,
    getEffectiveUserFields,
    isTerminalBillStatus,
    isWorkArchivable,
    mergeProjectDetailsNonDestructive,
    prepareRecordForStore,
    mergeImportedRecord,
    sanitizeWorkRecord,
    ...asyncApi,
  });

  globalScope.__P3H__ = globalScope.__P3H__ || {};
  globalScope.__P3H__.db = dbApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = dbApi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
