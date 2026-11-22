/**
 * PRICE 3.0 Helper — Project Register & Custom Report Builder
 *
 * Reads active and/or archived works from local storage (p3h_price_db) and provides:
 * - Multi-field filtering (search, bill status, activity, constituency, contractor, schedule, date range)
 * - Grouped AS/TS columns, Contractor PAN/Phone hidden unless selected
 * - User-entered Extensions (1st, 2nd, ... with fine), Status of Work, and Physical Progress (%)
 * - Expandable per-activity sub-rows and activity-wise filtering
 * - Hide / display fields with saved column presets and type-aware sorting
 * - Custom CSV export and printable PDF report without double-counting totals
 */
(function (globalScope) {
  'use strict';

  function getExtractor() {
    if (globalScope.__P3H__ && globalScope.__P3H__.extractor) return globalScope.__P3H__.extractor;
    if (typeof require === 'function') return require('./extractor.js');
    return null;
  }

  function getDb() {
    if (globalScope.__P3H__ && globalScope.__P3H__.db) return globalScope.__P3H__.db;
    if (typeof require === 'function') return require('./db.js');
    return null;
  }

  function escapeHtml(str) {
    const db = getDb();
    if (db && typeof db.escapeHtml === 'function') return db.escapeHtml(str);
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function csvEscape(v) {
    const db = getDb();
    if (db && typeof db.csvEscape === 'function') return db.csvEscape(v);
    const raw = String(v == null ? '' : v);
    const safe = typeof v !== 'number' && /^[\t\r ]*[=+\-@]/.test(raw) ? "'" + raw : raw;
    return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
  }

  const REG_COLLATOR =
    typeof Intl !== 'undefined' && typeof Intl.Collator === 'function'
      ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
      : null;

  function formatNoAndDate(no, date) {
    const n = String(no || '').trim();
    const d = String(date || '').trim();
    if (n && d) return `${n} (${d})`;
    return n || d || '';
  }

  function formatWorkDetailsText(row) {
    if (!row) return '';
    const act = row.activityName || row.activityNames || '';
    return [row.fileNumber || '', row.subject || '', act].filter(Boolean).join(' | ');
  }

  function normalizeFilterList(val) {
    if (val == null || val === '') return [];
    const raw = val instanceof Set ? Array.from(val) : Array.isArray(val) ? val : [val];
    const out = [];
    const seen = new Set();
    raw.forEach((item) => {
      const s = String(item == null ? '' : item).trim();
      if (!s || s.toLowerCase() === 'all' || seen.has(s)) return;
      seen.add(s);
      out.push(s);
    });
    return out;
  }

  const WORK_STATUS_PRESETS = [
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

  function formatFinancialStatusText(row, ext) {
    const billed = Number(row && row.totalActiveAmount) || 0;
    const pct =
      row && typeof row.financialPct === 'number' && Number.isFinite(row.financialPct)
        ? row.financialPct
        : null;
    if (billed > 0 && pct !== null) {
      return `₹${ext.formatInr(billed)} (${pct}%)`;
    }
    if (billed > 0) {
      return `₹${ext.formatInr(billed)}`;
    }
    if (pct !== null && row && row.adjustedTsAmount > 0) {
      return `${pct}%`;
    }
    return '';
  }

  function renderDueDateProgressBadgeHtml(dueDate, periodProgress, prefixLabel, isExtended) {
    const dt = String(dueDate || '').trim();
    const prefix = String(prefixLabel || '').trim();
    if (!periodProgress) {
      const txt = prefix && dt ? `${prefix}: ${dt}` : dt;
      return escapeHtml(txt);
    }
    const labelText = (prefix ? `${prefix}: ` : '') + (dt || '');
    const titleText =
      (prefix ? `${prefix} — ` : '') +
      `Agreement Due: ${dt || '—'} · ${periodProgress.detailLabel} (${periodProgress.elapsedDays}/${periodProgress.totalDays}d)` +
      (isExtended ? ' (Extended)' : '');
    const safeFill = Math.max(0, Math.min(100, Number(periodProgress.barFillPct) || 0));
    return `<span class="p3h-due-bar-badge p3h-zone-${escapeHtml(periodProgress.zone)}" title="${escapeHtml(
      titleText
    )}"><span class="p3h-due-bar-fill" style="width:${safeFill}%;"></span><span class="p3h-due-bar-mark" title="100% Agreement Period"></span><span class="p3h-due-bar-text"><span>${escapeHtml(
      labelText
    )}</span><span class="p3h-due-bar-pct">${escapeHtml(periodProgress.shortLabel)}</span></span></span>`;
  }

  const COLUMNS = [
    {
      key: 'slNo',
      label: 'Sl No',
      group: 'Work',
      type: 'number',
      defaultVisible: true,
      getValue: (r) => r._rowIndex,
      format: (v) => (v !== '' && v != null ? String(v) : ''),
    },
    {
      key: 'workDetails',
      label: 'File No, Work Name & Activity',
      group: 'Work',
      type: 'text',
      defaultVisible: true,
      getValue: (r) => formatWorkDetailsText(r),
      getSortValue: (r) => r.fileNumber || r.subject || null,
    },
    {
      key: 'constituency',
      label: 'Constituency (LAC)',
      group: 'Location',
      type: 'text',
      defaultVisible: true,
      getValue: (r) => r.constituency || '',
    },
    {
      key: 'asNoDate',
      label: 'AS No. & Date',
      group: 'Sanctions',
      type: 'date',
      defaultVisible: true,
      getValue: (r) => r.asNoDateText || '',
      getSortValue: (r, ext) => {
        const iso = ext.toIsoDate(r.asDate);
        if (iso) return iso;
        return r.asNo ? '9999-00-00-' + r.asNo : null;
      },
    },
    {
      key: 'tsNoDate',
      label: 'TS No. & Date',
      group: 'Sanctions',
      type: 'date',
      defaultVisible: true,
      getValue: (r) => r.tsNoDateText || '',
      getSortValue: (r, ext) => {
        const iso = ext.toIsoDate(r.tsDate);
        if (iso) return iso;
        return r.tsNo ? '9999-00-00-' + r.tsNo : null;
      },
    },
    {
      key: 'agreementNoDate',
      label: 'Agreement No. & Date',
      group: 'Agreement & Contractor',
      type: 'date',
      defaultVisible: true,
      getValue: (r) => r.agreementNoDateText || '',
      getSortValue: (r, ext) => {
        const iso = ext.toIsoDate(r.agreementDate);
        if (iso) return iso;
        return r.agreementNo ? '9999-00-00-' + r.agreementNo : null;
      },
    },
    {
      key: 'agreedPac',
      label: 'Agreed PAC (₹)',
      group: 'Agreement & Contractor',
      type: 'money',
      defaultVisible: true,
      getValue: (r) => r.agreedPacNum,
      format: (v, r, ext) => (v > 0 ? ext.formatInr(v) : r.agreedPac || ''),
    },
    {
      key: 'contractorName',
      label: 'Contractor Name',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: true,
      getValue: (r) => r.contractorName || '',
    },
    {
      key: 'shoDate',
      label: 'Date of Handing Over',
      group: 'Schedule',
      type: 'date',
      defaultVisible: true,
      getValue: (r) => r.shoDate || '',
    },
    {
      key: 'periodText',
      label: 'Period of Completion',
      group: 'Schedule',
      type: 'duration',
      defaultVisible: true,
      getValue: (r) => r.periodText || '',
      getSortValue: (r) => r.periodDaysTotal,
    },
    {
      key: 'completionDate',
      label: 'Date of Completion',
      group: 'Schedule',
      type: 'date',
      defaultVisible: true,
      getValue: (r) => r.completionDate || '',
    },
    {
      key: 'extendedCompletionDate',
      label: 'Extended Date of Completion',
      group: 'Schedule',
      type: 'date',
      defaultVisible: true,
      getValue: (r) => r.extendedCompletionDate || '',
    },
    {
      key: 'scheduleStatus',
      label: 'Schedule Status',
      group: 'Schedule',
      type: 'badge',
      defaultVisible: true,
      getValue: (r) => r.scheduleStatusLabel || '',
      getSortValue: (r) => r.scheduleSortRank,
    },
    {
      key: 'workStatus',
      label: 'Status of Work',
      group: 'Work Progress',
      type: 'text',
      defaultVisible: true,
      getValue: (r) => r.workStatus || '',
    },
    {
      key: 'physicalProgress',
      label: 'Physical Progress (%)',
      group: 'Work Progress',
      type: 'number',
      defaultVisible: true,
      getValue: (r) => r.physicalProgress,
      format: (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v}%` : ''),
    },
    {
      key: 'totalActiveAmount',
      label: 'Financial Status',
      group: 'Work',
      type: 'money',
      defaultVisible: true,
      getValue: (r) => r.totalActiveAmount,
      getSortValue: (r) => {
        if (typeof r.financialPct === 'number' && Number.isFinite(r.financialPct)) {
          return r.financialPct;
        }
        return r.totalActiveAmount > 0 ? -1 : null;
      },
      format: (v, r, ext) => formatFinancialStatusText(r, ext),
    },
    {
      key: 'fileNumber',
      label: 'File Number',
      group: 'Work',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.fileNumber || '',
    },
    {
      key: 'subject',
      label: 'Subject / Work Name',
      group: 'Work',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.subject || '',
    },
    {
      key: 'activityName',
      label: 'Activity',
      group: 'Work',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.activityName || r.activityNames || '',
    },
    {
      key: 'activityNames',
      label: 'Activities',
      group: 'Work',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.activityNames || '',
    },
    {
      key: 'billCategory',
      label: 'Bill Status',
      group: 'Work',
      type: 'badge',
      defaultVisible: false,
      getValue: (r) => r.billLabel || '',
    },
    {
      key: 'latestBillStatus',
      label: 'Latest Bill Status',
      group: 'Work',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.latestBillStatus || '',
    },
    {
      key: 'manualArchiveReason',
      label: 'Archive Reason',
      group: 'Work',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.manualArchiveReason || '',
    },
    {
      key: 'lastProgressUpdatedAt',
      label: 'Last Progress Update',
      group: 'Work Progress',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => {
        const db = getDb();
        return r.lastProgressUpdatedAt && db
          ? db.formatProgressTimestamp(r.lastProgressUpdatedAt)
          : '';
      },
      getSortValue: (r) => r.lastProgressUpdatedAt || null,
    },
    {
      key: 'progressHistory',
      label: 'Progress History',
      group: 'Work Progress',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.progressHistorySummary || '',
    },
    {
      key: 'parliamentConstituency',
      label: 'Parliament Constituency',
      group: 'Location',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.parliamentConstituency || '',
    },
    {
      key: 'asNo',
      label: 'AS No.',
      group: 'Sanctions',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.asNo || '',
    },
    {
      key: 'asDate',
      label: 'AS Date',
      group: 'Sanctions',
      type: 'date',
      defaultVisible: false,
      getValue: (r) => r.asDate || '',
    },
    {
      key: 'asAmount',
      label: 'AS Amount (₹)',
      group: 'Sanctions',
      type: 'money',
      defaultVisible: false,
      getValue: (r) => r.asAmountNum,
      format: (v, r, ext) => (v > 0 ? ext.formatInr(v) : r.asAmount || ''),
    },
    {
      key: 'asAuthority',
      label: 'AS Authority',
      group: 'Sanctions',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.asAuthority || '',
    },
    {
      key: 'tsNo',
      label: 'TS No.',
      group: 'Sanctions',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.tsNo || '',
    },
    {
      key: 'tsDate',
      label: 'TS Date',
      group: 'Sanctions',
      type: 'date',
      defaultVisible: false,
      getValue: (r) => r.tsDate || '',
    },
    {
      key: 'tsAmount',
      label: 'TS Amount (₹)',
      group: 'Sanctions',
      type: 'money',
      defaultVisible: false,
      getValue: (r) => r.tsAmountNum,
      format: (v, r, ext) => (v > 0 ? ext.formatInr(v) : r.tsAmount || ''),
    },
    {
      key: 'adjustedTsAmount',
      label: 'Adjusted TS (₹)',
      group: 'Sanctions',
      type: 'money',
      defaultVisible: false,
      getValue: (r) => r.adjustedTsAmount,
      format: (v, r, ext) => (v > 0 ? ext.formatInr(v) : ''),
    },
    {
      key: 'tsAuthority',
      label: 'TS Authority',
      group: 'Sanctions',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.tsAuthority || '',
    },
    {
      key: 'agreementNo',
      label: 'Agreement No.',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.agreementNo || '',
    },
    {
      key: 'agreementDate',
      label: 'Date of Agreement',
      group: 'Agreement & Contractor',
      type: 'date',
      defaultVisible: false,
      getValue: (r) => r.agreementDate || '',
    },
    {
      key: 'negotiatedRate',
      label: 'Negotiated Rate (%)',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.negotiatedRate || '',
    },
    {
      key: 'contractorMobile',
      label: 'Contractor Phone',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.contractorMobile || '',
    },
    {
      key: 'contractorPan',
      label: 'Contractor PAN',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.contractorPan || '',
    },
    {
      key: 'contractorEmail',
      label: 'Contractor Email',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.contractorEmail || '',
    },
    {
      key: 'contractorType',
      label: 'Applicant Type',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.contractorType || '',
    },
    {
      key: 'contractorLicenseSource',
      label: 'License Source',
      group: 'Agreement & Contractor',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.contractorLicenseSource || '',
    },
    {
      key: 'contractorSignedDate',
      label: 'Contractor Signed Date',
      group: 'Schedule',
      type: 'date',
      defaultVisible: false,
      getValue: (r) => r.contractorSignedDate || '',
    },
    {
      key: 'extensionFine',
      label: 'Extension Fine (₹)',
      group: 'Schedule',
      type: 'money',
      defaultVisible: false,
      getValue: (r) => r.extensionFine,
      format: (v, r, ext) => (v > 0 ? ext.formatInr(v) : ''),
    },
    {
      key: 'extensionsHistory',
      label: 'Extension Details',
      group: 'Schedule',
      type: 'text',
      defaultVisible: false,
      getValue: (r) => r.extensionsSummary || '',
    },
  ];

  const COLUMN_MAP = Object.assign(
    Object.create(null),
    Object.fromEntries(COLUMNS.map((c) => [c.key, c]))
  );

  const COLUMN_PRESETS = {
    standard: COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key),
    agreement_schedule: [
      'slNo',
      'workDetails',
      'constituency',
      'agreementNoDate',
      'agreedPac',
      'contractorName',
      'shoDate',
      'periodText',
      'completionDate',
      'extendedCompletionDate',
      'extensionFine',
      'scheduleStatus',
      'workStatus',
      'physicalProgress',
    ],
    sanctions: [
      'slNo',
      'workDetails',
      'constituency',
      'parliamentConstituency',
      'asNoDate',
      'asAmount',
      'asAuthority',
      'tsNoDate',
      'tsAmount',
      'adjustedTsAmount',
      'tsAuthority',
      'totalActiveAmount',
    ],
    all: COLUMNS.map((c) => c.key),
  };

  function computeScheduleRank(sched) {
    if (sched.key === 'overdue') return sched.daysDelta;
    if (sched.key === 'ongoing') return sched.daysDelta;
    if (sched.key === 'completed') return 1000000;
    return 2000000;
  }

  function computeRowHaystack(r) {
    const childHay = (r.activityRows || [])
      .map((a) =>
        [
          a.activityName,
          a.constituency,
          a.asNo,
          a.tsNo,
          a.contractorName,
          a.workStatus,
          a.manualArchiveReason,
        ]
          .filter(Boolean)
          .join(' ')
      )
      .join(' ');
    return [
      r.fileNumber,
      r.subject,
      r.activityName,
      r.activityNames,
      r.constituency,
      r.parliamentConstituency,
      r.asNo,
      r.tsNo,
      r.agreementNo,
      r.contractorName,
      r.workStatus,
      r.extensionsSummary,
      r.manualArchiveReason,
      r.progressHistorySummary,
      childHay,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function buildActivitySubRow(
    workRecord,
    act,
    pd,
    userFields,
    referenceTodayDmy,
    ext,
    compositeGroupTotal,
    activityCount
  ) {
    const db = getDb();
    const canInheritPdExecution =
      Number(activityCount || 0) <= 1 ||
      Boolean(act.isCompositeFinal || act.isCompositeGroupMember || act.isCompositeSibling);
    const actPd = act.details || (canInheritPdExecution ? pd : {}) || {};
    const ctr = actPd.contractor || (canInheritPdExecution && pd && pd.contractor) || {};

    const schedFallbackPd = canInheritPdExecution ? pd : null;
    const schedDates = ext.resolveScheduleDates(actPd, schedFallbackPd, referenceTodayDmy);
    const shoDate = schedDates.shoDate;
    const completionDate = schedDates.completionDate;
    const periodText = schedDates.periodText;
    const periodDaysTotal = schedDates.periodDaysTotal;

    const hasActFinal = Boolean(
      act.isFinalized || (act.bills || []).some((b) => !b.isCancelled && !b.isDraft && b.kind === 'Final')
    );
    const actSched = ext.computeScheduleStatus(
      completionDate,
      hasActFinal,
      referenceTodayDmy,
      userFields.extendedCompletionDate
    );

    const activeBills = (act.bills || []).filter((b) => !b.isCancelled && !b.isDraft);
    const billable = activeBills.filter((b) => b.includedInWorkTotal);
    const rawCompBilled = billable.reduce((acc, b) => acc + ext.parseInr(b.grandTotal), 0);
    const totalActive =
      act.isCompositeFinal && act.groupHasCf && typeof compositeGroupTotal === 'number'
        ? compositeGroupTotal
        : rawCompBilled;

    const latestPool = billable.length ? billable : activeBills.length ? activeBills : act.bills || [];
    const latestBill = ext.pickLatestBill(latestPool);

    const asNo = actPd.asNo || (canInheritPdExecution ? pd.asNo : '') || '';
    const asDate = actPd.asDate || (canInheritPdExecution ? pd.asDate : '') || '';
    const tsNo = actPd.tsNo || (canInheritPdExecution ? pd.tsNo : '') || '';
    const tsDate = actPd.tsDate || (canInheritPdExecution ? pd.tsDate : '') || '';
    const asAmount = actPd.asAmount || (canInheritPdExecution ? pd.asAmount : '') || '';
    const asAuthority = actPd.asAuthority || (canInheritPdExecution ? pd.asAuthority : '') || '';
    const tsAmount = actPd.tsAmount || (canInheritPdExecution ? pd.tsAmount : '') || '';
    const tsAuthority = actPd.tsAuthority || (canInheritPdExecution ? pd.tsAuthority : '') || '';
    const agreedPac = actPd.agreedPac || (canInheritPdExecution ? pd.agreedPac : '') || '';
    const estimatePac = actPd.estimatePac || (canInheritPdExecution ? pd.estimatePac : '') || '';
    const negotiatedRate =
      actPd.negotiatedRate || (canInheritPdExecution ? pd.negotiatedRate : '') || '';
    const agreementNo = actPd.agreementNo || (canInheritPdExecution ? pd.agreementNo : '') || '';
    const agreementDate = schedDates.agreementDate;
    const contractorSignedDate = schedDates.contractorSignedDate;

    const asAmountNum = asAmount ? ext.parseInr(asAmount) : null;
    const tsAmountNum = tsAmount ? ext.parseInr(tsAmount) : null;
    const agreedPacNum = agreedPac ? ext.parseInr(agreedPac) : null;

    const financialStatus = ext.computeFinancialStatus(totalActive, {
      tsAmount: tsAmountNum || tsAmount,
      negotiatedRate,
      agreedPac,
      estimatePac,
    });

    const isManuallyArchived = Boolean(
      act.isManuallyArchived || (userFields.manualArchive && userFields.manualArchive.archived)
    );
    const manualArchive = act.manualArchive || userFields.manualArchive || null;
    const periodProgress = ext.computePeriodProgress({
      shoDate,
      completionDate,
      isFinalized: hasActFinal,
      isManuallyArchived,
      isMbookClosed: Boolean(act.isMbookClosed),
      referenceTodayDmy,
    });

    const fileId = String(workRecord.fileId || '');
    const actKey = act.activityKey || act.estimateCode || act.activityName || '';
    const editActivityKey = db
      ? db.resolveUserDataScope(workRecord, actKey, activityCount)
      : Number(activityCount || 0) <= 1
      ? ''
      : actKey;
    const rawUd = db ? db.normalizeUserData(workRecord && workRecord.userData) : null;
    const rawOv =
      rawUd && actKey && rawUd.activityOverrides && Object.hasOwn(rawUd.activityOverrides, actKey)
        ? rawUd.activityOverrides[actKey]
        : null;
    const hasExtensionOverride = Boolean(rawOv && rawOv.extensions && rawOv.extensions.length > 0);

    const drafts = (act.bills || []).filter((b) => b.isDraft);
    const cancelled = (act.bills || []).filter((b) => b.isCancelled);
    const parts = activeBills.filter((b) => b.kind === 'Part');
    const preFinals = activeBills.filter((b) => b.kind === 'Pre-Final');
    const mbookClosedNoFinal =
      typeof act.mbookClosedNoFinal === 'boolean'
        ? act.mbookClosedNoFinal
        : Boolean(act.isMbookClosed && !hasActFinal && !(act.isCompositeSibling && act.groupHasCf));

    let actCategoryKey = 'nobill';
    if (isManuallyArchived) {
      actCategoryKey = 'manually_archived';
    } else if (hasActFinal || (act.isCompositeSibling && act.groupHasCf)) {
      actCategoryKey = 'final';
    } else if (preFinals.length > 0) {
      actCategoryKey = 'prefinal_only';
    } else if (mbookClosedNoFinal && parts.length === 0) {
      actCategoryKey = 'mbook_closed_no_final';
    } else if (parts.length > 0) {
      actCategoryKey = 'part_only';
    } else if (drafts.length > 0 && activeBills.length === 0) {
      actCategoryKey = 'nobill';
    } else if (cancelled.length > 0 && activeBills.length === 0) {
      actCategoryKey = 'cancelled';
    } else if (!act.hasEBillStage && !act.hasPostTender && !act.hasSiteHandover && !act.hasEmbook) {
      actCategoryKey = 'dpr';
    }

    const canInheritLoc = canInheritPdExecution || !actPd.fetchedAt;
    const rowObj = {
      isActivityRow: true,
      rowKey: `${fileId}::${actKey}`,
      _rowIndex: '',
      fileId,
      fileNumber: workRecord.fileNumber || '',
      workSubject: workRecord.subject || '',
      subject: act.activityName || act.componentLabel || '',
      activityName: act.activityName || '',
      activityKey: actKey,
      editActivityKey,
      hasExtensionOverride,
      estimateCode: act.estimateCode || '',
      workGroup: act.workGroup || '',
      isCompositeFinal: Boolean(act.isCompositeFinal),
      isCompositeGroupMember: Boolean(act.isCompositeGroupMember),
      isCompositeSibling: Boolean(act.isCompositeSibling),
      groupHasCf: Boolean(act.groupHasCf),
      activityNames: act.activityName || '',
      billCategoryKey: actCategoryKey,
      billLabel: act.compBadgeText || '',
      billBadgeClass: act.compBadgeClass || 'p3h-badge-nobill',
      hasPart: parts.length > 0,
      isFinalized: hasActFinal,
      isTerminallySubmitted: Boolean(act.isTerminallySubmitted),
      lifecycleState: act.lifecycleState || 'active',
      isMbookOpen: Boolean(act.isMbookOpen),
      isMbookClosed: Boolean(act.isMbookClosed),
      mbookClosedNoFinal,
      isManuallyArchived,
      isWorkManuallyArchived: Boolean(userFields.isWorkManuallyArchived),
      isActivityManuallyArchived: Boolean(userFields.isActivityManuallyArchived),
      manualArchive,
      manualArchiveReason: (manualArchive && manualArchive.reason) || '',
      manualArchivedAt: (manualArchive && manualArchive.archivedAt) || '',
      totalActiveAmount: totalActive > 0 ? totalActive : null,
      adjustedTsAmount: financialStatus.adjustedTsAmount,
      financialPct: financialStatus.pct,
      financialBasis: financialStatus.basis,
      negotiatedRate,
      latestBillStatus: latestBill ? latestBill.status || '' : '',
      constituency: actPd.constituency || (canInheritLoc ? pd.constituency : '') || '',
      parliamentConstituency:
        actPd.parliamentConstituency || (canInheritLoc ? pd.parliamentConstituency : '') || '',
      asNo,
      asDate,
      asNoDateText: formatNoAndDate(asNo, asDate),
      asAmount,
      asAmountNum: asAmountNum > 0 ? asAmountNum : null,
      asAuthority,
      tsNo,
      tsDate,
      tsNoDateText: formatNoAndDate(tsNo, tsDate),
      tsAmount,
      tsAmountNum: tsAmountNum > 0 ? tsAmountNum : null,
      tsAuthority,
      agreementNo,
      agreementDate,
      agreementNoDateText: formatNoAndDate(agreementNo, agreementDate),
      agreedPac,
      agreedPacNum: agreedPacNum > 0 ? agreedPacNum : null,
      contractorName: ctr.name || '',
      contractorMobile: ctr.mobile || '',
      contractorPan: ctr.pan || '',
      contractorEmail: ctr.email || '',
      contractorType: ctr.applicantType || '',
      contractorLicenseSource: ctr.licenseSource || '',
      periodText,
      periodDaysTotal,
      shoDate,
      contractorSignedDate,
      completionDate,
      periodProgress,
      extendedCompletionDate: userFields.extendedCompletionDate,
      extensionOrder: userFields.extensionOrder,
      extensionFine: userFields.totalFine > 0 ? userFields.totalFine : null,
      extensionsSummary: userFields.extensionsSummary,
      scheduleStatusKey: actSched.key,
      scheduleStatusLabel: actSched.label,
      scheduleSortRank: computeScheduleRank(actSched),
      workStatus: userFields.workStatus || '',
      physicalProgress: userFields.physicalProgress,
      progressHistory: userFields.progressHistory || [],
      lastProgressUpdatedAt: userFields.lastProgressUpdatedAt || '',
      progressHistorySummary: userFields.progressHistorySummary || '',
      mbookStatus: act.mbookStatus || '',
      wcaStage: act.wcaStage || '',
    };
    rowObj._searchHaystack = computeRowHaystack(rowObj);
    return rowObj;
  }

  function buildRegisterRow(workRecord, index, referenceTodayDmy) {
    const ext = getExtractor();
    const db = getDb();
    const summary = ext.analyzeWorkRecord(workRecord);
    const pd = (workRecord && workRecord.projectDetails) || {};
    const contractor = pd.contractor || {};
    const missingInfo = ext.getMissingFields(workRecord, summary);
    const userFields = db.getEffectiveUserFields(workRecord);

    const schedDates = ext.resolveScheduleDates(pd, null, referenceTodayDmy);
    let periodText = schedDates.periodText;
    let periodDaysTotal = schedDates.periodDaysTotal;
    let shoDate = schedDates.shoDate;
    let completionDate = schedDates.completionDate;
    let contractorSignedDate = schedDates.contractorSignedDate;

    const isFullyFinalized = Boolean(summary.isFullyFinalized);

    // Precompute composite group cumulative billed amounts for Composite Final Component rows
    const compositeGroupTotals = {};
    (summary.activities || []).forEach((act) => {
      if (act.isCompositeGroupMember && !act.isManuallyArchived) {
        const gk = (act.workGroup || '').toLowerCase();
        compositeGroupTotals[gk] = (compositeGroupTotals[gk] || 0) + (act.compTotalActiveAmount || 0);
      }
    });

    const actCount = (summary.activities || []).length;
    const activityRows = (summary.activities || []).map((act) => {
      const actUser = db.getEffectiveUserFields(workRecord, act.activityKey);
      const gk = (act.workGroup || '').toLowerCase();
      const grpTotal = act.isCompositeFinal && act.groupHasCf ? compositeGroupTotals[gk] : undefined;
      return buildActivitySubRow(
        workRecord,
        act,
        pd,
        actUser,
        referenceTodayDmy,
        ext,
        grpTotal,
        actCount
      );
    });
    const activityNamesList = summary.activityNames || [];

    const activitiesWithFetchedDetails = (summary.activities || []).filter(
      (a) => a.details && a.details.fetchedAt
    );
    const splitParentDetails = Boolean(
      summary.hasIndependentActivities && activitiesWithFetchedDetails.length >= 2
    );

    const pickUnanimous = (list, getter) => {
      if (!Array.isArray(list) || list.length === 0) return '';
      const vals = list.map((item) => String(getter(item) || '').trim());
      if (vals.some((v) => !v)) return '';
      return vals.every((v) => v === vals[0]) ? vals[0] : '';
    };
    const joinUniqueCsv = (list, getter) => {
      const seen = new Set();
      const out = [];
      (list || []).forEach((item) => {
        String(getter(item) || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((part) => {
            if (!seen.has(part)) {
              seen.add(part);
              out.push(part);
            }
          });
      });
      return out.join(', ');
    };

    let constituency = pd.constituency || '';
    let parliamentConstituency = pd.parliamentConstituency || '';
    let asNo = pd.asNo || '';
    let asDate = pd.asDate || '';
    let asAuthority = pd.asAuthority || '';
    let asAmount = pd.asAmount || '';
    let asAmountNum = pd.asAmount ? ext.parseInr(pd.asAmount) : null;
    let tsNo = pd.tsNo || '';
    let tsDate = pd.tsDate || '';
    let tsAuthority = pd.tsAuthority || '';
    let tsAmount = pd.tsAmount || '';
    let tsAmountNum = pd.tsAmount ? ext.parseInr(pd.tsAmount) : null;
    let agreementNo = pd.agreementNo || '';
    let agreementDate = schedDates.agreementDate;
    let agreedPac = pd.agreedPac || '';
    let agreedPacNum = pd.agreedPac ? ext.parseInr(pd.agreedPac) : null;
    let negotiatedRate = pd.negotiatedRate || '';
    let contractorName = contractor.name || '';
    let contractorMobile = contractor.mobile || '';
    let contractorPan = contractor.pan || '';
    let contractorEmail = contractor.email || '';
    let contractorType = contractor.applicantType || '';
    let contractorLicenseSource = contractor.licenseSource || '';

    const workFin = ext.computeWorkFinancialStatus(workRecord, summary);
    let adjustedTsAmount = workFin.adjustedTsAmount;
    let financialPct = workFin.pct;
    const financialBasis = workFin.basis;

    if (splitParentDetails) {
      const activeSubs = activityRows.filter((a) => !a.isManuallyArchived);
      const detailPool = activeSubs.length > 0 ? activeSubs : activityRows;

      constituency = joinUniqueCsv(detailPool, (a) => a.constituency);
      parliamentConstituency = joinUniqueCsv(detailPool, (a) => a.parliamentConstituency);

      asNo = pickUnanimous(detailPool, (a) => a.asNo);
      asDate = pickUnanimous(detailPool, (a) => a.asDate);
      asAuthority = pickUnanimous(detailPool, (a) => a.asAuthority);
      if (asNo) {
        const firstAs = detailPool.find((a) => a.asAmountNum > 0);
        asAmountNum = firstAs ? firstAs.asAmountNum : null;
        asAmount = firstAs && firstAs.asAmount ? firstAs.asAmount : asAmountNum ? String(asAmountNum) : '';
      } else {
        const seenAs = new Set();
        let sumAs = 0;
        detailPool.forEach((a) => {
          const k = a.asNo || a.activityKey || '';
          if (a.asAmountNum > 0 && (!k || !seenAs.has(k))) {
            if (k) seenAs.add(k);
            sumAs += a.asAmountNum;
          }
        });
        asAmountNum = sumAs > 0 ? Math.round(sumAs * 100) / 100 : null;
        asAmount = asAmountNum ? String(asAmountNum) : '';
      }

      tsNo = pickUnanimous(detailPool, (a) => a.tsNo);
      tsDate = pickUnanimous(detailPool, (a) => a.tsDate);
      tsAuthority = pickUnanimous(detailPool, (a) => a.tsAuthority);
      const sumTs = detailPool.reduce((acc, a) => acc + (a.tsAmountNum > 0 ? a.tsAmountNum : 0), 0);
      tsAmountNum = sumTs > 0 ? Math.round(sumTs * 100) / 100 : null;
      tsAmount = tsAmountNum ? String(tsAmountNum) : '';

      agreementNo = pickUnanimous(detailPool, (a) => a.agreementNo);
      agreementDate = pickUnanimous(detailPool, (a) => a.agreementDate);
      negotiatedRate = pickUnanimous(detailPool, (a) => a.negotiatedRate);
      const sumPac = detailPool.reduce((acc, a) => acc + (a.agreedPacNum > 0 ? a.agreedPacNum : 0), 0);
      agreedPacNum = sumPac > 0 ? Math.round(sumPac * 100) / 100 : null;
      agreedPac = agreedPacNum ? String(agreedPacNum) : '';

      contractorName = pickUnanimous(detailPool, (a) => a.contractorName);
      if (contractorName) {
        contractorMobile = pickUnanimous(detailPool, (a) => a.contractorMobile);
        contractorPan = pickUnanimous(detailPool, (a) => a.contractorPan);
        contractorEmail = pickUnanimous(detailPool, (a) => a.contractorEmail);
        contractorType = pickUnanimous(detailPool, (a) => a.contractorType);
        contractorLicenseSource = pickUnanimous(detailPool, (a) => a.contractorLicenseSource);
      } else {
        contractorMobile = '';
        contractorPan = '';
        contractorEmail = '';
        contractorType = '';
        contractorLicenseSource = '';
      }

      shoDate = pickUnanimous(detailPool, (a) => a.shoDate);
      contractorSignedDate = pickUnanimous(detailPool, (a) => a.contractorSignedDate);
      periodText = pickUnanimous(detailPool, (a) => a.periodText);
      completionDate = pickUnanimous(detailPool, (a) => a.completionDate);
      if (periodText && shoDate && completionDate) {
        const firstMatch = detailPool.find((a) => a.periodDaysTotal != null);
        periodDaysTotal = firstMatch ? firstMatch.periodDaysTotal : null;
      } else {
        periodDaysTotal = null;
      }

      const hasAggTs =
        financialBasis === 'multi_activity_sum' || financialBasis === 'composite_group_sum';
      if (!hasAggTs) {
        adjustedTsAmount = null;
        financialPct = null;
      }
    }

    const sched = splitParentDetails
      ? isFullyFinalized
        ? { key: 'completed', label: 'Finalized', daysDelta: null }
        : completionDate
        ? ext.computeScheduleStatus(
            completionDate,
            false,
            referenceTodayDmy,
            userFields.extendedCompletionDate
          )
        : { key: 'no_date', label: 'Per Activity', daysDelta: null }
      : ext.computeScheduleStatus(
          completionDate,
          isFullyFinalized,
          referenceTodayDmy,
          userFields.extendedCompletionDate
        );

    const seenCompositeDueGroups = new Set();
    const activeDueItems = activityRows.filter((a) => {
      if (a.isFinalized || a.isManuallyArchived || a.isMbookClosed || !a.periodProgress) {
        return false;
      }
      if (a.isCompositeGroupMember || a.isCompositeFinal) {
        const gk = (a.workGroup || '__default__').toLowerCase();
        if (seenCompositeDueGroups.has(gk)) return false;
        seenCompositeDueGroups.add(gk);
      }
      return true;
    });
    const hasAnyOpenNonClosedMbook = activityRows.some(
      (a) => !a.isFinalized && !a.isManuallyArchived && !a.isMbookClosed
    );
    const filePeriodProgress =
      activeDueItems.length === 1
        ? activeDueItems[0].periodProgress
        : splitParentDetails
        ? null
        : ext.computePeriodProgress({
            shoDate,
            completionDate,
            isFinalized: isFullyFinalized,
            isManuallyArchived: Boolean(summary.isFullyManuallyArchived),
            isMbookClosed:
              activityRows.length > 0
                ? !hasAnyOpenNonClosedMbook && Boolean(summary.hasMbookClosedNoFinal)
                : Boolean(summary.hasMbookClosedNoFinal),
            referenceTodayDmy,
          });
    const hasOpenMbook75 = activityRows.some(
      (a) =>
        !a.isFinalized &&
        !a.isManuallyArchived &&
        a.isMbookOpen &&
        Boolean(a.periodProgress && a.periodProgress.reached75)
    );

    const fileId = String(workRecord.fileId || '');
    const isManuallyArchived = Boolean(
      workRecord.isManuallyArchived ||
        summary.isFullyManuallyArchived ||
        userFields.isWorkManuallyArchived
    );
    const manualArchive = userFields.manualArchive || null;

    const rowObj = {
      raw: workRecord,
      summary,
      missingInfo,
      isActivityRow: false,
      hasSplitActivityDetails: splitParentDetails,
      rowKey: fileId,
      _rowIndex: index + 1,
      fileId,
      fileNumber: workRecord.fileNumber || '',
      subject: workRecord.subject || '',
      isArchived: Boolean(workRecord.isArchived),
      isManuallyArchived,
      isWorkManuallyArchived: Boolean(userFields.isWorkManuallyArchived),
      hasManualArchive: Boolean(workRecord.hasManualArchive || summary.hasAnyManualArchive),
      manualArchive,
      manualArchiveReason: (manualArchive && manualArchive.reason) || '',
      manualArchivedAt: (manualArchive && manualArchive.archivedAt) || '',
      activityNamesList,
      activityNames: activityNamesList.join(', '),
      activityRows,
      billCategoryKey: summary.categoryKey,
      billLabel: summary.label,
      billBadgeClass: summary.badgeClass,
      hasFinal: isFullyFinalized,
      isFullyFinalized,
      hasAnyFinal: Boolean(summary.hasAnyFinal),
      hasPart: summary.hasPart,
      hasMbookClosedNoFinal: summary.hasMbookClosedNoFinal,
      totalActiveAmount: summary.totalActiveAmount > 0 ? summary.totalActiveAmount : null,
      adjustedTsAmount,
      financialPct,
      financialBasis,
      negotiatedRate,
      latestBillStatus: summary.latestBill ? summary.latestBill.status || '' : '',
      constituency,
      parliamentConstituency,
      asNo,
      asDate,
      asNoDateText: formatNoAndDate(asNo, asDate),
      asAmount,
      asAmountNum: asAmountNum > 0 ? asAmountNum : null,
      asAuthority,
      tsNo,
      tsDate,
      tsNoDateText: formatNoAndDate(tsNo, tsDate),
      tsAmount,
      tsAmountNum: tsAmountNum > 0 ? tsAmountNum : null,
      tsAuthority,
      agreementNo,
      agreementDate,
      agreementNoDateText: formatNoAndDate(agreementNo, agreementDate),
      agreedPac,
      agreedPacNum: agreedPacNum > 0 ? agreedPacNum : null,
      contractorName,
      contractorMobile,
      contractorPan,
      contractorEmail,
      contractorType,
      contractorLicenseSource,
      periodText,
      periodDaysTotal,
      shoDate,
      contractorSignedDate,
      completionDate,
      periodProgress: filePeriodProgress,
      activeDueItems,
      hasOpenMbook75,
      extendedCompletionDate: userFields.extendedCompletionDate,
      extensionOrder: userFields.extensionOrder,
      extensionFine: userFields.totalFine > 0 ? userFields.totalFine : null,
      extensionsSummary: userFields.extensionsSummary,
      workStatus: userFields.workStatus || '',
      physicalProgress: userFields.physicalProgress,
      progressHistory: userFields.progressHistory || [],
      lastProgressUpdatedAt: userFields.lastProgressUpdatedAt || '',
      progressHistorySummary: userFields.progressHistorySummary || '',
      scheduleStatusKey: sched.key,
      scheduleStatusLabel: sched.label,
      scheduleSortRank: computeScheduleRank(sched),
      hasDetails: Boolean(pd.fetchedAt),
      isIncomplete: missingInfo.isIncomplete,
    };
    rowObj._searchHaystack = computeRowHaystack(rowObj);
    return rowObj;
  }

  /**
   * Builds flat Activity-wise rows scoped to active / archived / manually_archived / all.
   * Applies the Composite Work rule:
   * - If Composite Final Bill IS generated: keep only Composite Final Component row (no sibling duplication)
   * - If Composite Final Bill is NOT generated: keep each active composite component, omit empty Composite Final shell
   */
  function buildActivityRegisterRows(rawWorks, scope, referenceTodayDmy) {
    const mode = scope || 'active';
    const out = [];

    (rawWorks || []).forEach((w, idx) => {
      const parent = buildRegisterRow(w, idx, referenceTodayDmy);
      const subs = parent.activityRows || [];

      if (subs.length === 0) {
        const matchesScope =
          mode === 'all' ||
          (mode === 'active' && !parent.isManuallyArchived && !parent.isArchived) ||
          (mode === 'archived' && parent.isArchived && !parent.isManuallyArchived) ||
          (mode === 'manually_archived' && parent.isManuallyArchived);
        if (matchesScope) {
          const fallbackRow = {
            ...parent,
            isActivityRow: true,
            activityKey: '',
            editActivityKey: '',
            activityName: parent.activityNames || '',
            isFinalized: Boolean(parent.isFullyFinalized),
            _rowIndex: out.length + 1,
          };
          fallbackRow._searchHaystack = computeRowHaystack(fallbackRow);
          out.push(fallbackRow);
        }
        return;
      }

      const compositeSiblingGroups = new Set();
      subs.forEach((s) => {
        if (s.isCompositeSibling) compositeSiblingGroups.add((s.workGroup || '').toLowerCase());
      });

      const dedupedSubs = subs.filter((s) => {
        const gk = (s.workGroup || '').toLowerCase();
        if (s.groupHasCf && s.isCompositeSibling) return false;
        if (!s.groupHasCf && s.isCompositeFinal && compositeSiblingGroups.has(gk)) return false;
        return true;
      });

      dedupedSubs.forEach((s) => {
        let keep = true;
        if (mode === 'active') {
          keep = s.lifecycleState === 'active';
        } else if (mode === 'archived') {
          keep = s.lifecycleState === 'finalized_archived';
        } else if (mode === 'manually_archived') {
          keep = s.lifecycleState === 'manually_archived';
        }
        if (!keep) return;

        const rowItem = {
          ...s,
          raw: parent.raw,
          summary: parent.summary,
          missingInfo: parent.missingInfo,
          isIncomplete: parent.isIncomplete,
          hasDetails: parent.hasDetails,
          isArchived: parent.isArchived,
          subject: parent.subject || s.subject,
          activityNamesList: s.activityName ? [s.activityName] : [],
          hasFinal: s.isFinalized,
          isFullyFinalized: s.isFinalized,
          hasPart: Boolean(s.hasPart),
          hasMbookClosedNoFinal: Boolean(s.mbookClosedNoFinal),
          hasOpenMbook75: Boolean(
            !s.isFinalized &&
              !s.isManuallyArchived &&
              s.isMbookOpen &&
              s.periodProgress &&
              s.periodProgress.reached75
          ),
          compositePacGroupKey: s.isCompositeGroupMember
            ? `${s.fileId}::${(s.workGroup || '').toLowerCase()}`
            : '',
          _rowIndex: out.length + 1,
        };
        rowItem._searchHaystack = computeRowHaystack(rowItem);
        out.push(rowItem);
      });
    });

    return out;
  }

  function matchesSingleBillCategory(r, billCat) {
    if (billCat === 'final') {
      return r.isActivityRow ? Boolean(r.isFinalized) : Boolean(r.isFullyFinalized);
    }
    if (billCat === 'not_final') {
      return r.isActivityRow
        ? !r.isFinalized && !r.isManuallyArchived
        : Boolean(r.summary && r.summary.scanned && !r.isFullyFinalized && !r.isManuallyArchived);
    }
    if (billCat === 'mbook_closed_no_final') return Boolean(r.hasMbookClosedNoFinal);
    if (billCat === 'has_part') return Boolean(r.hasPart);
    if (billCat === 'part_only') {
      return r.billCategoryKey === 'part_only' || r.billCategoryKey === 'prefinal_only';
    }
    if (billCat === 'nobill') {
      return r.billCategoryKey === 'nobill' || r.billCategoryKey === 'cancelled';
    }
    if (billCat === 'dpr') return r.billCategoryKey === 'dpr';
    if (billCat === 'manually_archived') {
      return Boolean(r.isManuallyArchived || r.hasManualArchive);
    }
    if (billCat === 'missing_details') {
      return Boolean(!r.isManuallyArchived && r.isIncomplete);
    }
    return true;
  }

  function filterRegisterRows(rows, filters) {
    const ext = getExtractor();
    const f = filters || {};
    const q = String(f.search || '').trim().toLowerCase();
    const billCats = normalizeFilterList(f.billCategory);
    const actFilters = normalizeFilterList(f.activity);
    const lacFilters = normalizeFilterList(f.constituency);
    const contractorFilters = normalizeFilterList(f.contractor);
    const schedFilters = normalizeFilterList(f.scheduleStatus);
    const openMbook75 = Boolean(f.openMbook75);
    const hideExcluded = Boolean(f.hideExcluded);
    const excludedSet =
      f.excludedKeys instanceof Set ? f.excludedKeys : new Set(f.excludedKeys || []);
    const dateField = f.dateField || 'agreementDate';
    const dateFrom = String(f.dateFrom || '').trim();
    const dateTo = String(f.dateTo || '').trim();

    return (rows || []).filter((r) => {
      if (hideExcluded && r.rowKey && excludedSet.has(r.rowKey)) {
        return false;
      }

      if (openMbook75) {
        if (r.isActivityRow) {
          if (
            r.isFinalized ||
            r.isManuallyArchived ||
            !r.isMbookOpen ||
            !r.periodProgress ||
            !r.periodProgress.reached75
          ) {
            return false;
          }
        } else if (!r.hasOpenMbook75) {
          return false;
        }
      }

      if (billCats.length > 0 && !billCats.some((cat) => matchesSingleBillCategory(r, cat))) {
        return false;
      }

      if (actFilters.length > 0) {
        if (r.isActivityRow) {
          if (!actFilters.includes(r.activityName)) return false;
        } else if (
          !r.activityNamesList ||
          !actFilters.some((a) => r.activityNamesList.includes(a))
        ) {
          return false;
        }
      }

      if (lacFilters.length > 0) {
        const lacSetForRow = new Set(
          String(r.constituency || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        if (!r.isActivityRow && Array.isArray(r.activityRows)) {
          r.activityRows.forEach((ar) => {
            String(ar.constituency || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .forEach((l) => lacSetForRow.add(l));
          });
        }
        if (!lacFilters.some((lac) => lacSetForRow.has(lac))) return false;
      }

      if (contractorFilters.length > 0) {
        const matchParent = contractorFilters.includes(r.contractorName);
        const matchChild = (r.activityRows || []).some((a) =>
          contractorFilters.includes(a.contractorName)
        );
        if (!matchParent && !matchChild) return false;
      }

      if (schedFilters.length > 0) {
        if (!r.isActivityRow && r.hasSplitActivityDetails) {
          const children = (r.activityRows || []).filter((a) => !a.isManuallyArchived);
          const matchChild = children.some((a) => schedFilters.includes(a.scheduleStatusKey));
          if (!schedFilters.includes(r.scheduleStatusKey) && !matchChild) return false;
        } else if (!schedFilters.includes(r.scheduleStatusKey)) {
          return false;
        }
      }

      if (dateFrom || dateTo) {
        const matchesDateRange = (item) => {
          const rawDate = (item && item[dateField]) || '';
          const iso = ext.toIsoDate(rawDate);
          if (!iso) return false;
          if (dateFrom && iso < dateFrom) return false;
          if (dateTo && iso > dateTo) return false;
          return true;
        };
        if (!r.isActivityRow && r.hasSplitActivityDetails) {
          const children = (r.activityRows || []).filter((a) => !a.isManuallyArchived);
          if (!matchesDateRange(r) && !children.some(matchesDateRange)) return false;
        } else if (!matchesDateRange(r)) {
          return false;
        }
      }

      if (q) {
        const hay =
          typeof r._searchHaystack === 'string' ? r._searchHaystack : computeRowHaystack(r);
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  }

  function sortRegisterRows(rows, sortKey, sortDir) {
    const ext = getExtractor();
    const col = Object.hasOwn(COLUMN_MAP, sortKey) ? COLUMN_MAP[sortKey] : null;
    if (!col) return [...(rows || [])];
    const dir = sortDir === 'desc' ? -1 : 1;

    const getComparable = (row) => {
      if (typeof col.getSortValue === 'function') return col.getSortValue(row, ext);
      const val = col.getValue(row);
      if (col.type === 'date') {
        const iso = ext.toIsoDate(val);
        return iso || null;
      }
      if (col.type === 'money' || col.type === 'number') {
        return typeof val === 'number' && Number.isFinite(val) ? val : null;
      }
      const s = String(val == null ? '' : val).trim();
      return s || null;
    };

    const keyed = (rows || []).map((row) => ({ row, v: getComparable(row) }));
    keyed.sort((a, b) => {
      const av = a.v;
      const bv = b.v;
      const aEmpty = av === null || av === '';
      const bEmpty = bv === null || bv === '';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;

      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
      }
      if (col.type === 'date') {
        return av < bv ? -dir : av > bv ? dir : 0;
      }
      const sa = String(av);
      const sb = String(bv);
      return (
        (REG_COLLATOR
          ? REG_COLLATOR.compare(sa, sb)
          : sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })) * dir
      );
    });
    return keyed.map((k) => k.row);
  }

  function formatCellValue(col, row) {
    const ext = getExtractor();
    const val = col.getValue(row);
    if (typeof col.format === 'function') {
      return col.format(val, row, ext);
    }
    return val == null ? '' : String(val);
  }

  function getFilteredActivityRows(parentRow, activityFilter) {
    const list = parentRow.activityRows || [];
    const actFilters = normalizeFilterList(activityFilter);
    if (actFilters.length === 0) return list;
    return list.filter((a) => actFilters.includes(a.activityName));
  }

  function getEffectiveColumnsForView(selectedKeys, viewMode, scope) {
    const keys = [...(selectedKeys || [])];
    if (
      viewMode === 'activity' &&
      !keys.includes('workDetails') &&
      !keys.includes('activityName')
    ) {
      const subjIdx = keys.indexOf('subject');
      const fileIdx = keys.indexOf('fileNumber');
      const insertAt = subjIdx >= 0 ? subjIdx + 1 : fileIdx >= 0 ? fileIdx + 1 : 0;
      keys.splice(insertAt, 0, 'activityName');
    }
    if (scope === 'manually_archived' && !keys.includes('manualArchiveReason')) {
      const workIdx = keys.indexOf('workDetails');
      const actIdx = keys.indexOf('activityName');
      const subjIdx = keys.indexOf('subject');
      const insertAt =
        workIdx >= 0
          ? workIdx + 1
          : actIdx >= 0
          ? actIdx + 1
          : subjIdx >= 0
          ? subjIdx + 1
          : keys.length;
      keys.splice(insertAt, 0, 'manualArchiveReason');
    }
    return keys.filter((k) => Object.hasOwn(COLUMN_MAP, k));
  }

  function generateCsvFromColumns(rows, selectedKeys, options) {
    const opts = options || {};
    const viewMode = opts.viewMode || 'file';
    const includeActivities = viewMode !== 'activity' && Boolean(opts.includeActivities);
    const activityFilter = opts.activityFilter || [];
    const excludedSet =
      opts.excludedKeys instanceof Set ? opts.excludedKeys : new Set(opts.excludedKeys || []);
    const cols = (selectedKeys || [])
      .filter((k) => Object.hasOwn(COLUMN_MAP, k))
      .map((k) => COLUMN_MAP[k]);
    const headers = cols.map((c) => c.label);
    const lines = [headers.map(csvEscape).join(',')];

    const includedRows = (rows || []).filter((r) => !(r.rowKey && excludedSet.has(r.rowKey)));

    includedRows.forEach((row, idx) => {
      const line = cols.map((col) => {
        if (col.key === 'slNo') return csvEscape(idx + 1);
        return csvEscape(formatCellValue(col, row));
      });
      lines.push(line.join(','));

      if (includeActivities) {
        const subRows = getFilteredActivityRows(row, activityFilter).filter(
          (sub) => !(sub.rowKey && excludedSet.has(sub.rowKey))
        );
        subRows.forEach((sub) => {
          const subLine = cols.map((col) => {
            if (col.key === 'slNo') return csvEscape('');
            if (col.key === 'workDetails' || col.key === 'subject') {
              return csvEscape(`  ↳ ${sub.activityName || ''}`);
            }
            if (
              col.key === 'fileNumber' &&
              !selectedKeys.includes('subject') &&
              !selectedKeys.includes('workDetails')
            ) {
              return csvEscape(`${sub.fileNumber} [↳ ${sub.activityName}]`);
            }
            return csvEscape(formatCellValue(col, sub));
          });
          lines.push(subLine.join(','));
        });
      }
    });

    return lines.join('\r\n');
  }

  function renderStackedNoDateHtml(no, date) {
    const n = String(no || '').trim();
    const d = String(date || '').trim();
    if (!n && !d) return '';
    return (
      (n ? `<div class="p3h-stacked-main">${escapeHtml(n)}</div>` : '') +
      (d ? `<div class="p3h-stacked-sub">${escapeHtml(d)}</div>` : '')
    );
  }

  function renderFinancialCellHtml(row, ext) {
    const billed = Number(row && row.totalActiveAmount) || 0;
    const pct =
      row && typeof row.financialPct === 'number' && Number.isFinite(row.financialPct)
        ? row.financialPct
        : null;
    const adjTs = Number(row && row.adjustedTsAmount) || 0;
    const tsOrig = Number(row && row.tsAmountNum) || 0;
    const rateTxt = row && row.negotiatedRate ? ` | Rate: ${row.negotiatedRate}` : '';
    const titleBits = [];
    if (billed > 0) titleBits.push(`Billed: ₹${ext.formatInr(billed)}`);
    if (adjTs > 0) titleBits.push(`Adj. TS: ₹${ext.formatInr(adjTs)}`);
    if (tsOrig > 0) titleBits.push(`TS: ₹${ext.formatInr(tsOrig)}${rateTxt}`);
    const titleAttr = titleBits.length ? ` title="${escapeHtml(titleBits.join(' | '))}"` : '';

    if (billed <= 0 && pct === null) return '';
    return `<div class="p3h-fin-cell"${titleAttr}>${
      pct !== null ? `<div class="p3h-fin-pct">${escapeHtml(pct + '%')}</div>` : ''
    }${billed > 0 ? `<div class="p3h-fin-amt">₹${escapeHtml(ext.formatInr(billed))}</div>` : ''}</div>`;
  }

  function renderWorkDetailsReportHtml(row) {
    const fileNo = String((row && row.fileNumber) || '').trim();
    const subj = String((row && row.subject) || '').trim();
    const act = String((row && (row.activityName || row.activityNames)) || '').trim();
    const code = String((row && row.estimateCode) || '').trim();
    return (
      (fileNo ? `<div class="p3h-stacked-main">${escapeHtml(fileNo)}</div>` : '') +
      (subj ? `<div class="p3h-work-cell-subj">${escapeHtml(subj)}</div>` : '') +
      (act
        ? `<div class="p3h-work-cell-act">${escapeHtml(act)}${
            code ? ` <span class="act-code">[${escapeHtml(code)}]</span>` : ''
          }</div>`
        : '')
    );
  }

  function renderDueDateColumnHtml(row) {
    return escapeHtml((row && row.completionDate) || '');
  }

  function formatReportCellHtml(col, row, idxText) {
    const ext = getExtractor();
    if (col.key === 'slNo') return escapeHtml(idxText);
    if (col.key === 'workDetails') return renderWorkDetailsReportHtml(row);
    if (col.key === 'totalActiveAmount') return renderFinancialCellHtml(row, ext);
    if (col.key === 'completionDate') return renderDueDateColumnHtml(row);
    if (col.key === 'asNoDate') return renderStackedNoDateHtml(row.asNo, row.asDate);
    if (col.key === 'tsNoDate') return renderStackedNoDateHtml(row.tsNo, row.tsDate);
    if (col.key === 'agreementNoDate') {
      return renderStackedNoDateHtml(row.agreementNo, row.agreementDate);
    }
    if (col.key === 'extendedCompletionDate') {
      const dt = row.extendedCompletionDate || '';
      if (!dt) return '';
      const ord = row.extensionOrder
        ? ` <span class="ext-tag">${escapeHtml(getDb().formatOrdinal(row.extensionOrder))}</span>`
        : '';
      return `${escapeHtml(dt)}${ord}`;
    }
    return escapeHtml(formatCellValue(col, row));
  }

  function buildReportHtml({
    title,
    rows,
    selectedKeys,
    filterSummary,
    sortSummary,
    includeActivities,
    activityFilter,
    viewMode,
    excludedKeys,
  }) {
    const ext = getExtractor();
    const cols = (selectedKeys || [])
      .filter((k) => Object.hasOwn(COLUMN_MAP, k))
      .map((k) => COLUMN_MAP[k]);
    const mode = viewMode || 'file';
    const allowChildRows = mode !== 'activity' && Boolean(includeActivities);
    const excludedSet =
      excludedKeys instanceof Set ? excludedKeys : new Set(excludedKeys || []);
    const allRows = rows || [];
    const includedRows = allRows.filter((r) => !(r.rowKey && excludedSet.has(r.rowKey)));
    const excludedInScopeCount = allRows.length - includedRows.length;

    const moneyKeys = new Set([
      'totalActiveAmount',
      'asAmount',
      'tsAmount',
      'adjustedTsAmount',
      'agreedPac',
      'extensionFine',
    ]);
    const dedupCompositeKeys = new Set(['asAmount', 'tsAmount', 'adjustedTsAmount', 'agreedPac']);
    const seenCompositeByCol = Object.create(null);
    const seenFineFiles = new Set();
    const totals = Object.create(null);
    cols.forEach((c) => {
      if (moneyKeys.has(c.key)) {
        totals[c.key] = 0;
        seenCompositeByCol[c.key] = new Set();
      }
    });

    const hasSubjectCol = cols.some((c) => c.key === 'subject' || c.key === 'workDetails');
    const bodyParts = [];

    includedRows.forEach((row, idx) => {
      const tds = cols
        .map((col) => {
          if (Object.hasOwn(totals, col.key)) {
            const num = Number(col.getValue(row) || 0);
            if (Number.isFinite(num) && num > 0) {
              if (col.key === 'extensionFine' && row.isActivityRow && !row.hasExtensionOverride) {
                const fid = String(row.fileId || '');
                if (!seenFineFiles.has(fid)) {
                  seenFineFiles.add(fid);
                  totals[col.key] += num;
                }
              } else {
                const compKey = row.compositePacGroupKey || '';
                if (compKey && dedupCompositeKeys.has(col.key)) {
                  if (!seenCompositeByCol[col.key].has(compKey)) {
                    seenCompositeByCol[col.key].add(compKey);
                    totals[col.key] += num;
                  }
                } else {
                  totals[col.key] += num;
                }
              }
            }
          }
          const cellHtml = formatReportCellHtml(col, row, String(idx + 1));
          const cls = col.type === 'money' || col.type === 'number' ? ' class="num"' : '';
          return `<td${cls}>${cellHtml}</td>`;
        })
        .join('');
      bodyParts.push(`<tr>${tds}</tr>`);

      if (allowChildRows) {
        const subRows = getFilteredActivityRows(row, activityFilter).filter(
          (sub) => !(sub.rowKey && excludedSet.has(sub.rowKey))
        );
        subRows.forEach((sub) => {
          const subTds = cols
            .map((col) => {
              const cls = col.type === 'money' || col.type === 'number' ? ' class="num"' : '';
              if (col.key === 'slNo') return '<td></td>';
              if (col.key === 'subject' || col.key === 'workDetails') {
                const code = sub.estimateCode
                  ? ` <span class="act-code">[${escapeHtml(sub.estimateCode)}]</span>`
                  : '';
                return `<td class="act-name">↳ ${escapeHtml(sub.activityName)}${code}</td>`;
              }
              if (col.key === 'fileNumber') {
                return hasSubjectCol
                  ? '<td class="act-muted">↳ Activity</td>'
                  : `<td class="act-name">↳ ${escapeHtml(sub.activityName)}</td>`;
              }
              return `<td${cls}>${formatReportCellHtml(col, sub, '')}</td>`;
            })
            .join('');
          bodyParts.push(`<tr class="act-row">${subTds}</tr>`);
        });
      }
    });

    const hasAnyTotals = Object.keys(totals).length > 0;
    const footerHtml = hasAnyTotals
      ? `<tfoot><tr>${cols
          .map((col, idx) => {
            if (idx === 0) {
              return Object.hasOwn(totals, col.key)
                ? `<th class="num">Total: ₹${escapeHtml(ext.formatInr(totals[col.key]))}</th>`
                : '<th>Total</th>';
            }
            if (Object.hasOwn(totals, col.key)) {
              return `<th class="num">₹${escapeHtml(ext.formatInr(totals[col.key]))}</th>`;
            }
            return '<th></th>';
          })
          .join('')}</tr></tfoot>`
      : '';

    const unitNoun = mode === 'activity' ? 'activities' : 'works';
    const modeTag = mode === 'activity' ? 'Activity-wise' : 'File-wise';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title || 'PRICE 3.0 Project Register Report')}</title>
<style>
  @page { size: landscape; margin: 10mm; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; margin: 16px; font-size: 11px; }
  .no-print { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; margin-bottom: 14px; }
  .btn { padding: 7px 14px; border-radius: 6px; border: 1px solid #1d4ed8; background: #1d4ed8; color: #fff; font-weight: 600; cursor: pointer; font-size: 12px; }
  .btn:hover { background: #1e40af; }
  h1 { font-size: 17px; margin: 0 0 4px 0; }
  .meta { font-size: 11px; color: #475569; margin-bottom: 12px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #cbd5e1; padding: 5px 6px; text-align: left; vertical-align: top; }
  thead th { background: #1e293b; color: #ffffff; font-weight: 600; white-space: nowrap; }
  tfoot th { background: #f1f5f9; font-weight: 700; }
  tbody tr:nth-child(even):not(.act-row) { background: #f8fafc; }
  tr.act-row { background: #f1f5f9; color: #334155; font-size: 10.5px; }
  td.act-name { padding-left: 16px; font-weight: 600; color: #0f172a; }
  td.act-muted { color: #64748b; font-style: italic; }
  .act-code { font-weight: 400; color: #64748b; font-size: 10px; }
  .p3h-stacked-main { font-weight: 600; }
  .p3h-stacked-sub { font-size: 10px; color: #475569; margin-top: 1px; }
  .p3h-work-cell-subj { font-size: 10.5px; color: #1e293b; margin-top: 2px; line-height: 1.3; }
  .p3h-work-cell-act { font-size: 10px; color: #0f766e; font-weight: 600; margin-top: 2px; }
  .p3h-fin-cell { text-align: right; }
  .p3h-fin-pct { font-weight: 700; color: #0f172a; }
  .p3h-fin-amt { font-size: 10px; color: #475569; }
  .ext-tag { display: inline-block; padding: 0 4px; border-radius: 3px; background: #fef3c7; color: #92400e; font-size: 9.5px; font-weight: 600; }
  .num { text-align: right; white-space: nowrap; }
  @media print { .no-print { display: none; } body { margin: 0; } }
</style>
</head>
<body>
  <div class="no-print">
    <span><strong>Report Preview (${escapeHtml(modeTag)})</strong> — ${includedRows.length} ${unitNoun}, ${cols.length} selected fields${allowChildRows ? ' (with Activity rows)' : ''}${excludedInScopeCount > 0 ? ` (${excludedInScopeCount} excluded)` : ''}</span>
    <button type="button" class="btn" id="p3h-report-print-btn">Print / Save as PDF</button>
  </div>
  <h1>${escapeHtml(title || 'PRICE 3.0 Project Register Report')}</h1>
  <div class="meta">
    <div><strong>Generated:</strong> ${escapeHtml(new Date().toLocaleString())} &nbsp;|&nbsp; <strong>Mode:</strong> ${escapeHtml(modeTag)} &nbsp;|&nbsp; <strong>Records:</strong> ${includedRows.length} &nbsp;|&nbsp; <strong>Sorted By:</strong> ${escapeHtml(sortSummary || 'Default')}</div>
    <div><strong>Applied Filters:</strong> ${escapeHtml(filterSummary || 'All Works')}</div>
  </div>
  <table>
    <thead><tr>${cols.map((c) => `<th${c.type === 'money' || c.type === 'number' ? ' class="num"' : ''}>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${bodyParts.join('')}</tbody>
    ${footerHtml}
  </table>
</body>
</html>`;
  }

  function renderMilestoneTimelineHtml(history, options) {
    const db = getDb();
    const opts = options || {};
    const list = db && typeof db.normalizeProgressHistory === 'function'
      ? db.normalizeProgressHistory(history)
      : Array.isArray(history)
      ? history
      : [];
    const allowDelete = Boolean(opts.allowDelete);
    const descending = Boolean(opts.descending);

    if (list.length === 0) {
      return '<div class="p3h-ms-empty">No timestamped progress milestones recorded yet.</div>';
    }

    const enriched = list.map((item, idx) => {
      const prev = idx > 0 ? list[idx - 1] : null;
      const curPct = typeof item.physicalProgress === 'number' ? item.physicalProgress : null;
      const prevPct = prev && typeof prev.physicalProgress === 'number' ? prev.physicalProgress : null;
      const delta = curPct !== null && prevPct !== null ? Math.round((curPct - prevPct) * 100) / 100 : null;
      return { ...item, delta, index: idx };
    });

    const ordered = descending ? [...enriched].reverse() : enriched;

    return `<div class="p3h-milestone-timeline">
      ${ordered
        .map((m) => {
          const pct = m.physicalProgress;
          const dotCls =
            pct === 100
              ? 'p3h-ms-dot-done'
              : pct !== null && pct > 0
              ? 'p3h-ms-dot-active'
              : 'p3h-ms-dot-start';
          const tsTxt = db ? db.formatProgressTimestamp(m.timestamp) : m.timestamp;
          const deltaBadge =
            m.delta !== null && m.delta !== 0
              ? `<span class="p3h-ms-delta ${m.delta > 0 ? 'p3h-ms-delta-up' : 'p3h-ms-delta-down'}">${
                  m.delta > 0 ? '+' : ''
                }${m.delta}%</span>`
              : '';
          const delBtn = allowDelete
            ? `<button type="button" class="p3h-ms-del" data-del-ms="${escapeHtml(m.id)}" title="Delete milestone">×</button>`
            : '';
          return `
            <div class="p3h-ms-item">
              <div class="p3h-ms-rail">
                <span class="p3h-ms-dot ${dotCls}"></span>
              </div>
              <div class="p3h-ms-card">
                <div class="p3h-ms-head">
                  <span class="p3h-ms-ts">${escapeHtml(tsTxt)}</span>
                  <span class="p3h-ms-badges">
                    ${pct !== null ? `<span class="p3h-ms-pct">${escapeHtml(pct + '%')}</span>` : ''}
                    ${deltaBadge}
                    ${delBtn}
                  </span>
                </div>
                ${m.workStatus ? `<div class="p3h-ms-status">${escapeHtml(m.workStatus)}</div>` : ''}
                ${m.remarks ? `<div class="p3h-ms-remarks">${escapeHtml(m.remarks)}</div>` : ''}
              </div>
            </div>`;
        })
        .join('')}
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Interactive Register Modal UI
  // -------------------------------------------------------------------------

  const BILL_CATEGORY_OPTIONS = [
    { value: 'final', label: 'Final Bill Generated' },
    { value: 'not_final', label: 'Final Bill Not Generated' },
    { value: 'mbook_closed_no_final', label: 'M-Book Closed (No Final Bill)' },
    { value: 'has_part', label: 'Has Part Bills' },
    { value: 'part_only', label: 'Part / Pre-Final Only' },
    { value: 'nobill', label: 'No Bills / Cancelled' },
    { value: 'dpr', label: 'DPR / Pre-Tender' },
    { value: 'manually_archived', label: 'Manually Archived' },
    { value: 'missing_details', label: 'Missing Fields / Needs Refresh' },
  ];

  const SCHEDULE_STATUS_OPTIONS = [
    { value: 'overdue', label: 'Overdue (Past Completion)' },
    { value: 'ongoing', label: 'Ongoing (Within Period)' },
    { value: 'completed', label: 'Finalized' },
    { value: 'no_date', label: 'No SHO / Period' },
  ];

  const MULTI_FILTER_DEFS = [
    {
      key: 'billCategory',
      wrapId: 'p3h-reg-ms-bill',
      allLabel: 'All Bill Categories',
      shortLabel: 'Bill Status',
      staticOptions: BILL_CATEGORY_OPTIONS,
    },
    {
      key: 'activity',
      wrapId: 'p3h-reg-ms-act',
      allLabel: 'All Activities',
      shortLabel: 'Activities',
    },
    {
      key: 'constituency',
      wrapId: 'p3h-reg-ms-lac',
      allLabel: 'All Constituencies',
      shortLabel: 'Constituencies',
    },
    {
      key: 'contractor',
      wrapId: 'p3h-reg-ms-ctr',
      allLabel: 'All Contractors',
      shortLabel: 'Contractors',
    },
    {
      key: 'scheduleStatus',
      wrapId: 'p3h-reg-ms-sched',
      allLabel: 'All Schedule Statuses',
      shortLabel: 'Schedule',
      staticOptions: SCHEDULE_STATUS_OPTIONS,
    },
  ];

  const regState = {
    isOpen: false,
    viewMode: 'activity', // 'activity' | 'file'
    scope: 'active', // 'active' | 'archived' | 'manually_archived' | 'all'
    counts: { activeCount: 0, archivedCount: 0, manualArchivedCount: 0, totalCount: 0 },
    rawWorks: [],
    allRows: [],
    filteredRows: [],
    sortedRows: [],
    visibleColumns: [...COLUMN_PRESETS.standard],
    sortKey: 'slNo',
    sortDir: 'asc',
    page: 1,
    pageSize: 50,
    expandedIds: new Set(),
    includeActivitiesInExport: false,
    reportTitle: 'PRICE 3.0 Project Register Report',
    excludedKeys: new Set(),
    hideExcluded: false,
    dynamicFilterOptions: {
      activity: [],
      constituency: [],
      contractor: [],
    },
    filters: {
      search: '',
      billCategory: [],
      activity: [],
      constituency: [],
      contractor: [],
      scheduleStatus: [],
      openMbook75: false,
      dateField: 'agreementDate',
      dateFrom: '',
      dateTo: '',
    },
    onInspectWork: null,
    onDataUpdated: null,
    onDatabaseImported: null,
    settingsLoaded: false,
    extEditTarget: null,
  };

  let filterSaveTimer = null;
  let titleSaveTimer = null;
  let searchDebounceTimer = null;
  let globalListenersBound = false;

  async function saveSettingSafe(key, value) {
    try {
      await getDb().setSetting(key, value);
    } catch (e) {
      // ignore
    }
  }

  async function loadUserPreferences() {
    if (regState.settingsLoaded) return;
    const db = getDb();
    try {
      const [
        savedCols,
        savedSort,
        savedMode,
        savedScope,
        savedPageSize,
        savedIncludeActs,
        savedTitle,
        savedFilters,
      ] = await Promise.all([
        db.getSetting('register_columns_v23', null),
        db.getSetting('register_sort', null),
        db.getSetting('register_view_mode', 'activity'),
        db.getSetting('register_scope', 'active'),
        db.getSetting('register_page_size', 50),
        db.getSetting('register_include_activities', false),
        db.getSetting('register_report_title', ''),
        db.getSetting('register_filters_v23', null),
      ]);

      if (Array.isArray(savedCols) && savedCols.length > 0) {
        const valid = savedCols.filter((k) => Object.hasOwn(COLUMN_MAP, k));
        if (valid.length > 0) regState.visibleColumns = valid;
      }
      if (savedSort && Object.hasOwn(COLUMN_MAP, savedSort.key)) {
        regState.sortKey = savedSort.key;
        regState.sortDir = savedSort.dir === 'desc' ? 'desc' : 'asc';
      }
      if (savedMode === 'activity' || savedMode === 'file') {
        regState.viewMode = savedMode;
      }
      if (['active', 'archived', 'manually_archived', 'all'].includes(savedScope)) {
        regState.scope = savedScope;
      }
      if ([50, 100, 250].includes(savedPageSize)) {
        regState.pageSize = savedPageSize;
      }
      regState.includeActivitiesInExport = Boolean(savedIncludeActs);
      if (typeof savedTitle === 'string' && savedTitle.trim()) {
        regState.reportTitle = savedTitle;
      }
      if (savedFilters && typeof savedFilters === 'object') {
        const validBillValues = new Set(BILL_CATEGORY_OPTIONS.map((o) => o.value));
        const validSchedValues = new Set(SCHEDULE_STATUS_OPTIONS.map((o) => o.value));
        const validDateFields = new Set([
          'agreementDate',
          'shoDate',
          'completionDate',
          'extendedCompletionDate',
          'asDate',
          'tsDate',
        ]);
        regState.filters = {
          search: typeof savedFilters.search === 'string' ? savedFilters.search : '',
          billCategory: normalizeFilterList(savedFilters.billCategory).filter((v) =>
            validBillValues.has(v)
          ),
          activity: normalizeFilterList(savedFilters.activity),
          constituency: normalizeFilterList(savedFilters.constituency),
          contractor: normalizeFilterList(savedFilters.contractor),
          scheduleStatus: normalizeFilterList(savedFilters.scheduleStatus).filter((v) =>
            validSchedValues.has(v)
          ),
          openMbook75: Boolean(savedFilters.openMbook75),
          dateField: validDateFields.has(savedFilters.dateField)
            ? savedFilters.dateField
            : 'agreementDate',
          dateFrom: typeof savedFilters.dateFrom === 'string' ? savedFilters.dateFrom : '',
          dateTo: typeof savedFilters.dateTo === 'string' ? savedFilters.dateTo : '',
        };
      }
    } catch (e) {
      console.warn('[P3H] Failed to load register settings:', e);
    }
    regState.settingsLoaded = true;
  }

  function saveColumnPreference() {
    return saveSettingSafe('register_columns_v23', regState.visibleColumns);
  }

  function saveViewModePreference() {
    return saveSettingSafe('register_view_mode', regState.viewMode);
  }

  function saveScopePreference() {
    return saveSettingSafe('register_scope', regState.scope);
  }

  function savePageSizePreference() {
    return saveSettingSafe('register_page_size', regState.pageSize);
  }

  function saveIncludeActivitiesPreference() {
    return saveSettingSafe('register_include_activities', regState.includeActivitiesInExport);
  }

  function saveReportTitlePreference(immediate) {
    if (titleSaveTimer) clearTimeout(titleSaveTimer);
    if (immediate) {
      return saveSettingSafe('register_report_title', regState.reportTitle);
    }
    titleSaveTimer = setTimeout(() => {
      saveSettingSafe('register_report_title', regState.reportTitle);
    }, 250);
  }

  function saveFilterPreference(immediate) {
    if (filterSaveTimer) clearTimeout(filterSaveTimer);
    const payload = {
      search: regState.filters.search || '',
      billCategory: [...normalizeFilterList(regState.filters.billCategory)],
      activity: [...normalizeFilterList(regState.filters.activity)],
      constituency: [...normalizeFilterList(regState.filters.constituency)],
      contractor: [...normalizeFilterList(regState.filters.contractor)],
      scheduleStatus: [...normalizeFilterList(regState.filters.scheduleStatus)],
      openMbook75: Boolean(regState.filters.openMbook75),
      dateField: regState.filters.dateField || 'agreementDate',
      dateFrom: regState.filters.dateFrom || '',
      dateTo: regState.filters.dateTo || '',
    };
    if (immediate) {
      return saveSettingSafe('register_filters_v23', payload);
    }
    filterSaveTimer = setTimeout(() => {
      saveSettingSafe('register_filters_v23', payload);
    }, 250);
  }

  function saveSortPreference() {
    return saveSettingSafe('register_sort', {
      key: regState.sortKey,
      dir: regState.sortDir,
    });
  }

  function positionPopoverWithinViewport(triggerEl, popEl, align, displayMode) {
    if (!triggerEl || !popEl || typeof window === 'undefined') return;
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;

    popEl.style.position = 'fixed';
    popEl.style.right = 'auto';
    popEl.style.visibility = 'hidden';
    popEl.style.display = displayMode === 'flex' ? 'flex' : 'block';

    const popW = popEl.offsetWidth || 300;
    const preferredLeft = align === 'left' ? rect.left : rect.right - popW;
    const clampedLeft = Math.max(12, Math.min(preferredLeft, vw - popW - 12));
    const top = Math.max(12, Math.min(rect.bottom + 6, vh - 160));
    const maxH = Math.max(180, vh - top - 16);

    popEl.style.left = `${Math.round(clampedLeft)}px`;
    popEl.style.top = `${Math.round(top)}px`;
    popEl.style.maxHeight = `${Math.round(maxH)}px`;
    popEl.style.visibility = '';
  }

  function closeAllRegisterPopovers(modal) {
    const root = modal || document.getElementById('p3h-register-modal');
    if (!root) return false;
    let anyWasOpen = false;
    const colPop = root.querySelector('#p3h-reg-cols-popover');
    if (colPop) {
      if (colPop.style.display && colPop.style.display !== 'none') anyWasOpen = true;
      colPop.style.display = 'none';
    }
    root.querySelectorAll('.p3h-ms-menu').forEach((menu) => {
      if (menu.style.display && menu.style.display !== 'none') anyWasOpen = true;
      menu.style.display = 'none';
    });
    root.querySelectorAll('.p3h-ms-btn').forEach((btn) => {
      btn.setAttribute('aria-expanded', 'false');
    });
    return anyWasOpen;
  }

  function getMultiFilterOptions(def) {
    return def.staticOptions || regState.dynamicFilterOptions[def.key] || [];
  }

  function updateMultiFilterButtonLabel(modal, def) {
    const root = modal || document.getElementById('p3h-register-modal');
    if (!root || !def) return;
    const wrap = root.querySelector('#' + def.wrapId);
    if (!wrap) return;
    const btn = wrap.querySelector('.p3h-ms-btn');
    const lblEl = wrap.querySelector('.p3h-ms-label');
    if (!btn || !lblEl) return;

    const opts = getMultiFilterOptions(def);
    const selected = normalizeFilterList(regState.filters[def.key]);
    if (selected.length === 0) {
      lblEl.textContent = def.staticOptions ? def.allLabel : `${def.allLabel} (${opts.length})`;
      btn.classList.remove('p3h-ms-has-val');
      btn.title = def.allLabel;
    } else if (selected.length === 1) {
      const match = opts.find((o) => o.value === selected[0]);
      const name = match ? match.label : selected[0];
      lblEl.textContent = `${def.shortLabel}: ${name}`;
      btn.classList.add('p3h-ms-has-val');
      btn.title = `${def.shortLabel}: ${name}`;
    } else {
      lblEl.textContent = `${def.shortLabel} (${selected.length} selected)`;
      btn.classList.add('p3h-ms-has-val');
      btn.title = selected
        .map((v) => {
          const match = opts.find((o) => o.value === v);
          return match ? match.label : v;
        })
        .join(', ');
    }
  }

  function updateAllMultiFilterButtons(modal) {
    MULTI_FILTER_DEFS.forEach((def) => updateMultiFilterButtonLabel(modal, def));
  }

  function renderMultiFilterMenu(modal, def) {
    const wrap = modal.querySelector('#' + def.wrapId);
    if (!wrap) return;
    const btn = wrap.querySelector('.p3h-ms-btn');
    const menu = wrap.querySelector('.p3h-ms-menu');
    if (!btn || !menu) return;

    const opts = getMultiFilterOptions(def);
    const selectedSet = new Set(normalizeFilterList(regState.filters[def.key]));

    menu.innerHTML = `
      <div class="p3h-ms-menu-head">
        <input type="text" class="p3h-input p3h-ms-search" placeholder="Search ${escapeHtml(
          def.shortLabel.toLowerCase()
        )}..." />
        <button type="button" class="p3h-btn p3h-btn-sm p3h-ms-clear">Clear</button>
      </div>
      <div class="p3h-ms-list">
        ${
          opts.length === 0
            ? '<div style="font-size:11px;color:#64748b;padding:6px;">No options available</div>'
            : opts
                .map(
                  (o) => `
          <label class="p3h-col-check p3h-ms-opt" data-opt-label="${escapeHtml(
            o.label.toLowerCase()
          )}">
            <input type="checkbox" value="${escapeHtml(o.value)}" ${
                    selectedSet.has(o.value) ? 'checked' : ''
                  } />
            <span>${escapeHtml(o.label)}</span>
          </label>`
                )
                .join('')
        }
      </div>
    `;

    const searchInp = menu.querySelector('.p3h-ms-search');
    if (searchInp) {
      searchInp.oninput = () => {
        const q = searchInp.value.trim().toLowerCase();
        menu.querySelectorAll('.p3h-ms-opt').forEach((lbl) => {
          const txt = lbl.getAttribute('data-opt-label') || '';
          lbl.style.display = !q || txt.includes(q) ? 'flex' : 'none';
        });
      };
    }

    const clearBtn = menu.querySelector('.p3h-ms-clear');
    if (clearBtn) {
      clearBtn.onclick = (e) => {
        e.stopPropagation();
        regState.filters[def.key] = [];
        menu.querySelectorAll('input[type="checkbox"]').forEach((c) => {
          c.checked = false;
        });
        updateMultiFilterButtonLabel(modal, def);
        saveFilterPreference(true);
        regState.page = 1;
        applyFilterSortAndRender();
      };
    }

    menu.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
      chk.onchange = () => {
        const chosen = Array.from(menu.querySelectorAll('input[type="checkbox"]:checked')).map(
          (c) => c.value
        );
        regState.filters[def.key] = chosen;
        if (def.key === 'activity' && regState.viewMode === 'file' && chosen.length > 0) {
          regState.includeActivitiesInExport = true;
          const incChk = modal.querySelector('#p3h-reg-include-acts');
          if (incChk) incChk.checked = true;
          saveIncludeActivitiesPreference();
        }
        updateMultiFilterButtonLabel(modal, def);
        saveFilterPreference(true);
        regState.page = 1;
        applyFilterSortAndRender();
      };
    });

    positionPopoverWithinViewport(btn, menu, 'left');
    btn.setAttribute('aria-expanded', 'true');
  }

  function syncPreferencesToModalDom(modal) {
    if (!modal) return;
    const titleInp = modal.querySelector('#p3h-reg-report-title');
    if (titleInp) titleInp.value = regState.reportTitle || 'PRICE 3.0 Project Register Report';
    const incChk = modal.querySelector('#p3h-reg-include-acts');
    if (incChk) incChk.checked = Boolean(regState.includeActivitiesInExport);
    const searchInp = modal.querySelector('#p3h-reg-search');
    if (searchInp) searchInp.value = regState.filters.search || '';
    const mbookBtn = modal.querySelector('#p3h-reg-mbook75-btn');
    if (mbookBtn) mbookBtn.classList.toggle('p3h-active', Boolean(regState.filters.openMbook75));
    const dateFieldSel = modal.querySelector('#p3h-reg-date-field');
    if (dateFieldSel) dateFieldSel.value = regState.filters.dateField || 'agreementDate';
    const dateFromInp = modal.querySelector('#p3h-reg-date-from');
    if (dateFromInp) dateFromInp.value = regState.filters.dateFrom || '';
    const dateToInp = modal.querySelector('#p3h-reg-date-to');
    if (dateToInp) dateToInp.value = regState.filters.dateTo || '';
    updateAllMultiFilterButtons(modal);
  }

  function ensureModalDom() {
    let modal = document.getElementById('p3h-register-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'p3h-register-modal';
    modal.className = 'p3h-register-modal';
    modal.innerHTML = `
      <datalist id="p3h-work-status-list">
        ${WORK_STATUS_PRESETS.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('')}
      </datalist>
      <div class="p3h-reg-shell">
        <div class="p3h-reg-header">
          <div class="p3h-reg-title-block">
            <h3>PRICE 3.0 Project Register &amp; Report Builder</h3>
            <div class="p3h-view-switch" id="p3h-reg-view-switch" title="Switch between Activity-wise and File-wise register &amp; reports">
              <button type="button" class="p3h-pill p3h-active" data-view-mode="activity">Activity-wise</button>
              <button type="button" class="p3h-pill" data-view-mode="file">File-wise</button>
            </div>
            <div class="p3h-reg-scopes" id="p3h-reg-scopes">
              <button type="button" class="p3h-pill p3h-active" data-scope="active">Active Works (<span data-cnt="active">0</span>)</button>
              <button type="button" class="p3h-pill" data-scope="archived">Finalized / EMILI (<span data-cnt="archived">0</span>)</button>
              <button type="button" class="p3h-pill" data-scope="manually_archived">Manually Archived (<span data-cnt="manually_archived">0</span>)</button>
              <button type="button" class="p3h-pill" data-scope="all">All Works (<span data-cnt="all">0</span>)</button>
            </div>
          </div>
          <div class="p3h-reg-top-actions">
            <input type="text" id="p3h-reg-report-title" class="p3h-input" value="PRICE 3.0 Project Register Report" placeholder="Report Title" title="Custom Report Title" />
            <button type="button" class="p3h-btn" id="p3h-reg-expand-all-btn">Expand All Activities</button>
            <label class="p3h-col-check" id="p3h-reg-include-acts-wrap" style="margin:0;white-space:nowrap;" title="Include activity sub-rows in CSV &amp; Print/PDF Report">
              <input type="checkbox" id="p3h-reg-include-acts" />
              <span>Include Activity Rows</span>
            </label>
            <div class="p3h-col-wrap">
              <button type="button" class="p3h-btn" id="p3h-reg-cols-btn">Columns (Hide/Show)</button>
              <div class="p3h-popover p3h-col-popover" id="p3h-reg-cols-popover" style="display:none;"></div>
            </div>
            <button type="button" class="p3h-btn" id="p3h-reg-csv-btn">Export Selected CSV</button>
            <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-reg-report-btn">Create Report (Print / PDF)</button>
            <button type="button" class="p3h-btn" id="p3h-reg-backup-btn" title="Download full JSON backup of all saved works, extensions, milestones &amp; archives">Backup JSON</button>
            <button type="button" class="p3h-btn" id="p3h-reg-restore-btn" title="Import &amp; non-destructively merge a JSON backup file">Restore JSON</button>
            <input type="file" id="p3h-reg-import-input" accept=".json,application/json" style="display:none;" />
          </div>
          <button type="button" class="p3h-reg-close-x" id="p3h-reg-close-btn" title="Close (Esc)" aria-label="Close">×</button>
        </div>

        <div class="p3h-reg-filters">
          <input type="text" id="p3h-reg-search" class="p3h-input p3h-reg-search" placeholder="Search file no, subject, activity, status, contractor, agreement, AS/TS, constituency..." />
          <button type="button" class="p3h-pill p3h-pill-mbook75" id="p3h-reg-mbook75-btn" title="Active works/activities with Open M-Books that reached or passed 75% of Agreement Period">Open M-Book ≥ 75% Period</button>
          ${MULTI_FILTER_DEFS.map(
            (def) => `
          <div class="p3h-ms-wrap" id="${escapeHtml(def.wrapId)}" data-ms-filter="${escapeHtml(def.key)}">
            <button type="button" class="p3h-ms-btn" aria-expanded="false">
              <span class="p3h-ms-label">${escapeHtml(def.allLabel)}</span>
              <span class="p3h-ms-caret">▾</span>
            </button>
            <div class="p3h-ms-menu" style="display:none;"></div>
          </div>`
          ).join('')}
          <div class="p3h-reg-daterange">
            <select id="p3h-reg-date-field" class="p3h-select">
              <option value="agreementDate">Agreement Date</option>
              <option value="shoDate">Handing Over Date</option>
              <option value="completionDate">Completion Date</option>
              <option value="extendedCompletionDate">Extended Completion Date</option>
              <option value="asDate">AS Date</option>
              <option value="tsDate">TS Date</option>
            </select>
            <input type="date" id="p3h-reg-date-from" class="p3h-input" title="From date" />
            <span>to</span>
            <input type="date" id="p3h-reg-date-to" class="p3h-input" title="To date" />
          </div>
          <button type="button" class="p3h-btn" id="p3h-reg-reset-filters">Reset Filters</button>
        </div>

        <div class="p3h-reg-kpis" id="p3h-reg-kpis"></div>
        <div class="p3h-reg-notice" id="p3h-reg-notice" style="display:none;"></div>

        <div class="p3h-reg-table-wrap">
          <table class="p3h-reg-table" id="p3h-reg-table">
            <thead id="p3h-reg-thead"></thead>
            <tbody id="p3h-reg-tbody"></tbody>
          </table>
        </div>

        <div class="p3h-reg-pagination" id="p3h-reg-pagination"></div>
      </div>

      <div class="p3h-ext-dialog-backdrop" id="p3h-ext-dialog-backdrop" style="display:none;">
        <div class="p3h-ext-dialog" id="p3h-ext-dialog"></div>
      </div>
    `;
    document.body.appendChild(modal);
    wireModalEvents(modal);
    return modal;
  }

  function getExpandableFileIds() {
    const ids = [];
    const seen = new Set();
    (regState.sortedRows || []).forEach((r) => {
      if ((r.activityRows || []).length > 0 && r.fileId && !seen.has(r.fileId)) {
        seen.add(r.fileId);
        ids.push(r.fileId);
      }
    });
    return ids;
  }

  function syncExpandAllButtonLabel(modal) {
    const root = modal || document.getElementById('p3h-register-modal');
    if (!root) return;
    const expAllBtn = root.querySelector('#p3h-reg-expand-all-btn');
    if (!expAllBtn) return;
    const expandable = getExpandableFileIds();
    const allExpanded =
      expandable.length > 0 && expandable.every((fid) => regState.expandedIds.has(fid));
    expAllBtn.textContent = allExpanded ? 'Collapse All Activities' : 'Expand All Activities';
  }

  function updateViewModeControls(modal) {
    if (!modal) return;
    const isAct = regState.viewMode === 'activity';
    modal.querySelectorAll('#p3h-reg-view-switch [data-view-mode]').forEach((btn) => {
      btn.classList.toggle('p3h-active', btn.getAttribute('data-view-mode') === regState.viewMode);
    });
    const expBtn = modal.querySelector('#p3h-reg-expand-all-btn');
    const incWrap = modal.querySelector('#p3h-reg-include-acts-wrap');
    if (expBtn) expBtn.style.display = isAct ? 'none' : 'inline-flex';
    if (incWrap) incWrap.style.display = isAct ? 'none' : 'inline-flex';
    syncExpandAllButtonLabel(modal);
  }

  function rebuildRowsFromRaw() {
    const ext = getExtractor();
    const todayDmy = ext.getTodayDmy();
    if (regState.viewMode === 'activity') {
      regState.allRows = buildActivityRegisterRows(regState.rawWorks, regState.scope, todayDmy);
    } else {
      regState.allRows = regState.rawWorks.map((w, idx) => buildRegisterRow(w, idx, todayDmy));
    }
    populateDynamicFilterOptions();
    applyFilterSortAndRender();
  }

  function wireModalEvents(modal) {
    modal.querySelector('#p3h-reg-close-btn').onclick = close;

    modal.querySelector('#p3h-reg-view-switch').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-view-mode]');
      if (!btn) return;
      const mode = btn.getAttribute('data-view-mode');
      if (mode && mode !== regState.viewMode) {
        regState.viewMode = mode;
        regState.page = 1;
        regState.excludedKeys.clear();
        regState.hideExcluded = false;
        saveViewModePreference();
        updateViewModeControls(modal);
        await reloadScopeData();
      }
    });

    modal.querySelector('#p3h-reg-scopes').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-scope]');
      if (!btn) return;
      const scope = btn.getAttribute('data-scope');
      if (scope && scope !== regState.scope) {
        regState.scope = scope;
        regState.page = 1;
        regState.excludedKeys.clear();
        regState.hideExcluded = false;
        saveScopePreference();
        await reloadScopeData();
      }
    });

    const expAllBtn = modal.querySelector('#p3h-reg-expand-all-btn');
    expAllBtn.onclick = () => {
      const expandable = getExpandableFileIds();
      const allExpanded =
        expandable.length > 0 && expandable.every((fid) => regState.expandedIds.has(fid));
      if (allExpanded) {
        expandable.forEach((fid) => regState.expandedIds.delete(fid));
      } else {
        expandable.forEach((fid) => regState.expandedIds.add(fid));
      }
      syncExpandAllButtonLabel(modal);
      renderTableAndPagination();
    };

    const incActsChk = modal.querySelector('#p3h-reg-include-acts');
    incActsChk.onchange = () => {
      regState.includeActivitiesInExport = incActsChk.checked;
      saveIncludeActivitiesPreference();
    };

    const titleInp = modal.querySelector('#p3h-reg-report-title');
    if (titleInp) {
      titleInp.addEventListener('input', () => {
        regState.reportTitle = titleInp.value;
        saveReportTitlePreference(false);
      });
    }

    const mbook75Btn = modal.querySelector('#p3h-reg-mbook75-btn');
    mbook75Btn.onclick = () => {
      regState.filters.openMbook75 = !regState.filters.openMbook75;
      mbook75Btn.classList.toggle('p3h-active', regState.filters.openMbook75);
      saveFilterPreference(true);
      regState.page = 1;
      applyFilterSortAndRender();
    };

    MULTI_FILTER_DEFS.forEach((def) => {
      const wrap = modal.querySelector('#' + def.wrapId);
      if (!wrap) return;
      const btn = wrap.querySelector('.p3h-ms-btn');
      const menu = wrap.querySelector('.p3h-ms-menu');
      if (!btn || !menu) return;

      btn.onclick = (e) => {
        e.stopPropagation();
        const isOpen = menu.style.display === 'block' || menu.style.display === 'flex';
        closeAllRegisterPopovers(modal);
        if (!isOpen) {
          renderMultiFilterMenu(modal, def);
        }
      };
      menu.onclick = (e) => e.stopPropagation();
    });

    const onScalarFilterChange = (immediateSave) => {
      regState.filters.search = modal.querySelector('#p3h-reg-search').value;
      regState.filters.dateField = modal.querySelector('#p3h-reg-date-field').value;
      regState.filters.dateFrom = modal.querySelector('#p3h-reg-date-from').value;
      regState.filters.dateTo = modal.querySelector('#p3h-reg-date-to').value;
      saveFilterPreference(Boolean(immediateSave));
      regState.page = 1;
      applyFilterSortAndRender();
    };

    modal.querySelector('#p3h-reg-search').addEventListener('input', () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchDebounceTimer = null;
        onScalarFilterChange(false);
      }, 180);
    });
    ['#p3h-reg-date-field', '#p3h-reg-date-from', '#p3h-reg-date-to'].forEach((sel) => {
      modal.querySelector(sel).addEventListener('change', () => onScalarFilterChange(true));
    });

    modal.querySelector('#p3h-reg-reset-filters').onclick = () => {
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
      }
      modal.querySelector('#p3h-reg-search').value = '';
      modal.querySelector('#p3h-reg-date-field').value = 'agreementDate';
      modal.querySelector('#p3h-reg-date-from').value = '';
      modal.querySelector('#p3h-reg-date-to').value = '';
      regState.filters.search = '';
      regState.filters.billCategory = [];
      regState.filters.activity = [];
      regState.filters.constituency = [];
      regState.filters.contractor = [];
      regState.filters.scheduleStatus = [];
      regState.filters.openMbook75 = false;
      regState.filters.dateField = 'agreementDate';
      regState.filters.dateFrom = '';
      regState.filters.dateTo = '';
      regState.hideExcluded = false;
      mbook75Btn.classList.remove('p3h-active');
      updateAllMultiFilterButtons(modal);
      closeAllRegisterPopovers(modal);
      saveFilterPreference(true);
      regState.page = 1;
      applyFilterSortAndRender();
    };

    const colBtn = modal.querySelector('#p3h-reg-cols-btn');
    const colPop = modal.querySelector('#p3h-reg-cols-popover');
    colBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = Boolean(colPop.style.display && colPop.style.display !== 'none');
      closeAllRegisterPopovers(modal);
      if (!isOpen) {
        renderColumnPopover(colPop, colBtn);
        positionPopoverWithinViewport(colBtn, colPop, 'right');
      }
    };
    colPop.onclick = (e) => e.stopPropagation();

    modal.addEventListener('click', (e) => {
      if (!e.target.closest('.p3h-col-wrap') && !e.target.closest('.p3h-ms-wrap')) {
        closeAllRegisterPopovers(modal);
      }
    });

    const theadEl = modal.querySelector('#p3h-reg-thead');
    const tbodyEl = modal.querySelector('#p3h-reg-tbody');
    if (theadEl) {
      let dragThKey = '';
      theadEl.addEventListener('change', (e) => {
        const target = e.target;
        if (!target || target.id !== 'p3h-reg-select-all') return;
        const checked = target.checked;
        regState.sortedRows.forEach((r) => {
          if (checked) {
            if (r.rowKey) regState.excludedKeys.delete(r.rowKey);
            (r.activityRows || []).forEach((s) => {
              if (s.rowKey) regState.excludedKeys.delete(s.rowKey);
            });
          } else {
            if (r.rowKey) regState.excludedKeys.add(r.rowKey);
            (r.activityRows || []).forEach((s) => {
              if (s.rowKey) regState.excludedKeys.add(s.rowKey);
            });
          }
        });
        if (regState.hideExcluded) {
          applyFilterSortAndRender();
        } else {
          renderKpis();
          renderTableAndPagination();
        }
      });

      theadEl.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort-key]');
        if (!th || !theadEl.contains(th)) return;
        const key = th.getAttribute('data-sort-key');
        if (!key) return;
        if (regState.sortKey === key) {
          regState.sortDir = regState.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          regState.sortKey = key;
          regState.sortDir = 'asc';
        }
        regState.page = 1;
        saveSortPreference();
        applyFilterSortAndRender();
      });

      theadEl.addEventListener('dragstart', (e) => {
        const th = e.target.closest('th[data-col-key]');
        if (!th || !theadEl.contains(th)) return;
        dragThKey = th.getAttribute('data-col-key') || '';
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', dragThKey);
        }
      });

      theadEl.addEventListener('dragover', (e) => {
        const th = e.target.closest('th[data-col-key]');
        if (!th || !theadEl.contains(th)) return;
        e.preventDefault();
        if (dragThKey && th.getAttribute('data-col-key') !== dragThKey) {
          th.classList.add('p3h-th-drag-over');
        }
      });

      theadEl.addEventListener('dragleave', (e) => {
        const th = e.target.closest('th[data-col-key]');
        if (!th || !theadEl.contains(th)) return;
        th.classList.remove('p3h-th-drag-over');
      });

      theadEl.addEventListener('drop', (e) => {
        const th = e.target.closest('th[data-col-key]');
        if (!th || !theadEl.contains(th)) return;
        e.preventDefault();
        th.classList.remove('p3h-th-drag-over');
        const targetKey = th.getAttribute('data-col-key') || '';
        const srcKey = dragThKey || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
        dragThKey = '';
        if (srcKey && targetKey && srcKey !== targetKey) {
          moveVisibleColumnToTarget(srcKey, targetKey);
        }
      });

      theadEl.addEventListener('dragend', () => {
        dragThKey = '';
        theadEl.querySelectorAll('th').forEach((el) => el.classList.remove('p3h-th-drag-over'));
      });
    }

    if (tbodyEl) {
      tbodyEl.addEventListener('change', async (e) => {
        const target = e.target;
        if (!target) return;
        if (target.classList && target.classList.contains('p3h-row-inc-chk')) {
          const k = target.getAttribute('data-inc-key');
          if (!k) return;
          if (target.checked) regState.excludedKeys.delete(k);
          else regState.excludedKeys.add(k);
          if (regState.hideExcluded) {
            applyFilterSortAndRender();
          } else {
            const tr = target.closest('tr');
            if (tr) tr.classList.toggle('p3h-row-excluded', !target.checked);
            renderKpis();
            syncSelectAllCheckboxState(tbodyEl, theadEl);
          }
          return;
        }
        if (target.hasAttribute('data-inline-status')) {
          const fid = target.getAttribute('data-inline-status');
          const actKey = target.getAttribute('data-act-key') || '';
          await saveInlineUserField(
            fid,
            actKey,
            { workStatus: target.value.trim() },
            { attr: 'data-inline-status', fileId: fid, actKey }
          );
          return;
        }
        if (target.hasAttribute('data-inline-progress')) {
          const fid = target.getAttribute('data-inline-progress');
          const actKey = target.getAttribute('data-act-key') || '';
          const rawVal = target.value.trim();
          const numVal = rawVal === '' ? null : Math.max(0, Math.min(100, parseFloat(rawVal)));
          const finalProg = numVal !== null && Number.isFinite(numVal) ? numVal : null;
          if (finalProg !== null) target.value = String(finalProg);
          const bar = target.parentElement && target.parentElement.querySelector('.p3h-prog-bar span');
          if (bar) bar.style.width = `${finalProg || 0}%`;
          await saveInlineUserField(
            fid,
            actKey,
            { physicalProgress: finalProg },
            { attr: 'data-inline-progress', fileId: fid, actKey }
          );
        }
      });

      tbodyEl.addEventListener('click', async (e) => {
        const openBtn = e.target.closest('[data-open-file]');
        if (openBtn && tbodyEl.contains(openBtn)) {
          const fid = openBtn.getAttribute('data-open-file');
          const hit = regState.rawWorks.find((w) => String(w.fileId) === String(fid));
          if (hit && typeof regState.onInspectWork === 'function') {
            regState.onInspectWork(hit);
          }
          return;
        }
        const toggleBtn = e.target.closest('[data-toggle-act]');
        if (toggleBtn && tbodyEl.contains(toggleBtn)) {
          const fid = toggleBtn.getAttribute('data-toggle-act');
          if (regState.expandedIds.has(fid)) regState.expandedIds.delete(fid);
          else regState.expandedIds.add(fid);
          syncExpandAllButtonLabel(modal);
          renderTableAndPagination();
          return;
        }
        const extBtn = e.target.closest('[data-edit-ext]');
        if (extBtn && tbodyEl.contains(extBtn)) {
          openExtensionEditorDialog(
            extBtn.getAttribute('data-edit-ext'),
            extBtn.getAttribute('data-act-key') || ''
          );
          return;
        }
        const histBtn = e.target.closest('[data-open-history]');
        if (histBtn && tbodyEl.contains(histBtn)) {
          openProgressHistoryDialog(
            histBtn.getAttribute('data-open-history'),
            histBtn.getAttribute('data-act-key') || ''
          );
          return;
        }
        const archBtn = e.target.closest('[data-manual-arch]');
        if (archBtn && tbodyEl.contains(archBtn)) {
          const fid = archBtn.getAttribute('data-manual-arch');
          openManualArchiveDialog(
            fid,
            archBtn.getAttribute('data-act-key') || '',
            archBtn.getAttribute('data-arch-label') || fid
          );
          return;
        }
        const restoreBtn = e.target.closest('[data-restore-arch]');
        if (restoreBtn && tbodyEl.contains(restoreBtn)) {
          const fid = restoreBtn.getAttribute('data-restore-arch');
          const actKey = restoreBtn.getAttribute('data-act-key') || '';
          const restoreWork = restoreBtn.getAttribute('data-restore-work') === '1';
          const dualArch = restoreBtn.getAttribute('data-dual-arch') === '1';
          const db = getDb();
          const ext = getExtractor();
          const updated =
            actKey && !restoreWork
              ? await db.setActivityManualArchive(
                  fid,
                  actKey,
                  { archived: false, clearWorkArchive: dualArch },
                  ext.analyzeWorkRecord
                )
              : await db.setWorkManualArchive(fid, { archived: false }, ext.analyzeWorkRecord);
          await refreshAfterMutation(updated);
        }
      });
    }

    if (typeof window !== 'undefined' && !globalListenersBound) {
      globalListenersBound = true;
      window.addEventListener('resize', () => {
        if (regState.isOpen) {
          closeAllRegisterPopovers(document.getElementById('p3h-register-modal'));
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !regState.isOpen) return;
        const drawerEl = document.getElementById('p3h-drawer');
        if (drawerEl && drawerEl.classList.contains('p3h-open')) return;
        const activeModal = document.getElementById('p3h-register-modal');
        const dlgBackdrop = document.getElementById('p3h-ext-dialog-backdrop');
        if (dlgBackdrop && dlgBackdrop.style.display === 'flex') {
          dlgBackdrop.style.display = 'none';
          return;
        }
        if (closeAllRegisterPopovers(activeModal)) return;
        close();
      });
    }

    modal.querySelector('#p3h-reg-csv-btn').onclick = exportSelectedCsv;
    modal.querySelector('#p3h-reg-report-btn').onclick = openCustomReport;

    let noticeTimer = null;
    const showRegisterNotice = (msg, isError) => {
      const el = modal.querySelector('#p3h-reg-notice');
      if (!el) return;
      if (noticeTimer) {
        clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      el.textContent = msg || '';
      el.classList.toggle('p3h-reg-notice-err', Boolean(isError));
      el.style.display = msg ? 'block' : 'none';
      if (msg) {
        noticeTimer = setTimeout(() => {
          noticeTimer = null;
          el.style.display = 'none';
        }, 7000);
      }
    };

    const backupBtn = modal.querySelector('#p3h-reg-backup-btn');
    if (backupBtn) {
      backupBtn.onclick = async () => {
        try {
          const payload = await getDb().exportDatabasePayload('all');
          const jsonStr = JSON.stringify(payload, null, 2);
          const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `price3_helper_backup_${new Date().toISOString().slice(0, 10)}.json`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            URL.revokeObjectURL(url);
            a.remove();
          }, 5000);
          showRegisterNotice(
            `Backup downloaded: ${payload.totalExported || 0} works (${payload.activeCount || 0} active, ${payload.archivedCount || 0} finalized).`
          );
        } catch (err) {
          showRegisterNotice(
            `Backup failed: ${err && err.message ? err.message : String(err)}`,
            true
          );
        }
      };
    }

    const restoreBtn = modal.querySelector('#p3h-reg-restore-btn');
    const importInp = modal.querySelector('#p3h-reg-import-input');
    if (restoreBtn && importInp) {
      restoreBtn.onclick = () => {
        importInp.value = '';
        importInp.click();
      };
      importInp.onchange = async () => {
        const file = importInp.files && importInp.files[0];
        if (!file) return;
        try {
          const rawText = await file.text();
          const parsed = JSON.parse(rawText);
          const list = Array.isArray(parsed)
            ? parsed
            : parsed && Array.isArray(parsed.works)
            ? parsed.works
            : null;
          if (!list) {
            showRegisterNotice('Invalid backup JSON: expected a works array.', true);
            return;
          }
          if (
            !confirm(
              `Restore/merge ${list.length} work(s) from "${file.name}" into local storage?\n\nExisting extensions, progress milestones, manual archives, and newer portal scans are preserved.`
            )
          ) {
            return;
          }
          const res = await getDb().importDatabasePayload(parsed, getExtractor().analyzeWorkRecord);
          await reloadScopeData();
          if (typeof regState.onDatabaseImported === 'function') {
            await regState.onDatabaseImported(res);
          }
          showRegisterNotice(
            `Restored ${res.inserted || 0} works (${res.activePlaced || 0} active, ${res.archivedPlaced || 0} finalized).`
          );
        } catch (err) {
          showRegisterNotice(
            `Restore failed: ${err && err.message ? err.message : String(err)}`,
            true
          );
        } finally {
          importInp.value = '';
        }
      };
    }
  }

  function moveVisibleColumnToTarget(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    let next = [...regState.visibleColumns];
    if (!next.includes(fromKey) || !next.includes(toKey)) {
      next = getEffectiveColumnsForView(regState.visibleColumns, regState.viewMode, regState.scope);
    }
    const fromIdx = next.indexOf(fromKey);
    const toIdx = next.indexOf(toKey);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    regState.visibleColumns = next;
    saveColumnPreference();
    const pop = document.getElementById('p3h-reg-cols-popover');
    const colBtn = document.getElementById('p3h-reg-cols-btn');
    if (pop && pop.style.display === 'block') {
      renderColumnPopover(pop, colBtn);
      if (colBtn) positionPopoverWithinViewport(colBtn, pop, 'right');
    }
    renderTableAndPagination();
  }

  function moveVisibleColumnByOffset(colKey, delta) {
    const idx = regState.visibleColumns.indexOf(colKey);
    const targetIdx = idx + delta;
    if (idx < 0 || targetIdx < 0 || targetIdx >= regState.visibleColumns.length) return;
    const next = [...regState.visibleColumns];
    const [moved] = next.splice(idx, 1);
    next.splice(targetIdx, 0, moved);
    regState.visibleColumns = next;
    saveColumnPreference();
    const pop = document.getElementById('p3h-reg-cols-popover');
    const colBtn = document.getElementById('p3h-reg-cols-btn');
    if (pop && pop.style.display === 'block') {
      renderColumnPopover(pop, colBtn);
      if (colBtn) positionPopoverWithinViewport(colBtn, pop, 'right');
    }
    renderTableAndPagination();
  }

  function renderColumnPopover(pop, triggerBtn) {
    const prevPopScroll = pop.scrollTop || 0;
    const prevListEl = pop.querySelector('.p3h-col-order-list');
    const prevListScroll = prevListEl ? prevListEl.scrollTop || 0 : 0;
    const escCss = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape : (s) => String(s);
    let focusAttr = '';
    let focusVal = '';
    let focusDir = '';
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    if (activeEl && pop.contains(activeEl)) {
      if (activeEl.hasAttribute('data-move-col')) {
        focusAttr = 'data-move-col';
        focusVal = activeEl.getAttribute('data-move-col') || '';
        focusDir = activeEl.getAttribute('data-move-dir') || '';
      } else if (activeEl.hasAttribute('data-hide-col')) {
        focusAttr = 'data-hide-col';
        focusVal = activeEl.getAttribute('data-hide-col') || '';
      } else if (activeEl.hasAttribute('data-col-key')) {
        focusAttr = 'data-col-key';
        focusVal = activeEl.getAttribute('data-col-key') || '';
      } else if (activeEl.hasAttribute('data-preset')) {
        focusAttr = 'data-preset';
        focusVal = activeEl.getAttribute('data-preset') || '';
      }
    }

    const groups = [];
    const byGroup = new Map();
    COLUMNS.forEach((c) => {
      if (!byGroup.has(c.group)) {
        byGroup.set(c.group, []);
        groups.push(c.group);
      }
      byGroup.get(c.group).push(c);
    });

    const selectedSet = new Set(regState.visibleColumns);
    const orderedVisibleCols = regState.visibleColumns
      .map((k) => (Object.hasOwn(COLUMN_MAP, k) ? COLUMN_MAP[k] : null))
      .filter(Boolean);
    const colBtn = triggerBtn || document.getElementById('p3h-reg-cols-btn');

    pop.innerHTML = `
      <div class="p3h-col-presets">
        <span style="font-weight:700;font-size:11px;color:#475569;">Presets:</span>
        <button type="button" class="p3h-btn" data-preset="standard">Standard</button>
        <button type="button" class="p3h-btn" data-preset="agreement_schedule">Agreement &amp; Schedule</button>
        <button type="button" class="p3h-btn" data-preset="sanctions">Sanctions &amp; LAC</button>
        <button type="button" class="p3h-btn" data-preset="all">All Fields</button>
      </div>
      <div class="p3h-col-order-wrap">
        <div class="p3h-col-group-title" style="margin-bottom:5px;">Column Order (Drag or ↑/↓ — applies to Table, CSV &amp; PDF)</div>
        <div class="p3h-col-order-list">
          ${orderedVisibleCols
            .map(
              (col, idx) => `
            <div class="p3h-col-order-item" draggable="true" data-order-key="${escapeHtml(col.key)}">
              <span class="p3h-col-drag-handle" title="Drag to reorder">⋮⋮</span>
              <span class="p3h-col-order-idx">${idx + 1}.</span>
              <span class="p3h-col-order-lbl" title="${escapeHtml(col.label)}">${escapeHtml(
                col.label
              )}</span>
              <span class="p3h-col-order-btns">
                <button type="button" class="p3h-inline-edit-btn" data-move-col="${escapeHtml(
                  col.key
                )}" data-move-dir="-1" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="p3h-inline-edit-btn" data-move-col="${escapeHtml(
                  col.key
                )}" data-move-dir="1" title="Move down" ${
                idx === orderedVisibleCols.length - 1 ? 'disabled' : ''
              }>↓</button>
                <button type="button" class="p3h-inline-edit-btn" data-hide-col="${escapeHtml(
                  col.key
                )}" title="Hide column" ${
                orderedVisibleCols.length <= 1 ? 'disabled' : ''
              }>×</button>
              </span>
            </div>`
            )
            .join('')}
        </div>
      </div>
      <div class="p3h-col-groups">
        ${groups
          .map(
            (g) => `
          <div class="p3h-col-group">
            <div class="p3h-col-group-title">${escapeHtml(g)}</div>
            ${byGroup
              .get(g)
              .map(
                (col) => `
              <label class="p3h-col-check">
                <input type="checkbox" data-col-key="${escapeHtml(col.key)}" ${
                  selectedSet.has(col.key) ? 'checked' : ''
                } />
                <span>${escapeHtml(col.label)}</span>
              </label>`
              )
              .join('')}
          </div>`
          )
          .join('')}
      </div>
    `;

    pop.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const presetKey = btn.getAttribute('data-preset');
        if (presetKey && Object.hasOwn(COLUMN_PRESETS, presetKey)) {
          regState.visibleColumns = [...COLUMN_PRESETS[presetKey]];
          saveColumnPreference();
          renderColumnPopover(pop, colBtn);
          if (colBtn) positionPopoverWithinViewport(colBtn, pop, 'right');
          renderTableAndPagination();
        }
      };
    });

    pop.querySelectorAll('[data-move-col]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const key = btn.getAttribute('data-move-col');
        const dir = parseInt(btn.getAttribute('data-move-dir'), 10) || 0;
        moveVisibleColumnByOffset(key, dir);
      };
    });

    pop.querySelectorAll('[data-hide-col]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const key = btn.getAttribute('data-hide-col');
        if (regState.visibleColumns.length <= 1) return;
        regState.visibleColumns = regState.visibleColumns.filter((k) => k !== key);
        saveColumnPreference();
        renderColumnPopover(pop, colBtn);
        if (colBtn) positionPopoverWithinViewport(colBtn, pop, 'right');
        renderTableAndPagination();
      };
    });

    let dragOrderKey = '';
    pop.querySelectorAll('.p3h-col-order-item').forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        dragOrderKey = item.getAttribute('data-order-key') || '';
        item.classList.add('p3h-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', dragOrderKey);
        }
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dragOrderKey && item.getAttribute('data-order-key') !== dragOrderKey) {
          item.classList.add('p3h-drag-over');
        }
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('p3h-drag-over');
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('p3h-drag-over');
        const targetKey = item.getAttribute('data-order-key') || '';
        const srcKey = dragOrderKey || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : '');
        dragOrderKey = '';
        if (srcKey && targetKey && srcKey !== targetKey) {
          moveVisibleColumnToTarget(srcKey, targetKey);
        }
      });
      item.addEventListener('dragend', () => {
        dragOrderKey = '';
        pop.querySelectorAll('.p3h-col-order-item').forEach((el) => {
          el.classList.remove('p3h-dragging', 'p3h-drag-over');
        });
      });
    });

    pop.querySelectorAll('input[data-col-key]').forEach((inp) => {
      inp.onchange = () => {
        const colKey = inp.getAttribute('data-col-key');
        if (!colKey) return;
        if (inp.checked) {
          if (!regState.visibleColumns.includes(colKey)) {
            regState.visibleColumns = [...regState.visibleColumns, colKey];
          }
        } else {
          if (regState.visibleColumns.length <= 1) {
            inp.checked = true;
            return;
          }
          regState.visibleColumns = regState.visibleColumns.filter((k) => k !== colKey);
        }
        saveColumnPreference();
        renderColumnPopover(pop, colBtn);
        if (colBtn) positionPopoverWithinViewport(colBtn, pop, 'right');
        renderTableAndPagination();
      };
    });

    pop.scrollTop = prevPopScroll;
    const nextListEl = pop.querySelector('.p3h-col-order-list');
    if (nextListEl) nextListEl.scrollTop = prevListScroll;
    if (focusAttr && focusVal) {
      let targetFocus =
        focusAttr === 'data-move-col'
          ? pop.querySelector(`[data-move-col="${escCss(focusVal)}"][data-move-dir="${escCss(focusDir)}"]`)
          : pop.querySelector(`[${focusAttr}="${escCss(focusVal)}"]`);
      if ((!targetFocus || targetFocus.disabled) && focusAttr === 'data-move-col') {
        targetFocus =
          Array.from(pop.querySelectorAll(`[data-move-col="${escCss(focusVal)}"]`)).find(
            (el) => !el.disabled
          ) || null;
      }
      if (targetFocus && !targetFocus.disabled && typeof targetFocus.focus === 'function') {
        try {
          targetFocus.focus({ preventScroll: true });
        } catch (e) {
          targetFocus.focus();
        }
      }
    }
  }

  function buildDynamicFilterOptions(presentSet, filterKey) {
    const present = Array.from(presentSet).sort((a, b) => a.localeCompare(b));
    const opts = present.map((v) => ({ value: v, label: v }));
    const selected = normalizeFilterList(regState.filters[filterKey]);
    const absentSelected = selected
      .filter((v) => !presentSet.has(v))
      .sort((a, b) => a.localeCompare(b))
      .map((v) => ({ value: v, label: `${v} (0)` }));
    return absentSelected.length > 0 ? opts.concat(absentSelected) : opts;
  }

  function populateDynamicFilterOptions() {
    const modal = document.getElementById('p3h-register-modal');
    if (!modal) return;

    const actSet = new Set();
    const lacSet = new Set();
    const contractorSet = new Set();
    regState.allRows.forEach((r) => {
      (r.activityNamesList || []).forEach((a) => actSet.add(a));
      if (r.constituency) {
        r.constituency
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((l) => lacSet.add(l));
      }
      if (r.contractorName) contractorSet.add(r.contractorName);
      (r.activityRows || []).forEach((ar) => {
        if (ar.contractorName) contractorSet.add(ar.contractorName);
      });
    });

    regState.dynamicFilterOptions.activity = buildDynamicFilterOptions(actSet, 'activity');
    regState.dynamicFilterOptions.constituency = buildDynamicFilterOptions(lacSet, 'constituency');
    regState.dynamicFilterOptions.contractor = buildDynamicFilterOptions(contractorSet, 'contractor');

    updateAllMultiFilterButtons(modal);
  }

  function applyFilterSortAndRender() {
    regState.filteredRows = filterRegisterRows(regState.allRows, {
      ...regState.filters,
      hideExcluded: regState.hideExcluded,
      excludedKeys: regState.excludedKeys,
    });
    regState.sortedRows = sortRegisterRows(
      regState.filteredRows,
      regState.sortKey,
      regState.sortDir
    );
    renderKpis();
    renderTableAndPagination();
  }

  function renderKpis() {
    const kpiEl = document.getElementById('p3h-reg-kpis');
    if (!kpiEl) return;
    const ext = getExtractor();
    let totalPac = 0;
    let totalBilled = 0;
    let totalFines = 0;
    let overdueCount = 0;
    let mbookClosedCount = 0;
    let openMbook75Count = 0;
    let excludedInViewCount = 0;
    let includedCount = 0;
    const seenPacGroups = new Set();
    const seenFineFiles = new Set();

    regState.sortedRows.forEach((r) => {
      if (r.rowKey && regState.excludedKeys.has(r.rowKey)) {
        excludedInViewCount++;
        return;
      }
      includedCount++;
      if (r.agreedPacNum) {
        if (r.compositePacGroupKey) {
          if (!seenPacGroups.has(r.compositePacGroupKey)) {
            seenPacGroups.add(r.compositePacGroupKey);
            totalPac += r.agreedPacNum;
          }
        } else {
          totalPac += r.agreedPacNum;
        }
      }
      if (r.totalActiveAmount) totalBilled += r.totalActiveAmount;
      if (r.extensionFine) {
        if (r.isActivityRow && !r.hasExtensionOverride) {
          const fid = String(r.fileId || '');
          if (!seenFineFiles.has(fid)) {
            seenFineFiles.add(fid);
            totalFines += r.extensionFine;
          }
        } else {
          totalFines += r.extensionFine;
        }
      }
      if (r.scheduleStatusKey === 'overdue') overdueCount++;
      if (r.hasMbookClosedNoFinal) mbookClosedCount++;
      if (r.hasOpenMbook75) openMbook75Count++;
    });

    const unitLabel = regState.viewMode === 'activity' ? 'activities' : 'works';
    const exclControls =
      regState.excludedKeys.size > 0
        ? `<span class="p3h-kpi-excl">(${regState.excludedKeys.size} excluded from report)
            <button type="button" class="p3h-inline-edit-btn" id="p3h-reg-include-all-btn">Include All</button>
            <label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;margin-left:4px;">
              <input type="checkbox" id="p3h-reg-hide-excl-chk" ${
                regState.hideExcluded ? 'checked' : ''
              } /> Hide Excluded
            </label>
          </span>`
        : '';

    kpiEl.innerHTML = `
      <span><strong>Included:</strong> ${includedCount} / ${regState.sortedRows.length} ${unitLabel}${
      excludedInViewCount > 0 ? ` (${excludedInViewCount} unchecked)` : ''
    }</span>
      <span><strong>Total Agreed PAC:</strong> ₹${escapeHtml(ext.formatInr(totalPac))}</span>
      <span><strong>Financial Billed:</strong> ₹${escapeHtml(ext.formatInr(totalBilled))}</span>
      ${totalFines > 0 ? `<span><strong>Ext. Fines:</strong> ₹${escapeHtml(ext.formatInr(totalFines))}</span>` : ''}
      <span class="${overdueCount > 0 ? 'p3h-kpi-warn' : ''}"><strong>Overdue:</strong> ${overdueCount}</span>
      <span><strong>Open M-Book ≥75%:</strong> ${openMbook75Count}</span>
      <span><strong>M-Book Closed (No Final):</strong> ${mbookClosedCount}</span>
      ${exclControls}
    `;

    const incAllBtn = kpiEl.querySelector('#p3h-reg-include-all-btn');
    if (incAllBtn) {
      incAllBtn.onclick = () => {
        regState.excludedKeys.clear();
        regState.hideExcluded = false;
        applyFilterSortAndRender();
      };
    }
    const hideChk = kpiEl.querySelector('#p3h-reg-hide-excl-chk');
    if (hideChk) {
      hideChk.onchange = () => {
        regState.hideExcluded = hideChk.checked;
        regState.page = 1;
        applyFilterSortAndRender();
      };
    }
  }

  function patchWorkInRegRows(updated) {
    if (!updated || !updated.fileId) return;
    const rawIdx = regState.rawWorks.findIndex(
      (w) => String(w.fileId) === String(updated.fileId)
    );
    if (rawIdx >= 0) regState.rawWorks[rawIdx] = updated;
    rebuildRowsFromRaw();
    if (typeof regState.onDataUpdated === 'function') {
      regState.onDataUpdated(updated);
    }
  }

  async function refreshAfterMutation(updatedRecord) {
    await reloadScopeData();
    if (typeof regState.onDataUpdated === 'function' && updatedRecord) {
      regState.onDataUpdated(updatedRecord);
    }
  }

  async function saveInlineUserField(fileId, activityKey, patch, focusTarget) {
    const db = getDb();
    const workRec = regState.rawWorks.find((w) => String(w.fileId) === String(fileId));
    const scopeKey = workRec
      ? db.resolveUserDataScope(workRec, activityKey || '')
      : activityKey || '';
    const updated = await db.patchWorkUserTracking(fileId, scopeKey, patch);
    if (!updated) return;

    const tbody = typeof document !== 'undefined' ? document.getElementById('p3h-reg-tbody') : null;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const wasInTbody = Boolean(tbody && activeEl && tbody.contains(activeEl));

    patchWorkInRegRows(updated);

    if (wasInTbody && focusTarget && focusTarget.attr && tbody) {
      const escCss = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape : (s) => String(s);
      const actSel = focusTarget.actKey
        ? `[data-act-key="${escCss(focusTarget.actKey)}"]`
        : ':not([data-act-key])';
      const el = tbody.querySelector(
        `[${focusTarget.attr}="${escCss(focusTarget.fileId)}"]${actSel}`
      );
      if (el && typeof el.focus === 'function') {
        try {
          el.focus({ preventScroll: true });
        } catch (e) {
          el.focus();
        }
      }
    }
  }

  function openManualArchiveDialog(fileId, activityKey, displayLabel) {
    const backdrop = document.getElementById('p3h-ext-dialog-backdrop');
    const dialog = document.getElementById('p3h-ext-dialog');
    if (!backdrop || !dialog) return;

    const db = getDb();
    const ext = getExtractor();
    const isAct = Boolean(activityKey);
    const presets = [
      'Cancelled',
      'Abandoned',
      'Dropped / Not Required',
      'Superseded / Revised Estimate',
      'Duplicate Entry',
    ];

    dialog.innerHTML = `
      <div class="p3h-ext-dialog-head">
        <div>
          <strong>Manually Archive ${isAct ? 'Activity' : 'Work'}</strong>
          <div style="font-size:11px;color:#475569;">${escapeHtml(displayLabel || fileId)}</div>
        </div>
        <button type="button" class="p3h-btn" id="p3h-arch-dlg-close">×</button>
      </div>
      <div class="p3h-ext-dialog-body">
        <div style="font-size:12px;color:#334155;margin-bottom:8px;">
          Manually archived items are hidden from Active Works &amp; Active Reports and remain accessible under the <strong>Manually Archived</strong> tab.
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
          ${presets
            .map(
              (p) =>
                `<button type="button" class="p3h-pill" data-arch-preset="${escapeHtml(p)}">${escapeHtml(
                  p
                )}</button>`
            )
            .join('')}
        </div>
        <label class="p3h-ud-field">
          <span>Reason / Remarks</span>
          <input type="text" class="p3h-input" id="p3h-arch-reason" placeholder="e.g., Cancelled by authority, Abandoned..." />
        </label>
      </div>
      <div class="p3h-ext-dialog-foot">
        <span style="font-size:11px;color:#64748b;">You can restore it anytime from Manually Archived.</span>
        <div style="display:flex;gap:8px;">
          <button type="button" class="p3h-btn" id="p3h-arch-dlg-cancel">Cancel</button>
          <button type="button" class="p3h-btn p3h-btn-warn" id="p3h-arch-dlg-confirm">Archive ${
            isAct ? 'Activity' : 'Work'
          }</button>
        </div>
      </div>
    `;

    const reasonInp = dialog.querySelector('#p3h-arch-reason');
    dialog.querySelectorAll('[data-arch-preset]').forEach((btn) => {
      btn.onclick = () => {
        reasonInp.value = btn.getAttribute('data-arch-preset') || '';
        reasonInp.focus();
      };
    });
    dialog.querySelector('#p3h-arch-dlg-close').onclick = () => {
      backdrop.style.display = 'none';
    };
    dialog.querySelector('#p3h-arch-dlg-cancel').onclick = () => {
      backdrop.style.display = 'none';
    };
    dialog.querySelector('#p3h-arch-dlg-confirm').onclick = async () => {
      const reason = reasonInp.value.trim() || 'Manually Archived';
      const updated = isAct
        ? await db.setActivityManualArchive(
            fileId,
            activityKey,
            { archived: true, reason },
            ext.analyzeWorkRecord
          )
        : await db.setWorkManualArchive(
            fileId,
            { archived: true, reason },
            ext.analyzeWorkRecord
          );
      backdrop.style.display = 'none';
      await refreshAfterMutation(updated);
    };

    backdrop.style.display = 'flex';
  }

  function openProgressHistoryDialog(fileId, activityKey) {
    const backdrop = document.getElementById('p3h-ext-dialog-backdrop');
    const dialog = document.getElementById('p3h-ext-dialog');
    if (!backdrop || !dialog) return;

    const db = getDb();
    let descending = false;
    let draft = null;

    const getContext = () => {
      const workRec = regState.rawWorks.find((w) => String(w.fileId) === String(fileId));
      if (!workRec) return null;
      const scopeKey = db.resolveUserDataScope(workRec, activityKey || '');
      const uFields = db.getEffectiveUserFields(workRec, scopeKey);
      const sum = getExtractor().analyzeWorkRecord(workRec);
      const act = scopeKey
        ? (sum.activities || []).find((a) => a.activityKey === scopeKey)
        : null;
      return { workRec, scopeKey, uFields, act };
    };

    const toLocalDateTimeInput = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
        d.getHours()
      )}:${pad(d.getMinutes())}`;
    };

    const captureDraft = () => {
      const statusEl = dialog.querySelector('#p3h-ms-new-status');
      if (!statusEl) return;
      const progEl = dialog.querySelector('#p3h-ms-new-prog');
      const tsEl = dialog.querySelector('#p3h-ms-new-ts');
      const remEl = dialog.querySelector('#p3h-ms-new-remarks');
      draft = {
        workStatus: statusEl.value,
        physicalProgress: progEl ? progEl.value : '',
        tsLocal: tsEl ? tsEl.value : '',
        remarks: remEl ? remEl.value : '',
      };
    };

    const renderDialog = () => {
      const ctx = getContext();
      if (!ctx) {
        backdrop.style.display = 'none';
        return;
      }
      const { workRec, scopeKey, uFields, act } = ctx;
      const history = uFields.progressHistory || [];
      const initStatus = draft ? draft.workStatus : uFields.workStatus || '';
      const initProg = draft
        ? draft.physicalProgress
        : uFields.physicalProgress !== null
        ? String(uFields.physicalProgress)
        : '';
      const initTs = draft ? draft.tsLocal : toLocalDateTimeInput(new Date());
      const initRemarks = draft ? draft.remarks : '';

      dialog.innerHTML = `
        <div class="p3h-ext-dialog-head">
          <div>
            <strong>Milestone Progress Chronology</strong>
            <div style="font-size:11px;color:#475569;">${escapeHtml(workRec.fileNumber || '')}${
              act ? ' · ' + escapeHtml(act.activityName) : ''
            } (${history.length} ${history.length === 1 ? 'milestone' : 'milestones'})</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <button type="button" class="p3h-btn" id="p3h-ms-order-btn">${
              descending ? 'Latest First ↓' : 'Oldest First ↑'
            }</button>
            <button type="button" class="p3h-btn" id="p3h-ms-dlg-close">×</button>
          </div>
        </div>
        <div class="p3h-ext-dialog-body">
          <div style="margin-bottom:12px;">
            ${renderMilestoneTimelineHtml(history, { allowDelete: true, descending })}
          </div>
          <div style="border-top:1px solid #e2e8f0;padding-top:10px;">
            <strong style="font-size:12px;color:#0f172a;display:block;margin-bottom:6px;">+ Log New Milestone</strong>
            <div class="p3h-ud-grid">
              <label class="p3h-ud-field">
                <span>Status of Work</span>
                <input type="text" list="p3h-work-status-list" class="p3h-input" id="p3h-ms-new-status" value="${escapeHtml(
                  initStatus
                )}" placeholder="e.g., Material Procured..." />
              </label>
              <label class="p3h-ud-field" style="max-width:120px;">
                <span>Progress (%)</span>
                <input type="number" min="0" max="100" step="1" class="p3h-input" id="p3h-ms-new-prog" value="${escapeHtml(
                  initProg
                )}" placeholder="0 - 100" />
              </label>
              <label class="p3h-ud-field" style="max-width:190px;">
                <span>Date &amp; Time</span>
                <input type="datetime-local" class="p3h-input" id="p3h-ms-new-ts" value="${escapeHtml(
                  initTs
                )}" />
              </label>
            </div>
            <label class="p3h-ud-field" style="margin-top:6px;">
              <span>Milestone Remarks / Site Note</span>
              <input type="text" class="p3h-input" id="p3h-ms-new-remarks" value="${escapeHtml(
                initRemarks
              )}" placeholder="Optional note (e.g., Panels delivered to site)..." />
            </label>
          </div>
        </div>
        <div class="p3h-ext-dialog-foot">
          <span style="font-size:11px;color:#64748b;">Milestones are saved with exact timestamps.</span>
          <div style="display:flex;gap:8px;">
            <button type="button" class="p3h-btn" id="p3h-ms-dlg-cancel">Close</button>
            <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-ms-dlg-add">Save Milestone</button>
          </div>
        </div>
      `;

      dialog.querySelector('#p3h-ms-dlg-close').onclick = () => {
        backdrop.style.display = 'none';
      };
      dialog.querySelector('#p3h-ms-dlg-cancel').onclick = () => {
        backdrop.style.display = 'none';
      };
      dialog.querySelector('#p3h-ms-order-btn').onclick = () => {
        captureDraft();
        descending = !descending;
        renderDialog();
      };
      dialog.querySelectorAll('[data-del-ms]').forEach((btn) => {
        btn.onclick = async () => {
          captureDraft();
          const entryId = btn.getAttribute('data-del-ms');
          const updated = await db.deleteProgressHistoryEntry(fileId, scopeKey, entryId);
          if (updated) patchWorkInRegRows(updated);
          renderDialog();
        };
      });
      dialog.querySelector('#p3h-ms-dlg-add').onclick = async () => {
        const workStatus = dialog.querySelector('#p3h-ms-new-status').value.trim();
        const rawProg = dialog.querySelector('#p3h-ms-new-prog').value.trim();
        const physicalProgress = rawProg === '' ? null : parseFloat(rawProg);
        const remarks = dialog.querySelector('#p3h-ms-new-remarks').value.trim();
        const tsLocal = dialog.querySelector('#p3h-ms-new-ts').value;
        const timestamp = tsLocal && !Number.isNaN(Date.parse(tsLocal)) ? new Date(tsLocal).toISOString() : '';

        const updated = await db.addProgressHistoryEntry(fileId, scopeKey, {
          workStatus,
          physicalProgress,
          remarks,
          timestamp,
        });
        draft = null;
        if (updated) patchWorkInRegRows(updated);
        renderDialog();
      };
    };

    renderDialog();
    backdrop.style.display = 'flex';
  }

  function openExtensionEditorDialog(fileId, activityKey) {
    const backdrop = document.getElementById('p3h-ext-dialog-backdrop');
    const dialog = document.getElementById('p3h-ext-dialog');
    if (!backdrop || !dialog) return;
    const workRec = regState.rawWorks.find((w) => String(w.fileId) === String(fileId));
    if (!workRec) return;

    const db = getDb();
    const sum = getExtractor().analyzeWorkRecord(workRec);
    const ud = db.normalizeUserData(workRec.userData);
    const scopeKey = db.resolveUserDataScope(workRec, activityKey || '');
    const effective = db.getEffectiveUserFields(workRec, scopeKey);
    const ownExts = scopeKey
      ? ud.activityOverrides[scopeKey] && ud.activityOverrides[scopeKey].extensions
      : ud.extensions;
    const initialExts =
      Array.isArray(ownExts) && ownExts.length > 0 ? ownExts : effective.extensions || [];
    let workingExts = initialExts.map((e) => ({ ...e }));

    const actObj = scopeKey
      ? (sum.activities || []).find((a) => a.activityKey === scopeKey)
      : null;

    const dmyToInputVal = (dmy) => db.dmyToIso(dmy) || '';

    const renderDialog = () => {
      dialog.innerHTML = `
        <div class="p3h-ext-dialog-head">
          <div>
            <strong>Manage Extensions &amp; Fine</strong>
            <div style="font-size:11px;color:#475569;">${escapeHtml(workRec.fileNumber || '')}${
              actObj ? ' · ' + escapeHtml(actObj.activityName) : ''
            }</div>
          </div>
          <button type="button" class="p3h-btn" id="p3h-ext-dlg-close">×</button>
        </div>
        <div class="p3h-ext-dialog-body">
          ${
            workingExts.length === 0
              ? '<div style="font-size:12px;color:#64748b;padding:8px 0;">No extensions added yet. Click "+ Add Extension" below.</div>'
              : workingExts
                  .map(
                    (extItem, idx) => `
                <div class="p3h-ext-row" data-ext-idx="${idx}">
                  <span class="p3h-ext-ord">${escapeHtml(db.formatOrdinal(idx + 1))} Ext.</span>
                  <input type="date" class="p3h-input" data-ext-field="extendedDate" value="${escapeHtml(
                    dmyToInputVal(extItem.extendedDate)
                  )}" title="Extended Date of Completion" />
                  <input type="number" min="0" step="0.01" class="p3h-input" data-ext-field="fineAmount" value="${
                    extItem.fineAmount > 0 ? escapeHtml(extItem.fineAmount) : ''
                  }" placeholder="Fine (₹)" style="width:105px;" />
                  <input type="text" class="p3h-input" data-ext-field="orderNo" value="${escapeHtml(
                    extItem.orderNo || ''
                  )}" placeholder="Order No." style="width:120px;" />
                  <input type="text" class="p3h-input" data-ext-field="remarks" value="${escapeHtml(
                    extItem.remarks || ''
                  )}" placeholder="Remarks" style="flex:1;min-width:110px;" />
                  <button type="button" class="p3h-btn p3h-btn-danger" data-ext-del="${idx}" title="Remove">×</button>
                </div>`
                  )
                  .join('')
          }
        </div>
        <div class="p3h-ext-dialog-foot">
          <button type="button" class="p3h-btn" id="p3h-ext-dlg-add">+ Add ${escapeHtml(
            db.formatOrdinal(workingExts.length + 1)
          )} Extension</button>
          <div style="display:flex;gap:8px;">
            <button type="button" class="p3h-btn" id="p3h-ext-dlg-cancel">Cancel</button>
            <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-ext-dlg-save">Save Extensions</button>
          </div>
        </div>
      `;

      const syncInputs = () => {
        dialog.querySelectorAll('.p3h-ext-row').forEach((rowEl, idx) => {
          const dtVal = rowEl.querySelector('[data-ext-field="extendedDate"]').value;
          const fineVal = rowEl.querySelector('[data-ext-field="fineAmount"]').value;
          const ordVal = rowEl.querySelector('[data-ext-field="orderNo"]').value;
          const remVal = rowEl.querySelector('[data-ext-field="remarks"]').value;
          workingExts[idx] = db.normalizeExtensionEntry(
            {
              order: idx + 1,
              extendedDate: dtVal,
              fineAmount: fineVal,
              orderNo: ordVal,
              remarks: remVal,
            },
            idx
          );
        });
      };

      dialog.querySelector('#p3h-ext-dlg-close').onclick = () => {
        backdrop.style.display = 'none';
      };
      dialog.querySelector('#p3h-ext-dlg-cancel').onclick = () => {
        backdrop.style.display = 'none';
      };
      dialog.querySelector('#p3h-ext-dlg-add').onclick = () => {
        syncInputs();
        workingExts.push({
          order: workingExts.length + 1,
          extendedDate: '',
          fineAmount: 0,
          orderNo: '',
          remarks: '',
        });
        renderDialog();
      };
      dialog.querySelectorAll('[data-ext-del]').forEach((btn) => {
        btn.onclick = () => {
          syncInputs();
          const delIdx = parseInt(btn.getAttribute('data-ext-del'), 10);
          workingExts.splice(delIdx, 1);
          workingExts = workingExts.map((x, i) => ({ ...x, order: i + 1 }));
          renderDialog();
        };
      });
      dialog.querySelector('#p3h-ext-dlg-save').onclick = async () => {
        syncInputs();
        const cleaned = workingExts.map((x, i) => ({ ...x, order: i + 1 }));
        backdrop.style.display = 'none';
        await saveInlineUserField(fileId, scopeKey, { extensions: cleaned });
      };
    };

    renderDialog();
    backdrop.style.display = 'flex';
  }

  function renderTableCell(col, row, globalIdx, isChild) {
    const db = getDb();
    const ext = getExtractor();
    const txt = col.key === 'slNo' ? (isChild ? '' : String(globalIdx)) : formatCellValue(col, row);
    const editActivityKey =
      row.editActivityKey !== undefined ? row.editActivityKey : row.activityKey || '';
    const actKeyAttr = editActivityKey ? ` data-act-key="${escapeHtml(editActivityKey)}"` : '';

    if (col.key === 'workDetails') {
      if (isChild) {
        const codeTxt = row.estimateCode
          ? `<div class="p3h-stacked-sub">[${escapeHtml(row.estimateCode)}]</div>`
          : '';
        return `<td class="p3h-reg-subj p3h-act-subj">↳ <strong>${escapeHtml(
          row.activityName || row.subject || ''
        )}</strong>${codeTxt}</td>`;
      }
      const archChip = row.isManuallyArchived
        ? ' <span class="p3h-badge p3h-badge-manual-arch" title="Manually Archived">Manual Arch</span>'
        : row.isArchived
        ? ' <span class="p3h-badge p3h-badge-archived" title="Finalized &amp; Submitted (Archived)">Archived</span>'
        : '';
      const actCount = regState.viewMode === 'file' ? (row.activityRows || []).length : 0;
      const isExp =
        regState.expandedIds.has(row.fileId) ||
        normalizeFilterList(regState.filters.activity).length > 0;
      const expandBtn =
        actCount > 0
          ? `<button type="button" class="p3h-expand-btn" data-toggle-act="${escapeHtml(
              row.fileId
            )}" title="Show/hide activity breakdown">${isExp ? '▾' : '▸'} ${actCount} ${
              actCount === 1 ? 'Activity' : 'Activities'
            }</button>`
          : '';
      const actText = row.activityName || row.activityNames || '';
      const codeHtml =
        row.activityName && row.estimateCode
          ? ` <span class="p3h-work-cell-code">[${escapeHtml(row.estimateCode)}]</span>`
          : '';
      return `<td class="p3h-reg-subj">
        <div class="p3h-work-cell">
          <div class="p3h-work-cell-file">
            <button type="button" class="p3h-link-btn" data-open-file="${escapeHtml(
              row.fileId
            )}">${escapeHtml(row.fileNumber || '')}</button>${archChip}
          </div>
          ${
            row.subject
              ? `<div class="p3h-work-cell-subj" title="${escapeHtml(row.subject)}">${escapeHtml(
                  row.subject
                )}</div>`
              : ''
          }
          ${
            actText
              ? `<div class="p3h-work-cell-act">${escapeHtml(actText)}${codeHtml}</div>`
              : ''
          }
          ${expandBtn ? `<div style="margin-top:2px;">${expandBtn}</div>` : ''}
        </div>
      </td>`;
    }

    if (col.key === 'fileNumber') {
      if (isChild) {
        return `<td class="p3h-act-cell-muted">↳ Activity</td>`;
      }
      const archChip = row.isManuallyArchived
        ? ' <span class="p3h-badge p3h-badge-manual-arch" title="Manually Archived">Manual Arch</span>'
        : row.isArchived
        ? ' <span class="p3h-badge p3h-badge-archived" title="Finalized &amp; Submitted (Archived)">Archived</span>'
        : '';
      const actCount = regState.viewMode === 'file' ? (row.activityRows || []).length : 0;
      const isExp =
        regState.expandedIds.has(row.fileId) ||
        normalizeFilterList(regState.filters.activity).length > 0;
      const expandBtn =
        actCount > 0
          ? `<button type="button" class="p3h-expand-btn" data-toggle-act="${escapeHtml(
              row.fileId
            )}" title="Show/hide activity breakdown">${isExp ? '▾' : '▸'} ${actCount} ${
              actCount === 1 ? 'Activity' : 'Activities'
            }</button>`
          : '';
      return `<td><div><button type="button" class="p3h-link-btn" data-open-file="${escapeHtml(
        row.fileId
      )}">${escapeHtml(txt)}</button>${archChip}</div>${
        expandBtn ? `<div style="margin-top:3px;">${expandBtn}</div>` : ''
      }</td>`;
    }

    if (col.key === 'subject') {
      if (isChild) {
        const codeTxt = row.estimateCode
          ? `<div class="p3h-stacked-sub">[${escapeHtml(row.estimateCode)}]</div>`
          : '';
        return `<td class="p3h-reg-subj p3h-act-subj">↳ <strong>${escapeHtml(
          row.activityName || txt
        )}</strong>${codeTxt}</td>`;
      }
      return `<td class="p3h-reg-subj" title="${escapeHtml(txt)}">${escapeHtml(txt)}</td>`;
    }

    if (col.key === 'activityName') {
      const codeTxt = row.estimateCode
        ? `<div class="p3h-stacked-sub">[${escapeHtml(row.estimateCode)}]</div>`
        : '';
      return `<td><div class="p3h-stacked-main">${escapeHtml(
        row.activityName || txt
      )}</div>${codeTxt}</td>`;
    }

    if (col.key === 'billCategory') {
      const mbookBadge =
        (isChild || row.isActivityRow) && row.mbookStatus
          ? `<div style="margin-top:2px;"><span class="p3h-badge ${
              /^closed$/i.test(row.mbookStatus) ? 'p3h-badge-mbook-closed' : 'p3h-badge-nobill'
            }">M-Book: ${escapeHtml(row.mbookStatus)}</span></div>`
          : '';
      return `<td><span class="p3h-badge ${escapeHtml(
        row.billBadgeClass || 'p3h-badge-nobill'
      )}">${escapeHtml(txt)}</span>${mbookBadge}</td>`;
    }

    if (col.key === 'totalActiveAmount') {
      return `<td class="p3h-num">${renderFinancialCellHtml(row, ext)}</td>`;
    }

    if (col.key === 'completionDate') {
      return `<td>${renderDueDateColumnHtml(row)}</td>`;
    }

    if (col.key === 'asNoDate') {
      return `<td>${renderStackedNoDateHtml(row.asNo, row.asDate)}</td>`;
    }
    if (col.key === 'tsNoDate') {
      return `<td>${renderStackedNoDateHtml(row.tsNo, row.tsDate)}</td>`;
    }
    if (col.key === 'agreementNoDate') {
      return `<td>${renderStackedNoDateHtml(row.agreementNo, row.agreementDate)}</td>`;
    }

    if (col.key === 'extendedCompletionDate') {
      const ordBadge = row.extensionOrder
        ? `<span class="p3h-badge p3h-badge-part">${escapeHtml(
            db.formatOrdinal(row.extensionOrder)
          )}</span>`
        : '';
      return `<td>
        <div class="p3h-ext-cell">
          <span>${txt ? escapeHtml(txt) : '<span style="color:#94a3b8;">—</span>'}</span>
          ${ordBadge}
          <button type="button" class="p3h-inline-edit-btn" data-edit-ext="${escapeHtml(
            row.fileId
          )}"${actKeyAttr} title="Add / Edit Extensions &amp; Fine">✎</button>
        </div>
      </td>`;
    }

    if (col.key === 'workStatus') {
      return `<td><input type="text" list="p3h-work-status-list" class="p3h-inline-input" data-inline-status="${escapeHtml(
        row.fileId
      )}"${actKeyAttr} value="${escapeHtml(row.workStatus || '')}" placeholder="Enter status..." /></td>`;
    }

    if (col.key === 'physicalProgress') {
      const val =
        typeof row.physicalProgress === 'number' && Number.isFinite(row.physicalProgress)
          ? row.physicalProgress
          : '';
      const pctWidth = val !== '' ? Math.max(0, Math.min(100, val)) : 0;
      const histCount = Array.isArray(row.progressHistory) ? row.progressHistory.length : 0;
      return `<td class="p3h-num">
        <div class="p3h-prog-row">
          <div class="p3h-prog-cell">
            <input type="number" min="0" max="100" step="1" class="p3h-inline-num" data-inline-progress="${escapeHtml(
              row.fileId
            )}"${actKeyAttr} value="${escapeHtml(val)}" placeholder="%" />
            <div class="p3h-prog-bar"><span style="width:${pctWidth}%"></span></div>
          </div>
          <button type="button" class="p3h-hist-btn" data-open-history="${escapeHtml(
            row.fileId
          )}"${actKeyAttr} title="Milestone Progress Chronology (${histCount})">🕒${
        histCount > 0 ? ' ' + histCount : ''
      }</button>
        </div>
      </td>`;
    }

    if (col.key === 'scheduleStatus') {
      const cls =
        row.scheduleStatusKey === 'overdue'
          ? 'p3h-badge-overdue'
          : row.scheduleStatusKey === 'completed'
          ? 'p3h-badge-final'
          : row.scheduleStatusKey === 'ongoing'
          ? 'p3h-badge-part'
          : 'p3h-badge-nobill';
      return `<td><span class="p3h-badge ${cls}">${escapeHtml(txt)}</span></td>`;
    }

    const numCls = col.type === 'money' || col.type === 'number' ? ' class="p3h-num"' : '';
    return `<td${numCls}>${escapeHtml(txt)}</td>`;
  }

  function renderActionCellHtml(row) {
    const actAttr = row.activityKey ? ` data-act-key="${escapeHtml(row.activityKey)}"` : '';
    const restoreWorkFlag =
      row.isWorkManuallyArchived && !row.isActivityManuallyArchived ? ' data-restore-work="1"' : '';
    const dualArchFlag =
      row.isWorkManuallyArchived && row.isActivityManuallyArchived ? ' data-dual-arch="1"' : '';
    if (row.isManuallyArchived) {
      return `<td><button type="button" class="p3h-btn p3h-btn-sm" data-restore-arch="${escapeHtml(
        row.fileId
      )}"${actAttr}${restoreWorkFlag}${dualArchFlag} title="${escapeHtml(
        row.manualArchiveReason ? 'Reason: ' + row.manualArchiveReason : 'Restore to Active'
      )}">Restore</button></td>`;
    }
    return `<td><button type="button" class="p3h-btn p3h-btn-sm p3h-btn-danger" data-manual-arch="${escapeHtml(
      row.fileId
    )}"${actAttr} data-arch-label="${escapeHtml(
      (row.fileNumber || '') + (row.activityName ? ' · ' + row.activityName : '')
    )}" title="Manually archive (Cancelled / Abandoned)">Archive</button></td>`;
  }

  function syncSelectAllCheckboxState(tbody, thead) {
    const rootHead = thead || document.getElementById('p3h-reg-thead');
    if (!rootHead) return;
    const selAllChk = rootHead.querySelector('#p3h-reg-select-all');
    if (!selAllChk) return;
    const allFilteredSelected =
      regState.sortedRows.length > 0 &&
      regState.sortedRows.every((r) => !(r.rowKey && regState.excludedKeys.has(r.rowKey)));
    selAllChk.checked = allFilteredSelected;
  }

  function renderTableAndPagination() {
    const thead = document.getElementById('p3h-reg-thead');
    const tbody = document.getElementById('p3h-reg-tbody');
    const pagEl = document.getElementById('p3h-reg-pagination');
    if (!thead || !tbody || !pagEl) return;

    const cols = getEffectiveColumnsForView(
      regState.visibleColumns,
      regState.viewMode,
      regState.scope
    );
    const colObjs = cols
      .map((k) => (Object.hasOwn(COLUMN_MAP, k) ? COLUMN_MAP[k] : null))
      .filter(Boolean);
    const allFilteredSelected =
      regState.sortedRows.length > 0 &&
      regState.sortedRows.every((r) => !(r.rowKey && regState.excludedKeys.has(r.rowKey)));

    thead.innerHTML = `<tr>
      <th class="p3h-chk-col" title="Include / Exclude from Report">
        <input type="checkbox" id="p3h-reg-select-all" ${allFilteredSelected ? 'checked' : ''} />
      </th>
      ${colObjs
        .map((col) => {
          const isSorted = regState.sortKey === col.key;
          const arrow = isSorted ? (regState.sortDir === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
          const numCls = col.type === 'money' || col.type === 'number' ? ' p3h-num' : '';
          return `<th class="p3h-sortable${numCls}${isSorted ? ' p3h-sorted' : ''}" draggable="true" title="Click to sort, drag to reorder column" data-sort-key="${escapeHtml(
            col.key
          )}" data-col-key="${escapeHtml(col.key)}">${escapeHtml(
            col.label
          )}<span class="p3h-sort-ind">${arrow}</span></th>`;
        })
        .join('')}
      <th>Action</th>
    </tr>`;

    const total = regState.sortedRows.length;
    const totalPages = Math.max(1, Math.ceil(total / regState.pageSize));
    if (regState.page > totalPages) regState.page = totalPages;
    const startIdx = (regState.page - 1) * regState.pageSize;
    const pageRows = regState.sortedRows.slice(startIdx, startIdx + regState.pageSize);
    const totalColSpan = colObjs.length + 2;
    const hasActFilter = normalizeFilterList(regState.filters.activity).length > 0;

    if (pageRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${totalColSpan}" style="text-align:center;padding:24px;color:#64748b;">No records match the current scope and filters.</td></tr>`;
    } else {
      const rowHtmlList = [];
      pageRows.forEach((row, i) => {
        const globalIdx = startIdx + i + 1;
        const isExcl = Boolean(row.rowKey && regState.excludedKeys.has(row.rowKey));
        const chkTd = `<td class="p3h-chk-col"><input type="checkbox" class="p3h-row-inc-chk" data-inc-key="${escapeHtml(
          row.rowKey || ''
        )}" ${isExcl ? '' : 'checked'} title="Include in generated CSV / PDF report" /></td>`;
        const parentTds = colObjs.map((col) => renderTableCell(col, row, globalIdx, false)).join('');
        const actTd = renderActionCellHtml(row);
        rowHtmlList.push(
          `<tr class="${isExcl ? 'p3h-row-excluded' : ''}">${chkTd}${parentTds}${actTd}</tr>`
        );

        const showChildren =
          regState.viewMode === 'file' &&
          (regState.expandedIds.has(row.fileId) || hasActFilter);
        if (showChildren && (row.activityRows || []).length > 0) {
          const children = getFilteredActivityRows(row, regState.filters.activity);
          children.forEach((sub) => {
            const subExcl = Boolean(sub.rowKey && regState.excludedKeys.has(sub.rowKey));
            const subChkTd = `<td class="p3h-chk-col"><input type="checkbox" class="p3h-row-inc-chk" data-inc-key="${escapeHtml(
              sub.rowKey || ''
            )}" ${subExcl ? '' : 'checked'} title="Include activity in report" /></td>`;
            const subTds = colObjs.map((col) => renderTableCell(col, sub, '', true)).join('');
            const subActTd = renderActionCellHtml(sub);
            rowHtmlList.push(
              `<tr class="p3h-activity-row${
                subExcl ? ' p3h-row-excluded' : ''
              }">${subChkTd}${subTds}${subActTd}</tr>`
            );
          });
        }
      });
      tbody.innerHTML = rowHtmlList.join('');
    }

    syncExpandAllButtonLabel();
    syncSelectAllCheckboxState(tbody, thead);

    pagEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span>Rows per page:</span>
        ${[50, 100, 250]
          .map(
            (sz) =>
              `<button type="button" class="p3h-btn${
                regState.pageSize === sz ? ' p3h-btn-primary' : ''
              }" data-reg-ps="${sz}">${sz}</button>`
          )
          .join('')}
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button type="button" class="p3h-btn" id="p3h-reg-prev" ${regState.page <= 1 ? 'disabled' : ''}>Prev</button>
        <span>Page ${regState.page} of ${totalPages} (${total} records)</span>
        <button type="button" class="p3h-btn" id="p3h-reg-next" ${
          regState.page >= totalPages ? 'disabled' : ''
        }>Next</button>
      </div>
    `;

    pagEl.querySelectorAll('[data-reg-ps]').forEach((b) => {
      b.onclick = () => {
        regState.pageSize = parseInt(b.getAttribute('data-reg-ps'), 10) || 50;
        regState.page = 1;
        savePageSizePreference();
        renderTableAndPagination();
      };
    });
    const prevBtn = pagEl.querySelector('#p3h-reg-prev');
    const nextBtn = pagEl.querySelector('#p3h-reg-next');
    if (prevBtn) {
      prevBtn.onclick = () => {
        if (regState.page > 1) {
          regState.page--;
          renderTableAndPagination();
        }
      };
    }
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (regState.page < totalPages) {
          regState.page++;
          renderTableAndPagination();
        }
      };
    }
  }

  function describeActiveFilters() {
    const f = regState.filters;
    const parts = [
      `View: ${regState.viewMode === 'activity' ? 'Activity-wise' : 'File-wise'}`,
      `Scope: ${regState.scope}`,
    ];
    if (f.openMbook75) parts.push('Open M-Book ≥ 75% Period');
    const billCats = normalizeFilterList(f.billCategory);
    if (billCats.length > 0) parts.push(`Bill Status: ${billCats.join(', ')}`);
    const acts = normalizeFilterList(f.activity);
    if (acts.length > 0) parts.push(`Activity: ${acts.join(', ')}`);
    const lacs = normalizeFilterList(f.constituency);
    if (lacs.length > 0) parts.push(`Constituency: ${lacs.join(', ')}`);
    const ctrs = normalizeFilterList(f.contractor);
    if (ctrs.length > 0) parts.push(`Contractor: ${ctrs.join(', ')}`);
    const scheds = normalizeFilterList(f.scheduleStatus);
    if (scheds.length > 0) parts.push(`Schedule: ${scheds.join(', ')}`);
    if (f.dateFrom || f.dateTo) {
      parts.push(`${f.dateField}: ${f.dateFrom || '...'} to ${f.dateTo || '...'}`);
    }
    if (f.search.trim()) parts.push(`Search: "${f.search.trim()}"`);
    if (regState.excludedKeys.size > 0) parts.push(`Excluded: ${regState.excludedKeys.size}`);
    return parts.join(' | ');
  }

  function exportSelectedCsv() {
    const exportCols = getEffectiveColumnsForView(
      regState.visibleColumns,
      regState.viewMode,
      regState.scope
    );
    const csvContent = generateCsvFromColumns(regState.sortedRows, exportCols, {
      viewMode: regState.viewMode,
      includeActivities: regState.includeActivitiesInExport,
      activityFilter: regState.filters.activity,
      excludedKeys: regState.excludedKeys,
    });
    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `price_register_${regState.viewMode}_${regState.scope}_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 5000);
  }

  function mountReportHtmlIntoDocument(targetDoc, html) {
    if (!targetDoc) return;
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const importedRoot = targetDoc.importNode(parsed.documentElement, true);
    if (targetDoc.documentElement) {
      targetDoc.replaceChild(importedRoot, targetDoc.documentElement);
    } else {
      targetDoc.appendChild(importedRoot);
    }
    const printBtn = targetDoc.getElementById('p3h-report-print-btn');
    if (printBtn && targetDoc.defaultView) {
      printBtn.addEventListener('click', () => targetDoc.defaultView.print());
    }
  }

  function openCustomReport() {
    const modal = document.getElementById('p3h-register-modal');
    const titleInput = modal ? modal.querySelector('#p3h-reg-report-title') : null;
    const title = (titleInput && titleInput.value.trim()) || 'PRICE 3.0 Project Register Report';
    const sortCol = Object.hasOwn(COLUMN_MAP, regState.sortKey)
      ? COLUMN_MAP[regState.sortKey]
      : null;
    const sortSummary = sortCol
      ? `${sortCol.label} (${regState.sortDir === 'desc' ? 'Descending' : 'Ascending'})`
      : 'Default';
    const reportCols = getEffectiveColumnsForView(
      regState.visibleColumns,
      regState.viewMode,
      regState.scope
    );

    const html = buildReportHtml({
      title,
      rows: regState.sortedRows,
      selectedKeys: reportCols,
      filterSummary: describeActiveFilters(),
      sortSummary,
      viewMode: regState.viewMode,
      includeActivities: regState.includeActivitiesInExport,
      activityFilter: regState.filters.activity,
      excludedKeys: regState.excludedKeys,
    });

    const win = window.open('', '_blank', 'width=1200,height=800');
    if (win) {
      try {
        win.opener = null;
      } catch (e) {
        // ignore
      }
      mountReportHtmlIntoDocument(win.document, html);
      return;
    }

    if (!document.body) return;
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    const frameDoc = iframe.contentDocument;
    const frameWin = iframe.contentWindow;
    if (!frameDoc || !frameWin) {
      iframe.remove();
      return;
    }
    mountReportHtmlIntoDocument(frameDoc, html);
    const cleanupIframe = () => {
      if (iframe.parentNode) iframe.remove();
    };
    const fallbackTimer = setTimeout(cleanupIframe, 60000);
    frameWin.addEventListener(
      'afterprint',
      () => {
        clearTimeout(fallbackTimer);
        cleanupIframe();
      },
      { once: true }
    );
    setTimeout(() => {
      try {
        frameWin.focus();
        frameWin.print();
      } catch (e) {
        clearTimeout(fallbackTimer);
        cleanupIframe();
      }
    }, 250);
  }

  function updateScopeCountBadges(modal, counts) {
    if (!modal || !counts) return;
    const activeSpan = modal.querySelector('[data-cnt="active"]');
    const archSpan = modal.querySelector('[data-cnt="archived"]');
    const manSpan = modal.querySelector('[data-cnt="manually_archived"]');
    const allSpan = modal.querySelector('[data-cnt="all"]');
    if (activeSpan) activeSpan.textContent = String(counts.activeCount || 0);
    if (archSpan) archSpan.textContent = String(counts.archivedCount || 0);
    if (manSpan) manSpan.textContent = String(counts.manualArchivedCount || 0);
    if (allSpan) allSpan.textContent = String(counts.totalCount || 0);

    modal.querySelectorAll('#p3h-reg-scopes [data-scope]').forEach((btn) => {
      btn.classList.toggle('p3h-active', btn.getAttribute('data-scope') === regState.scope);
    });
  }

  async function reloadScopeData() {
    const db = getDb();
    const [counts, rawWorks] = await Promise.all([
      db.getCounts(),
      db.getWorksByScope(regState.scope, {
        includePartialForActivities: regState.viewMode === 'activity',
      }),
    ]);
    regState.counts = counts;
    regState.rawWorks = rawWorks || [];

    const modal = document.getElementById('p3h-register-modal');
    if (modal) {
      updateScopeCountBadges(modal, counts);
      updateViewModeControls(modal);
    }

    rebuildRowsFromRaw();
  }

  async function open(options) {
    if (options && typeof options.onInspectWork === 'function') {
      regState.onInspectWork = options.onInspectWork;
    }
    if (options && typeof options.onDataUpdated === 'function') {
      regState.onDataUpdated = options.onDataUpdated;
    }
    if (options && typeof options.onDatabaseImported === 'function') {
      regState.onDatabaseImported = options.onDatabaseImported;
    }
    const modal = ensureModalDom();
    await loadUserPreferences();
    regState.isOpen = true;
    modal.classList.add('p3h-open');
    syncPreferencesToModalDom(modal);
    updateViewModeControls(modal);
    await reloadScopeData();
  }

  function clearExcludedKeys() {
    regState.excludedKeys.clear();
    regState.hideExcluded = false;
  }

  function close() {
    regState.isOpen = false;
    regState.rawWorks = [];
    regState.allRows = [];
    regState.filteredRows = [];
    regState.sortedRows = [];
    const modal = document.getElementById('p3h-register-modal');
    if (modal) {
      closeAllRegisterPopovers(modal);
      const dlgBackdrop = modal.querySelector('#p3h-ext-dialog-backdrop');
      if (dlgBackdrop) dlgBackdrop.style.display = 'none';
      const tbody = modal.querySelector('#p3h-reg-tbody');
      if (tbody) tbody.innerHTML = '';
      modal.classList.remove('p3h-open');
    }
  }

  async function refreshIfOpen() {
    if (!regState.isOpen) return;
    await reloadScopeData();
  }

  const registerApi = Object.freeze({
    COLUMNS,
    COLUMN_PRESETS,
    WORK_STATUS_PRESETS,
    buildRegisterRow,
    buildActivityRegisterRows,
    filterRegisterRows,
    sortRegisterRows,
    generateCsvFromColumns,
    buildReportHtml,
    renderDueDateProgressBadgeHtml,
    renderMilestoneTimelineHtml,
    getEffectiveColumnsForView,
    clearExcludedKeys,
    open,
    close,
    refreshIfOpen,
  });

  globalScope.__P3H__ = globalScope.__P3H__ || {};
  globalScope.__P3H__.register = registerApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = registerApi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
