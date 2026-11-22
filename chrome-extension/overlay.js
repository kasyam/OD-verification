/**
 * PRICE 3.0 Helper — Works List Overlay & Drawer (ISOLATED Content Script)
 *
 * Coordinates the portal DataTable overlay via page-bridge.js, mismatch/missing-field rescans,
 * extension IndexedDB persistence via background.js RPC (db.js), Project Details & Bills Drawer
 * (with Extensions, Status of Work, and Milestone Progress), and launches the Project Register.
 */
(function (globalScope) {
  'use strict';

  const hasDocument = typeof document !== 'undefined';
  if (hasDocument && globalScope.__P3H_LOADED__) return;
  if (hasDocument) {
    globalScope.__P3H_LOADED__ = true;
  }

  const P3H = (globalScope.__P3H__ = globalScope.__P3H__ || {});
  const db = P3H.db;
  const extractor = P3H.extractor;
  const register = P3H.register;

  const TABLE_SELECTOR = '#pt-file_table_list';

  const TARGET_OPTIONS = [
    { key: 'unscanned', label: 'New / Unscanned Works', defaultChecked: true },
    { key: 'missing_details', label: 'Missing Fields / Needs Refresh', defaultChecked: true },
    { key: 'not_final', label: 'Final Bill Not Generated', defaultChecked: true },
    { key: 'open_mbook_75', label: 'Open M-Book ≥ 75% Period', defaultChecked: false },
    { key: 'mbook_closed_no_final', label: 'M-Book Closed (No Final Bill)', defaultChecked: false },
    { key: 'dpr', label: 'DPR / Pre-Tender', defaultChecked: false },
    { key: 'part_only', label: 'Part / Pre-Final Only', defaultChecked: false },
    { key: 'nobill', label: 'No Bills / Cancelled', defaultChecked: false },
  ];

  const FILTER_COUNT_KEYS = [
    'final',
    'not_final',
    'open_mbook_75',
    'mbook_closed_no_final',
    'has_part',
    'part_only',
    'nobill',
    'dpr',
    'manually_archived',
    'missing_details',
    'unscanned',
  ];

  const WORK_STATUS_PRESETS = (register && register.WORK_STATUS_PRESETS) || [
    'Not Started',
    'Site Handed Over',
    'In Progress',
    'Material Procured',
    'Wiring / Piping Completed',
    'Testing & Commissioning',
    'Work Completed',
    'M-Book Closed',
    'Bill Submitted',
    'Held Up / Site Issue',
  ];

  const rowMetaCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  const summaryCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  const state = {
    worksByFileId: Object.create(null),
    dbCounts: { activeCount: 0, archivedCount: 0, manualArchivedCount: 0, totalCount: 0 },
    dbReady: false,
    activeFilter: 'all',
    activeActivityFilter: 'all',
    isScanning: false,
    pauseRequested: false,
    scanDone: 0,
    scanTotal: 0,
    scanErrors: 0,
    scanConcurrency: 6,
    statusMessage: '',
    currentTable: null,
    hasDt: false,
    allRowsCache: [],
    drawerFileId: null,
    drawerScopeKey: '',
    drawerTimelineDesc: false,
    pickerTargets: new Set(TARGET_OPTIONS.filter((o) => o.defaultChecked).map((o) => o.key)),
    pickerIncludeDetails: true,
    pickerIncludeArchivedMissing: true,
  };

  let dbInitPromise = null;
  let activeScanPromise = null;
  let activeScanAbortController = null;
  let statusClearTimer = null;
  let globalListenersBound = false;
  let pendingPaginationScroll = false;
  let pendingPaginationTimer = null;

  function escapeHtml(str) {
    if (db && typeof db.escapeHtml === 'function') return db.escapeHtml(str);
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function csvEscape(val) {
    if (db && typeof db.csvEscape === 'function') return db.csvEscape(val);
    const raw = String(val == null ? '' : val);
    const safe = typeof val !== 'number' && /^[\t\r ]*[=+\-@]/.test(raw) ? "'" + raw : raw;
    return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  }

  function getWorkSummary(rec) {
    if (!rec || typeof rec !== 'object') return extractor.summarizeWork(null);
    if (summaryCache) {
      const cached = summaryCache.get(rec);
      if (cached) return cached;
      const sum = extractor.summarizeWork(rec);
      summaryCache.set(rec, sum);
      return sum;
    }
    return extractor.summarizeWork(rec);
  }

  function isFullyManuallyArchived(rec, summary) {
    if (summary && summary.isFullyManuallyArchived) return true;
    if (rec && rec.isManuallyArchived) return true;
    const ud = rec && rec.userData;
    return Boolean(ud && ud.manualArchive && ud.manualArchive.archived);
  }

  function hasAnyManualArchive(rec, summary) {
    if (isFullyManuallyArchived(rec, summary)) return true;
    if (summary && summary.hasAnyManualArchive) return true;
    if (rec && rec.hasManualArchive) return true;
    const overrides = rec && rec.userData && rec.userData.activityOverrides;
    if (overrides && typeof overrides === 'object') {
      return Object.values(overrides).some((ov) =>
        Boolean(ov && ov.manualArchive && ov.manualArchive.archived)
      );
    }
    return false;
  }

  function isWorkArchivedRec(rec, summary) {
    if (rec && typeof rec.isArchived === 'boolean') return rec.isArchived;
    return Boolean(summary && summary.isFullyFinalized);
  }

  function setTransientStatus(msg, durationMs) {
    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
      statusClearTimer = null;
    }
    state.statusMessage = msg || '';
    if (state.currentTable) updateToolbarUI(state.currentTable);
    if (msg && typeof setTimeout === 'function') {
      const ms = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 7000;
      statusClearTimer = setTimeout(() => {
        statusClearTimer = null;
        if (!state.isScanning && state.statusMessage === msg) {
          state.statusMessage = '';
          if (state.currentTable) updateToolbarUI(state.currentTable);
        }
      }, ms);
    }
  }

  function extractRowMetaFromTr(tr) {
    if (!tr || !tr.querySelectorAll) return null;
    if (rowMetaCache && rowMetaCache.has(tr)) return rowMetaCache.get(tr);

    const tds = tr.querySelectorAll('td');
    if (tds.length < 5) return null;

    let fileId = '';
    const nodes = [tr, ...Array.from(tr.querySelectorAll('[onclick]'))];
    for (let i = 0; i < nodes.length; i++) {
      const m = (nodes[i].getAttribute('onclick') || '').match(
        /callworkfiledetails\([^,]+,\s*[^,]+,\s*['"]?(\d+)['"]?\s*\)/
      );
      if (m && m[1]) {
        fileId = m[1];
        break;
      }
    }
    if (!fileId) return null;

    const subjClone = tds[2].cloneNode(true);
    subjClone.querySelectorAll('.p3h-cell-meta').forEach((n) => n.remove());

    const meta = {
      rowNo: extractor.cleanSingleLine(tds[0].textContent),
      fileId,
      fileNumber: extractor.cleanSingleLine(tds[1].textContent),
      subject: extractor.cleanText(subjClone),
      createdBy: extractor.cleanSingleLine(tds[3].textContent),
      createdOn: extractor.cleanSingleLine(tds[4].textContent),
    };
    if (rowMetaCache) rowMetaCache.set(tr, meta);
    return meta;
  }

  function getAllTableRowsMeta(table) {
    if (!table) return [];
    const res =
      extractor && typeof extractor.syncBridgeCall === 'function'
        ? extractor.syncBridgeCall('dt:getAllRows', { selector: TABLE_SELECTOR })
        : { bridged: false };
    if (res && res.bridged && res.ok && res.result && res.result.hasDt) {
      state.hasDt = true;
      state.allRowsCache = res.result.rows || [];
      return state.allRowsCache;
    }

    state.hasDt = false;
    const list = [];
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const meta = extractRowMetaFromTr(tr);
      if (meta) list.push(meta);
    });
    state.allRowsCache = list;
    return list;
  }

  function computeActivityPeriodProgress(act, pd, referenceTodayDmy) {
    if (!act || act.isFinalized || act.isManuallyArchived || act.isMbookClosed) return null;
    const sched = extractor.resolveScheduleDates(act.details, pd, referenceTodayDmy);
    return extractor.computePeriodProgress({
      shoDate: sched.shoDate,
      completionDate: sched.completionDate,
      isFinalized: Boolean(act.isFinalized),
      isManuallyArchived: Boolean(act.isManuallyArchived),
      isMbookClosed: Boolean(act.isMbookClosed),
      referenceTodayDmy,
    });
  }

  function matchesFilter(summary, record, filterKey, activityFilter) {
    if (activityFilter && activityFilter !== 'all') {
      if (!summary || !summary.activityNames || !summary.activityNames.includes(activityFilter)) {
        return false;
      }
    }
    const isFullManual = isFullyManuallyArchived(record, summary);
    const hasManual = hasAnyManualArchive(record, summary);

    if (filterKey === 'all') return true;
    if (filterKey === 'final') return Boolean(summary && summary.isFullyFinalized);
    if (filterKey === 'not_final') {
      return Boolean(summary && summary.scanned && !summary.isFullyFinalized && !isFullManual);
    }
    if (filterKey === 'open_mbook_75') {
      if (!summary || !summary.scanned || isFullManual) return false;
      const fallbackPd = summary.hasIndependentActivities ? null : record && record.projectDetails;
      return (summary.activities || []).some((act) => {
        if (act.isFinalized || act.isManuallyArchived || !act.isMbookOpen) return false;
        const prog = computeActivityPeriodProgress(act, fallbackPd);
        return Boolean(prog && prog.reached75);
      });
    }
    if (filterKey === 'manually_archived') {
      return Boolean(hasManual);
    }
    if (filterKey === 'mbook_closed_no_final') {
      return Boolean(summary && summary.hasMbookClosedNoFinal);
    }
    if (filterKey === 'has_part') return Boolean(summary && summary.hasPart);
    if (filterKey === 'part_only') {
      return Boolean(
        summary && (summary.categoryKey === 'part_only' || summary.categoryKey === 'prefinal_only')
      );
    }
    if (filterKey === 'nobill') {
      return Boolean(
        summary && (summary.categoryKey === 'nobill' || summary.categoryKey === 'cancelled')
      );
    }
    if (filterKey === 'dpr') return Boolean(summary && summary.categoryKey === 'dpr');
    if (filterKey === 'unscanned') return !summary || !summary.scanned;
    if (filterKey === 'missing_details') {
      if (isFullManual) return false;
      return extractor.getMissingFields(record, summary).isIncomplete;
    }
    return true;
  }

  async function syncTableCacheFromDb(table) {
    if (!state.dbReady || !table) return;
    const rows = getAllTableRowsMeta(table);
    const fileIds = rows.map((r) => r.fileId);
    const [loaded, counts] = await Promise.all([db.getWorksByFileIds(fileIds), db.getCounts()]);
    const nextMap = Object.create(null);
    const loadedMap = (loaded && loaded.worksByFileId) || {};
    Object.keys(loadedMap).forEach((k) => {
      if (db.isSafeKey ? db.isSafeKey(k) : k !== '__proto__') {
        nextMap[k] = loadedMap[k];
      }
    });
    state.worksByFileId = nextMap;
    state.dbCounts = counts || {
      activeCount: 0,
      archivedCount: 0,
      manualArchivedCount: 0,
      totalCount: 0,
    };
  }

  function ensureDtFilter(table) {
    if (!table || !extractor || typeof extractor.syncBridgeCall !== 'function') return false;
    const res = extractor.syncBridgeCall('dt:ensure', { selector: TABLE_SELECTOR });
    if (res && res.bridged && res.ok && res.result && res.result.hasDt) {
      state.hasDt = true;
      return Boolean(res.result.newlyBound);
    }
    state.hasDt = false;
    return false;
  }

  function applyActiveFilterToTable(table, resetPaging) {
    if (!table) return;
    const isFiltered = state.activeFilter !== 'all' || state.activeActivityFilter !== 'all';

    if (state.hasDt && extractor && typeof extractor.syncBridgeCall === 'function') {
      if (!isFiltered) {
        extractor.syncBridgeCall('dt:setVisibleFileIds', {
          selector: TABLE_SELECTOR,
          active: false,
          draw: true,
          resetPaging: Boolean(resetPaging),
        });
        return;
      }
      const allRows = state.allRowsCache.length > 0 ? state.allRowsCache : getAllTableRowsMeta(table);
      const visibleIds = [];
      allRows.forEach((r) => {
        const rec = state.worksByFileId[r.fileId];
        const sum = getWorkSummary(rec);
        if (matchesFilter(sum, rec, state.activeFilter, state.activeActivityFilter)) {
          visibleIds.push(r.fileId);
        }
      });
      extractor.syncBridgeCall('dt:setVisibleFileIds', {
        selector: TABLE_SELECTOR,
        active: true,
        fileIds: visibleIds,
        draw: true,
        resetPaging: Boolean(resetPaging),
      });
      return;
    }

    // Non-DataTables DOM fallback
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const meta = extractRowMetaFromTr(tr);
      if (!meta) return;
      if (!isFiltered) {
        tr.style.display = '';
        return;
      }
      const rec = state.worksByFileId[meta.fileId];
      const sum = getWorkSummary(rec);
      tr.style.display = matchesFilter(sum, rec, state.activeFilter, state.activeActivityFilter)
        ? ''
        : 'none';
    });
  }

  function renderWorkRowBadgesHtml(cached, summary, todayDmy) {
    const today = todayDmy || extractor.getTodayDmy();
    const sum = summary || getWorkSummary(cached);
    const pd = cached && cached.projectDetails;
    const uFields = db.getEffectiveUserFields(cached);
    const rawUd = db.normalizeUserData(cached && cached.userData);
    const isFullManual = isFullyManuallyArchived(cached, sum);
    const hasManual = hasAnyManualArchive(cached, sum);
    const isArch = isWorkArchivedRec(cached, sum);

    const archTxt = isFullManual
      ? `<span class="p3h-badge p3h-badge-manual-arch" title="Manually Archived">Manually Archived</span>`
      : isArch
      ? `<span class="p3h-badge p3h-badge-archived" title="Finalized &amp; Submitted (Archived)">Archived</span>`
      : hasManual
      ? `<span class="p3h-badge p3h-badge-manual-arch" title="Contains manually archived activity">Partial Manual Arch</span>`
      : '';

    if (sum.hasIndependentActivities) {
      const primaryControlHtml = !sum.hasAnyBills
        ? `<button type="button" class="p3h-badge p3h-badge-clickable ${escapeHtml(
            sum.badgeClass
          )}" data-open-drawer="1" title="Click to inspect details &amp; edit status/extensions">${escapeHtml(
            sum.label
          )}</button>`
        : `<span class="p3h-badge ${escapeHtml(sum.badgeClass)}">${escapeHtml(
            sum.label
          )}</span>` + `<button type="button" class="p3h-inspect-btn" data-open-drawer="1">Bill Details</button>`;

      const rootProgParts = [];
      if (rawUd.workStatus) rootProgParts.push(rawUd.workStatus);
      if (rawUd.physicalProgress !== null && rawUd.physicalProgress !== undefined) {
        rootProgParts.push(`${rawUd.physicalProgress}%`);
      }
      const rootProgTxt =
        rootProgParts.length > 0
          ? `<span class="p3h-badge p3h-badge-progress">${escapeHtml(
              rootProgParts.join(' · ')
            )}</span>`
          : '';

      const multiActLinesHtml = `<div class="p3h-comp-status-lines">${(sum.activities || [])
        .map((a) => {
          const actNameBadge = `<span class="p3h-badge p3h-badge-activity" title="${escapeHtml(
            a.estimateCode || ''
          )}">${escapeHtml(a.activityName)}: ${escapeHtml(a.compBadgeText)}</span>`;

          const actActiveBills = (a.bills || []).filter((b) => !b.isCancelled && !b.isDraft);
          const actBillable = actActiveBills.filter((b) => b.includedInWorkTotal);
          const actLatestPool = actBillable.length
            ? actBillable
            : actActiveBills.length
            ? actActiveBills
            : a.bills || [];
          const actLatestBill = extractor.pickLatestBill(actLatestPool);
          const actLatestTxt =
            actLatestBill && actLatestBill.status
              ? `<span class="p3h-badge p3h-badge-nobill" title="${escapeHtml(
                  actLatestBill.billTypeAndNo || ''
                )}">${escapeHtml(actLatestBill.status)}</span>`
              : '';

          const actDet = a.details || {};
          const actFin = extractor.computeFinancialStatus(a.compTotalActiveAmount || 0, {
            tsAmount: actDet.tsAmount,
            negotiatedRate: actDet.negotiatedRate,
            agreedPac: actDet.agreedPac,
            estimatePac: actDet.estimatePac,
          });
          const actBilled = Number(a.compTotalActiveAmount) || 0;
          const actAmtLabel =
            actBilled > 0
              ? `₹${extractor.formatInr(actBilled)}${
                  actFin.pct !== null ? ` (${actFin.pct}%)` : ''
                }`
              : '';
          const actAmtTxt = actAmtLabel
            ? `<span class="p3h-badge p3h-badge-nobill" title="Financial Status">${escapeHtml(
                actAmtLabel
              )}</span>`
            : '';

          const actKey = a.activityKey || '';
          const actOv =
            actKey && rawUd.activityOverrides && Object.hasOwn(rawUd.activityOverrides, actKey)
              ? rawUd.activityOverrides[actKey]
              : null;
          const actUser = actKey ? db.getEffectiveUserFields(cached, actKey) : null;
          const actHasOwnExt = Boolean(
            actOv && Array.isArray(actOv.extensions) && actOv.extensions.length > 0
          );
          const actExtDate = actHasOwnExt && actUser ? actUser.extendedCompletionDate : '';
          let actDueHtml = '';
          if (!a.isFinalized && !a.isManuallyArchived && !a.isMbookClosed) {
            const actSched = extractor.resolveScheduleDates(a.details, null, today);
            const actCompDate = actSched.completionDate;
            const actProg = computeActivityPeriodProgress(a, null, today);
            const effDue = actExtDate || actCompDate;
            if (actProg && actCompDate) {
              actDueHtml = register.renderDueDateProgressBadgeHtml(
                actCompDate,
                actProg,
                '',
                Boolean(actExtDate)
              );
            } else if (effDue) {
              const schedAct = extractor.computeScheduleStatus(
                actCompDate,
                false,
                today,
                actExtDate
              );
              actDueHtml = `<span class="p3h-badge ${
                schedAct.key === 'overdue' ? 'p3h-badge-overdue' : 'p3h-badge-due'
              }">${schedAct.isExtended ? 'Due (Ext): ' : 'Due: '}${escapeHtml(
                schedAct.effectiveDate
              )}</span>`;
            }
          }

          const actProgParts = [];
          if (actOv && actOv.workStatus) actProgParts.push(actOv.workStatus);
          if (
            actOv &&
            actOv.physicalProgress !== null &&
            actOv.physicalProgress !== undefined
          ) {
            actProgParts.push(`${actOv.physicalProgress}%`);
          }
          const actProgTxt =
            actProgParts.length > 0
              ? `<span class="p3h-badge p3h-badge-progress">${escapeHtml(
                  actProgParts.join(' · ')
                )}</span>`
              : '';

          return `<div class="p3h-comp-status-line">${actNameBadge}${actLatestTxt}${actAmtTxt}${actDueHtml}${actProgTxt}</div>`;
        })
        .join('')}</div>`;

      return primaryControlHtml + rootProgTxt + archTxt + multiActLinesHtml;
    }

    const schedDates = extractor.resolveScheduleDates(pd, null, today);
    const completionDate = schedDates.completionDate;
    const finStatus = extractor.computeWorkFinancialStatus(cached, sum);

    let primaryControlHtml = '';
    if (!sum.hasAnyBills) {
      primaryControlHtml = `<button type="button" class="p3h-badge p3h-badge-clickable ${escapeHtml(
        sum.badgeClass
      )}" data-open-drawer="1" title="Click to inspect details &amp; edit status/extensions">${escapeHtml(
        sum.label
      )}</button>`;
    } else {
      const latestTxt =
        sum.latestBill && sum.latestBill.status
          ? `<span class="p3h-badge p3h-badge-nobill" title="${escapeHtml(
              sum.latestBill.billTypeAndNo
            )}">${escapeHtml(sum.latestBill.status)}</span>`
          : '';
      const amtLabel =
        sum.totalActiveAmount > 0
          ? `₹${extractor.formatInr(sum.totalActiveAmount)}${
              finStatus.pct !== null ? ` (${finStatus.pct}%)` : ''
            }`
          : finStatus.pct !== null
          ? `${finStatus.pct}%`
          : '';
      const amtTxt = amtLabel
        ? `<span class="p3h-badge p3h-badge-nobill" title="Financial Status">${escapeHtml(
            amtLabel
          )}</span>`
        : '';
      primaryControlHtml =
        `<span class="p3h-badge ${escapeHtml(sum.badgeClass)}">${escapeHtml(sum.label)}</span>` +
        latestTxt +
        amtTxt +
        `<button type="button" class="p3h-inspect-btn" data-open-drawer="1">Bill Details</button>`;
    }

    const activeComps = (sum.activities || []).filter(
      (a) => !a.isFinalized && !a.isManuallyArchived && !a.isMbookClosed
    );
    const dueEntries = [];
    if (sum.isCompositeWork) {
      const compGroupActives = activeComps.filter(
        (a) => a.isCompositeGroupMember || a.isCompositeFinal
      );
      const nonCompActives = activeComps.filter(
        (a) => !a.isCompositeGroupMember && !a.isCompositeFinal
      );
      if (compGroupActives.length > 0) {
        const rep =
          compGroupActives.find((a) => a.isCompositeFinal && (a.details || {}).shoDate) ||
          compGroupActives.find((a) => (a.details || {}).shoDate) ||
          compGroupActives[0];
        const repSched = extractor.resolveScheduleDates(rep && rep.details, pd, today);
        const repUser = uFields.extendedCompletionDate
          ? uFields
          : db.getEffectiveUserFields(cached, rep && rep.activityKey);
        const repProg = extractor.computePeriodProgress({
          shoDate: repSched.shoDate,
          completionDate: repSched.completionDate || completionDate,
          isFinalized: false,
          isManuallyArchived: false,
          isMbookClosed: false,
          referenceTodayDmy: today,
        });
        dueEntries.push({
          prefix: '',
          compDate: repSched.completionDate || completionDate,
          prog: repProg,
          extendedDate: repUser.extendedCompletionDate,
        });
      }
      nonCompActives.forEach((act) => {
        const actSched = extractor.resolveScheduleDates(act.details, pd, today);
        const actCompDate = actSched.completionDate || completionDate;
        const actUser = db.getEffectiveUserFields(cached, act.activityKey);
        dueEntries.push({
          prefix: compGroupActives.length > 0 || nonCompActives.length > 1 ? act.activityName : '',
          compDate: actCompDate,
          prog: computeActivityPeriodProgress(act, pd, today),
          extendedDate: actUser.extendedCompletionDate,
        });
      });
    } else {
      const showCompPrefix = activeComps.length > 1 || (sum.activities || []).length > 1;
      activeComps.forEach((act) => {
        const actSched = extractor.resolveScheduleDates(act.details, pd, today);
        const actCompDate = actSched.completionDate || completionDate;
        const actUser = db.getEffectiveUserFields(cached, act.activityKey);
        dueEntries.push({
          prefix: showCompPrefix ? act.activityName : '',
          compDate: actCompDate,
          prog: computeActivityPeriodProgress(act, pd, today),
          extendedDate: actUser.extendedCompletionDate,
        });
      });
    }

    const compDueHtmlList = [];
    dueEntries.forEach((entry) => {
      const effDue = entry.extendedDate || entry.compDate;
      if (entry.prog && entry.compDate) {
        compDueHtmlList.push(
          register.renderDueDateProgressBadgeHtml(
            entry.compDate,
            entry.prog,
            entry.prefix,
            Boolean(entry.extendedDate)
          )
        );
      } else if (effDue) {
        const schedAct = extractor.computeScheduleStatus(
          entry.compDate,
          false,
          today,
          entry.extendedDate
        );
        compDueHtmlList.push(
          `<span class="p3h-badge ${
            schedAct.key === 'overdue' ? 'p3h-badge-overdue' : 'p3h-badge-due'
          }">${entry.prefix ? escapeHtml(entry.prefix) + ': ' : ''}${
            schedAct.isExtended ? 'Due (Ext): ' : 'Due: '
          }${escapeHtml(schedAct.effectiveDate)}</span>`
        );
      }
    });
    if (compDueHtmlList.length === 0 && !sum.isFullyFinalized && !isFullManual) {
      const sched = extractor.computeScheduleStatus(
        completionDate,
        false,
        today,
        uFields.extendedCompletionDate
      );
      if (sched.effectiveDate) {
        const fallbackProg = extractor.computePeriodProgress({
          shoDate: schedDates.shoDate,
          completionDate,
          isFinalized: false,
          isManuallyArchived: isFullManual,
          isMbookClosed: Boolean(sum.hasMbookClosedNoFinal),
          referenceTodayDmy: today,
        });
        compDueHtmlList.push(
          fallbackProg
            ? register.renderDueDateProgressBadgeHtml(
                completionDate,
                fallbackProg,
                '',
                sched.isExtended
              )
            : `<span class="p3h-badge ${
                sched.key === 'overdue' ? 'p3h-badge-overdue' : 'p3h-badge-due'
              }">${sched.isExtended ? 'Due (Ext): ' : 'Due: '}${escapeHtml(
                sched.effectiveDate
              )}</span>`
        );
      }
    }
    const dueTxt = compDueHtmlList.join('');

    const progParts = [];
    if (uFields.workStatus) progParts.push(uFields.workStatus);
    if (uFields.physicalProgress !== null) progParts.push(`${uFields.physicalProgress}%`);
    const progTxt =
      progParts.length > 0
        ? `<span class="p3h-badge p3h-badge-progress">${escapeHtml(progParts.join(' · '))}</span>`
        : '';

    const multiActTxt =
      (sum.activities || []).length > 1
        ? sum.activities
            .map(
              (a) =>
                `<span class="p3h-badge p3h-badge-activity" title="${escapeHtml(
                  a.estimateCode || ''
                )}">${escapeHtml(a.activityName)}: ${escapeHtml(a.compBadgeText)}</span>`
            )
            .join('')
        : '';

    return primaryControlHtml + dueTxt + progTxt + multiActTxt + archTxt;
  }

  function renderVisibleRowBadges(table, force, targetFileId) {
    if (!table) return;

    const rowNodes = Array.from(table.querySelectorAll('tbody tr'));
    const todayDmy = extractor.getTodayDmy();

    rowNodes.forEach((tr) => {
      const meta = extractRowMetaFromTr(tr);
      if (!meta) return;
      if (targetFileId && meta.fileId !== String(targetFileId)) return;

      const subjTd = tr.querySelectorAll('td')[2];
      if (!subjTd) return;

      const cached = state.worksByFileId[meta.fileId];
      const pd = cached && cached.projectDetails;
      const uFields = db.getEffectiveUserFields(cached);
      const rawUd = db.normalizeUserData(cached && cached.userData);
      const summary = getWorkSummary(cached);
      const isFullManual = isFullyManuallyArchived(cached, summary);
      const hasManual = hasAnyManualArchive(cached, summary);
      const isArch = isWorkArchivedRec(cached, summary);

      const actOvSig = rawUd.activityOverrides
        ? Object.keys(rawUd.activityOverrides)
            .sort()
            .map((k) => {
              const ov = rawUd.activityOverrides[k];
              return `${k}:${ov.workStatus || ''}:${
                ov.physicalProgress !== null && ov.physicalProgress !== undefined
                  ? ov.physicalProgress
                  : ''
              }:${(ov.extensions || []).length}:${(ov.progressHistory || []).length}:${
                ov.manualArchive && ov.manualArchive.archived ? '1' : '0'
              }`;
            })
            .join('|')
        : '';

      const sig = [
        'v241',
        cached ? cached.updatedAt || cached.scannedAt || '1' : 'none',
        pd && pd.fetchedAt ? pd.fetchedAt : 'nopd',
        pd && pd.extractorVersion ? pd.extractorVersion : '0',
        uFields.extendedCompletionDate || '',
        uFields.workStatus || '',
        uFields.physicalProgress !== null ? uFields.physicalProgress : '',
        (uFields.progressHistory || []).length,
        actOvSig,
        isFullManual ? 'manfull' : hasManual ? 'manpart' : '',
        isArch ? 'arch' : 'act',
        todayDmy,
      ].join(':');

      let container = subjTd.querySelector('.p3h-cell-meta');
      if (!force && container && container.getAttribute('data-p3h-sig') === sig) {
        return;
      }
      if (!container) {
        container = document.createElement('div');
        container.className = 'p3h-cell-meta';
        subjTd.appendChild(container);
      }
      container.setAttribute('data-p3h-sig', sig);
      container.innerHTML = renderWorkRowBadgesHtml(cached, summary, todayDmy);
    });
  }

  function getTargetedQueueRows(allRows, targetKeys, options) {
    const keys = Array.from(targetKeys || []);
    const includeArchivedMissing = Boolean(options && options.includeArchivedMissing);
    const activityFilter = (options && options.activityFilter) || 'all';

    return (allRows || []).filter((r) => {
      const rec = state.worksByFileId[r.fileId];
      const sum = getWorkSummary(rec);
      if (isFullyManuallyArchived(rec, sum)) {
        return keys.includes('manually_archived');
      }
      if (isWorkArchivedRec(rec, sum)) {
        if (
          !includeArchivedMissing ||
          !keys.includes('missing_details') ||
          !extractor.getMissingFields(rec, sum).isIncomplete
        ) {
          return false;
        }
      }
      return keys.some((k) => matchesFilter(sum, rec, k, activityFilter));
    });
  }

  function updateActivityFilterOptions(allRows) {
    const sel = document.getElementById('p3h-activity-filter');
    if (!sel) return;
    const actSet = new Set();
    (allRows || []).forEach((r) => {
      const rec = state.worksByFileId[r.fileId];
      if (!rec) return;
      const sum = getWorkSummary(rec);
      (sum.activityNames || []).forEach((name) => actSet.add(name));
    });
    const sorted = Array.from(actSet).sort((a, b) => a.localeCompare(b));
    const prev = state.activeActivityFilter;
    sel.innerHTML =
      `<option value="all">All Activities (${sorted.length})</option>` +
      sorted.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
    sel.value = sorted.includes(prev) ? prev : 'all';
    state.activeActivityFilter = sel.value;
  }

  function updateToolbarUI(table) {
    const toolbar = document.getElementById('p3h-toolbar');
    if (!toolbar || !table) return;

    const allRows = getAllTableRowsMeta(table);
    updateActivityFilterOptions(allRows);

    const counts = { all: allRows.length };
    FILTER_COUNT_KEYS.forEach((k) => {
      counts[k] = 0;
    });

    allRows.forEach((r) => {
      const rec = state.worksByFileId[r.fileId];
      const sum = getWorkSummary(rec);
      FILTER_COUNT_KEYS.forEach((k) => {
        if (matchesFilter(sum, rec, k, 'all')) counts[k]++;
      });
    });

    toolbar.querySelectorAll('[data-p3h-filter]').forEach((btn) => {
      const fKey = btn.getAttribute('data-p3h-filter');
      btn.classList.toggle('p3h-active', fKey === state.activeFilter);
      const cntEl = btn.querySelector('.p3h-pill-count');
      if (cntEl && Object.hasOwn(counts, fKey)) {
        cntEl.textContent = String(counts[fKey]);
      }
    });

    const scanBtn = toolbar.querySelector('#p3h-scan-btn');
    const syncBtn = toolbar.querySelector('#p3h-sync-missing-btn');
    const pauseBtn = toolbar.querySelector('#p3h-pause-btn');
    const rescanBtn = toolbar.querySelector('#p3h-rescan-btn');
    const rescanFilteredBtn = toolbar.querySelector('#p3h-rescan-filtered-btn');
    const rescanPickerBtn = toolbar.querySelector('#p3h-rescan-picker-btn');
    const clearBtn = toolbar.querySelector('#p3h-clear-btn');
    const statusEl = toolbar.querySelector('#p3h-status-text');
    const fillEl = toolbar.querySelector('#p3h-progress-fill');

    if (scanBtn) {
      scanBtn.disabled = state.isScanning;
      scanBtn.textContent =
        counts.unscanned === 0 && allRows.length > 0
          ? 'All Scanned'
          : counts.unscanned < allRows.length
          ? `Scan Remaining (${counts.unscanned})`
          : `Scan All Works (${allRows.length})`;
    }

    if (syncBtn) {
      syncBtn.disabled = state.isScanning || counts.missing_details === 0;
      syncBtn.textContent = `Sync Missing (${counts.missing_details})`;
    }

    if (rescanBtn) rescanBtn.disabled = state.isScanning;
    if (clearBtn) clearBtn.disabled = state.isScanning;
    if (rescanFilteredBtn) {
      rescanFilteredBtn.disabled = state.isScanning;
      if (state.activeFilter !== 'all' || state.activeActivityFilter !== 'all') {
        const filteredQueue = getTargetedQueueRows(allRows, [state.activeFilter], {
          includeArchivedMissing: state.pickerIncludeArchivedMissing,
          activityFilter: state.activeActivityFilter,
        });
        rescanFilteredBtn.textContent = `Update Filtered (${filteredQueue.length})`;
      } else {
        rescanFilteredBtn.textContent = 'Update Filtered...';
      }
    }
    if (rescanPickerBtn) rescanPickerBtn.disabled = state.isScanning;
    if (pauseBtn) pauseBtn.style.display = state.isScanning ? 'inline-flex' : 'none';

    const scannedCount = allRows.length - counts.unscanned;
    const completeCount = allRows.length - counts.missing_details;
    const pct =
      state.isScanning && state.scanTotal > 0
        ? Math.min(100, Math.round(((state.scanDone + state.scanErrors) / state.scanTotal) * 100))
        : allRows.length
        ? Math.round((scannedCount / allRows.length) * 100)
        : 0;
    if (fillEl) fillEl.style.width = pct + '%';

    if (statusEl) {
      if (state.statusMessage) {
        statusEl.textContent = state.statusMessage;
      } else {
        const mismatchParts = [];
        if (counts.unscanned > 0) mismatchParts.push(`⚠ ${counts.unscanned} new not saved`);
        const incompleteScanned = Math.max(0, counts.missing_details - counts.unscanned);
        if (incompleteScanned > 0) mismatchParts.push(`${incompleteScanned} missing fields`);
        const mismatchStr = mismatchParts.length ? ` · ${mismatchParts.join(' · ')}` : '';
        statusEl.textContent =
          `Listed: ${scannedCount}/${allRows.length} scanned (${completeCount} complete)${mismatchStr} | ` +
          `Saved Data: ${state.dbCounts.activeCount} active, ${state.dbCounts.archivedCount} finalized, ${
            state.dbCounts.manualArchivedCount || 0
          } manual arch`;
      }
    }
  }

  function updateScanProgressUI(statusText) {
    if (typeof statusText === 'string') {
      state.statusMessage = statusText;
    }
    const toolbar = document.getElementById('p3h-toolbar');
    if (!toolbar) return;
    const statusEl = toolbar.querySelector('#p3h-status-text');
    const fillEl = toolbar.querySelector('#p3h-progress-fill');
    if (statusEl && state.statusMessage) {
      statusEl.textContent = state.statusMessage;
    }
    if (fillEl && state.scanTotal > 0) {
      const pct = Math.min(
        100,
        Math.round(((state.scanDone + state.scanErrors) / state.scanTotal) * 100)
      );
      fillEl.style.width = pct + '%';
    }
  }

  function formatScanProgressMessage({
    startIndex,
    sliceCount,
    total,
    firstFileNumber,
    processed,
    batchSize,
    elapsedSec,
  }) {
    const start = Math.max(0, Number(startIndex) || 0);
    const count = Math.max(1, Number(sliceCount) || 1);
    const tot = Math.max(1, Number(total) || 1);
    const rangeLabel = count > 1 ? `${start + 1}–${start + count}` : `${start + 1}`;
    let etaStr = '';
    if (processed >= batchSize && elapsedSec >= 0.4) {
      const rate = processed / elapsedSec;
      if (rate > 0) {
        const remainingSec = Math.max(0, Math.round((tot - processed) / rate));
        const etaText =
          remainingSec >= 60
            ? `${Math.floor(remainingSec / 60)}m ${remainingSec % 60}s`
            : `${remainingSec}s`;
        etaStr = ` (~${etaText} left)`;
      }
    }
    const fileSuffix = firstFileNumber ? `: ${firstFileNumber}...` : '...';
    return `Scanning ${rangeLabel}/${tot}${etaStr}${fileSuffix}`;
  }

  function runQueueScan(queue, options) {
    if (state.isScanning && activeScanPromise) return activeScanPromise;
    if (!state.currentTable) return Promise.resolve();

    const opts = options || {};
    const includeDetails = opts.includeDetails !== false;

    if (!queue || queue.length === 0) {
      setTransientStatus(opts.emptyMessage || 'No matching works to scan.');
      return Promise.resolve();
    }

    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
      statusClearTimer = null;
    }

    const concurrency = [1, 6, 12].includes(state.scanConcurrency) ? state.scanConcurrency : 6;
    const batchSize = concurrency;
    activeScanAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

    state.isScanning = true;
    state.pauseRequested = false;
    state.scanDone = 0;
    state.scanTotal = queue.length;
    state.scanErrors = 0;
    state.statusMessage = `Starting scan for ${queue.length} work(s)...`;
    updateToolbarUI(state.currentTable);

    const startedAt = Date.now();

    activeScanPromise = (async () => {
      try {
        for (let i = 0; i < queue.length; i += batchSize) {
          if (
            state.pauseRequested ||
            (activeScanAbortController && activeScanAbortController.signal.aborted)
          ) {
            state.statusMessage = `Paused at ${i}/${queue.length}.`;
            break;
          }

          const batchSlice = queue.slice(i, i + batchSize);
          const processed = state.scanDone + state.scanErrors;
          const elapsedSec = (Date.now() - startedAt) / 1000;
          updateScanProgressUI(
            formatScanProgressMessage({
              startIndex: i,
              sliceCount: batchSlice.length,
              total: queue.length,
              firstFileNumber: batchSlice[0] && batchSlice[0].fileNumber,
              processed,
              batchSize,
              elapsedSec,
            })
          );

          try {
            const existingByFileId = Object.create(null);
            batchSlice.forEach((r) => {
              if (r && r.fileId && state.worksByFileId[r.fileId]) {
                existingByFileId[r.fileId] = state.worksByFileId[r.fileId];
              }
            });

            const batchRes = await extractor.fetchBatchWorksFromPortal(batchSlice, {
              concurrency,
              delayMs: concurrency === 1 ? 80 : 0,
              includeDetails,
              existingByFileId,
              signal: activeScanAbortController ? activeScanAbortController.signal : undefined,
            });

            if (batchRes.results.length > 0) {
              const saved = await db.putWorksBatch(
                batchRes.results,
                extractor.analyzeWorkRecord,
                { returnRecords: true }
              );
              const recMap = (saved && saved.recordsByFileId) || {};
              batchRes.results.forEach((rec) => {
                const fid = String(rec.fileId);
                const stored = Object.hasOwn(recMap, fid) ? recMap[fid] : rec;
                state.worksByFileId[fid] = stored;
                if (state.currentTable && state.currentTable.isConnected) {
                  renderVisibleRowBadges(state.currentTable, true, fid);
                }
              });
            }

            state.scanDone += batchRes.results.length;
            state.scanErrors += batchRes.errors.length;
            updateScanProgressUI();
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (msg === 'SESSION_EXPIRED' || msg === 'NO_TOKEN') {
              state.statusMessage =
                'Scan stopped: PRICE 3.0 session expired or token missing. Please reload/login.';
              break;
            }
            if (msg === 'ABORTED') {
              state.statusMessage = `Paused at ${state.scanDone + state.scanErrors}/${queue.length}.`;
              break;
            }
            state.scanErrors += batchSlice.length;
            updateScanProgressUI();
          }

          if (concurrency === 1 && !state.pauseRequested) {
            await extractor.sleep(80);
          }
        }

        state.dbCounts = await db.getCounts();
        const finalMsg =
          !state.pauseRequested && !/stopped:|Paused/i.test(state.statusMessage)
            ? `Scan finished: ${state.scanDone}/${queue.length} works updated (errors: ${state.scanErrors}).`
            : state.statusMessage;
        state.isScanning = false;
        state.pauseRequested = false;
        setTransientStatus(finalMsg, 7000);
        if (state.currentTable && state.currentTable.isConnected) {
          applyActiveFilterToTable(state.currentTable, false);
          renderVisibleRowBadges(state.currentTable, true);
          updateToolbarUI(state.currentTable);
        }
        await register.refreshIfOpen();
      } finally {
        activeScanAbortController = null;
        state.isScanning = false;
        state.pauseRequested = false;
        activeScanPromise = null;
      }
    })();

    return activeScanPromise;
  }

  function runScanRemaining() {
    if (!state.currentTable) return;
    const allRows = getAllTableRowsMeta(state.currentTable);
    const queue = allRows.filter((r) => !state.worksByFileId[r.fileId]);
    runQueueScan(queue, {
      includeDetails: true,
      emptyMessage:
        'All listed works are already saved. Use "Sync Missing" or "Update Filtered" to refresh.',
    });
  }

  function runSyncMissing() {
    if (!state.currentTable) return;
    const allRows = getAllTableRowsMeta(state.currentTable);
    const queue = allRows.filter((r) => {
      const rec = state.worksByFileId[r.fileId];
      if (!rec) return true;
      const sum = getWorkSummary(rec);
      if (isFullyManuallyArchived(rec, sum)) return false;
      return extractor.getMissingFields(rec, sum).isIncomplete;
    });
    runQueueScan(queue, {
      includeDetails: true,
      emptyMessage: 'No new or incomplete works found — all listed data is up to date.',
    });
  }

  function runRescanAll() {
    if (!state.currentTable) return;
    const allRows = getAllTableRowsMeta(state.currentTable);
    const activeOrIncomplete = allRows.filter((r) => {
      const rec = state.worksByFileId[r.fileId];
      const sum = getWorkSummary(rec);
      if (isFullyManuallyArchived(rec, sum)) return false;
      if (!isWorkArchivedRec(rec, sum)) return true;
      return extractor.getMissingFields(rec, sum).isIncomplete;
    });
    const skippedArchived = allRows.length - activeOrIncomplete.length;

    let queue = activeOrIncomplete;
    if (skippedArchived > 0) {
      if (activeOrIncomplete.length === 0) {
        if (
          !confirm(
            `All ${allRows.length} listed works are archived and complete. Force rescan all of them?`
          )
        ) {
          return;
        }
        queue = allRows;
      } else {
        const msg =
          `Rescan ${activeOrIncomplete.length} active/incomplete works?\n\n` +
          `(${skippedArchived} finalized or manually archived works are skipped for speed. ` +
          `Click Cancel to abort, or use the individual drawer Refresh to update an archived work.)`;
        if (!confirm(msg)) return;
      }
    }

    runQueueScan(queue, { includeDetails: state.pickerIncludeDetails });
  }

  function renderTargetPickerPopover() {
    const pop = document.getElementById('p3h-rescan-popover');
    if (!pop || !state.currentTable) return;
    const allRows = getAllTableRowsMeta(state.currentTable);
    const previewQueue = getTargetedQueueRows(allRows, state.pickerTargets, {
      includeArchivedMissing: state.pickerIncludeArchivedMissing,
      activityFilter: state.activeActivityFilter,
    });

    pop.innerHTML = `
      <div style="font-weight:700;font-size:12px;margin-bottom:6px;color:#0f172a;">Select Categories to Update</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px;">Automatically skips complete archived works unless checked below.</div>
      <div class="p3h-picker-list">
        ${TARGET_OPTIONS.map((opt) => {
          const cnt = getTargetedQueueRows(allRows, [opt.key], {
            includeArchivedMissing: state.pickerIncludeArchivedMissing,
            activityFilter: state.activeActivityFilter,
          }).length;
          return `
            <label class="p3h-col-check">
              <input type="checkbox" data-target-key="${escapeHtml(opt.key)}" ${
                state.pickerTargets.has(opt.key) ? 'checked' : ''
              } />
              <span>${escapeHtml(opt.label)} (${cnt})</span>
            </label>`;
        }).join('')}
      </div>
      <div style="border-top:1px solid #e2e8f0;margin:8px 0;padding-top:8px;">
        <label class="p3h-col-check" title="Fetch AS/TS, Agreement, Contractor, SHO Date, M-Book &amp; Constituency">
          <input type="checkbox" id="p3h-picker-details-chk" ${
            state.pickerIncludeDetails ? 'checked' : ''
          } />
          <span>Fetch Project Details (AS/TS/Agreement/SHO/LAC)</span>
        </label>
        <label class="p3h-col-check" title="Also rescan archived works that are missing fields">
          <input type="checkbox" id="p3h-picker-arch-missing-chk" ${
            state.pickerIncludeArchivedMissing ? 'checked' : ''
          } />
          <span>Include Archived works with missing fields</span>
        </label>
        <div class="p3h-picker-speed-row">
          <label for="p3h-picker-speed-sel">Scan Speed:</label>
          <select id="p3h-picker-speed-sel" class="p3h-select">
            <option value="6" ${state.scanConcurrency === 6 ? 'selected' : ''}>Standard</option>
            <option value="12" ${state.scanConcurrency === 12 ? 'selected' : ''}>Fast</option>
            <option value="1" ${state.scanConcurrency === 1 ? 'selected' : ''}>Safe (Slow)</option>
          </select>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px;">
        <button type="button" class="p3h-btn" id="p3h-picker-cancel">Close</button>
        <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-picker-start" ${
          previewQueue.length === 0 ? 'disabled' : ''
        }>Start Targeted Update (${previewQueue.length})</button>
      </div>
    `;

    pop.querySelectorAll('input[data-target-key]').forEach((inp) => {
      inp.onchange = () => {
        const key = inp.getAttribute('data-target-key');
        if (inp.checked) state.pickerTargets.add(key);
        else state.pickerTargets.delete(key);
        renderTargetPickerPopover();
      };
    });

    const detChk = pop.querySelector('#p3h-picker-details-chk');
    if (detChk) {
      detChk.onchange = () => {
        state.pickerIncludeDetails = detChk.checked;
      };
    }

    const archMissingChk = pop.querySelector('#p3h-picker-arch-missing-chk');
    if (archMissingChk) {
      archMissingChk.onchange = () => {
        state.pickerIncludeArchivedMissing = archMissingChk.checked;
        renderTargetPickerPopover();
      };
    }

    const speedSel = pop.querySelector('#p3h-picker-speed-sel');
    if (speedSel) {
      speedSel.onchange = () => {
        const val = parseInt(speedSel.value, 10);
        state.scanConcurrency = [1, 6, 12].includes(val) ? val : 6;
        db.setSetting('scan_concurrency', state.scanConcurrency).catch(() => {});
      };
    }

    pop.querySelector('#p3h-picker-cancel').onclick = () => {
      pop.style.display = 'none';
    };

    pop.querySelector('#p3h-picker-start').onclick = () => {
      pop.style.display = 'none';
      const q = getTargetedQueueRows(getAllTableRowsMeta(state.currentTable), state.pickerTargets, {
        includeArchivedMissing: state.pickerIncludeArchivedMissing,
        activityFilter: state.activeActivityFilter,
      });
      runQueueScan(q, { includeDetails: state.pickerIncludeDetails });
    };
  }

  function exportFilteredCsv() {
    if (!state.currentTable) return;
    const allRows = getAllTableRowsMeta(state.currentTable);
    let searchSet = null;
    if (state.hasDt && extractor && typeof extractor.syncBridgeCall === 'function') {
      const searchRes = extractor.syncBridgeCall('dt:getSearchAppliedFileIds', {
        selector: TABLE_SELECTOR,
      });
      if (searchRes && searchRes.bridged && searchRes.ok && searchRes.result && searchRes.result.hasDt) {
        searchSet = new Set(searchRes.result.fileIds || []);
      }
    }

    const filtered = allRows.filter((r) => {
      if (searchSet && !searchSet.has(r.fileId)) return false;
      const rec = state.worksByFileId[r.fileId];
      return matchesFilter(
        getWorkSummary(rec),
        rec,
        state.activeFilter,
        state.activeActivityFilter
      );
    });

    const headers = [
      'No',
      'File Number',
      'Subject',
      'Activities',
      'Classification',
      'Constituency (LAC)',
      'AS No. & Date',
      'TS No. & Date',
      'Agreement No',
      'Date of Agreement',
      'Agreed PAC (INR)',
      'Contractor Name',
      'Period of Completion',
      'Date of Handing Over',
      'Date of Completion',
      'Extended Date of Completion',
      'Extension Fine (INR)',
      'Status of Work',
      'Physical Progress (%)',
      'Schedule Status',
      'Components Finalized',
      'Part Bills',
      'Pre-Final',
      'Final Bills',
      'Cancelled Bills',
      'Latest Bill Type & No',
      'Latest Status',
      'Pending With',
      'Financial Status Billed (INR)',
      'Financial Status (%)',
      'Manual Archive Reason',
      'Created By',
      'Created On',
      'File ID',
    ];

    const fmtNoDate = (no, dt) => (no && dt ? `${no} (${dt})` : no || dt || '');
    const lines = [headers.map(csvEscape).join(',')];

    filtered.forEach((r, idx) => {
      const rec = state.worksByFileId[r.fileId];
      const sum = getWorkSummary(rec);
      const pd = (rec && rec.projectDetails) || {};
      const ctr = pd.contractor || {};
      const uFields = db.getEffectiveUserFields(rec);
      const regRow =
        rec && register && typeof register.buildRegisterRow === 'function'
          ? register.buildRegisterRow(rec, idx)
          : null;
      const schedDates = regRow ? null : extractor.resolveScheduleDates(pd);
      const compDate = regRow ? regRow.completionDate : schedDates.completionDate;
      const schedLabel = regRow
        ? regRow.scheduleStatusLabel
        : extractor.computeScheduleStatus(
            compDate,
            sum.isFullyFinalized,
            undefined,
            uFields.extendedCompletionDate
          ).label;
      const fin = regRow ? null : extractor.computeWorkFinancialStatus(rec, sum);
      const finPct = regRow ? regRow.financialPct : fin.pct;
      const compRatio =
        sum.scanned && sum.trackableCompCount > 0
          ? `${sum.finalizedTrackableCompCount}/${sum.trackableCompCount}`
          : '';

      lines.push(
        [
          idx + 1,
          r.fileNumber,
          r.subject,
          (sum.activityNames || []).join(', '),
          sum.label,
          regRow ? regRow.constituency : pd.constituency || '',
          regRow ? regRow.asNoDateText : fmtNoDate(pd.asNo, pd.asDate),
          regRow ? regRow.tsNoDateText : fmtNoDate(pd.tsNo, pd.tsDate),
          regRow ? regRow.agreementNo : pd.agreementNo || '',
          regRow ? regRow.agreementDate : schedDates.agreementDate || '',
          regRow ? regRow.agreedPac : pd.agreedPac || '',
          regRow ? regRow.contractorName : ctr.name || '',
          regRow ? regRow.periodText : schedDates.periodText || '',
          regRow ? regRow.shoDate : schedDates.shoDate || '',
          compDate,
          regRow ? regRow.extendedCompletionDate : uFields.extendedCompletionDate || '',
          regRow
            ? regRow.extensionFine > 0
              ? regRow.extensionFine.toFixed(2)
              : ''
            : uFields.totalFine > 0
            ? uFields.totalFine.toFixed(2)
            : '',
          regRow ? regRow.workStatus : uFields.workStatus || '',
          regRow
            ? regRow.physicalProgress !== null
              ? `${regRow.physicalProgress}%`
              : ''
            : uFields.physicalProgress !== null
            ? `${uFields.physicalProgress}%`
            : '',
          schedLabel,
          compRatio,
          sum.partCount,
          sum.preFinalCount,
          sum.finalCount,
          sum.cancelledCount,
          sum.latestBill ? sum.latestBill.billTypeAndNo : '',
          sum.latestBill ? sum.latestBill.status : '',
          sum.latestBill ? sum.latestBill.pendingWith : '',
          sum.totalActiveAmount.toFixed(2),
          finPct !== null ? `${finPct}%` : '',
          (uFields.manualArchive && uFields.manualArchive.reason) || '',
          r.createdBy,
          r.createdOn,
          r.fileId,
        ]
          .map(csvEscape)
          .join(',')
      );
    });

    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `price_works_${state.activeFilter}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 5000);
  }

  function ensureDrawerElements() {
    if (document.getElementById('p3h-drawer')) return;
    const backdrop = document.createElement('div');
    backdrop.id = 'p3h-drawer-backdrop';
    backdrop.className = 'p3h-drawer-backdrop';
    backdrop.onclick = closeDrawer;

    const drawer = document.createElement('aside');
    drawer.id = 'p3h-drawer';
    drawer.className = 'p3h-drawer';
    drawer.innerHTML = `
      <datalist id="p3h-drawer-status-list">
        ${WORK_STATUS_PRESETS.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('')}
      </datalist>
      <div class="p3h-drawer-header">
        <div>
          <h4 class="p3h-drawer-title" id="p3h-drawer-title">Work Bills &amp; Details</h4>
          <div class="p3h-drawer-subtitle" id="p3h-drawer-subtitle"></div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button type="button" class="p3h-btn" id="p3h-drawer-refresh">Refresh</button>
          <button type="button" class="p3h-btn" id="p3h-drawer-close">Close</button>
        </div>
      </div>
      <div class="p3h-drawer-body" id="p3h-drawer-body"></div>
    `;
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    drawer.querySelector('#p3h-drawer-close').onclick = closeDrawer;
  }

  function closeDrawer() {
    state.drawerFileId = null;
    state.drawerScopeKey = '';
    document.getElementById('p3h-drawer-backdrop')?.classList.remove('p3h-open');
    document.getElementById('p3h-drawer')?.classList.remove('p3h-open');
  }

  function renderProjectDetailsCard(workRecord, summary) {
    const pd = workRecord && workRecord.projectDetails;
    const isWorkManArch = Boolean(
      workRecord &&
        workRecord.userData &&
        workRecord.userData.manualArchive &&
        workRecord.userData.manualArchive.archived
    );
    const workArchBtn = workRecord
      ? isWorkManArch
        ? `<button type="button" class="p3h-btn p3h-btn-sm" id="p3h-drawer-restore-work">Restore Work</button>`
        : `<button type="button" class="p3h-btn p3h-btn-sm p3h-btn-danger" id="p3h-drawer-archive-work">Archive Work</button>`
      : '';
    const manArchBanner =
      isWorkManArch && workRecord.userData.manualArchive
        ? `<div style="padding:6px 12px;border-bottom:1px solid #e2e8f0;background:#f5f3ff;font-size:11.5px;color:#5b21b6;"><strong>Manually Archived:</strong> ${escapeHtml(
            workRecord.userData.manualArchive.reason || 'Archived'
          )} (${escapeHtml(db.formatProgressTimestamp(workRecord.userData.manualArchive.archivedAt))})</div>`
        : '';

    if (!pd || !pd.fetchedAt) {
      return `
        <div class="p3h-meta-card">
          <div class="p3h-meta-card-head">
            <span>Project Details (AS / TS / Agreement / SHO / Constituency)</span>
            <span style="display:flex;gap:6px;align-items:center;">
              <span class="p3h-badge p3h-badge-unscanned">Not Fetched</span>
              ${workArchBtn}
            </span>
          </div>
          ${manArchBanner}
          <div id="p3h-drawer-arch-prompt"></div>
          <div style="padding:8px 10px;font-size:12px;color:#64748b;">
            Click <strong>Refresh</strong> above to extract AS, TS, Agreement, Contractor, SHO Date, M-Book &amp; Constituency from PRICE 3.0.
          </div>
        </div>
      `;
    }

    const ctr = pd.contractor || {};
    const uFields = db.getEffectiveUserFields(workRecord);
    const schedDates = extractor.resolveScheduleDates(pd);
    const completionDate = schedDates.completionDate;
    const sched = extractor.computeScheduleStatus(
      completionDate,
      summary.isFullyFinalized,
      undefined,
      uFields.extendedCompletionDate
    );
    const schedCls =
      sched.key === 'overdue'
        ? 'p3h-badge-overdue'
        : sched.key === 'completed'
        ? 'p3h-badge-final'
        : sched.key === 'ongoing'
        ? 'p3h-badge-part'
        : 'p3h-badge-nobill';

    const finStatus = extractor.computeWorkFinancialStatus(workRecord, summary);
    const finTxt =
      finStatus.billedAmount > 0 || finStatus.pct !== null
        ? `${finStatus.billedAmount > 0 ? '₹' + extractor.formatInr(finStatus.billedAmount) : '₹0.00'}${
            finStatus.pct !== null ? ` (${finStatus.pct}% of Adj. TS ₹${extractor.formatInr(finStatus.adjustedTsAmount)})` : ''
          }`
        : '';

    const val = (x) => (x ? escapeHtml(x) : '<span style="color:#94a3b8;">—</span>');
    const pacText = pd.agreedPac ? '₹' + extractor.formatInr(extractor.parseInr(pd.agreedPac)) : '';
    const fineText = uFields.totalFine > 0 ? '₹' + extractor.formatInr(uFields.totalFine) : '';
    const missing = extractor.getMissingFields(workRecord, summary);
    const activities = summary.activities || [];

    if (summary && summary.hasIndependentActivities) {
      const lacSet = new Set();
      const parlSet = new Set();
      activities.forEach((a) => {
        const d = a && a.details;
        if (!d) return;
        String(d.constituency || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((v) => lacSet.add(v));
        String(d.parliamentConstituency || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((v) => parlSet.add(v));
      });
      const projLac = lacSet.size > 0 ? Array.from(lacSet).join(', ') : pd.constituency || '';
      const projParl =
        parlSet.size > 0 ? Array.from(parlSet).join(', ') : pd.parliamentConstituency || '';
      const hasAggregatedTs =
        finStatus.basis === 'multi_activity_sum' || finStatus.basis === 'composite_group_sum';
      const projFinTxt =
        finStatus.billedAmount > 0 || (hasAggregatedTs && finStatus.pct !== null)
          ? `${
              finStatus.billedAmount > 0
                ? '₹' + extractor.formatInr(finStatus.billedAmount)
                : '₹0.00'
            }${
              hasAggregatedTs && finStatus.pct !== null
                ? ` (${finStatus.pct}% of Total Adj. TS ₹${extractor.formatInr(
                    finStatus.adjustedTsAmount
                  )})`
                : ''
            }`
          : '';
      const actCountText = `${activities.length}${
        summary.trackableCompCount > 0
          ? ` (${summary.finalizedTrackableCompCount}/${summary.trackableCompCount} finalized)`
          : ''
      }`;
      return `
        <div class="p3h-meta-card">
          <div class="p3h-meta-card-head">
            <span>Project Overview</span>
            <span style="display:flex;gap:6px;align-items:center;">
              <span class="p3h-badge p3h-badge-nobill">${escapeHtml(
                String(activities.length)
              )} Activities</span>
              ${workArchBtn}
            </span>
          </div>
          ${manArchBanner}
          <div id="p3h-drawer-arch-prompt"></div>
          <div class="p3h-meta-grid">
            <div><span class="p3h-meta-lbl">Constituency (LAC):</span> ${val(projLac)}</div>
            <div><span class="p3h-meta-lbl">Parliament:</span> ${val(projParl)}</div>
            <div><span class="p3h-meta-lbl">Activities:</span> ${escapeHtml(actCountText)}</div>
            <div><span class="p3h-meta-lbl">Total Financial Status:</span> ${val(projFinTxt)}</div>
          </div>
          <div class="p3h-meta-note">This work has multiple independent activities. AS, TS, Agreement, Contractor, Financial Status, Schedule, and Progress details are shown under each activity below.</div>
          ${
            missing.isIncomplete
              ? `<div style="padding:6px 12px;border-top:1px solid #e2e8f0;background:#fffbeb;font-size:11px;color:#92400e;"><strong>Missing / Pending Refresh:</strong> ${escapeHtml(
                  missing.missing.join(', ')
                )}</div>`
              : ''
          }
        </div>
      `;
    }

    return `
      <div class="p3h-meta-card">
        <div class="p3h-meta-card-head">
          <span>Project Metadata</span>
          <span style="display:flex;gap:6px;align-items:center;">
            <span class="p3h-badge ${schedCls}">${escapeHtml(sched.label)}</span>
            ${workArchBtn}
          </span>
        </div>
        ${manArchBanner}
        <div id="p3h-drawer-arch-prompt"></div>
        <div class="p3h-meta-grid">
          <div><span class="p3h-meta-lbl">Constituency (LAC):</span> ${val(pd.constituency)}</div>
          <div><span class="p3h-meta-lbl">Parliament:</span> ${val(pd.parliamentConstituency)}</div>
          <div><span class="p3h-meta-lbl">AS No. &amp; Date:</span> ${val(pd.asNo)} ${pd.asDate ? '(' + escapeHtml(pd.asDate) + ')' : ''}</div>
          <div><span class="p3h-meta-lbl">TS No. &amp; Date:</span> ${val(pd.tsNo)} ${pd.tsDate ? '(' + escapeHtml(pd.tsDate) + ')' : ''}</div>
          <div><span class="p3h-meta-lbl">Agreement No. &amp; Date:</span> ${val(pd.agreementNo)} ${pd.agreementDate ? '(' + escapeHtml(pd.agreementDate) + ')' : ''}${pd.isUrgentPreAgreement && !pd.agreementNo ? ' <span class="p3h-badge p3h-badge-part">Urgent (Pre-Agmt)</span>' : ''}</div>
          <div><span class="p3h-meta-lbl">Agreed PAC / Rate:</span> ${val(pacText)}${pd.negotiatedRate ? ` · ${escapeHtml(pd.negotiatedRate)}` : ''}</div>
          <div><span class="p3h-meta-lbl">Financial Status:</span> ${val(finTxt)}</div>
          <div><span class="p3h-meta-lbl">Contractor:</span> ${val(ctr.name)} ${ctr.mobile ? '· ' + escapeHtml(ctr.mobile) : ''}</div>
          <div><span class="p3h-meta-lbl">Contractor PAN / Email:</span> ${val(ctr.pan)} ${ctr.email ? '· ' + escapeHtml(ctr.email) : ''}</div>
          <div><span class="p3h-meta-lbl">Period of Completion:</span> ${val(schedDates.periodText)}</div>
          <div><span class="p3h-meta-lbl">Contractor Signed:</span> ${val(schedDates.contractorSignedDate)}</div>
          <div><span class="p3h-meta-lbl">Handing Over (SHO):</span> ${val(schedDates.shoDate)}</div>
          <div><span class="p3h-meta-lbl">Agreement Completion:</span> <strong>${val(completionDate)}</strong></div>
          <div><span class="p3h-meta-lbl">Extended Completion:</span> <strong>${val(uFields.extendedCompletionDate)}</strong> ${uFields.extensionOrder ? '<span class="p3h-badge p3h-badge-part">' + escapeHtml(db.formatOrdinal(uFields.extensionOrder)) + '</span>' : ''}</div>
          <div><span class="p3h-meta-lbl">Extension Fine:</span> ${val(fineText)}</div>
          <div><span class="p3h-meta-lbl">Status of Work:</span> ${val(uFields.workStatus)}</div>
          <div><span class="p3h-meta-lbl">Physical Progress:</span> ${uFields.physicalProgress !== null ? escapeHtml(uFields.physicalProgress + '%') : val('')}</div>
        </div>
        ${
          missing.isIncomplete
            ? `<div style="padding:6px 12px;border-top:1px solid #e2e8f0;background:#fffbeb;font-size:11px;color:#92400e;"><strong>Missing / Pending Refresh:</strong> ${escapeHtml(
                missing.missing.join(', ')
              )}</div>`
            : ''
        }
      </div>
    `;
  }

  function renderUserTrackingEditorCard(workRecord, summary) {
    const activities = (summary.activities || []).filter((a) => !a.isDeactivated);
    const ud = db.normalizeUserData(workRecord && workRecord.userData);
    const scopeKey = activities.some((a) => a.activityKey === state.drawerScopeKey)
      ? state.drawerScopeKey
      : '';
    const scopeData = scopeKey
      ? (ud.activityOverrides && Object.hasOwn(ud.activityOverrides, scopeKey) && ud.activityOverrides[scopeKey]) || {
          extensions: [],
          workStatus: '',
          physicalProgress: null,
          progressHistory: [],
        }
      : ud;

    const exts = (scopeData.extensions || []).map((e) => ({ ...e }));
    const history = scopeData.progressHistory || [];

    return `
      <div class="p3h-meta-card p3h-ud-card" id="p3h-ud-card">
        <div class="p3h-meta-card-head">
          <span>Extensions, Work Status &amp; Milestone Progress</span>
          ${
            activities.length > 1
              ? `<select id="p3h-ud-scope" class="p3h-select" style="font-size:11px;padding:2px 6px;">
                  <option value="">Project Level (All)</option>
                  ${activities
                    .map((a) => {
                      const hasOv = Boolean(
                        ud.activityOverrides &&
                          Object.hasOwn(ud.activityOverrides, a.activityKey)
                      );
                      return `<option value="${escapeHtml(a.activityKey)}" ${
                        scopeKey === a.activityKey ? 'selected' : ''
                      }>Activity: ${escapeHtml(a.activityName)}${hasOv ? ' ★' : ''}</option>`;
                    })
                    .join('')}
                </select>`
              : ''
          }
        </div>
        <div class="p3h-ud-body">
          <div class="p3h-ud-grid">
            <label class="p3h-ud-field">
              <span>Status of Work</span>
              <input type="text" id="p3h-ud-status" list="p3h-drawer-status-list" class="p3h-input" value="${escapeHtml(
                scopeData.workStatus || ''
              )}" placeholder="e.g., In Progress, Wiring Completed..." />
            </label>
            <label class="p3h-ud-field" style="max-width:150px;">
              <span>Physical Progress (%)</span>
              <input type="number" id="p3h-ud-progress" min="0" max="100" step="1" class="p3h-input" value="${
                scopeData.physicalProgress !== null && scopeData.physicalProgress !== undefined
                  ? escapeHtml(scopeData.physicalProgress)
                  : ''
              }" placeholder="0 - 100" />
            </label>
          </div>
          <label class="p3h-ud-field" style="margin-top:6px;">
            <span>Milestone Remarks / Site Note (optional)</span>
            <input type="text" id="p3h-ud-remarks" class="p3h-input" placeholder="Optional note logged with this timestamped milestone..." />
          </label>

          <div style="margin-top:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <strong style="font-size:12px;color:#334155;">Time Extensions</strong>
              <button type="button" class="p3h-btn" id="p3h-ud-add-ext">+ Add ${escapeHtml(
                db.formatOrdinal(exts.length + 1)
              )} Extension</button>
            </div>
            <div id="p3h-ud-ext-list">
              ${
                exts.length === 0
                  ? '<div style="font-size:11px;color:#64748b;padding:4px 0;">No extensions recorded.</div>'
                  : exts
                      .map(
                        (e, idx) => `
                  <div class="p3h-ext-row" data-ud-ext-idx="${idx}">
                    <span class="p3h-ext-ord">${escapeHtml(db.formatOrdinal(idx + 1))}</span>
                    <input type="date" class="p3h-input" data-ud-ext="extendedDate" value="${escapeHtml(
                      db.dmyToIso(e.extendedDate) || ''
                    )}" title="Extended Date of Completion" />
                    <input type="number" min="0" step="0.01" class="p3h-input" data-ud-ext="fineAmount" value="${
                      e.fineAmount > 0 ? escapeHtml(e.fineAmount) : ''
                    }" placeholder="Fine (₹)" style="width:95px;" />
                    <input type="text" class="p3h-input" data-ud-ext="orderNo" value="${escapeHtml(
                      e.orderNo || ''
                    )}" placeholder="Order No." style="width:100px;" />
                    <input type="text" class="p3h-input" data-ud-ext="remarks" value="${escapeHtml(
                      e.remarks || ''
                    )}" placeholder="Remarks" style="flex:1;min-width:90px;" />
                    <button type="button" class="p3h-btn p3h-btn-danger" data-ud-del="${idx}" title="Remove">×</button>
                  </div>`
                      )
                      .join('')
              }
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;padding-top:8px;border-top:1px solid #e2e8f0;">
            <span id="p3h-ud-feedback" style="font-size:11px;color:#15803d;font-weight:600;"></span>
            <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-ud-save">Save Status &amp; Extensions</button>
          </div>

          <div style="margin-top:12px;padding-top:10px;border-top:1px solid #e2e8f0;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <strong style="font-size:12px;color:#334155;">Milestone Chronology (${history.length})</strong>
              ${
                history.length > 1
                  ? `<button type="button" class="p3h-btn p3h-btn-sm" id="p3h-drawer-ms-order">${
                      state.drawerTimelineDesc ? 'Latest First ↓' : 'Oldest First ↑'
                    }</button>`
                  : ''
              }
            </div>
            <div class="p3h-drawer-ms-scroll">
              ${register.renderMilestoneTimelineHtml(history, {
                allowDelete: true,
                descending: state.drawerTimelineDesc,
              })}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renumberExtensionRows(card, addBtn) {
    if (!card) return;
    const rows = card.querySelectorAll('.p3h-ext-row');
    rows.forEach((rowEl, idx) => {
      rowEl.setAttribute('data-ud-ext-idx', String(idx));
      const ordSpan = rowEl.querySelector('.p3h-ext-ord');
      if (ordSpan) ordSpan.textContent = db.formatOrdinal(idx + 1);
      const delBtn = rowEl.querySelector('[data-ud-del]');
      if (delBtn) delBtn.setAttribute('data-ud-del', String(idx));
    });
    if (rows.length === 0) {
      const listEl = card.querySelector('#p3h-ud-ext-list');
      if (listEl) {
        listEl.innerHTML =
          '<div style="font-size:11px;color:#64748b;padding:4px 0;">No extensions recorded.</div>';
      }
    }
    if (addBtn) {
      addBtn.textContent = `+ Add ${db.formatOrdinal(rows.length + 1)} Extension`;
    }
  }

  function wireDrawerUserEditor(meta, workRecord, summary) {
    const syncAfterChange = async (updated) => {
      if (!updated) return;
      state.worksByFileId[meta.fileId] = updated;
      state.dbCounts = await db.getCounts();
      if (state.drawerFileId === meta.fileId) {
        renderDrawerContent(meta, updated);
      }
      if (state.currentTable) {
        updateToolbarUI(state.currentTable);
        renderVisibleRowBadges(state.currentTable, true, meta.fileId);
        applyActiveFilterToTable(state.currentTable, false);
      }
      await register.refreshIfOpen();
    };

    const showInlineArchivePrompt = (activityKey, label) => {
      const box = document.getElementById('p3h-drawer-arch-prompt');
      if (!box) return;
      const presets = ['Cancelled', 'Abandoned', 'Dropped', 'Superseded', 'Duplicate'];
      box.innerHTML = `
        <div class="p3h-drawer-arch-box">
          <div style="font-size:12px;font-weight:700;color:#5b21b6;margin-bottom:6px;">
            Archive ${activityKey ? 'Activity' : 'Work'}: ${escapeHtml(label)}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">
            ${presets
              .map(
                (p) =>
                  `<button type="button" class="p3h-pill" data-d-arch-pre="${escapeHtml(p)}">${escapeHtml(
                    p
                  )}</button>`
              )
              .join('')}
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="p3h-d-arch-reason" class="p3h-input" style="flex:1;" placeholder="Reason (e.g., Cancelled / Abandoned)..." />
            <button type="button" class="p3h-btn p3h-btn-warn" id="p3h-d-arch-go">Confirm</button>
            <button type="button" class="p3h-btn" id="p3h-d-arch-cancel">Cancel</button>
          </div>
        </div>
      `;
      const inp = box.querySelector('#p3h-d-arch-reason');
      box.querySelectorAll('[data-d-arch-pre]').forEach((b) => {
        b.onclick = () => {
          inp.value = b.getAttribute('data-d-arch-pre') || '';
          inp.focus();
        };
      });
      box.querySelector('#p3h-d-arch-cancel').onclick = () => {
        box.innerHTML = '';
      };
      box.querySelector('#p3h-d-arch-go').onclick = async () => {
        const reason = inp.value.trim() || 'Manually Archived';
        const updated = activityKey
          ? await db.setActivityManualArchive(
              meta.fileId,
              activityKey,
              { archived: true, reason },
              extractor.analyzeWorkRecord
            )
          : await db.setWorkManualArchive(
              meta.fileId,
              { archived: true, reason },
              extractor.analyzeWorkRecord
            );
        await syncAfterChange(updated);
      };
    };

    const archWorkBtn = document.getElementById('p3h-drawer-archive-work');
    if (archWorkBtn) {
      archWorkBtn.onclick = () => showInlineArchivePrompt('', meta.fileNumber || meta.fileId);
    }
    const restWorkBtn = document.getElementById('p3h-drawer-restore-work');
    if (restWorkBtn) {
      restWorkBtn.onclick = async () => {
        const updated = await db.setWorkManualArchive(
          meta.fileId,
          { archived: false },
          extractor.analyzeWorkRecord
        );
        await syncAfterChange(updated);
      };
    }

    const isWorkManArch = Boolean(
      workRecord &&
        workRecord.userData &&
        workRecord.userData.manualArchive &&
        workRecord.userData.manualArchive.archived
    );

    document.querySelectorAll('[data-drawer-arch-act]').forEach((btn) => {
      btn.onclick = () => {
        const actKey = btn.getAttribute('data-drawer-arch-act') || '';
        const lbl = btn.getAttribute('data-drawer-arch-lbl') || actKey;
        showInlineArchivePrompt(actKey, lbl);
        document.getElementById('p3h-drawer-body')?.scrollTo({ top: 0, behavior: 'smooth' });
      };
    });
    document.querySelectorAll('[data-drawer-rest-act]').forEach((btn) => {
      btn.onclick = async () => {
        const actKey = btn.getAttribute('data-drawer-rest-act') || '';
        const updated = await db.setActivityManualArchive(
          meta.fileId,
          actKey,
          { archived: false, clearWorkArchive: isWorkManArch },
          extractor.analyzeWorkRecord
        );
        await syncAfterChange(updated);
      };
    });
    document.querySelectorAll('[data-drawer-log-act]').forEach((btn) => {
      btn.onclick = () => {
        const actKey = btn.getAttribute('data-drawer-log-act') || '';
        state.drawerScopeKey = actKey;
        renderDrawerContent(meta, state.worksByFileId[meta.fileId] || workRecord);
        document.getElementById('p3h-ud-card')?.scrollIntoView({ behavior: 'smooth' });
      };
    });

    const card = document.getElementById('p3h-ud-card');
    if (!card) return;

    const scopeSel = card.querySelector('#p3h-ud-scope');
    if (scopeSel) {
      scopeSel.onchange = () => {
        state.drawerScopeKey = scopeSel.value;
        renderDrawerContent(meta, state.worksByFileId[meta.fileId] || workRecord);
      };
    }

    const collectPayload = () => {
      const workStatus = (card.querySelector('#p3h-ud-status')?.value || '').trim();
      const rawProg = (card.querySelector('#p3h-ud-progress')?.value || '').trim();
      const parsedProg = rawProg === '' ? null : parseFloat(rawProg);
      const remarks = (card.querySelector('#p3h-ud-remarks')?.value || '').trim();
      const extensions = [];
      card.querySelectorAll('[data-ud-ext-idx]').forEach((rowEl, idx) => {
        const entry = db.normalizeExtensionEntry(
          {
            order: idx + 1,
            extendedDate: rowEl.querySelector('[data-ud-ext="extendedDate"]')?.value || '',
            fineAmount: rowEl.querySelector('[data-ud-ext="fineAmount"]')?.value || '',
            orderNo: rowEl.querySelector('[data-ud-ext="orderNo"]')?.value || '',
            remarks: rowEl.querySelector('[data-ud-ext="remarks"]')?.value || '',
          },
          idx
        );
        extensions.push(entry);
      });
      return { workStatus, physicalProgress: parsedProg, remarks, extensions };
    };

    const persistEditorState = async () => {
      const payload = collectPayload();
      const scopeKey = db.resolveUserDataScope(workRecord, state.drawerScopeKey || '');
      const updated = await db.patchWorkUserTracking(meta.fileId, scopeKey, {
        workStatus: payload.workStatus,
        physicalProgress: payload.physicalProgress,
        extensions: payload.extensions,
        remarks: payload.remarks,
        logHistory: true,
      });
      if (!updated) return;

      await syncAfterChange(updated);
      const fb = document.getElementById('p3h-ud-feedback');
      if (fb) fb.textContent = 'Saved & Milestone Logged!';
    };

    const orderBtn = card.querySelector('#p3h-drawer-ms-order');
    if (orderBtn) {
      orderBtn.onclick = () => {
        state.drawerTimelineDesc = !state.drawerTimelineDesc;
        renderDrawerContent(meta, state.worksByFileId[meta.fileId] || workRecord);
      };
    }

    card.querySelectorAll('[data-del-ms]').forEach((btn) => {
      btn.onclick = async () => {
        const entryId = btn.getAttribute('data-del-ms');
        const scopeKey = db.resolveUserDataScope(workRecord, state.drawerScopeKey || '');
        const updated = await db.deleteProgressHistoryEntry(meta.fileId, scopeKey, entryId);
        await syncAfterChange(updated);
      };
    });

    const addBtn = card.querySelector('#p3h-ud-add-ext');
    if (addBtn) {
      addBtn.onclick = () => {
        const payload = collectPayload();
        const listEl = card.querySelector('#p3h-ud-ext-list');
        if (!listEl) return;
        const idx = payload.extensions.length;
        if (idx === 0) listEl.innerHTML = '';
        const rowDiv = document.createElement('div');
        rowDiv.className = 'p3h-ext-row';
        rowDiv.setAttribute('data-ud-ext-idx', String(idx));
        rowDiv.innerHTML = `
          <span class="p3h-ext-ord">${escapeHtml(db.formatOrdinal(idx + 1))}</span>
          <input type="date" class="p3h-input" data-ud-ext="extendedDate" value="" title="Extended Date of Completion" />
          <input type="number" min="0" step="0.01" class="p3h-input" data-ud-ext="fineAmount" value="" placeholder="Fine (₹)" style="width:95px;" />
          <input type="text" class="p3h-input" data-ud-ext="orderNo" value="" placeholder="Order No." style="width:100px;" />
          <input type="text" class="p3h-input" data-ud-ext="remarks" value="" placeholder="Remarks" style="flex:1;min-width:90px;" />
          <button type="button" class="p3h-btn p3h-btn-danger" data-ud-del="${idx}" title="Remove">×</button>
        `;
        listEl.appendChild(rowDiv);
        rowDiv.querySelector('[data-ud-del]').onclick = () => {
          rowDiv.remove();
          renumberExtensionRows(card, addBtn);
        };
        renumberExtensionRows(card, addBtn);
      };
    }

    card.querySelectorAll('[data-ud-del]').forEach((btn) => {
      btn.onclick = () => {
        const rowEl = btn.closest('.p3h-ext-row');
        if (rowEl) {
          rowEl.remove();
          renumberExtensionRows(card, addBtn);
        }
      };
    });

    const saveBtn = card.querySelector('#p3h-ud-save');
    if (saveBtn) {
      saveBtn.onclick = persistEditorState;
    }
  }

  function renderComponentCardsHtml(workRecord, summary) {
    const allComps = (summary && summary.components) || [];
    const activeComps = allComps.filter((c) => !c.isDeactivated && !c.isDeactivatedDpr);
    if (activeComps.length === 0) {
      return '<p style="color:#475569;">No active components/activities found in side menu for this work.</p>';
    }

    const isIndependentMulti = Boolean(summary && summary.hasIndependentActivities);
    const pd = (workRecord && workRecord.projectDetails) || {};
    const val = (x) => (x ? escapeHtml(x) : '<span style="color:#94a3b8;">—</span>');

    return activeComps
      .map((c) => {
        const bills = c.bills || [];
        const stagePill = `<span class="p3h-badge ${escapeHtml(c.compBadgeClass)}">${escapeHtml(
          c.compBadgeText
        )}</span>`;
        const mbookPill = c.mbookStatus
          ? ` <span class="p3h-badge ${
              /^closed$/i.test(c.mbookStatus) ? 'p3h-badge-mbook-closed' : 'p3h-badge-nobill'
            }">M-Book: ${escapeHtml(c.mbookStatus)}</span>`
          : '';
        const fallbackPd = isIndependentMulti ? null : pd;
        const actDueProg = !c.isHelper ? computeActivityPeriodProgress(c, fallbackPd) : null;
        const actSched = extractor.resolveScheduleDates(c.details, fallbackPd);
        const actComp = actSched.completionDate;
        const dueBarPill =
          actDueProg && actComp
            ? ' ' + register.renderDueDateProgressBadgeHtml(actComp, actDueProg)
            : '';

        const actKey = c.activityKey || '';
        const actUser = !c.isHelper && actKey ? db.getEffectiveUserFields(workRecord, actKey) : null;
        const isActManArch = Boolean(actUser && actUser.isActivityManuallyArchived);
        const actArchBtn =
          !c.isHelper && actKey
            ? isActManArch
              ? ` <button type="button" class="p3h-btn p3h-btn-sm" data-drawer-rest-act="${escapeHtml(
                  actKey
                )}">Restore</button>`
              : ` <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-danger" data-drawer-arch-act="${escapeHtml(
                  actKey
                )}" data-drawer-arch-lbl="${escapeHtml(c.activityName)}">Archive</button>`
            : '';
        const actLogBtn =
          !c.isHelper && actKey
            ? ` <button type="button" class="p3h-btn p3h-btn-sm" data-drawer-log-act="${escapeHtml(
                actKey
              )}" title="Edit &amp; log timestamped milestones for this activity">+ Milestone</button>`
            : '';

        const headerTitle = c.workGroup ? `${c.workGroup} → ${c.componentLabel}` : c.componentLabel;

        const actDet = c.details || null;
        let actDetailsHtml = '';
        if (isIndependentMulti && !c.isHelper) {
          const hasActDet = Boolean(
            actDet &&
              (actDet.fetchedAt ||
                actDet.asNo ||
                actDet.tsNo ||
                actDet.agreementNo ||
                actDet.agreedPac ||
                actDet.shoDate ||
                actDet.periodText ||
                actDet.constituency ||
                (actDet.contractor && actDet.contractor.name))
          );
          if (!hasActDet) {
            actDetailsHtml =
              '<div class="p3h-act-strip">Activity details not fetched yet. Click <strong>Refresh</strong> above to extract details for this activity.</div>';
          } else {
            const actCtr = actDet.contractor || {};
            const actFin = extractor.computeFinancialStatus(c.compTotalActiveAmount || 0, {
              tsAmount: actDet.tsAmount,
              negotiatedRate: actDet.negotiatedRate,
              agreedPac: actDet.agreedPac,
              estimatePac: actDet.estimatePac,
            });
            const actFinTxt =
              actFin.billedAmount > 0 || actFin.pct !== null
                ? `${
                    actFin.billedAmount > 0
                      ? '₹' + extractor.formatInr(actFin.billedAmount)
                      : '₹0.00'
                  }${
                    actFin.pct !== null
                      ? ` (${actFin.pct}% of Adj. TS ₹${extractor.formatInr(
                          actFin.adjustedTsAmount
                        )})`
                      : ''
                  }`
                : '';
            const actPacText = actDet.agreedPac
              ? '₹' + extractor.formatInr(extractor.parseInr(actDet.agreedPac))
              : '';
            const actFineText =
              actUser && actUser.totalFine > 0 ? '₹' + extractor.formatInr(actUser.totalFine) : '';
            const actSchedStatus = extractor.computeScheduleStatus(
              actComp,
              Boolean(c.isFinalized),
              undefined,
              actUser ? actUser.extendedCompletionDate : ''
            );
            const actSchedCls =
              actSchedStatus.key === 'overdue'
                ? 'p3h-badge-overdue'
                : actSchedStatus.key === 'completed'
                ? 'p3h-badge-final'
                : actSchedStatus.key === 'ongoing'
                ? 'p3h-badge-part'
                : 'p3h-badge-nobill';

            actDetailsHtml = `
              <div class="p3h-meta-grid p3h-act-meta-grid">
                <div><span class="p3h-meta-lbl">Constituency (LAC):</span> ${val(actDet.constituency)}</div>
                ${
                  actDet.parliamentConstituency
                    ? `<div><span class="p3h-meta-lbl">Parliament:</span> ${escapeHtml(
                        actDet.parliamentConstituency
                      )}</div>`
                    : ''
                }
                <div><span class="p3h-meta-lbl">AS No. &amp; Date:</span> ${val(actDet.asNo)} ${
              actDet.asDate ? '(' + escapeHtml(actDet.asDate) + ')' : ''
            }</div>
                <div><span class="p3h-meta-lbl">TS No. &amp; Date:</span> ${val(actDet.tsNo)} ${
              actDet.tsDate ? '(' + escapeHtml(actDet.tsDate) + ')' : ''
            }</div>
                <div><span class="p3h-meta-lbl">Agreement No. &amp; Date:</span> ${val(
                  actDet.agreementNo
                )} ${
              actDet.agreementDate ? '(' + escapeHtml(actDet.agreementDate) + ')' : ''
            }${
              actDet.isUrgentPreAgreement && !actDet.agreementNo
                ? ' <span class="p3h-badge p3h-badge-part">Urgent (Pre-Agmt)</span>'
                : ''
            }</div>
                <div><span class="p3h-meta-lbl">Agreed PAC / Rate:</span> ${val(actPacText)}${
              actDet.negotiatedRate ? ` · ${escapeHtml(actDet.negotiatedRate)}` : ''
            }</div>
                <div><span class="p3h-meta-lbl">Financial Status:</span> ${val(actFinTxt)}</div>
                <div><span class="p3h-meta-lbl">Contractor:</span> ${val(actCtr.name)} ${
              actCtr.mobile ? '· ' + escapeHtml(actCtr.mobile) : ''
            }</div>
                <div><span class="p3h-meta-lbl">Contractor PAN / Email:</span> ${val(actCtr.pan)} ${
              actCtr.email ? '· ' + escapeHtml(actCtr.email) : ''
            }</div>
                <div><span class="p3h-meta-lbl">Period of Completion:</span> ${val(
                  actSched.periodText
                )}</div>
                <div><span class="p3h-meta-lbl">Contractor Signed:</span> ${val(
                  actSched.contractorSignedDate
                )}</div>
                <div><span class="p3h-meta-lbl">Handing Over (SHO):</span> ${val(
                  actSched.shoDate
                )}</div>
                <div><span class="p3h-meta-lbl">Agreement Completion:</span> <strong>${val(
                  actComp
                )}</strong></div>
                <div><span class="p3h-meta-lbl">Schedule Status:</span> <span class="p3h-badge ${actSchedCls}">${escapeHtml(
              actSchedStatus.label
            )}</span></div>
                <div><span class="p3h-meta-lbl">Extended Completion:</span> <strong>${val(
                  actUser && actUser.extendedCompletionDate
                )}</strong> ${
              actUser && actUser.extensionOrder
                ? '<span class="p3h-badge p3h-badge-part">' +
                  escapeHtml(db.formatOrdinal(actUser.extensionOrder)) +
                  '</span>'
                : ''
            }</div>
                <div><span class="p3h-meta-lbl">Extension Fine:</span> ${val(actFineText)}</div>
                <div><span class="p3h-meta-lbl">Status of Work:</span> ${val(
                  actUser && actUser.workStatus
                )}</div>
                <div><span class="p3h-meta-lbl">Physical Progress:</span> ${
                  actUser && actUser.physicalProgress !== null
                    ? escapeHtml(actUser.physicalProgress + '%')
                    : val('')
                }</div>
              </div>
            `;
          }
        } else if (actDet && !c.isHelper) {
          const actCtr = actDet.contractor || {};
          const actFin = extractor.computeFinancialStatus(c.compTotalActiveAmount || 0, {
            tsAmount: actDet.tsAmount || pd.tsAmount,
            negotiatedRate: actDet.negotiatedRate || pd.negotiatedRate,
            agreedPac: actDet.agreedPac || pd.agreedPac,
            estimatePac: actDet.estimatePac || pd.estimatePac,
          });
          const bits = [];
          if (actDet.asNo) {
            bits.push(`AS: ${actDet.asNo}${actDet.asDate ? ' (' + actDet.asDate + ')' : ''}`);
          }
          if (actDet.tsNo) {
            bits.push(`TS: ${actDet.tsNo}${actDet.tsDate ? ' (' + actDet.tsDate + ')' : ''}`);
          }
          if (actFin.adjustedTsAmount > 0 && (c.compTotalActiveAmount > 0 || actFin.pct !== null)) {
            bits.push(
              `Financial: ${actFin.pct}% (₹${extractor.formatInr(
                c.compTotalActiveAmount || 0
              )} / ₹${extractor.formatInr(actFin.adjustedTsAmount)})`
            );
          }
          if (actCtr.name) bits.push(`Contractor: ${actCtr.name}`);
          if (actSched.shoDate) bits.push(`SHO: ${actSched.shoDate}`);
          if (actComp) bits.push(`Due: ${actComp}`);
          if (bits.length > 0) {
            actDetailsHtml = `<div class="p3h-act-strip">${escapeHtml(bits.join('  |  '))}</div>`;
          }
        }

        const actMsHtml =
          actUser && (actUser.progressHistory || []).length > 0
            ? `<div class="p3h-act-ms-box">
                <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:4px;">Activity Milestone Chronology (${actUser.progressHistory.length})</div>
                ${register.renderMilestoneTimelineHtml(actUser.progressHistory, { allowDelete: false })}
              </div>`
            : '';

        let bodyHtml = '';
        if (bills.length === 0) {
          const emptyReason = c.isManuallyArchived
            ? `Manually Archived${
                c.manualArchive && c.manualArchive.reason ? ' — ' + c.manualArchive.reason : '.'
              }`
            : c.mbookClosedNoFinal
            ? 'M-Book is closed without a Final Bill.'
            : !c.hasEBillStage
            ? c.hasPostTender || c.hasSiteHandover || c.hasEmbook
              ? 'Post-Tender / Site Handover stage (no e-Bill stage yet).'
              : 'Pre-Tender / DPR stage only (no e-Bill stage yet).'
            : 'No bills generated under this activity.';
          bodyHtml = `<div style="padding:8px 10px;color:#64748b;font-size:12px;">${escapeHtml(
            emptyReason
          )}</div>`;
        } else {
          const rowsHtml = bills
            .map((b) => {
              const kind = b.kind || extractor.classifyBillKind(b.billTypeAndNo);
              const isCanc = b.isCancelled;
              const isDraft = Boolean(b.isDraft);
              const isMergedPf = b.isMergedIntoCompositeFinal;
              const kindBadge = isCanc
                ? 'p3h-badge-cancelled'
                : isDraft
                ? 'p3h-badge-nobill'
                : kind === 'Final' || isMergedPf
                ? 'p3h-badge-final'
                : kind === 'Part' || kind === 'Pre-Final'
                ? 'p3h-badge-part'
                : 'p3h-badge-nobill';
              const kindLabel = isDraft
                ? `${kind} · Draft (Excluded)`
                : isMergedPf
                ? 'Pre-Final (Component Final — Merged)'
                : kind === 'Pre-Final'
                ? 'Pre-Final (Component Final)'
                : b.isCompositeFinal
                ? 'Composite Final (Merged)'
                : kind;
              const mergedNote = isMergedPf
                ? '<div style="color:#15803d;font-size:11px;font-weight:600;">Merged into Composite Final</div>'
                : isDraft
                ? '<div style="color:#64748b;font-size:11px;">Draft bill excluded from Financial Status</div>'
                : '';
              return `
                <tr${isDraft ? ' style="opacity:0.68;"' : ''}>
                  <td>
                    <div style="font-weight:600;">${escapeHtml(b.billTypeAndNo)}</div>
                    <div style="margin-top:2px;"><span class="p3h-badge ${kindBadge}">${escapeHtml(
                kindLabel
              )}</span></div>
                  </td>
                  <td class="p3h-num">₹${escapeHtml(
                    extractor.formatInr(extractor.parseInr(b.grandTotal))
                  )}</td>
                  <td>${escapeHtml(b.initiatedOn || '')}</td>
                  <td>
                    <div style="font-weight:600;">${escapeHtml(b.status || '')}</div>
                    ${mergedNote}
                    <div style="color:#64748b;font-size:11px;">${escapeHtml(
                      b.pendingWith || ''
                    )}</div>
                  </td>
                </tr>
              `;
            })
            .join('');

          bodyHtml = `
            <table class="p3h-bill-table">
              <thead>
                <tr>
                  <th>Bill Type &amp; No</th>
                  <th class="p3h-num">Grand Total</th>
                  <th>Initiated</th>
                  <th>Status / Pending With</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          `;
        }

        return `
          <div class="p3h-comp-card">
            <div class="p3h-comp-head">
              <span>${escapeHtml(headerTitle)}</span>
              <span style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">${stagePill}${mbookPill}${dueBarPill}${actLogBtn}${actArchBtn}</span>
            </div>
            ${actDetailsHtml}
            ${bodyHtml}
            ${actMsHtml}
          </div>
        `;
      })
      .join('');
  }

  function renderDrawerContent(meta, workRecord) {
    const titleEl = document.getElementById('p3h-drawer-title');
    const subEl = document.getElementById('p3h-drawer-subtitle');
    const bodyEl = document.getElementById('p3h-drawer-body');
    if (!titleEl || !subEl || !bodyEl) return;

    const summary = getWorkSummary(workRecord);
    const isArch = isWorkArchivedRec(workRecord, summary);
    const isManArch = isFullyManuallyArchived(workRecord, summary);

    titleEl.textContent = meta.fileNumber || 'Work Details';
    subEl.innerHTML =
      `${escapeHtml(meta.subject)}<br>` +
      `<span class="p3h-badge ${escapeHtml(summary.badgeClass)}" style="margin-top:4px;">${escapeHtml(
        summary.label
      )}</span>` +
      (isManArch
        ? ' <span class="p3h-badge p3h-badge-manual-arch">Manually Archived</span>'
        : isArch
        ? ' <span class="p3h-badge p3h-badge-archived">Archived</span>'
        : '') +
      (workRecord && workRecord.scannedAt
        ? ` <span style="color:#64748b;font-size:11px;">Scanned: ${escapeHtml(
            new Date(workRecord.scannedAt).toLocaleString()
          )}</span>`
        : '');

    if (!workRecord) {
      bodyEl.innerHTML =
        '<p style="color:#475569;">Loading live component, activity, M-Book &amp; e-Bill details from PRICE 3.0...</p>';
      return;
    }

    const metaHtml = renderProjectDetailsCard(workRecord, summary);
    const editorHtml = renderUserTrackingEditorCard(workRecord, summary);
    const allComps = summary.components || [];
    const deactivatedComps = allComps.filter((c) => c.isDeactivated || c.isDeactivatedDpr);
    const compsHtml = renderComponentCardsHtml(workRecord, summary);

    const deactivatedHtml =
      deactivatedComps.length > 0
        ? `<details class="p3h-deactivated-details">
            <summary>Deactivated / Superseded Stages (${deactivatedComps.length})</summary>
            <ul class="p3h-deactivated-list">
              ${deactivatedComps
                .map((c) => {
                  const lbl = c.workGroup
                    ? `${c.workGroup} → ${c.componentLabel}`
                    : c.componentLabel;
                  const stage = c.stageName || c.compBadgeText || 'Deactivated';
                  return `<li><strong>${escapeHtml(lbl)}</strong> — ${escapeHtml(stage)}</li>`;
                })
                .join('')}
            </ul>
          </details>`
        : '';

    bodyEl.innerHTML = summary.hasIndependentActivities
      ? metaHtml + compsHtml + editorHtml + deactivatedHtml
      : metaHtml + editorHtml + compsHtml + deactivatedHtml;
    wireDrawerUserEditor(meta, workRecord, summary);
  }

  function resolveDefaultDrawerScopeKey(workRecord) {
    if (!workRecord) return '';
    const sum = getWorkSummary(workRecord);
    if (!sum || !sum.hasIndependentActivities) return '';
    const rawUd = db.normalizeUserData(workRecord.userData);
    const hasRootUser = Boolean(
      rawUd.workStatus ||
        (rawUd.physicalProgress !== null && rawUd.physicalProgress !== undefined) ||
        (rawUd.extensions && rawUd.extensions.length > 0)
    );
    if (hasRootUser) return '';
    const acts = (sum.activities || []).filter((a) => !a.isDeactivated && !a.isHelper);
    const firstActive = acts.find((a) => !a.isFinalized && !a.isManuallyArchived) || acts[0];
    return firstActive && firstActive.activityKey ? firstActive.activityKey : '';
  }

  async function refreshSingleWorkInDrawer(meta) {
    const targetFileId = meta.fileId;
    if (state.isScanning && activeScanPromise) {
      state.pauseRequested = true;
      await activeScanPromise;
    }
    if (state.drawerFileId !== targetFileId) return;

    const hadCached = Boolean(state.worksByFileId[targetFileId]);
    const bodyEl = document.getElementById('p3h-drawer-body');
    if (bodyEl) {
      bodyEl.innerHTML =
        '<p style="color:#1d4ed8;">Fetching live bills, M-Book &amp; activity details from PRICE 3.0...</p>';
    }
    try {
      const rec = await extractor.fetchSingleWorkFromPortal(meta, {
        delayMs: 0,
        concurrency: state.scanConcurrency || 6,
        includeDetails: true,
        existingRecord: state.worksByFileId[targetFileId] || null,
      });
      const sum = extractor.summarizeWork(rec);
      const saved = await db.putWork(rec, sum, extractor.analyzeWorkRecord);
      if (saved && saved.record) {
        state.worksByFileId[targetFileId] = saved.record;
      }
      state.dbCounts = await db.getCounts();

      if (state.drawerFileId === targetFileId) {
        const finalRec = (saved && saved.record) || rec;
        if (!hadCached && !state.drawerScopeKey) {
          state.drawerScopeKey = resolveDefaultDrawerScopeKey(finalRec);
        }
        renderDrawerContent(meta, finalRec);
      }
      if (state.currentTable) {
        updateToolbarUI(state.currentTable);
        renderVisibleRowBadges(state.currentTable, true, targetFileId);
        applyActiveFilterToTable(state.currentTable, false);
      }
      await register.refreshIfOpen();
    } catch (err) {
      if (state.drawerFileId === targetFileId && bodyEl) {
        bodyEl.innerHTML = `<p style="color:#b91c1c;">Failed to fetch work details: ${escapeHtml(
          err.message
        )}</p>`;
      }
    }
  }

  async function openDrawerForWork(meta) {
    ensureDrawerElements();
    const targetFileId = meta.fileId;
    state.drawerFileId = targetFileId;
    state.drawerScopeKey = '';
    document.getElementById('p3h-drawer-backdrop')?.classList.add('p3h-open');
    document.getElementById('p3h-drawer')?.classList.add('p3h-open');

    const refreshBtn = document.getElementById('p3h-drawer-refresh');
    if (refreshBtn) refreshBtn.onclick = () => refreshSingleWorkInDrawer(meta);

    let cached = state.worksByFileId[targetFileId];
    if (!cached && state.dbReady) {
      cached = await db.getWork(targetFileId);
      if (cached) state.worksByFileId[targetFileId] = cached;
    }
    if (state.drawerFileId !== targetFileId) return;
    if (cached) {
      state.drawerScopeKey = resolveDefaultDrawerScopeKey(cached);
    }
    renderDrawerContent(meta, cached || null);
    if (!cached) {
      refreshSingleWorkInDrawer(meta);
    }
  }

  function injectToolbar(table) {
    if (document.getElementById('p3h-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'p3h-toolbar';
    toolbar.className = 'p3h-toolbar';
    toolbar.innerHTML = `
      <div class="p3h-row-top">
        <div class="p3h-brand">
          <span>PRICE 3.0 Helper</span>
          <span class="p3h-brand-tag">v${escapeHtml(
            (db && db.EXTENSION_VERSION) || '2.4.0'
          )}</span>
        </div>
        <div class="p3h-actions">
          <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-scan-btn">Scan Remaining</button>
          <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-sync-missing-btn" title="Rescan newly added works and works with missing fields">Sync Missing (0)</button>
          <button type="button" class="p3h-btn p3h-btn-warn" id="p3h-pause-btn" style="display:none;">Pause Scan</button>
          <button type="button" class="p3h-btn" id="p3h-rescan-btn">Rescan All</button>
          <div class="p3h-split-group">
            <button type="button" class="p3h-btn" id="p3h-rescan-filtered-btn" title="Rescan only works matching the active filter (or choose categories)">Update Filtered...</button>
            <button type="button" class="p3h-btn p3h-split-caret" id="p3h-rescan-picker-btn" title="Pick categories to rescan">▾</button>
            <div class="p3h-popover p3h-rescan-popover" id="p3h-rescan-popover" style="display:none;"></div>
          </div>
          <button type="button" class="p3h-btn p3h-btn-register" id="p3h-open-register-btn">Project Register &amp; Reports</button>
          <button type="button" class="p3h-btn" id="p3h-export-btn">Export CSV</button>
          <button type="button" class="p3h-btn p3h-btn-danger" id="p3h-clear-btn">Clear Data</button>
        </div>
      </div>

      <div class="p3h-filters">
        <button type="button" class="p3h-pill p3h-active" data-p3h-filter="all">All <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-final" data-p3h-filter="final">Final Bill Generated <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-none" data-p3h-filter="not_final">Final Bill Not Generated <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-mbook75" data-p3h-filter="open_mbook_75" title="Active works with Open M-Books that reached or passed 75% of Agreement Period">Open M-Book ≥ 75% <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-mbook" data-p3h-filter="mbook_closed_no_final">M-Book Closed (No Final) <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-part" data-p3h-filter="has_part">Has Part Bills <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-part" data-p3h-filter="part_only">Part Bill Only <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-none" data-p3h-filter="nobill">No Bills <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-none" data-p3h-filter="dpr">DPR / Pre-Tender <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-none" data-p3h-filter="manually_archived">Manually Archived <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-none" data-p3h-filter="missing_details">Missing Fields <span class="p3h-pill-count">0</span></button>
        <button type="button" class="p3h-pill p3h-pill-none" data-p3h-filter="unscanned">New / Unscanned <span class="p3h-pill-count">0</span></button>
        <select id="p3h-activity-filter" class="p3h-select" title="Filter works by activity">
          <option value="all">All Activities (0)</option>
        </select>
      </div>

      <div class="p3h-status-bar">
        <span id="p3h-status-text">Initializing local data...</span>
        <div class="p3h-progress-wrap"><div class="p3h-progress-fill" id="p3h-progress-fill"></div></div>
        <div class="p3h-pagesize-group">
          <span>Show:</span>
          <button type="button" class="p3h-btn" data-p3h-len="10">10</button>
          <button type="button" class="p3h-btn" data-p3h-len="50">50</button>
          <button type="button" class="p3h-btn" data-p3h-len="100">100</button>
          <button type="button" class="p3h-btn" data-p3h-len="-1">All</button>
        </div>
      </div>
    `;

    const wrapper = table.closest('.dataTables_wrapper') || table.parentElement;
    if (wrapper && wrapper.parentElement) {
      wrapper.parentElement.insertBefore(toolbar, wrapper);
    }

    toolbar.querySelector('#p3h-scan-btn').onclick = runScanRemaining;
    toolbar.querySelector('#p3h-sync-missing-btn').onclick = runSyncMissing;
    toolbar.querySelector('#p3h-rescan-btn').onclick = runRescanAll;
    toolbar.querySelector('#p3h-pause-btn').onclick = () => {
      state.pauseRequested = true;
    };

    const pickerPop = toolbar.querySelector('#p3h-rescan-popover');
    toolbar.querySelector('#p3h-rescan-picker-btn').onclick = (e) => {
      e.stopPropagation();
      if (pickerPop.style.display === 'block') {
        pickerPop.style.display = 'none';
      } else {
        renderTargetPickerPopover();
        pickerPop.style.display = 'block';
      }
    };

    toolbar.querySelector('#p3h-rescan-filtered-btn').onclick = (e) => {
      e.stopPropagation();
      if (state.activeFilter === 'all' && state.activeActivityFilter === 'all') {
        renderTargetPickerPopover();
        pickerPop.style.display = 'block';
        return;
      }
      pickerPop.style.display = 'none';
      const allRows = getAllTableRowsMeta(state.currentTable);
      const queue = getTargetedQueueRows(allRows, [state.activeFilter], {
        includeArchivedMissing: state.pickerIncludeArchivedMissing,
        activityFilter: state.activeActivityFilter,
      });
      runQueueScan(queue, {
        includeDetails: state.pickerIncludeDetails,
        emptyMessage: `No works match filter "${state.activeFilter}".`,
      });
    };

    toolbar.querySelector('#p3h-open-register-btn').onclick = () => {
      register.open({
        onInspectWork: (rawWork) => openDrawerForWork(rawWork),
        onDataUpdated: async (updatedRec) => {
          if (updatedRec && updatedRec.fileId) {
            const fid = String(updatedRec.fileId);
            state.worksByFileId[fid] = updatedRec;
            state.dbCounts = await db.getCounts();
            if (state.currentTable) {
              renderVisibleRowBadges(state.currentTable, true, fid);
              updateToolbarUI(state.currentTable);
              applyActiveFilterToTable(state.currentTable, false);
            }
          }
        },
        onDatabaseImported: async () => {
          if (state.currentTable) {
            await syncTableCacheFromDb(state.currentTable);
            updateToolbarUI(state.currentTable);
            renderVisibleRowBadges(state.currentTable, true);
            applyActiveFilterToTable(state.currentTable, false);
          }
        },
      });
    };

    toolbar.querySelector('#p3h-export-btn').onclick = exportFilteredCsv;
    toolbar.querySelector('#p3h-clear-btn').onclick = async () => {
      if (state.isScanning) return;
      if (
        !confirm(
          'Clear ALL saved PRICE 3.0 works (Active & Archived) and manual extension/progress entries?'
        )
      ) {
        return;
      }
      closeDrawer();
      await db.clearWorks('all');
      state.worksByFileId = Object.create(null);
      state.dbCounts = await db.getCounts();
      if (register && typeof register.clearExcludedKeys === 'function') {
        register.clearExcludedKeys();
      }
      setTransientStatus('Saved data cleared.', 7000);
      if (state.currentTable) {
        updateToolbarUI(state.currentTable);
        renderVisibleRowBadges(state.currentTable, true);
        applyActiveFilterToTable(state.currentTable, false);
      }
      await register.refreshIfOpen();
    };

    toolbar.querySelectorAll('[data-p3h-filter]').forEach((btn) => {
      btn.onclick = () => {
        state.activeFilter = btn.getAttribute('data-p3h-filter');
        updateToolbarUI(state.currentTable);
        applyActiveFilterToTable(state.currentTable, true);
      };
    });

    const actSel = toolbar.querySelector('#p3h-activity-filter');
    if (actSel) {
      actSel.onchange = () => {
        state.activeActivityFilter = actSel.value;
        updateToolbarUI(state.currentTable);
        applyActiveFilterToTable(state.currentTable, true);
      };
    }

    toolbar.querySelectorAll('[data-p3h-len]').forEach((btn) => {
      btn.onclick = () => {
        const len = parseInt(btn.getAttribute('data-p3h-len'), 10);
        if (
          Number.isFinite(len) &&
          extractor &&
          typeof extractor.syncBridgeCall === 'function'
        ) {
          extractor.syncBridgeCall('dt:setPageLen', { selector: TABLE_SELECTOR, len });
        }
      };
    });
  }

  function bindTableDelegatedClicks(table) {
    if (!table || table._p3hCellClickBound) return;
    table._p3hCellClickBound = true;
    table.addEventListener(
      'click',
      (e) => {
        const metaBox =
          e.target && e.target.closest ? e.target.closest('.p3h-cell-meta') : null;
        if (!metaBox || !table.contains(metaBox)) return;
        e.stopPropagation();
        const drawerBtn = e.target.closest('[data-open-drawer]');
        if (drawerBtn) {
          e.preventDefault();
          const tr = drawerBtn.closest('tr');
          const meta = extractRowMetaFromTr(tr);
          if (meta) openDrawerForWork(meta);
        }
      },
      true
    );
  }

  function isWorksListTable(table) {
    if (!table) return false;
    if (state.currentTable === table && document.getElementById('p3h-toolbar')) return true;
    return Boolean(table.querySelector('tbody [onclick*="callworkfiledetails"]'));
  }

  async function initDatabaseOnce() {
    if (state.dbReady) return;
    if (dbInitPromise) return dbInitPromise;
    dbInitPromise = (async () => {
      await db.init();
      const rec = await db.reconcileArchiveStoresIfNeeded(extractor.analyzeWorkRecord);
      state.dbCounts = await db.getCounts();
      const savedConcurrency = await db.getSetting('scan_concurrency', 6);
      const parsedConc = Number(savedConcurrency);
      state.scanConcurrency = [1, 6, 12].includes(parsedConc) ? parsedConc : 6;
      state.dbReady = true;
      const msgs = [];
      if (rec && rec.movedToActive > 0) {
        msgs.push(`Restored ${rec.movedToActive} partially-finalized work(s) to Active`);
      }
      if (rec && rec.movedToArchived > 0) {
        msgs.push(`Archived ${rec.movedToArchived} finalized/deactivated work(s)`);
      }
      if (msgs.length > 0) {
        setTransientStatus(msgs.join(' · ') + '.', 7000);
      }
    })();
    try {
      await dbInitPromise;
    } catch (err) {
      dbInitPromise = null;
      throw err;
    }
  }

  async function attachToWorksTableIfPresent() {
    if (state.currentTable && !state.currentTable.isConnected) {
      if (state.isScanning) {
        state.pauseRequested = true;
        if (activeScanAbortController) {
          activeScanAbortController.abort();
        }
      }
      closeDrawer();
      state.currentTable = null;
      state.hasDt = false;
      state.worksByFileId = Object.create(null);
      state.allRowsCache = [];
      const oldToolbar = document.getElementById('p3h-toolbar');
      if (oldToolbar) oldToolbar.remove();
      if (extractor && typeof extractor.syncBridgeCall === 'function') {
        extractor.syncBridgeCall('dt:clear', {});
      }
    }

    const table = document.querySelector(TABLE_SELECTOR);
    if (!isWorksListTable(table)) return;

    try {
      await initDatabaseOnce();
    } catch (err) {
      console.warn('[P3H] Failed to initialize database:', err);
      return;
    }

    if (state.currentTable !== table) {
      state.currentTable = table;
      injectToolbar(table);
      bindTableDelegatedClicks(table);
      await syncTableCacheFromDb(table);
      ensureDtFilter(table);
      updateToolbarUI(table);
      applyActiveFilterToTable(table, false);
      renderVisibleRowBadges(table, true);
    } else {
      const newlyBoundDt = ensureDtFilter(table);
      if (newlyBoundDt) {
        await syncTableCacheFromDb(table);
        updateToolbarUI(table);
        applyActiveFilterToTable(table, false);
      }
      renderVisibleRowBadges(table, false);
    }
  }

  function scrollWorksTableToTop(table) {
    if (!table || typeof document === 'undefined' || typeof window === 'undefined') return;
    try {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        activeEl.closest &&
        activeEl.closest('.dataTables_paginate') &&
        typeof activeEl.blur === 'function'
      ) {
        activeEl.blur();
      }
      const wrap = table.closest ? table.closest('.dataTables_wrapper') : null;
      const pagEl = wrap
        ? wrap.querySelector('.dataTables_paginate')
        : document.querySelector && document.querySelector('.dataTables_paginate');
      if (pagEl && pagEl.querySelectorAll) {
        const focused = pagEl.querySelectorAll(':focus');
        focused.forEach((el) => {
          if (typeof el.blur === 'function') el.blur();
        });
      }
    } catch (_e) {}

    const anchorEl =
      document.getElementById('p3h-toolbar') ||
      (table.closest && table.closest('.dataTables_wrapper')) ||
      table;

    const scrollBody = table.closest && table.closest('.dataTables_scrollBody');
    if (scrollBody && scrollBody.scrollTop > 0) {
      scrollBody.scrollTop = 0;
    }

    if (anchorEl && typeof anchorEl.scrollIntoView === 'function') {
      try {
        anchorEl.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
      } catch (_e) {
        try {
          anchorEl.scrollIntoView(true);
        } catch (_e2) {}
      }
    }

    let cur = anchorEl ? anchorEl.parentElement : null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.scrollHeight > cur.clientHeight + 1) {
        let isScrollable = cur.scrollTop > 0;
        if (typeof window.getComputedStyle === 'function') {
          const overflowY = window.getComputedStyle(cur).overflowY || '';
          isScrollable = /(auto|scroll|overlay)/i.test(overflowY);
        }
        if (isScrollable) {
          if (
            typeof anchorEl.getBoundingClientRect === 'function' &&
            typeof cur.getBoundingClientRect === 'function'
          ) {
            const delta = anchorEl.getBoundingClientRect().top - cur.getBoundingClientRect().top;
            cur.scrollTop = Math.max(0, cur.scrollTop + delta - 12);
          } else {
            cur.scrollTop = 0;
          }
        }
      }
      cur = cur.parentElement;
    }

    if (
      anchorEl &&
      typeof anchorEl.getBoundingClientRect === 'function' &&
      typeof window.scrollTo === 'function'
    ) {
      const targetTop = Math.max(
        0,
        Math.round(
          anchorEl.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0) - 12
        )
      );
      try {
        window.scrollTo({ top: targetTop, behavior: 'auto' });
      } catch (_e) {
        window.scrollTo(0, targetTop);
      }
    }
  }

  if (hasDocument) {
    if (!globalListenersBound) {
      globalListenersBound = true;

      document.addEventListener('p3h:dt:draw', (ev) => {
        if (state.currentTable && state.currentTable.isConnected) {
          renderVisibleRowBadges(state.currentTable, false);
          let pageChanged = pendingPaginationScroll;
          if (ev && ev.detail) {
            try {
              const parsed = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : ev.detail;
              if (parsed && parsed.pageChanged) pageChanged = true;
            } catch (_e) {}
          }
          pendingPaginationScroll = false;
          if (pendingPaginationTimer) {
            clearTimeout(pendingPaginationTimer);
            pendingPaginationTimer = null;
          }
          if (pageChanged) {
            const tbl = state.currentTable;
            const doScroll = () => {
              if (tbl && tbl.isConnected) scrollWorksTableToTop(tbl);
            };
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(() => {
                doScroll();
                if (typeof setTimeout === 'function') {
                  setTimeout(doScroll, 50);
                }
              });
            } else {
              doScroll();
              if (typeof setTimeout === 'function') {
                setTimeout(doScroll, 50);
              }
            }
          }
        }
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.drawerFileId) {
          closeDrawer();
        }
      });

      document.addEventListener(
        'click',
        (e) => {
          if (
            e.target &&
            e.target.closest &&
            e.target.closest('.dataTables_paginate') &&
            state.currentTable &&
            state.currentTable.isConnected
          ) {
            pendingPaginationScroll = true;
            if (pendingPaginationTimer) clearTimeout(pendingPaginationTimer);
            pendingPaginationTimer = setTimeout(() => {
              pendingPaginationTimer = null;
              pendingPaginationScroll = false;
            }, 1000);
          }
        },
        true
      );

      document.addEventListener('click', (e) => {
        const pop = document.getElementById('p3h-rescan-popover');
        if (pop && pop.style.display === 'block' && !e.target.closest('.p3h-split-group')) {
          pop.style.display = 'none';
        }
      });

      document.addEventListener(
        'click',
        (e) => {
          if (!state.isScanning) return;
          const target = e.target;
          if (
            target &&
            target.closest &&
            (target.closest('#p3h-toolbar') ||
              target.closest('.p3h-cell-meta') ||
              target.closest('#p3h-drawer') ||
              target.closest('#p3h-drawer-backdrop') ||
              target.closest('#p3h-register-modal'))
          ) {
            return;
          }
          state.pauseRequested = true;
        },
        true
      );
    }

    if (typeof MutationObserver !== 'undefined' && document.body) {
      let timer = null;
      const observer = new MutationObserver((mutations) => {
        const onlyInternal = mutations.every((m) => {
          const t = m.target;
          return Boolean(
            t &&
              t.closest &&
              t.closest(
                '#p3h-toolbar, #p3h-drawer, #p3h-drawer-backdrop, #p3h-register-modal, .p3h-cell-meta, #pt-file_table_list, .dataTables_wrapper'
              )
          );
        });
        if (onlyInternal) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(attachToWorksTableIfPresent, 180);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      attachToWorksTableIfPresent();
    }
  }

  const overlayApi = Object.freeze({
    matchesFilter,
    isFullyManuallyArchived,
    computeActivityPeriodProgress,
    getTargetedQueueRows,
    formatScanProgressMessage,
    renderProjectDetailsCard,
    renderComponentCardsHtml,
    renderWorkRowBadgesHtml,
    scrollWorksTableToTop,
  });

  P3H.overlay = overlayApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = overlayApi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
