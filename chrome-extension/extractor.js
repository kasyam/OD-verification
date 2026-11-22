/**
 * PRICE 3.0 Helper — Extractor, Parsers & Domain SSOT Engine
 *
 * Extracts work components, bills, M-Book status, AS/TS, Agreement/Contractor,
 * Negotiated Rate / Bidder details, Site Handover (SHO), Period & Constituency
 * from Kerala PWD PRICE 3.0.
 *
 * Preserves rotating price_token (GTOKEN) via sequential FIFO or wave-barrier batching.
 */
(function (globalScope) {
  'use strict';

  const db =
    globalScope.__P3H__ && globalScope.__P3H__.db
      ? globalScope.__P3H__.db
      : typeof require === 'function'
      ? require('./db.js')
      : null;

  const BASE_URL =
    typeof location !== 'undefined' &&
    location.origin &&
    /^https?:/i.test(location.origin)
      ? location.origin + '/price3_pwd/'
      : 'https://price3.kerala.gov.in/price3_pwd/';

  const EXTRACTOR_VERSION = 3;
  const POST_TIMEOUT_MS = 30000;

  const RE_CANCELLED_STATUS = /cancel|reject|discard|deleted/i;
  const RE_DRAFT_STATUS = /\bdraft\b/i;
  const RE_PRE_FINAL = /pre[\s_\-]*final/i;
  const RE_FINAL = /(?:^|[\s_\-/])final(?:$|[\s_\-/])|first\s*&\s*final|1st\s*&\s*final/i;
  const RE_PART = /(?:^|[\s_\-/])part(?:$|[\s_\-/]|\d)/i;
  const RE_COMPOSITE_FINAL_COMP = /composite\s+final/i;
  const RE_COMPOSITE_WORK_BILL = /composite[\s_\-]*work/i;
  const RE_DEACTIVATED_TEXT = /deactivat|cancel|discard/i;

  const isTerminalBillStatus = db
    ? db.isTerminalBillStatus
    : (status) => {
        const s = String(status || '').trim();
        if (!s) return false;
        return (
          /submitted\s+to\s+em[il]+i|submitted\s+for\s+payment\s*\(\s*non[\s\-]*em[il]+i\s*\)/i.test(
            s
          ) && !/\b(pending|draft|passed)\b/i.test(s)
        );
      };

  const isSafeKey = db
    ? db.isSafeKey
    : (k) => {
        const s = String(k || '').trim();
        return Boolean(s && s !== '__proto__' && s !== 'constructor' && s !== 'prototype');
      };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function cleanSingleLine(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const BLOCK_TEXT_TAGS = new Set([
    'BR',
    'DIV',
    'P',
    'LI',
    'TR',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BLOCKQUOTE',
    'PRE',
  ]);

  function cleanText(el) {
    if (!el) return '';
    const parts = [];
    const walk = (node) => {
      if (!node) return;
      if (typeof node === 'string') {
        parts.push(node);
        return;
      }
      if (node.nodeType === 3) {
        parts.push(node.nodeValue !== undefined ? node.nodeValue : node.textContent || '');
        return;
      }
      const tag = node.tagName ? String(node.tagName).toUpperCase() : '';
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      if (tag === 'BR') {
        parts.push('\n');
        return;
      }
      const isBlock = BLOCK_TEXT_TAGS.has(tag);
      if (isBlock && parts.length > 0) parts.push('\n');
      const childList =
        node.childNodes && node.childNodes.length
          ? node.childNodes
          : Array.isArray(node._orderedParts) && node._orderedParts.length
          ? node._orderedParts
          : node.children;
      if (childList && childList.length) {
        for (let i = 0; i < childList.length; i++) {
          walk(childList[i]);
        }
      } else if (node.textContent) {
        parts.push(node.textContent);
      }
      if (isBlock && parts.length > 0) parts.push('\n');
    };
    walk(el);
    return parts
      .join('')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/(?:\s*\n\s*)+/g, ' | ')
      .replace(/^(?:\s*\|\s*)+|(?:\s*\|\s*)+$/g, '')
      .trim();
  }

  function parseInr(val) {
    const num = db ? db.parseSafeNumber(val) : NaN;
    return Number.isFinite(num) ? num : 0;
  }

  function formatInr(num) {
    return (Number(num) || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function uniqArr(arr) {
    const seen = new Set();
    const out = [];
    (arr || []).forEach((item) => {
      if (!item || seen.has(item)) return;
      seen.add(item);
      out.push(item);
    });
    return out;
  }

  // -------------------------------------------------------------------------
  // Date Parsing, Exact Calendar Arithmetic & Site Handing Over (SHO) Rules
  // -------------------------------------------------------------------------

  function parseDmyDate(str) {
    const p = db ? db.parseDateParts(str) : null;
    if (!p) return null;
    return { year: p.year, month: p.month, day: p.day };
  }

  function formatDmyDate(parts) {
    if (!parts) return '';
    return (
      String(parts.day).padStart(2, '0') +
      '-' +
      String(parts.month).padStart(2, '0') +
      '-' +
      String(parts.year).padStart(4, '0')
    );
  }

  function normalizeDmyDate(str) {
    const parsed = parseDmyDate(str);
    return parsed ? formatDmyDate(parsed) : '';
  }

  function toIsoDate(dmyStr) {
    const p = parseDmyDate(dmyStr);
    if (!p) return '';
    return (
      String(p.year).padStart(4, '0') +
      '-' +
      String(p.month).padStart(2, '0') +
      '-' +
      String(p.day).padStart(2, '0')
    );
  }

  function dmyToUtcMs(dmyStr) {
    const p = parseDmyDate(dmyStr);
    if (!p) return null;
    return Date.UTC(p.year, p.month - 1, p.day);
  }

  function compareDmyDates(aStr, bStr) {
    const aMs = dmyToUtcMs(aStr);
    const bMs = dmyToUtcMs(bStr);
    if (aMs === null || bMs === null) return null;
    return aMs < bMs ? -1 : aMs > bMs ? 1 : 0;
  }

  function getTodayDmy(nowDate) {
    const d = nowDate instanceof Date ? nowDate : new Date();
    return formatDmyDate({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
    });
  }

  /**
   * Exact calendar addition: adds years and months first (clamping to month end,
   * e.g., 31-01-2026 + 1 month -> 28-02-2026), then adds days in UTC.
   */
  function addCalendarPeriod(dmyStr, period) {
    const p = parseDmyDate(dmyStr);
    if (!p) return '';
    const years = Math.max(0, parseInt((period && period.years) || 0, 10) || 0);
    const months = Math.max(0, parseInt((period && period.months) || 0, 10) || 0);
    const days = Math.max(0, parseInt((period && period.days) || 0, 10) || 0);

    const totalMonths = p.year * 12 + (p.month - 1) + years * 12 + months;
    const targetYear = Math.floor(totalMonths / 12);
    const targetMonthZero = totalMonths % 12;
    const maxDayInMonth = new Date(Date.UTC(targetYear, targetMonthZero + 1, 0)).getUTCDate();
    const clampedDay = Math.min(p.day, maxDayInMonth);

    const finalDt = new Date(Date.UTC(targetYear, targetMonthZero, clampedDay + days));
    return formatDmyDate({
      year: finalDt.getUTCFullYear(),
      month: finalDt.getUTCMonth() + 1,
      day: finalDt.getUTCDate(),
    });
  }

  function shiftDmyDays(dmyStr, deltaDays) {
    const p = parseDmyDate(dmyStr);
    if (!p) return '';
    const delta = parseInt(deltaDays || 0, 10) || 0;
    const dt = new Date(Date.UTC(p.year, p.month - 1, p.day + delta));
    return formatDmyDate({
      year: dt.getUTCFullYear(),
      month: dt.getUTCMonth() + 1,
      day: dt.getUTCDate(),
    });
  }

  function formatPeriodText(period) {
    const y = Math.max(0, parseInt((period && period.years) || 0, 10) || 0);
    const m = Math.max(0, parseInt((period && period.months) || 0, 10) || 0);
    const d = Math.max(0, parseInt((period && period.days) || 0, 10) || 0);
    const parts = [];
    if (y > 0) parts.push(`${y} ${y === 1 ? 'Year' : 'Years'}`);
    if (m > 0) parts.push(`${m} ${m === 1 ? 'Month' : 'Months'}`);
    if (d > 0) parts.push(`${d} ${d === 1 ? 'Day' : 'Days'}`);
    return parts.join(' ');
  }

  /**
   * PWD Handing Over Date Rule:
   * Earlier of "Contractor Signing Date" (or WCA handover <= deemed day) or 10th day after Agreement Date.
   * Fallback strictly to Site Handover card Closed/Initiated On (never Tender Opening Date).
   */
  function computeEffectiveShoDate({
    agreementDate,
    contractorSignedDate,
    wcaShoDate,
    referenceTodayDmy,
  }) {
    const agDate = normalizeDmyDate(agreementDate);
    const signedDate = normalizeDmyDate(contractorSignedDate);
    const normWca = normalizeDmyDate(wcaShoDate);
    const deemedShoDate = agDate ? addCalendarPeriod(agDate, { days: 10 }) : '';
    const todayDmy = normalizeDmyDate(referenceTodayDmy) || getTodayDmy();

    if (signedDate && deemedShoDate) {
      const cmp = compareDmyDates(signedDate, deemedShoDate);
      if (cmp !== null && cmp <= 0) {
        return {
          shoDate: signedDate,
          deemedShoDate,
        };
      }
      return {
        shoDate: deemedShoDate,
        deemedShoDate,
      };
    }

    if (signedDate) {
      return {
        shoDate: signedDate,
        deemedShoDate: '',
      };
    }

    if (deemedShoDate) {
      if (normWca) {
        const cmpWca = compareDmyDates(normWca, deemedShoDate);
        if (cmpWca !== null && cmpWca <= 0) {
          return {
            shoDate: normWca,
            deemedShoDate,
          };
        }
      }
      const cmpToday = compareDmyDates(todayDmy, deemedShoDate);
      if (cmpToday !== null && cmpToday >= 0) {
        return {
          shoDate: deemedShoDate,
          deemedShoDate,
        };
      }
      if (normWca) {
        return {
          shoDate: normWca,
          deemedShoDate,
        };
      }
      return {
        shoDate: '',
        deemedShoDate,
      };
    }

    if (normWca) {
      return {
        shoDate: normWca,
        deemedShoDate: '',
      };
    }

    return {
      shoDate: '',
      deemedShoDate: '',
    };
  }

  /**
   * Due / Agreement completion date excludes the anniversary/last day:
   * calendar calculated date minus 1 day (e.g., 24-10-2026 + 6m -> 23-04-2027).
   */
  function computeCompletionDate(shoDate, period) {
    const normSho = normalizeDmyDate(shoDate);
    if (!normSho || !period) return '';
    const y = Math.max(0, parseInt(period.years || 0, 10) || 0);
    const m = Math.max(0, parseInt(period.months || 0, 10) || 0);
    const d = Math.max(0, parseInt(period.days || 0, 10) || 0);
    if (y === 0 && m === 0 && d === 0) return '';
    const calEnd = addCalendarPeriod(normSho, { years: y, months: m, days: d });
    return shiftDmyDays(calEnd, -1);
  }

  function hasPositivePeriodTuple(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return (
      (parseInt(obj.periodYears || 0, 10) || 0) > 0 ||
      (parseInt(obj.periodMonths || 0, 10) || 0) > 0 ||
      (parseInt(obj.periodDays || 0, 10) || 0) > 0
    );
  }

  function resolveScheduleDates(pd, fallbackPd, referenceTodayDmy) {
    const primary = pd && typeof pd === 'object' ? pd : {};
    const fb = fallbackPd && typeof fallbackPd === 'object' ? fallbackPd : {};

    const usePrimaryPeriod = hasPositivePeriodTuple(primary);
    const useFallbackPeriod = !usePrimaryPeriod && hasPositivePeriodTuple(fb);
    const periodSource = usePrimaryPeriod ? primary : useFallbackPeriod ? fb : primary;

    const periodYears = Math.max(0, parseInt(periodSource.periodYears || 0, 10) || 0);
    const periodMonths = Math.max(0, parseInt(periodSource.periodMonths || 0, 10) || 0);
    const periodDays = Math.max(0, parseInt(periodSource.periodDays || 0, 10) || 0);
    const periodText =
      (usePrimaryPeriod ? primary.periodText : '') ||
      (useFallbackPeriod ? fb.periodText : '') ||
      primary.periodText ||
      fb.periodText ||
      formatPeriodText({ years: periodYears, months: periodMonths, days: periodDays });

    const agreementDate = primary.agreementDate || fb.agreementDate || '';
    const contractorSignedDate = primary.contractorSignedDate || fb.contractorSignedDate || '';
    const wcaShoDate = primary.wcaShoDate || fb.wcaShoDate || '';

    const storedShoDate = normalizeDmyDate(primary.shoDate || fb.shoDate || '');
    const effectiveWcaShoDate = wcaShoDate || (!contractorSignedDate ? storedShoDate : '');
    const calcSho =
      agreementDate || contractorSignedDate || effectiveWcaShoDate
        ? computeEffectiveShoDate({
            agreementDate,
            contractorSignedDate,
            wcaShoDate: effectiveWcaShoDate,
            referenceTodayDmy,
          })
        : { shoDate: '', deemedShoDate: '' };

    const shoDate = calcSho.shoDate || storedShoDate;
    const deemedShoDate = calcSho.deemedShoDate || primary.deemedShoDate || fb.deemedShoDate || '';

    const computedComp =
      shoDate && (periodYears > 0 || periodMonths > 0 || periodDays > 0)
        ? computeCompletionDate(shoDate, {
            years: periodYears,
            months: periodMonths,
            days: periodDays,
          })
        : '';
    const completionDate = computedComp || primary.completionDate || fb.completionDate || '';

    const periodDaysTotal = (() => {
      const sMs = dmyToUtcMs(shoDate);
      const cMs = dmyToUtcMs(completionDate);
      if (sMs === null || cMs === null || cMs < sMs) return null;
      return Math.round((cMs - sMs) / 86400000) + 1;
    })();

    return {
      periodYears,
      periodMonths,
      periodDays,
      periodText,
      agreementDate,
      contractorSignedDate,
      wcaShoDate,
      deemedShoDate,
      shoDate,
      completionDate,
      periodDaysTotal,
    };
  }

  function computeScheduleStatus(
    completionDate,
    hasFinal,
    referenceTodayDmy,
    extendedCompletionDate
  ) {
    const normExt = normalizeDmyDate(extendedCompletionDate);
    const normOrig = normalizeDmyDate(completionDate);
    const isExtended = Boolean(normExt);
    const effectiveDate = normExt || normOrig;

    if (hasFinal) {
      return {
        key: 'completed',
        label: 'Finalized',
        daysDelta: null,
        effectiveDate,
        isExtended,
      };
    }
    const compMs = dmyToUtcMs(effectiveDate);
    if (compMs === null) {
      return {
        key: 'no_date',
        label: 'No SHO / Period',
        daysDelta: null,
        effectiveDate: '',
        isExtended,
      };
    }
    const todayMs = dmyToUtcMs(normalizeDmyDate(referenceTodayDmy) || getTodayDmy());
    const diffDays = Math.round((compMs - todayMs) / 86400000);
    const extSuffix = isExtended ? ' (Ext)' : '';
    if (diffDays < 0) {
      return {
        key: 'overdue',
        label: `Overdue (${Math.abs(diffDays)}d)${extSuffix}`,
        daysDelta: diffDays,
        effectiveDate,
        isExtended,
      };
    }
    return {
      key: 'ongoing',
      label: (diffDays === 0 ? 'Due Today' : `Due in ${diffDays}d`) + extSuffix,
      daysDelta: diffDays,
      effectiveDate,
      isExtended,
    };
  }

  // -------------------------------------------------------------------------
  // Financial Status (Tender Variation / Adjusted TS) & Period Elapsed Engine
  // -------------------------------------------------------------------------

  function parseNegotiatedRatePct(raw) {
    const s = cleanSingleLine(raw);
    if (!s || /^[-—]+$/i.test(s) || /^n\/?a$/i.test(s)) return null;
    if (/\bat\s*(?:par|estimate\s*rate)\b/i.test(s)) return 0;

    const parenSign = s.match(/\(\s*([+-])\s*\)\s*(\d+(?:\.\d+)?)/);
    if (parenSign) {
      const val = parseFloat(parenSign[2]);
      if (!Number.isFinite(val)) return null;
      return val === 0 ? 0 : parenSign[1] === '-' ? -val : val;
    }

    const trailingSign = s.match(/(\d+(?:\.\d+)?)\s*%?\s*\(\s*([+-])\s*\)/);
    if (trailingSign) {
      const val = parseFloat(trailingSign[1]);
      if (!Number.isFinite(val)) return null;
      return val === 0 ? 0 : trailingSign[2] === '-' ? -val : val;
    }

    const numMatch = s.match(/([+-]?\s*\d+(?:\.\d+)?)/);
    if (!numMatch) return null;
    const val = parseFloat(numMatch[1].replace(/\s+/g, ''));
    if (!Number.isFinite(val)) return null;
    if (val === 0) return 0;
    if (/\b(?:below|less|deduct|rebate)\b/i.test(s)) return -Math.abs(val);
    if (/\b(?:above|excess|plus)\b/i.test(s)) return Math.abs(val);
    return val;
  }

  function computeAdjustedTsAmount({ tsAmount, negotiatedRate, agreedPac, estimatePac }) {
    const tsAmountNum = parseInr(tsAmount);
    const agreedPacNum = parseInr(agreedPac);
    const estimatePacNum = parseInr(estimatePac);
    const negotiatedRatePct = parseNegotiatedRatePct(negotiatedRate);

    let adjustedTsAmount = null;
    let basis = 'none';
    if (tsAmountNum > 0 && negotiatedRatePct !== null) {
      adjustedTsAmount = Math.round(tsAmountNum * (1 + negotiatedRatePct / 100) * 100) / 100;
      basis = 'ts_adjusted';
    } else if (tsAmountNum > 0 && estimatePacNum > 0 && agreedPacNum > 0) {
      adjustedTsAmount = Math.round(tsAmountNum * (agreedPacNum / estimatePacNum) * 100) / 100;
      basis = 'ts_pac_ratio';
    } else if (tsAmountNum > 0) {
      adjustedTsAmount = Math.round(tsAmountNum * 100) / 100;
      basis = 'ts_unadjusted';
    } else if (agreedPacNum > 0) {
      adjustedTsAmount = Math.round(agreedPacNum * 100) / 100;
      basis = 'agreed_pac_fallback';
    }

    return {
      tsAmountNum: tsAmountNum > 0 ? tsAmountNum : null,
      negotiatedRatePct,
      adjustedTsAmount,
      basis,
    };
  }

  function computeFinancialStatus(billedAmount, tsInputs) {
    const tsInfo = computeAdjustedTsAmount(tsInputs || {});
    const billed = Number(billedAmount) > 0 ? Math.round(Number(billedAmount) * 100) / 100 : 0;
    const pct =
      tsInfo.adjustedTsAmount > 0
        ? Math.round((billed / tsInfo.adjustedTsAmount) * 1000) / 10
        : null;
    return {
      billedAmount: billed,
      adjustedTsAmount: tsInfo.adjustedTsAmount,
      tsAmountNum: tsInfo.tsAmountNum,
      negotiatedRatePct: tsInfo.negotiatedRatePct,
      basis: tsInfo.basis,
      pct,
    };
  }

  function computeWorkFinancialStatus(workRecord, summary) {
    const sum = summary || analyzeWorkRecord(workRecord);
    const pd = (workRecord && workRecord.projectDetails) || {};
    const acts = sum.activities || [];
    const totalActiveAmount = Number(sum.totalActiveAmount) || 0;

    if (acts.length <= 1) {
      const actPd = (acts[0] && acts[0].details) || pd;
      return computeFinancialStatus(totalActiveAmount, {
        tsAmount: actPd.tsAmount || pd.tsAmount,
        negotiatedRate: actPd.negotiatedRate || pd.negotiatedRate,
        agreedPac: actPd.agreedPac || pd.agreedPac,
        estimatePac: actPd.estimatePac || pd.estimatePac,
      });
    }

    const activeActs = acts.filter((a) => !a.isManuallyArchived);
    const pool = activeActs.length > 0 ? activeActs : acts;
    const isCompositeWork = Boolean(sum.isCompositeWork);
    const seenGroups = new Set();
    let distinctAdjustedTsSum = 0;
    let everyNonCompHasOwn = true;

    for (let i = 0; i < pool.length; i++) {
      const a = pool[i];
      const actPd = a.details || null;
      const isComp = Boolean(
        a.isCompositeFinal || a.isCompositeGroupMember || a.isCompositeSibling
      );
      if (isComp) {
        const gk = String(a.workGroup || '__default__').toLowerCase();
        if (seenGroups.has(gk)) continue;
        const fin = computeFinancialStatus(0, {
          tsAmount: (actPd && actPd.tsAmount) || pd.tsAmount,
          negotiatedRate: (actPd && actPd.negotiatedRate) || pd.negotiatedRate,
          agreedPac: (actPd && actPd.agreedPac) || pd.agreedPac,
          estimatePac: (actPd && actPd.estimatePac) || pd.estimatePac,
        });
        if (fin.adjustedTsAmount !== null && fin.adjustedTsAmount > 0) {
          seenGroups.add(gk);
          distinctAdjustedTsSum += fin.adjustedTsAmount;
        }
      } else {
        const hasOwn = Boolean(
          actPd && (parseInr(actPd.tsAmount) > 0 || parseInr(actPd.agreedPac) > 0)
        );
        if (!hasOwn) {
          everyNonCompHasOwn = false;
        } else {
          const fin = computeFinancialStatus(0, {
            tsAmount: actPd.tsAmount,
            negotiatedRate: actPd.negotiatedRate || pd.negotiatedRate,
            agreedPac: actPd.agreedPac,
            estimatePac: actPd.estimatePac || pd.estimatePac,
          });
          if (fin.adjustedTsAmount !== null && fin.adjustedTsAmount > 0) {
            distinctAdjustedTsSum += fin.adjustedTsAmount;
          }
        }
      }
    }

    if (everyNonCompHasOwn && distinctAdjustedTsSum > 0 && (!isCompositeWork || seenGroups.size > 0)) {
      const adj = Math.round(distinctAdjustedTsSum * 100) / 100;
      const billed = totalActiveAmount > 0 ? Math.round(totalActiveAmount * 100) / 100 : 0;
      const pct = adj > 0 ? Math.round((billed / adj) * 1000) / 10 : null;
      return {
        billedAmount: billed,
        adjustedTsAmount: adj,
        tsAmountNum: null,
        negotiatedRatePct: parseNegotiatedRatePct(pd.negotiatedRate),
        basis: isCompositeWork ? 'composite_group_sum' : 'multi_activity_sum',
        pct,
      };
    }

    return computeFinancialStatus(totalActiveAmount, {
      tsAmount: pd.tsAmount,
      negotiatedRate: pd.negotiatedRate,
      agreedPac: pd.agreedPac,
      estimatePac: pd.estimatePac,
    });
  }

  function pickLatestBill(bills) {
    if (!Array.isArray(bills) || bills.length === 0) return null;
    let best = bills[0];
    let bestIso = toIsoDate(best.initiatedOn);
    let bestRowNo = Number(best.billRowNo) || 0;
    for (let i = 1; i < bills.length; i++) {
      const cur = bills[i];
      const curIso = toIsoDate(cur.initiatedOn);
      const curRowNo = Number(cur.billRowNo) || 0;
      if (curIso && bestIso) {
        if (curIso > bestIso || (curIso === bestIso && curRowNo >= bestRowNo)) {
          best = cur;
          bestIso = curIso;
          bestRowNo = curRowNo;
        }
      } else if (curIso && !bestIso) {
        best = cur;
        bestIso = curIso;
        bestRowNo = curRowNo;
      } else if (!curIso && !bestIso) {
        best = cur;
        bestRowNo = curRowNo;
      }
    }
    return best;
  }

  /**
   * Computes elapsed % against the Agreement Period (SHO Date -> Agreement Completion Date).
   * Shown ONLY for active unfinalized components whose M-Book is not closed.
   * Scale: 0%..150% with zones: <=50% green, <=75% yellow, <=100% orange, >100% red.
   */
  function computePeriodProgress({
    shoDate,
    completionDate,
    isFinalized,
    isManuallyArchived,
    isMbookClosed,
    referenceTodayDmy,
  }) {
    if (isFinalized || isManuallyArchived || isMbookClosed) return null;
    const shoMs = dmyToUtcMs(shoDate);
    const compMs = dmyToUtcMs(completionDate);
    if (shoMs === null || compMs === null || compMs < shoMs) return null;

    const todayMs = dmyToUtcMs(normalizeDmyDate(referenceTodayDmy) || getTodayDmy());
    const rawSpanDays = Math.round((compMs - shoMs) / 86400000);
    const totalDays = rawSpanDays > 0 ? rawSpanDays : 1;
    let elapsedDays = 0;
    if (todayMs > shoMs) {
      elapsedDays = Math.round((todayMs - shoMs) / 86400000);
    }

    const pct = Math.round((elapsedDays / totalDays) * 1000) / 10;
    const remainingPct = pct <= 100 ? Math.round((100 - pct) * 10) / 10 : 0;
    const excessPct = pct > 100 ? Math.round((pct - 100) * 10) / 10 : 0;
    const barFillPct =
      Math.round(Math.min(100, (Math.min(150, Math.max(0, pct)) / 150) * 100) * 10) / 10;
    const zone = pct <= 50 ? 'green' : pct <= 75 ? 'yellow' : pct <= 100 ? 'orange' : 'red';
    const reached75 = pct >= 75;
    const shortLabel = pct > 100 ? `${pct}% (+${excessPct}%)` : `${pct}%`;
    const detailLabel =
      pct > 100 ? `${pct}% elapsed (+${excessPct}% excess)` : `${pct}% elapsed (${remainingPct}% left)`;

    return {
      pct,
      remainingPct,
      excessPct,
      totalDays,
      elapsedDays,
      barFillPct,
      zone,
      reached75,
      shortLabel,
      detailLabel,
    };
  }

  // -------------------------------------------------------------------------
  // Token Management & Wave-Barrier HTTP Client
  // -------------------------------------------------------------------------

  let bridgeReqSeq = 0;
  let lastKnownToken = '';
  let waveQueue = Promise.resolve();

  function syncBridgeCall(action, payload) {
    if (
      typeof importScripts === 'function' ||
      typeof document === 'undefined' ||
      typeof CustomEvent === 'undefined'
    ) {
      return { bridged: false, ok: false, result: null };
    }
    const reqId = `p3h_${++bridgeReqSeq}`;
    let handled = false;
    let out = null;
    const onRes = (ev) => {
      try {
        const data = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : ev.detail;
        if (!data || data.id !== reqId) return;
        handled = true;
        out = data;
      } catch (_e) {}
    };
    document.addEventListener('p3h:bridge:res', onRes);
    try {
      document.dispatchEvent(
        new CustomEvent('p3h:bridge:req', {
          detail: JSON.stringify({ id: reqId, action, payload: payload || null }),
        })
      );
    } finally {
      document.removeEventListener('p3h:bridge:res', onRes);
    }
    return handled && out ? { bridged: true, ...out } : { bridged: false, ok: false, result: null };
  }

  function getToken() {
    const res = syncBridgeCall('getToken');
    if (res.bridged && res.ok && typeof res.result === 'string' && res.result.trim()) {
      lastKnownToken = res.result.trim();
      return lastKnownToken;
    }
    if (typeof globalScope.GTOKEN === 'string' && globalScope.GTOKEN.trim()) {
      return globalScope.GTOKEN.trim();
    }
    if (typeof document !== 'undefined') {
      const gtokenEl = document.getElementById('gtoken');
      if (gtokenEl && typeof gtokenEl.value === 'string' && gtokenEl.value.trim()) {
        return gtokenEl.value.trim();
      }
      const inp = document.querySelector('input[name="price_token"]');
      if (inp && inp.value && String(inp.value).trim()) return String(inp.value).trim();
    }
    return lastKnownToken;
  }

  function setToken(tok) {
    if (!tok || typeof tok !== 'string') return;
    const t = tok.trim();
    if (!t) return;
    lastKnownToken = t;
    if (typeof document !== 'undefined') {
      const gtokenEl = document.getElementById('gtoken');
      if (gtokenEl && 'value' in gtokenEl) {
        gtokenEl.value = t;
      }
      document.querySelectorAll('input[name="price_token"]').forEach((inp) => {
        inp.value = t;
      });
    }
    const br = syncBridgeCall('setToken', { token: t });
    if (!br.bridged) {
      globalScope.GTOKEN = t;
    }
  }

  function extractTokensFromResponse(res, htmlText) {
    let headerToken = '';
    if (res && res.headers) {
      const hdr =
        res.headers.get('price_token') ||
        res.headers.get('Price_token') ||
        res.headers.get('PRICE_TOKEN');
      if (hdr && hdr.trim()) headerToken = hdr.trim();
    }
    let htmlToken = '';
    let jsonToken = '';
    const text = typeof htmlText === 'string' ? htmlText : '';
    const trimmed = text.trim();
    if (trimmed && trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.token === 'string' && parsed.token.trim()) {
          jsonToken = parsed.token.trim();
        }
      } catch (_e) {}
    }
    if (text) {
      const m = text.match(/GTOKEN\s*=\s*['"]([^'"]+)['"]/);
      if (m && m[1]) {
        htmlToken = m[1].trim();
      } else {
        const mInput =
          text.match(
            /<input[^>]*\bname=["']price_token["'][^>]*\bvalue=["']([^"']+)["']/i
          ) ||
          text.match(
            /<input[^>]*\bvalue=["']([^"']+)["'][^>]*\bname=["']price_token["']/i
          ) ||
          text.match(/<input[^>]*\bid=["']gtoken["'][^>]*\bvalue=["']([^"']+)["']/i) ||
          text.match(/<input[^>]*\bvalue=["']([^"']+)["'][^>]*\bid=["']gtoken["']/i);
        if (mInput && mInput[1]) htmlToken = mInput[1].trim();
      }
    }
    return { headerToken, htmlToken, jsonToken };
  }

  function extractTokenFromResponse(res, htmlText) {
    const tokens = extractTokensFromResponse(res, htmlText);
    return tokens.htmlToken || tokens.jsonToken || tokens.headerToken || '';
  }

  function resolveWaveWinningToken(outcomes) {
    if (!Array.isArray(outcomes) || outcomes.length === 0) return '';
    const valid = outcomes
      .filter((o) => o && o.ok && o.tokens)
      .slice()
      .sort((a, b) => (b.finishedSeq || 0) - (a.finishedSeq || 0));
    for (let i = 0; i < valid.length; i++) {
      const tok = valid[i].tokens.htmlToken || valid[i].tokens.jsonToken;
      if (tok) return tok;
    }
    for (let i = 0; i < valid.length; i++) {
      if (valid[i].tokens.headerToken) return valid[i].tokens.headerToken;
    }
    return '';
  }

  function isJsonSessionExpiredPayload(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    try {
      const obj = JSON.parse(trimmed);
      return Boolean(obj && typeof obj.status === 'string' && obj.status.trim().toUpperCase() === 'A');
    } catch (_e) {
      return false;
    }
  }

  function isTransientHttpStatus(status) {
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  async function executeSinglePost(endpoint, params, isAjax, callerSignal, opts) {
    const options = opts || {};
    const tokenOverride =
      typeof options.tokenOverride === 'string' ? options.tokenOverride.trim() : '';
    const skipTokenWrite = Boolean(options.skipTokenWrite);
    const maxRetries = typeof options.retries === 'number' ? Math.max(0, options.retries) : 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (callerSignal && callerSignal.aborted) {
        throw new Error('ABORTED');
      }
      const token = tokenOverride || getToken();
      if (!token) throw new Error('NO_TOKEN');

      const form = new URLSearchParams();
      form.append('price_token', token);
      Object.keys(params || {}).forEach((k) => {
        if (params[k] !== undefined && params[k] !== null) {
          form.append(k, String(params[k]));
        }
      });

      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        price_token: token,
      };
      if (isAjax) headers['X-Requested-With'] = 'XMLHttpRequest';

      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timedOut = false;
      const timer = controller
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, POST_TIMEOUT_MS)
        : null;
      const onCallerAbort = controller && callerSignal ? () => controller.abort() : null;
      if (onCallerAbort) callerSignal.addEventListener('abort', onCallerAbort, { once: true });

      try {
        const res = await fetch(BASE_URL + endpoint, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: form.toString(),
          ...(controller ? { signal: controller.signal } : {}),
        });
        const text = await res.text();
        if (callerSignal && callerSignal.aborted) {
          throw new Error('ABORTED');
        }

        const tokens = extractTokensFromResponse(res, text);
        const bestToken = tokens.htmlToken || tokens.jsonToken || tokens.headerToken || '';

        const hasPortalMarkers =
          /pt-file_table_list|pt-side-menu-full|id=["']pt-info["']|id=["']pt-heading["']/i.test(
            text
          );
        if (
          (res.url && /login(\.do|\.pro|\b)/i.test(res.url)) ||
          isJsonSessionExpiredPayload(text) ||
          (!hasPortalMarkers &&
            (/Session\s*Expired|Invalid\s*Session|Invalid\s*Token|Please\s*Login/i.test(text) ||
              /<input[^>]+type=["']password["']/i.test(text)))
        ) {
          throw new Error('SESSION_EXPIRED');
        }
        if (!res.ok) {
          if (!skipTokenWrite && bestToken) setToken(bestToken);
          const httpErr = new Error('HTTP_' + res.status);
          httpErr.isTransient = isTransientHttpStatus(res.status);
          httpErr.statusCode = res.status;
          throw httpErr;
        }
        if (!skipTokenWrite && bestToken) setToken(bestToken);
        return { text, tokens, status: res.status };
      } catch (err) {
        if (callerSignal && callerSignal.aborted) {
          throw new Error('ABORTED');
        }
        if (err && (err.message === 'SESSION_EXPIRED' || err.message === 'NO_TOKEN' || err.message === 'ABORTED')) {
          throw err;
        }
        let wrapped = err;
        if (timedOut) {
          wrapped = new Error('TIMEOUT');
          wrapped.isTransient = true;
        } else if (!(wrapped && typeof wrapped.statusCode === 'number')) {
          const netErr = new Error(
            (wrapped && wrapped.message ? wrapped.message : String(wrapped)) || 'NETWORK_ERROR'
          );
          netErr.isTransient = true;
          wrapped = netErr;
        }
        if (wrapped.isTransient && attempt < maxRetries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw wrapped;
      } finally {
        if (timer !== null) clearTimeout(timer);
        if (onCallerAbort && callerSignal) {
          callerSignal.removeEventListener('abort', onCallerAbort);
        }
      }
    }
  }

  function enqueueOnWaveQueue(fn) {
    const run = waveQueue.then(fn);
    waveQueue = run.catch(() => {});
    return run;
  }

  function postForm(endpoint, params, isAjax, callerSignal) {
    return enqueueOnWaveQueue(async () => {
      const res = await executeSinglePost(endpoint, params, isAjax, callerSignal, {
        skipTokenWrite: false,
        retries: 1,
      });
      return res.text;
    });
  }

  function makeRequestKey(endpoint, params, explicitKey) {
    if (explicitKey) return String(explicitKey);
    const p = params && typeof params === 'object' ? params : {};
    const sorted = {};
    Object.keys(p)
      .sort()
      .forEach((k) => {
        if (p[k] !== undefined && p[k] !== null) sorted[k] = p[k];
      });
    return endpoint + '|' + JSON.stringify(sorted);
  }

  function isWaveRetryableError(err) {
    if (!err) return false;
    if (err.isTransient) return true;
    const msg = err.message || String(err);
    return /^(?:TIMEOUT|PORTAL_ERROR_HTML|HTTP_(?:429|5\d\d))$/.test(msg);
  }

  function postBatchWave(reqSpecs, options) {
    const opts = options || {};
    const signal = opts.signal;
    const waveSize = Math.max(1, Math.min(12, parseInt(opts.concurrency, 10) || 6));
    const delayMs = typeof opts.delayMs === 'number' && opts.delayMs >= 0 ? opts.delayMs : 0;
    const retries = typeof opts.retries === 'number' ? Math.max(0, opts.retries) : 1;

    return enqueueOnWaveQueue(async () => {
      const resultsByKey = new Map();
      const errorsByKey = new Map();
      if (!Array.isArray(reqSpecs) || reqSpecs.length === 0) {
        return { resultsByKey, errorsByKey };
      }

      const uniqueSpecs = [];
      const seenKeys = new Set();
      for (let i = 0; i < reqSpecs.length; i++) {
        const s = reqSpecs[i];
        if (!s || !s.endpoint) continue;
        const key = makeRequestKey(s.endpoint, s.params, s.key);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        uniqueSpecs.push({
          key,
          endpoint: s.endpoint,
          params: s.params || {},
          isAjax: s.isAjax !== false,
          validatePortalHtml: s.validatePortalHtml !== false,
        });
      }

      const retrySpecs = [];
      let seqCounter = 0;

      for (let offset = 0; offset < uniqueSpecs.length; offset += waveSize) {
        if (signal && signal.aborted) {
          throw new Error('ABORTED');
        }
        if (waveSize === 1 && delayMs > 0 && offset > 0) {
          await sleep(delayMs);
        }
        const chunk = uniqueSpecs.slice(offset, offset + waveSize);
        const waveToken = getToken();
        if (!waveToken) throw new Error('NO_TOKEN');

        const outcomes = new Array(chunk.length);
        await Promise.allSettled(
          chunk.map(async (spec, idx) => {
            try {
              const res = await executeSinglePost(
                spec.endpoint,
                spec.params,
                spec.isAjax,
                signal,
                waveSize > 1
                  ? { tokenOverride: waveToken, skipTokenWrite: true, retries: 0 }
                  : { skipTokenWrite: false, retries }
              );
              outcomes[idx] = {
                spec,
                ok: true,
                finishedSeq: ++seqCounter,
                text: res.text,
                tokens: res.tokens,
              };
            } catch (err) {
              outcomes[idx] = {
                spec,
                ok: false,
                finishedSeq: ++seqCounter,
                error: err,
              };
            }
          })
        );

        let fatalAuthErr = null;
        let sawAbort = Boolean(signal && signal.aborted);
        for (let i = 0; i < outcomes.length; i++) {
          const o = outcomes[i];
          if (o && !o.ok && o.error) {
            const m = o.error.message || '';
            if (m === 'SESSION_EXPIRED' || m === 'NO_TOKEN') {
              fatalAuthErr = o.error;
              break;
            }
            if (m === 'ABORTED') sawAbort = true;
          }
        }
        if (fatalAuthErr) {
          throw fatalAuthErr;
        }
        if (waveSize > 1) {
          const winTok = resolveWaveWinningToken(outcomes);
          if (winTok) setToken(winTok);
        }
        if (sawAbort) {
          throw new Error('ABORTED');
        }

        for (let i = 0; i < outcomes.length; i++) {
          const o = outcomes[i];
          if (!o) continue;
          if (o.ok) {
            if (o.spec.validatePortalHtml && isPortalErrorHtml(o.text)) {
              if (waveSize > 1) {
                retrySpecs.push(o.spec);
              } else {
                errorsByKey.set(o.spec.key, new Error('PORTAL_ERROR_HTML'));
              }
            } else {
              resultsByKey.set(o.spec.key, o.text);
            }
          } else if (waveSize > 1 && isWaveRetryableError(o.error)) {
            retrySpecs.push(o.spec);
          } else {
            errorsByKey.set(
              o.spec.key,
              o.error || new Error('Request failed for ' + o.spec.endpoint)
            );
          }
        }
      }

      if (retrySpecs.length > 0) {
        for (let i = 0; i < retrySpecs.length; i++) {
          if (signal && signal.aborted) {
            throw new Error('ABORTED');
          }
          await sleep(200);
          const spec = retrySpecs[i];
          try {
            const res = await executeSinglePost(spec.endpoint, spec.params, spec.isAjax, signal, {
              skipTokenWrite: false,
              retries,
            });
            if (spec.validatePortalHtml && isPortalErrorHtml(res.text)) {
              errorsByKey.set(spec.key, new Error('PORTAL_ERROR_HTML'));
            } else {
              resultsByKey.set(spec.key, res.text);
            }
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            if (msg === 'SESSION_EXPIRED' || msg === 'NO_TOKEN' || msg === 'ABORTED') {
              throw err;
            }
            errorsByKey.set(spec.key, err);
          }
        }
      }

      return { resultsByKey, errorsByKey };
    });
  }

  // -------------------------------------------------------------------------
  // Error Detection, Activity Name Helpers & HTML Parsers (Pure & Testable)
  // -------------------------------------------------------------------------

  function isPortalErrorHtml(html) {
    const s = String(html || '').trim();
    if (!s) return true;
    const hasKnownMarkers =
      /pt-side-menu-full|pt-file_table_list|pt-specifications|pt-history_table|pd-attachment-table|durationYear|assemblyConstituencyCode|agreementNo|tsNumber|Administrative\s*Sanction|Site\s*Handover|MBook|activate_mbook/i.test(
        s
      );
    if (
      !hasKnownMarkers &&
      /Oops!\s*Something\s*went\s*wrong|Page\s*Exception|Ajax\s*Exception|HTTP\s*Status\s*(?:404|500)/i.test(
        s
      )
    ) {
      return true;
    }
    return false;
  }

  function extractActivityName(label) {
    return cleanSingleLine(String(label || '').replace(/\s*\[[^\]]*\]\s*$/, ''));
  }

  const extractEstimateCode = db
    ? db.extractEstimateCode
    : (label) => {
        const matches = Array.from(String(label || '').matchAll(/\[\s*([A-Za-z0-9_/\-]+)\s*\]/g));
        return matches.length > 0 ? matches[matches.length - 1][1].trim() : '';
      };

  function isHelperActivity(activityName, componentLabel) {
    const s = String(activityName || componentLabel || '').trim();
    return /^(?:composite\s+primary\s+component|investigation\b)/i.test(s);
  }

  const getActivityKey = db
    ? db.getActivityKey
    : (comp) => {
        if (!comp) return '';
        return String(
          comp.activityKey ||
            comp.estimateCode ||
            extractEstimateCode(comp.componentLabel) ||
            comp.estmainid ||
            comp.mbookActivityId ||
            comp.componentLabel ||
            ''
        ).trim();
      };

  let cachedDomParser = null;
  function parseHtmlString(html) {
    if (typeof DOMParser !== 'undefined') {
      if (!cachedDomParser) cachedDomParser = new DOMParser();
      return cachedDomParser.parseFromString(String(html || ''), 'text/html');
    }
    throw new Error('DOMParser is unavailable in this environment');
  }

  function getDirectLabelText(li, cache) {
    if (!li) return '';
    if (cache && cache.has(li)) return cache.get(li);
    let out = '';
    const children = li.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const tag = child.tagName ? child.tagName.toUpperCase() : '';
      if (
        tag === 'A' ||
        tag === 'SPAN' ||
        tag === 'DIV' ||
        tag === 'P' ||
        tag === 'LABEL' ||
        tag === 'DEL' ||
        tag === 'S' ||
        tag === 'STRIKE'
      ) {
        const txt = cleanSingleLine(child.textContent);
        if (txt) {
          out = txt;
          break;
        }
      }
    }
    if (!out) {
      const parts = [];
      const nodes =
        li.childNodes && li.childNodes.length
          ? li.childNodes
          : Array.isArray(li._orderedParts) && li._orderedParts.length
          ? li._orderedParts
          : children;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (typeof n === 'string') {
          parts.push(n);
        } else if (n && n.nodeType === 3) {
          parts.push(n.nodeValue !== undefined ? n.nodeValue : n.textContent || '');
        } else if (n && n.tagName) {
          const t = String(n.tagName).toUpperCase();
          if (t !== 'UL' && t !== 'OL') {
            parts.push(n.textContent || '');
          }
        }
      }
      out = cleanSingleLine(parts.join(' '));
    }
    if (cache) cache.set(li, out);
    return out;
  }

  function getSelectedOptionText(selectEl, rawHtml, selectorIdOrName) {
    if (!selectEl) return '';
    const opts = Array.from(selectEl.querySelectorAll('option'));
    let chosen = opts.find((o) => o.hasAttribute && o.hasAttribute('selected'));

    if (!chosen && rawHtml && selectorIdOrName) {
      const escaped = selectorIdOrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(
          `['"]#${escaped}['"]\\s*\\)\\s*\\.\\s*val\\(\\s*['"]?([^'")]+?)['"]?\\s*\\)`,
          'i'
        ),
        new RegExp(
          `['"][^'"]*name=['"]?${escaped}['"]?[^'"]*['"]\\s*\\)\\s*\\.\\s*val\\(\\s*['"]?([^'")]+?)['"]?\\s*\\)`,
          'i'
        ),
        new RegExp(
          `getElementById\\(\\s*['"]${escaped}['"]\\s*\\)\\s*\\.\\s*value\\s*=\\s*['"]?([^'";\\s]+)['"]?`,
          'i'
        ),
      ];
      for (let i = 0; i < patterns.length; i++) {
        const m = String(rawHtml).match(patterns[i]);
        if (m && m[1]) {
          const targetVal = m[1].trim();
          chosen = opts.find((o) => (o.getAttribute('value') || '') === targetVal);
          if (chosen) break;
        }
      }
    }

    const txt = chosen ? cleanSingleLine(chosen.textContent) : '';
    if (!txt || /^(-*\s*select\s*-*|--\s*choose\s*--|day|month|year)$/i.test(txt)) return '';
    return txt;
  }

  function extractArgsFromOnclick(onclickStr, fnName) {
    const src = String(onclickStr || '');
    const fnRe = new RegExp('\\b' + fnName + '\\s*\\(', 'i');
    const fnMatch = fnRe.exec(src);
    if (!fnMatch) return null;
    let idx = fnMatch.index + fnMatch[0].length;
    const args = [];
    let current = '';
    let quoteChar = '';
    let wasQuoted = false;
    let quoteClosed = false;
    let parenDepth = 0;

    for (; idx < src.length; idx++) {
      const ch = src[idx];
      if (quoteChar) {
        if (ch === '\\' && idx + 1 < src.length) {
          current += src[idx + 1];
          idx++;
          continue;
        }
        if (ch === quoteChar) {
          quoteChar = '';
          quoteClosed = true;
          continue;
        }
        current += ch;
        continue;
      }
      if (quoteClosed) {
        if (/\s/.test(ch)) continue;
        quoteClosed = false;
      }
      if (ch === '"' || ch === "'") {
        if (current.trim() === '' && !wasQuoted) {
          current = '';
        }
        quoteChar = ch;
        wasQuoted = true;
        continue;
      }
      if (ch === '(') {
        parenDepth++;
        current += ch;
        continue;
      }
      if (ch === ')') {
        if (parenDepth === 0) {
          if (current.trim() !== '' || wasQuoted || args.length > 0) {
            args.push(wasQuoted ? current : current.trim());
          }
          break;
        }
        parenDepth--;
        current += ch;
        continue;
      }
      if (ch === ',' && parenDepth === 0) {
        args.push(wasQuoted ? current : current.trim());
        current = '';
        wasQuoted = false;
        quoteClosed = false;
        continue;
      }
      current += ch;
    }
    return args.length > 0 ? args : null;
  }

  function hasDeactivatedMarkerEl(el) {
    if (!el || !el.getAttribute) return false;
    const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return true;
    if (el.hasAttribute && el.hasAttribute('disabled')) return true;
    const cls = el.getAttribute('class') || '';
    const title = el.getAttribute('title') || '';
    const style = el.getAttribute('style') || '';
    const dataStatus = el.getAttribute('data-status') || '';
    return (
      /deactivat|inactive/i.test(`${cls} ${title} ${dataStatus}`) ||
      /line-through/i.test(style)
    );
  }

  function hasDeactivatedInSubtreeHeader(rootEl) {
    if (!rootEl) return false;
    if (hasDeactivatedMarkerEl(rootEl)) return true;
    const stack = Array.from(rootEl.children || []);
    while (stack.length > 0) {
      const node = stack.pop();
      const tag = node && node.tagName ? String(node.tagName).toUpperCase() : '';
      if (tag === 'UL' || tag === 'OL') continue;
      if (hasDeactivatedMarkerEl(node)) return true;
      if (node.children && node.children.length) {
        for (let i = 0; i < node.children.length; i++) {
          stack.push(node.children[i]);
        }
      }
    }
    return false;
  }

  function collectComponentNodeInfo(compLi, menuRoot, componentLabel, workGroupOverride, directLabelCache) {
    let workGroup = workGroupOverride || '';
    let ancestorWorkGroupLi = null;
    if (!workGroup) {
      let cur = compLi.parentElement ? compLi.parentElement.closest('li') : null;
      while (cur && menuRoot.contains(cur)) {
        const pLbl = getDirectLabelText(cur, directLabelCache);
        if (pLbl && pLbl !== componentLabel) {
          workGroup = pLbl;
          ancestorWorkGroupLi = cur;
          break;
        }
        cur = cur.parentElement ? cur.parentElement.closest('li') : null;
      }
    }

    let isDeactivated =
      /deactivat|inactive/i.test(componentLabel || '') ||
      hasDeactivatedInSubtreeHeader(compLi) ||
      Boolean(
        ancestorWorkGroupLi &&
          (/deactivat|inactive/i.test(workGroup) || hasDeactivatedInSubtreeHeader(ancestorWorkGroupLi))
      );

    const basicEstIds = [];
    const sbdIds = [];
    const postTenderSbdIds = [];
    const loaCalls = [];
    const handoverEstIds = [];
    const mbookActivityIds = [];
    const ebillEstMainIds = [];
    const reEstMainIds = [];
    let postTenderStageLabel = '';
    let preTenderStageLabel = '';

    compLi.querySelectorAll('[onclick]').forEach((el) => {
      const oc = el.getAttribute('onclick') || '';
      if (/call_basicestimation/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'call_basicestimation');
        if (args && args.length >= 2 && args[1]) basicEstIds.push(String(args[1]));
      }
      if (/callsbd/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'callsbd');
        if (args && args.length >= 2 && args[1]) {
          sbdIds.push(String(args[1]));
          const lbl = cleanSingleLine(el.textContent);
          if (lbl) preTenderStageLabel = lbl;
        }
      }
      if (/callposttender/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'callposttender');
        if (args && args.length >= 2 && args[1]) {
          postTenderSbdIds.push(String(args[1]));
          const lbl = cleanSingleLine(el.textContent);
          if (lbl) postTenderStageLabel = lbl;
        }
      }
      if (/callloa_cw/i.test(oc)) {
        const cwArgs = extractArgsFromOnclick(oc, 'callloa_cw');
        if (cwArgs && cwArgs.length >= 3 && cwArgs[1]) {
          loaCalls.push({
            posttenderid: String(cwArgs[1]),
            cwEstId: String(cwArgs[2] || ''),
            isComposite: true,
          });
        }
      } else if (/callloa\b/i.test(oc)) {
        const stdArgs = extractArgsFromOnclick(oc, 'callloa');
        if (stdArgs && stdArgs.length >= 2 && stdArgs[1]) {
          loaCalls.push({
            posttenderid: String(stdArgs[1]),
            cwEstId: '',
            isComposite: false,
          });
        }
      }
      if (/callpricehandover/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'callpricehandover');
        if (args && args.length >= 2 && args[1]) handoverEstIds.push(String(args[1]));
      }
      if (/callembook/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'callembook');
        if (args && args.length >= 1 && args[0]) mbookActivityIds.push(String(args[0]));
      }
      if (/callebill/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'callebill');
        if (args && args.length >= 1 && args[0]) ebillEstMainIds.push(String(args[0]));
      }
      if (/callre\b/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'callre');
        if (args && args.length >= 1 && args[0]) reEstMainIds.push(String(args[0]));
      }
      if (/callhindranceregister/i.test(oc)) {
        const args = extractArgsFromOnclick(oc, 'callhindranceregister');
        if (args && args.length >= 2 && args[1]) reEstMainIds.push(String(args[1]));
      }
    });

    const uniqLoa = [];
    const seenLoa = new Set();
    loaCalls.forEach((l) => {
      const k = `${l.posttenderid}:${l.cwEstId}:${l.isComposite ? 1 : 0}`;
      if (!seenLoa.has(k)) {
        seenLoa.add(k);
        uniqLoa.push(l);
      }
    });

    const uniqEbillIds = uniqArr(ebillEstMainIds);
    const uniqHandoverIds = uniqArr(handoverEstIds);
    const uniqMbookIds = uniqArr(mbookActivityIds);
    const uniqReIds = uniqArr(reEstMainIds);
    const uniqSbdIds = uniqArr(sbdIds);
    const uniqPtSbdIds = uniqArr(postTenderSbdIds);
    const uniqBasicIds = uniqArr(basicEstIds);

    const activityName = extractActivityName(componentLabel) || componentLabel || 'Work Component';
    const estimateCode = extractEstimateCode(componentLabel);
    const hasEBillStage = uniqEbillIds.length > 0;
    const hasEmbook = uniqMbookIds.length > 0;
    const hasSiteHandover = uniqHandoverIds.length > 0;
    const hasPostTender = uniqPtSbdIds.length > 0 || uniqLoa.length > 0;
    const hasPreTender = uniqSbdIds.length > 0;

    let stageName = 'DPR';
    if (postTenderStageLabel || hasPostTender || hasSiteHandover || hasEmbook || hasEBillStage) {
      stageName = postTenderStageLabel || 'post-Tender';
    } else if (preTenderStageLabel || hasPreTender) {
      stageName = preTenderStageLabel || 'pre-Tender';
    }

    return {
      componentLabel: componentLabel || 'Work Component',
      activityName,
      estimateCode,
      workGroup: workGroup && workGroup !== componentLabel ? workGroup : '',
      isCompositeFinal: isCompositeFinalComponent(componentLabel),
      isHelper: isHelperActivity(activityName, componentLabel),
      isDeactivated,
      basicEstIds: uniqBasicIds,
      sbdIds: uniqSbdIds,
      postTenderSbdIds: uniqPtSbdIds,
      loaCalls: uniqLoa,
      handoverEstIds: uniqHandoverIds,
      mbookActivityIds: uniqMbookIds,
      estmainid: uniqEbillIds.length ? uniqEbillIds[uniqEbillIds.length - 1] : null,
      ebillEstMainIds: uniqEbillIds,
      reEstMainId: uniqReIds.length ? uniqReIds[uniqReIds.length - 1] : '',
      hasEBillStage,
      hasEmbook,
      hasSiteHandover,
      hasPostTender,
      hasPreTender,
      stageName,
    };
  }

  /**
   * Parses #pt-side-menu-full into per-activity descriptors and identifies
   * the authoritative anchor component (e.g., Composite Final Component).
   */
  function parseSideMenuStructure(doc) {
    const menuRoot = (doc && doc.querySelector('#pt-side-menu-full')) || (doc && doc.body) || doc;
    if (!menuRoot) {
      return {
        components: [],
        anchorComponent: null,
        hasCompositeFinal: false,
      };
    }

    const components = [];
    const capturedEbillIds = new Set();
    const capturedLis = new Set();
    const directLabelCache = new WeakMap();
    const allLis = Array.from(menuRoot.querySelectorAll('li'));
    const hasCodeDescendant = new Set();

    // Single O(N) bottom-up pass: reverse DOM pre-order visits every descendant before its ancestors
    for (let i = allLis.length - 1; i >= 0; i--) {
      const li = allLis[i];
      const lbl = getDirectLabelText(li, directLabelCache);
      const selfHasCode = /\[[^\]]+\]/.test(lbl);
      if (selfHasCode || hasCodeDescendant.has(li)) {
        const parentLi = li.parentElement ? li.parentElement.closest('li') : null;
        if (parentLi && menuRoot.contains(parentLi)) {
          hasCodeDescendant.add(parentLi);
        }
      }
    }

    for (let i = 0; i < allLis.length; i++) {
      const li = allLis[i];
      const label = getDirectLabelText(li, directLabelCache);
      if (!label || !/\[[^\]]+\]/.test(label)) continue;
      if (hasCodeDescendant.has(li)) continue;

      capturedLis.add(li);
      const info = collectComponentNodeInfo(li, menuRoot, label, '', directLabelCache);
      info.ebillEstMainIds.forEach((id) => capturedEbillIds.add(id));
      components.push(info);
    }

    // Defensive fallback for minimal synthetic DOM fixtures where labels lack [EST_CODE]
    menuRoot.querySelectorAll('[onclick*="callebill"]').forEach((el) => {
      const args = extractArgsFromOnclick(el.getAttribute('onclick'), 'callebill');
      const estmainid = args && args[0] ? String(args[0]) : '';
      if (!estmainid || capturedEbillIds.has(estmainid)) return;
      capturedEbillIds.add(estmainid);

      let cur = el.closest ? el.closest('li') : null;
      let compLi = cur;
      let steps = 0;
      while (cur && menuRoot.contains(cur) && steps < 3) {
        compLi = cur;
        cur = cur.parentElement && cur.parentElement.closest ? cur.parentElement.closest('li') : null;
        steps++;
      }
      if (!compLi || capturedLis.has(compLi)) return;
      capturedLis.add(compLi);
      const label = getDirectLabelText(compLi, directLabelCache) || 'Work Component';
      components.push(collectComponentNodeInfo(compLi, menuRoot, label, '', directLabelCache));
    });

    const nonDeactivated = components.filter((c) => !c.isDeactivated);
    const hasCompositeFinal = nonDeactivated.some((c) => c.isCompositeFinal);
    const anchorComponent =
      nonDeactivated.find(
        (c) =>
          c.isCompositeFinal &&
          (c.handoverEstIds.length || c.loaCalls.length || c.sbdIds.length || c.hasEBillStage)
      ) ||
      nonDeactivated.find(
        (c) =>
          !c.isHelper &&
          (c.hasEBillStage || c.hasSiteHandover || c.hasPostTender || c.loaCalls.length)
      ) ||
      nonDeactivated.find((c) => !c.isHelper) ||
      nonDeactivated[0] ||
      components[0] ||
      null;

    return {
      components,
      anchorComponent,
      hasCompositeFinal,
    };
  }

  /**
   * Backward-compatible summary of menu IDs with last-first ordering on retendered IDs.
   */
  function parseSideMenuIds(doc) {
    const struct = parseSideMenuStructure(doc);
    const anchor = struct.anchorComponent;
    const comps = struct.components;

    const allHandoverIds = uniqArr(comps.flatMap((c) => c.handoverEstIds));
    const allBasicIds = uniqArr(comps.flatMap((c) => c.basicEstIds));
    const allSbdIdsRev = uniqArr(
      [...(anchor ? [...anchor.sbdIds].reverse() : [])].concat(
        comps.flatMap((c) => [...c.sbdIds].reverse())
      )
    );
    const allPostTenderSbdRev = uniqArr(
      [...(anchor ? [...anchor.postTenderSbdIds].reverse() : [])].concat(
        comps.flatMap((c) => [...c.postTenderSbdIds].reverse())
      )
    );
    const allLoasRev = [];
    const seenLoa = new Set();
    const pushLoaRev = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i];
        const k = `${l.posttenderid}:${l.cwEstId}`;
        if (!seenLoa.has(k)) {
          seenLoa.add(k);
          allLoasRev.push({ posttenderid: l.posttenderid, cwEstId: l.cwEstId });
        }
      }
    };
    if (anchor) pushLoaRev(anchor.loaCalls);
    comps.forEach((c) => pushLoaRev(c.loaCalls));

    const anchorHo = anchor && anchor.handoverEstIds ? anchor.handoverEstIds : [];
    const handoverEstId =
      (anchorHo.length ? anchorHo[anchorHo.length - 1] : '') ||
      (allHandoverIds.length ? allHandoverIds[allHandoverIds.length - 1] : '');
    const anchorBasic = anchor && anchor.basicEstIds ? anchor.basicEstIds : [];
    const primaryBasicId =
      (anchorBasic.length ? anchorBasic[anchorBasic.length - 1] : '') ||
      (allBasicIds.length ? allBasicIds[allBasicIds.length - 1] : '');
    const primaryEstId = handoverEstId || primaryBasicId || '';
    const primaryLoa = allLoasRev[0] || null;
    const primarySbdId = allSbdIdsRev[0] || '';
    const anchorMbook = anchor && anchor.mbookActivityIds ? anchor.mbookActivityIds : [];
    const firstNonEmptyMbook = comps.find((c) => c.mbookActivityIds.length > 0);
    const mbookActivityId =
      (anchorMbook.length ? anchorMbook[anchorMbook.length - 1] : '') ||
      (firstNonEmptyMbook
        ? firstNonEmptyMbook.mbookActivityIds[firstNonEmptyMbook.mbookActivityIds.length - 1]
        : '');

    return {
      primaryEstId,
      handoverEstId,
      primarySbdId,
      sbdIds: allSbdIdsRev,
      primaryLoa,
      loaCalls: allLoasRev,
      basicEstIds: allBasicIds,
      postTenderSbdIds: allPostTenderSbdRev,
      mbookActivityId,
    };
  }

  function parsePeriodHtml(docOrHtml) {
    const rawHtml = typeof docOrHtml === 'string' ? docOrHtml : '';
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;
    const parseIntOrZero = (val) => {
      const n = parseInt(String(val || '').replace(/[^0-9]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    };

    const yText = getSelectedOptionText(
      doc.querySelector('select#durationYear, select[name="durationYear"]'),
      rawHtml,
      'durationYear'
    );
    const mText = getSelectedOptionText(
      doc.querySelector('select#durationMonth, select[name="durationMonth"]'),
      rawHtml,
      'durationMonth'
    );
    const dText = getSelectedOptionText(
      doc.querySelector('select#durationDay, select[name="durationDay"]'),
      rawHtml,
      'durationDay'
    );

    const workPriority = getSelectedOptionText(
      doc.querySelector('select#workPriorityCode, select[name="workPriorityCode"]'),
      rawHtml,
      'workPriorityCode'
    );
    const workExecutionMode = getSelectedOptionText(
      doc.querySelector('select#workExecutionCode, select[name="workExecutionCode"]'),
      rawHtml,
      'workExecutionCode'
    );

    const periodYears = parseIntOrZero(yText);
    const periodMonths = parseIntOrZero(mText);
    const periodDays = parseIntOrZero(dText);

    return {
      periodYears,
      periodMonths,
      periodDays,
      periodText: formatPeriodText({ years: periodYears, months: periodMonths, days: periodDays }),
      workPriority,
      workExecutionMode,
    };
  }

  function parseConstituencyHtml(docOrHtml) {
    const rawHtml = typeof docOrHtml === 'string' ? docOrHtml : '';
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;

    const lacSet = new Set();
    doc.querySelectorAll('select[name="assemblyConstituencyCode"]').forEach((sel) => {
      const selId = sel.getAttribute ? sel.getAttribute('id') : '';
      const txt = getSelectedOptionText(sel, rawHtml, selId || 'assemblyConstituencyCode1');
      if (txt) lacSet.add(txt);
    });

    const parlSelect = doc.querySelector('select[name="parlConstituencyCode"]');
    const parlId = parlSelect && parlSelect.getAttribute ? parlSelect.getAttribute('id') : '';
    const parliamentConstituency = getSelectedOptionText(
      parlSelect,
      rawHtml,
      parlId || 'parlConstituencyCode1'
    );

    return {
      constituency: Array.from(lacSet).join(', '),
      parliamentConstituency,
    };
  }

  function getDirectRowCells(tr, tdOnly) {
    return Array.from((tr && tr.children) || []).filter((c) => {
      const tag = c && c.tagName ? String(c.tagName).toUpperCase() : '';
      return tdOnly ? tag === 'TD' : tag === 'TD' || tag === 'TH';
    });
  }

  function findInnermostTable(doc, idSel, pred) {
    if (!doc || !doc.querySelector) return null;
    if (idSel) {
      const byId = doc.querySelector(idSel);
      if (byId) return byId;
    }
    const tables = Array.from(doc.querySelectorAll('table'));
    const matching = tables.filter((t) => pred(t));
    if (matching.length === 0) return null;
    return (
      matching.find(
        (t) => !matching.some((other) => other !== t && t.contains && t.contains(other))
      ) || matching[0]
    );
  }

  function extractTableLabelValueMap(doc) {
    const map = Object.create(null);
    if (!doc) return map;
    doc.querySelectorAll('table tr').forEach((tr) => {
      const cells = getDirectRowCells(tr, false);
      if (cells.length < 2) return;
      for (let i = 0; i + 1 < cells.length; i += 2) {
        const rawLabel = cleanSingleLine(cells[i].textContent)
          .replace(/[.*:\s]+$/g, '')
          .toLowerCase();
        if (!rawLabel || !isSafeKey(rawLabel)) continue;
        const valCell = cells[i + 1];
        const inp = valCell.querySelector && valCell.querySelector('input:not([type="hidden"])');
        const lbl = valCell.querySelector && valCell.querySelector('label, b, strong');
        let val = '';
        if (inp) {
          val = cleanSingleLine(inp.value || inp.getAttribute('value') || '');
        }
        if (!val && lbl) {
          val = cleanSingleLine(lbl.textContent);
        }
        if (!val) {
          val = cleanSingleLine(valCell.textContent);
        }
        if (val && !Object.hasOwn(map, rawLabel)) {
          map[rawLabel] = val;
        }
      }
    });
    return map;
  }

  function parseAsTsHtml(docOrHtml) {
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;
    const map = extractTableLabelValueMap(doc);

    const tsLbl = doc.querySelector && doc.querySelector('label#tsNumber');
    const tsLblText = tsLbl ? cleanSingleLine(tsLbl.textContent) : '';

    return {
      asNo: map['administrative sanction number'] || '',
      asDate:
        normalizeDmyDate(map['administrative sanction date']) ||
        map['administrative sanction date'] ||
        '',
      asAmount: map['administrative sanction amount'] || '',
      asAuthority: map['administrative sanction authority'] || '',
      tsNo: tsLblText || map['technical sanction number'] || '',
      tsDate:
        normalizeDmyDate(map['technical sanction date']) ||
        map['technical sanction date'] ||
        '',
      tsAmount: map['technical sanction amount'] || '',
      tsAuthority: map['technical sanction authority'] || '',
    };
  }

  function parseTsFromHandoverHtml(docOrHtml) {
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;
    const map = extractTableLabelValueMap(doc);
    // Intentionally excludes "tender opening date" — never treat it as SHO Date.
    return {
      tsNo: map['technical sanction number'] || '',
      tsDate:
        normalizeDmyDate(map['technical sanction date']) ||
        map['technical sanction date'] ||
        '',
      tsAmount: map['technical sanction amount'] || '',
      tsAuthority: map['technical sanction authority'] || '',
      agreedPac: map['agreed pac'] || '',
      estimatePac: map['estimate pac'] || '',
    };
  }

  function parseLoaEagreementParams(docOrHtml, fallbackLoa) {
    const rawHtml = typeof docOrHtml === 'string' ? docOrHtml : '';
    if (rawHtml && isPortalErrorHtml(rawHtml)) return null;
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;
    const el = doc.querySelector && doc.querySelector('[onclick*="eagreement("]');
    if (!el) return null;

    const args = extractArgsFromOnclick(el.getAttribute('onclick'), 'eagreement');
    if (!args || args.length < 6) return null;

    let cwEstId = '';
    if (rawHtml) {
      const m = rawHtml.match(/cwEstId\s*[:=]\s*['"]?(\d+)['"]?/i);
      if (m && m[1]) cwEstId = m[1];
    }
    if (!cwEstId) {
      const cwInput = doc.querySelector && doc.querySelector('input[name="cwEstId"], input#cwEstId');
      if (cwInput) cwEstId = cleanSingleLine(cwInput.value || cwInput.getAttribute('value') || '');
    }
    if (!cwEstId && args[4]) {
      cwEstId = String(args[4]);
    }
    if (!cwEstId && fallbackLoa && fallbackLoa.handoverEstId) {
      cwEstId = String(fallbackLoa.handoverEstId);
    }
    if (!cwEstId && fallbackLoa && fallbackLoa.cwEstId) {
      cwEstId = String(fallbackLoa.cwEstId);
    }

    return {
      posttenderid: String(args[1] || (fallbackLoa && fallbackLoa.posttenderid) || ''),
      fileid: String(args[2] || ''),
      workactivityid: String(args[3] || ''),
      estid: String(args[4] || ''),
      estmainid: String(args[5] || ''),
      cwEstId: String(cwEstId || ''),
    };
  }

  function parseAgreementAndContractorHtml(docOrHtml) {
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;
    const map = extractTableLabelValueMap(doc);

    const readInputOrOutput = (id, mapKey) => {
      const inp = doc.querySelector && doc.querySelector(`input#${id}`);
      if (inp) {
        const v = cleanSingleLine(inp.value || inp.getAttribute('value') || '');
        if (v) return v;
        const parentTd = inp.closest ? inp.closest('td') : null;
        const lbl =
          parentTd && parentTd.querySelector ? parentTd.querySelector('label.output-data') : null;
        if (lbl) {
          const lv = cleanSingleLine(lbl.textContent);
          if (lv) return lv;
        }
      }
      return (mapKey && map[mapKey]) || '';
    };

    const rawAgreementNo =
      readInputOrOutput('agreementNo', 'agreement number') || map['agreement no'] || '';
    const rawAgreementDate =
      readInputOrOutput('agreementDate', 'agreement date') || map['date of agreement'] || '';
    const estPacEl =
      doc.querySelector && doc.querySelector('input#estpac, input[name="estpac"]');
    const hiddenEstPac = estPacEl
      ? cleanSingleLine(estPacEl.value || estPacEl.getAttribute('value') || '')
      : '';

    return {
      agreementNo: rawAgreementNo,
      agreementDate: normalizeDmyDate(rawAgreementDate) || rawAgreementDate,
      agreedPac: map['agreed pac'] || '',
      estimatePac: map['estimate pac'] || map['tendered pac'] || hiddenEstPac || '',
      negotiatedRate:
        map['neogotiated rate'] ||
        map['negotiated rate'] ||
        map['tender variation'] ||
        map['tender excess/less'] ||
        '',
      executionOffice: map['execution office'] || '',
      contractor: {
        name: map['bidder name'] || '',
        pan: map['contractor pan'] || '',
        mobile: map['mobile'] || '',
        email: map['e-mail'] || map['email'] || '',
        applicantType: map['applicant type'] || '',
        licenseSource: map['license source'] || '',
      },
    };
  }

  function parseHandoverHistoryHtml(docOrHtml) {
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;
    const table =
      (doc.querySelector && doc.querySelector('#pt-history_table')) ||
      (doc.querySelector && doc.querySelector('table'));
    if (!table) {
      return {
        contractorSignedDate: '',
        handoverInitiatedDate: '',
        handoverCountersignedDate: '',
      };
    }

    let contractorSignedDate = '';
    let handoverInitiatedDate = '';
    let handoverCountersignedDate = '';

    table.querySelectorAll('tbody tr').forEach((tr) => {
      const tds = getDirectRowCells(tr, true);
      if (tds.length < 2) return;
      const dateStr = normalizeDmyDate(cleanSingleLine(tds[0].textContent));
      if (!dateStr) return;
      const action = cleanSingleLine(tds[1].textContent);
      const notes = tds.length >= 5 ? cleanSingleLine(tds[4].textContent) : '';

      if (/take\s*over\s*the\s*site/i.test(action) && !handoverInitiatedDate) {
        handoverInitiatedDate = dateStr;
      }
      if (
        (/for\s*counter\s*sign/i.test(action) || /signed\s*by\s*contractor/i.test(notes)) &&
        !contractorSignedDate
      ) {
        contractorSignedDate = dateStr;
      }
      if (/sign\s*the\s*performa/i.test(action) && !handoverCountersignedDate) {
        handoverCountersignedDate = dateStr;
      }
    });

    return {
      contractorSignedDate,
      handoverInitiatedDate,
      handoverCountersignedDate,
    };
  }

  /**
   * Parses work_component_analysis.pro stage cards (Estimate, Site Handover, MBook, eBill, etc.).
   */
  function parseWorkComponentAnalysisHtml(docOrHtml) {
    const rawHtml = typeof docOrHtml === 'string' ? docOrHtml : '';
    if (rawHtml && isPortalErrorHtml(rawHtml)) {
      return {
        sections: Object.create(null),
        mbookStatus: '',
        mbookInitiatedOn: '',
        mbookCurrentStage: '',
        mbookCurrentTask: '',
        mbookPendingWith: '',
        mbookPendingSince: '',
        wcaShoDate: '',
        wcaShoStatus: '',
        estimateStage: '',
        estimateTask: '',
        ebillStatus: '',
        asApprovedOn: '',
        asApprovedBy: '',
        tsApprovedOn: '',
        tsApprovedBy: '',
      };
    }

    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;
    const sections = Object.create(null);
    let currentSection = '';

    doc.querySelectorAll('h5, .row').forEach((el) => {
      if (el.tagName === 'H5') {
        currentSection = cleanSingleLine(el.textContent);
        if (currentSection && isSafeKey(currentSection) && !Object.hasOwn(sections, currentSection)) {
          sections[currentSection] = Object.create(null);
        }
        return;
      }
      if (!currentSection || !isSafeKey(currentSection) || !Object.hasOwn(sections, currentSection)) {
        return;
      }
      const cols = Array.from(el.children || []).filter((c) => {
        const cls = (c.getAttribute && c.getAttribute('class')) || c.className || '';
        return /\bcol-md-6\b/.test(cls);
      });
      if (cols.length < 2) return;
      const k = cleanSingleLine(cols[0].textContent)
        .replace(/[.*:\s]+$/g, '')
        .toLowerCase();
      if (!k || !isSafeKey(k)) return;
      const bEl = cols[1].querySelector('b, strong');
      const v = cleanSingleLine(bEl ? bEl.textContent : cols[1].textContent);
      if (v) sections[currentSection][k] = v;
    });

    const findSec = (re) => {
      const key = Object.keys(sections).find((name) => re.test(name));
      return key ? sections[key] : Object.create(null);
    };

    const est = findSec(/^estimate/i);
    const sho = findSec(/site\s*handover/i);
    const mb = findSec(/^m\s*book$/i);
    const eb = findSec(/^e\s*bill$/i);

    return {
      sections,
      mbookStatus: mb['status'] || '',
      mbookInitiatedOn: normalizeDmyDate(mb['initiated on']) || '',
      mbookCurrentStage: mb['current stage'] || '',
      mbookCurrentTask: mb['current task'] || '',
      mbookPendingWith: mb['pending with'] || '',
      mbookPendingSince: normalizeDmyDate(mb['pending since']) || '',
      wcaShoDate: normalizeDmyDate(sho['closed on']) || normalizeDmyDate(sho['initiated on']) || '',
      wcaShoStatus: sho['status'] || '',
      estimateStage: est['current stage'] || '',
      estimateTask: est['current task'] || '',
      ebillStatus: eb['status'] || '',
      asApprovedOn: normalizeDmyDate(est['as approved on']) || '',
      asApprovedBy: est['as approved by'] || '',
      tsApprovedOn: normalizeDmyDate(est['ts approved on']) || '',
      tsApprovedBy: est['ts approved by'] || '',
    };
  }

  function parseMbookViewClosedHtml(docOrHtml) {
    const raw = typeof docOrHtml === 'string' ? docOrHtml : '';
    if (typeof docOrHtml === 'string' && !raw.trim()) return false;
    try {
      const doc = typeof docOrHtml === 'string' ? parseHtmlString(raw) : docOrHtml;
      if (doc && doc.querySelector) {
        if (doc.querySelector('[onclick*="activate_mbook"]')) return true;
        const els = doc.querySelectorAll(
          'a, button, input[type="button"], input[type="submit"], span, label, div'
        );
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          const val =
            (el.getAttribute && el.getAttribute('value')) || el.textContent || '';
          if (/ACTIVATE\s+MBOOK/i.test(val)) return true;
        }
        return false;
      }
    } catch (_e) {}
    const stripped = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
    return /activate_mbook\s*\(/i.test(stripped) || /ACTIVATE\s+MBOOK/i.test(stripped);
  }

  function parseNegotiatedRateHtml(docOrHtml) {
    const rawHtml = typeof docOrHtml === 'string' ? docOrHtml : '';
    if (rawHtml && isPortalErrorHtml(rawHtml)) return null;
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;

    const table = findInnermostTable(doc, '#pt-specifications1', (t) => {
      const txt = cleanSingleLine(t.textContent).toLowerCase();
      return txt.includes('bidder') && txt.includes('negotiated');
    });
    if (!table) return null;

    const headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
    const headers = headerCells.map((c) => cleanSingleLine(c.textContent).toLowerCase());
    const idxOf = (re, fallbackIdx) => {
      const i = headers.findIndex((h) => re.test(h));
      return i >= 0 ? i : fallbackIdx;
    };

    const bidderIdx = idxOf(/bidder/, 1);
    const estPacIdx = idxOf(/estimate\s*pac/, 2);
    const remarksIdx = idxOf(/remarks/, 7);
    const negRateIdx = idxOf(/negotiated\s*rate/, 8);
    const negPacIdx = idxOf(/negotiated\s*pac/, 9);

    const candidates = [];
    table.querySelectorAll('tbody tr').forEach((tr) => {
      if (tr.querySelector('td.dataTables_empty')) return;
      const tds = getDirectRowCells(tr, true);
      if (tds.length < 4) return;

      const rawBidder = cleanSingleLine(tds[bidderIdx] ? tds[bidderIdx].textContent : '');
      if (!rawBidder || /no data available/i.test(rawBidder)) return;

      let contractorName = rawBidder;
      let contractorPan = '';
      const m = rawBidder.match(/^(.*?)\s*\(([A-Z0-9]{8,12})\)\s*$/i);
      if (m) {
        contractorName = cleanSingleLine(m[1]);
        contractorPan = m[2].toUpperCase();
      }

      const estimatePac = estPacIdx < tds.length ? cleanSingleLine(tds[estPacIdx].textContent) : '';
      const remarks = remarksIdx < tds.length ? cleanSingleLine(tds[remarksIdx].textContent) : '';
      const negotiatedRate =
        negRateIdx < tds.length ? cleanSingleLine(tds[negRateIdx].textContent) : '';
      const negotiatedPac =
        negPacIdx < tds.length ? cleanSingleLine(tds[negPacIdx].textContent) : '';
      const accepted = Boolean(
        tr.querySelector('.fa-check-circle, .fa-check, input[type="radio"]:checked')
      );

      candidates.push({
        contractorName,
        contractorPan,
        estimatePac,
        negotiatedRate,
        negotiatedPac,
        remarks,
        accepted,
      });
    });

    if (candidates.length === 0) return null;
    const chosen =
      candidates.find((c) => c.accepted) ||
      candidates.find((c) => /\bLQI\b/i.test(c.remarks)) ||
      candidates[0];

    return {
      contractorName: chosen.contractorName,
      contractorPan: chosen.contractorPan,
      estimatePac: chosen.estimatePac,
      negotiatedRate: chosen.negotiatedRate,
      negotiatedPac: chosen.negotiatedPac,
      remarks: chosen.remarks,
    };
  }

  function parsePostTenderIdsHtml(docOrHtml) {
    const rawHtml = typeof docOrHtml === 'string' ? docOrHtml : '';
    if (rawHtml && isPortalErrorHtml(rawHtml)) return null;
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;

    const readVal = (sel, re) => {
      const el = doc.querySelector(sel);
      if (el) {
        const v = cleanSingleLine(el.value || el.getAttribute('value') || '');
        if (v) return v;
      }
      if (rawHtml && re) {
        const m = rawHtml.match(re);
        if (m && m[1]) return cleanSingleLine(m[1]);
      }
      return '';
    };

    const ptid = readVal(
      'input#ptid, input[name="ptid"], input[name="ptid1"]',
      /id=["']ptid["'][^>]*value=["']([^"']+)["']/i
    );
    const sbdid = readVal(
      'input#sbdid, input[name="sbdid"], input[name="sbdid1"]',
      /id=["']sbdid["'][^>]*value=["']([^"']+)["']/i
    );

    if (!ptid && !sbdid) return null;
    return { ptid, sbdid };
  }

  function parseBidderViewHtml(docOrHtml, targetPan, targetName) {
    const rawHtml = typeof docOrHtml === 'string' ? docOrHtml : '';
    if (rawHtml && isPortalErrorHtml(rawHtml)) return null;
    const doc = typeof docOrHtml === 'string' ? parseHtmlString(docOrHtml) : docOrHtml;

    const table = findInnermostTable(doc, '#pd-attachment-table', (t) => {
      const txt = cleanSingleLine(t.textContent).toLowerCase();
      return txt.includes('pan') && (txt.includes('mobile') || txt.includes('bidder'));
    });
    if (!table) return null;

    const headerCells = Array.from(table.querySelectorAll('thead th, thead td'));
    const headers = headerCells.map((c) => cleanSingleLine(c.textContent).toLowerCase());
    const idxOf = (re, fallbackIdx) => {
      const i = headers.findIndex((h) => re.test(h));
      return i >= 0 ? i : fallbackIdx;
    };

    const panIdx = idxOf(/\bpan\b/, 1);
    const nameIdx = idxOf(/bidder\s*name|name/, 2);
    const emailIdx = idxOf(/e-?mail/, 3);
    const mobileIdx = idxOf(/mobile|phone/, 4);
    const typeIdx = idxOf(/applicant\s*type/, 5);

    const bidders = [];
    table.querySelectorAll('tbody tr').forEach((tr) => {
      if (tr.querySelector('td.dataTables_empty')) return;
      const tds = getDirectRowCells(tr, true);
      if (tds.length < 4) return;
      const pan = cleanSingleLine(tds[panIdx] ? tds[panIdx].textContent : '').toUpperCase();
      const name = cleanSingleLine(tds[nameIdx] ? tds[nameIdx].textContent : '');
      const email = emailIdx < tds.length ? cleanSingleLine(tds[emailIdx].textContent) : '';
      const mobile = mobileIdx < tds.length ? cleanSingleLine(tds[mobileIdx].textContent) : '';
      const applicantType = typeIdx < tds.length ? cleanSingleLine(tds[typeIdx].textContent) : '';
      if (!name && !pan) return;
      bidders.push({ name, pan, email, mobile, applicantType });
    });

    if (bidders.length === 0) return null;
    const normPan = String(targetPan || '').trim().toUpperCase();
    const normName = cleanSingleLine(targetName || '').toLowerCase();

    return (
      (normPan && bidders.find((b) => b.pan === normPan)) ||
      (normName && bidders.find((b) => b.name.toLowerCase() === normName)) ||
      (bidders.length === 1 ? bidders[0] : null)
    );
  }

  // -------------------------------------------------------------------------
  // Bill Classification, M-Book Closed & Missing Fields Analysis
  // -------------------------------------------------------------------------

  function classifyBillKind(billTypeAndNo) {
    const bt = String(billTypeAndNo || '').trim();
    if (RE_PRE_FINAL.test(bt)) return 'Pre-Final';
    if (RE_FINAL.test(bt)) return 'Final';
    if (RE_PART.test(bt)) return 'Part';
    return 'Other';
  }

  function isCompositeFinalComponent(compLabel) {
    return RE_COMPOSITE_FINAL_COMP.test(String(compLabel || ''));
  }

  function isCompositeFinalBill(compLabel, billTypeAndNo) {
    return isCompositeFinalComponent(compLabel) || RE_COMPOSITE_WORK_BILL.test(String(billTypeAndNo || ''));
  }

  function analyzeWorkRecord(workRecord) {
    if (!workRecord) {
      return {
        scanned: false,
        categoryKey: 'unscanned',
        label: 'Not Scanned',
        badgeClass: 'p3h-badge-unscanned',
        hasAnyBills: false,
        hasFinal: false,
        isFullyFinalized: false,
        hasPartialFinal: false,
        hasAnyFinal: false,
        hasPart: false,
        hasPreFinal: false,
        hasCompositeFinal: false,
        isCompositeWork: false,
        hasIndependentActivities: false,
        hasMbookClosedNoFinal: false,
        mbookClosedNoFinalCount: 0,
        isFullyManuallyArchived: false,
        hasAnyManualArchive: false,
        partCount: 0,
        preFinalCount: 0,
        finalCount: 0,
        draftCount: 0,
        cancelledCount: 0,
        ebillCompCount: 0,
        finalizedEBillCompCount: 0,
        trackableCompCount: 0,
        finalizedTrackableCompCount: 0,
        totalActiveAmount: 0,
        latestBill: null,
        components: [],
        activities: [],
        activityNames: [],
        activeOpenMbookActivities: [],
      };
    }

    const ud =
      workRecord.userData && typeof workRecord.userData === 'object' ? workRecord.userData : null;
    const workManualArchive =
      ud && ud.manualArchive && ud.manualArchive.archived === true
        ? { ...ud.manualArchive }
        : null;
    const actOverrides =
      ud && ud.activityOverrides && typeof ud.activityOverrides === 'object'
        ? ud.activityOverrides
        : {};

    const hasDeactivatedWcaText = (str) => RE_DEACTIVATED_TEXT.test(String(str || ''));

    const rawComps = Array.isArray(workRecord.components) ? workRecord.components : [];
    const groupsWithCfComp = new Set();
    const groupsWithCf = new Set();
    const groupsWithCfTerminallySubmitted = new Set();
    const groupsWithUnbilledCf = new Set();
    const groupsWithPf = new Set();
    let workHasCompositeFinal = false;

    const preparedComps = rawComps.map((c) => {
      const compLabel = String(c.componentLabel || '').trim();
      const activityName =
        c.activityName || extractActivityName(compLabel) || compLabel || 'Work Component';
      const workGroup = String(c.workGroup || '').trim();
      const groupKey = workGroup.toLowerCase();
      const isHelper =
        typeof c.isHelper === 'boolean' ? c.isHelper : isHelperActivity(activityName, compLabel);
      const isComponentDeactivated = Boolean(c.isDeactivated || hasDeactivatedWcaText(c.wcaStage));
      const bills = (Array.isArray(c.bills) ? c.bills : []).map((b) => {
        const isCancelled = RE_CANCELLED_STATUS.test(b.status || '');
        const isDraft = !isCancelled && RE_DRAFT_STATUS.test(b.status || '');
        const kind = classifyBillKind(b.billTypeAndNo);
        return { ...b, isCancelled, isDraft, kind, componentLabel: compLabel, workGroup };
      });
      if (!isComponentDeactivated && !isHelper) {
        if (isCompositeFinalComponent(compLabel)) {
          groupsWithCfComp.add(groupKey);
        }
        const cfFinals = bills.filter(
          (b) =>
            !b.isCancelled &&
            !b.isDraft &&
            b.kind === 'Final' &&
            isCompositeFinalBill(compLabel, b.billTypeAndNo)
        );
        const hasCf = cfFinals.length > 0;
        const hasPf = bills.some((b) => !b.isCancelled && !b.isDraft && b.kind === 'Pre-Final');
        if (hasCf) {
          groupsWithCf.add(groupKey);
          workHasCompositeFinal = true;
          if (cfFinals.every((b) => isTerminalBillStatus(b.status))) {
            groupsWithCfTerminallySubmitted.add(groupKey);
          }
        } else if (isCompositeFinalComponent(compLabel)) {
          groupsWithUnbilledCf.add(groupKey);
        }
        if (hasPf) groupsWithPf.add(groupKey);
      }
      return {
        raw: c,
        compLabel,
        activityName,
        workGroup,
        groupKey,
        isHelper,
        isComponentDeactivated,
        bills,
      };
    });

    const groupNonMergedBillables = new Map();

    const prelimComps = preparedComps.map((pc) => {
      const c = pc.raw;
      const activityName = pc.activityName;
      const estimateCode = c.estimateCode || extractEstimateCode(pc.compLabel) || '';
      const activityKey = getActivityKey(c);
      const isHelper = pc.isHelper;
      const isComponentDeactivated = pc.isComponentDeactivated;

      const isCompositeFinalComp = isCompositeFinalComponent(pc.compLabel);
      const isCompositeGroupMember =
        groupsWithCfComp.has(pc.groupKey) &&
        (isCompositeFinalComp || /^composite\b/i.test(activityName));
      const isCompositeSibling = isCompositeGroupMember && !isCompositeFinalComp;

      // Strictly scoped per workGroup so Composite Final in one group never finalizes unrelated phases
      const groupHasCf = groupsWithCf.has(pc.groupKey);
      const groupHasPf =
        groupsWithPf.has(pc.groupKey) ||
        (groupsWithPf.size > 0 && isCompositeFinalComp && groupHasCf);

      const ov =
        activityKey && isSafeKey(activityKey) && Object.hasOwn(actOverrides, activityKey)
          ? actOverrides[activityKey]
          : null;
      const actManualArchive =
        ov && ov.manualArchive && ov.manualArchive.archived === true
          ? { ...ov.manualArchive }
          : null;
      const effectiveManualArchive = actManualArchive || workManualArchive;
      const isManuallyArchived = Boolean(
        effectiveManualArchive && effectiveManualArchive.archived
      );

      const bills = pc.bills.map((b) => {
        const isMergedIntoCompositeFinal =
          !b.isCancelled &&
          !b.isDraft &&
          groupHasCf &&
          ((isCompositeSibling && (b.kind === 'Pre-Final' || b.kind === 'Final')) ||
            (!isCompositeFinalComp && b.kind === 'Pre-Final'));
        const includedInWorkTotal = !b.isCancelled && !b.isDraft && !isMergedIntoCompositeFinal;
        const isCompositeFinal =
          !b.isCancelled &&
          !b.isDraft &&
          b.kind === 'Final' &&
          isCompositeFinalBill(pc.compLabel, b.billTypeAndNo) &&
          (groupHasPf || isCompositeGroupMember);
        return {
          ...b,
          isMergedIntoCompositeFinal,
          includedInWorkTotal,
          isCompositeFinal,
        };
      });

      const active = bills.filter((b) => !b.isCancelled && !b.isDraft);
      const drafts = bills.filter((b) => b.isDraft);
      const cancelled = bills.filter((b) => b.isCancelled);
      const hasFinalBill = active.some((b) => b.kind === 'Final');
      const hasPreFinalBill = active.some((b) => b.kind === 'Pre-Final');
      const partBillsInComp = active.filter((b) => b.kind === 'Part');

      const isMbookClosed = /^closed$/i.test(c.mbookStatus || '') || Boolean(c.mbookClosed);
      const isMbookOpen =
        !isMbookClosed &&
        (Boolean(c.hasEmbook) ||
          Boolean(c.mbookActivityId) ||
          (Boolean(c.mbookStatus) && !/^(closed|not\s*initiated|none)$/i.test(c.mbookStatus)));
      const mbookClosedNoFinal =
        isMbookClosed && !hasFinalBill && !hasPreFinalBill && !(isCompositeSibling && groupHasCf);

      const stageTxt = cleanSingleLine(c.stageName || '');
      const isPureDprLabel =
        !stageTxt ||
        /^dpr$/i.test(stageTxt) ||
        /^dpr\s*\/\s*pre[\s_-]*tender(?:\s*only)?$/i.test(stageTxt) ||
        /^dpr\s*only$/i.test(stageTxt);
      const hasExplicitStageFlags =
        typeof c.hasPreTender === 'boolean' || typeof c.hasPostTender === 'boolean';
      const hasStageBeyondDpr =
        !isPureDprLabel &&
        !(
          hasExplicitStageFlags &&
          !c.hasPreTender &&
          !c.hasPostTender &&
          !c.hasSiteHandover &&
          !c.hasEmbook &&
          !c.hasEBillStage
        ) &&
        /\b(?:pre[\s_-]*tender|post[\s_-]*tender|handover|embook|m[\s_-]*book|e-?bill)/i.test(
          stageTxt
        );
      const isExecutionActivity = Boolean(
        c.hasEBillStage ||
          c.hasEmbook ||
          c.hasSiteHandover ||
          c.hasPostTender ||
          c.hasPreTender ||
          hasStageBeyondDpr ||
          active.length > 0
      );
      const isFinalized =
        hasFinalBill ||
        (hasPreFinalBill && groupHasCf) ||
        (isCompositeSibling && groupHasCf);

      const compBillable = active.filter((b) => b.includedInWorkTotal);
      const compTotalActiveAmount = compBillable.reduce((acc, b) => acc + parseInr(b.grandTotal), 0);

      if (!isComponentDeactivated && !isHelper && !isManuallyArchived && isCompositeGroupMember) {
        if (!groupNonMergedBillables.has(pc.groupKey)) {
          groupNonMergedBillables.set(pc.groupKey, []);
        }
        const bucket = groupNonMergedBillables.get(pc.groupKey);
        compBillable.forEach((b) => bucket.push(b));
      }

      return {
        raw: c,
        groupKey: pc.groupKey,
        activityName,
        estimateCode,
        activityKey,
        isHelper,
        isCompositeFinalComp,
        isCompositeGroupMember,
        isCompositeSibling,
        groupHasCf,
        groupHasPf,
        isComponentDeactivated,
        isExecutionActivity,
        isFinalized,
        hasFinalBill,
        hasPreFinalBill,
        partBillsInComp,
        active,
        drafts,
        cancelled,
        isMbookClosed,
        isMbookOpen,
        mbookClosedNoFinal,
        isManuallyArchived,
        effectiveManualArchive,
        compBillable,
        compTotalActiveAmount,
        bills,
      };
    });

    const groupsWithAllBillsTerminal = new Set();
    groupNonMergedBillables.forEach((grpBills, gk) => {
      if (
        groupsWithCfTerminallySubmitted.has(gk) &&
        grpBills.length > 0 &&
        grpBills.every((b) => isTerminalBillStatus(b.status))
      ) {
        groupsWithAllBillsTerminal.add(gk);
      }
    });

    const analyzedComps = prelimComps.map((pc) => {
      const c = pc.raw;
      const isTerminallySubmitted =
        !pc.isComponentDeactivated &&
        (pc.isCompositeGroupMember && pc.groupHasCf
          ? groupsWithAllBillsTerminal.has(pc.groupKey)
          : Boolean(
              pc.isFinalized &&
                pc.compBillable.length > 0 &&
                pc.compBillable.every((b) => isTerminalBillStatus(b.status))
            ));

      const lifecycleState = pc.isManuallyArchived
        ? 'manually_archived'
        : isTerminallySubmitted
        ? 'finalized_archived'
        : 'active';

      let compBadgeText = '';
      let compBadgeClass = 'p3h-badge-dpr';
      let actCategoryKey = 'nobill';
      if (pc.isManuallyArchived) {
        actCategoryKey = 'manually_archived';
        compBadgeText = 'Manually Archived';
        compBadgeClass = 'p3h-badge-manual-arch';
      } else if (pc.isComponentDeactivated) {
        actCategoryKey = 'deactivated';
        compBadgeText = 'Deactivated';
        compBadgeClass = 'p3h-badge-cancelled';
      } else if (pc.hasFinalBill) {
        actCategoryKey = 'final';
        compBadgeText =
          pc.isCompositeFinalComp && pc.groupHasPf
            ? 'Composite Final (Merged)'
            : `Final (${pc.active.length})`;
        compBadgeClass = 'p3h-badge-final';
      } else if (pc.isCompositeSibling && pc.groupHasCf) {
        actCategoryKey = 'final';
        compBadgeText = 'Merged in Composite Final';
        compBadgeClass = 'p3h-badge-final';
      } else if (pc.hasPreFinalBill) {
        actCategoryKey = 'prefinal_only';
        compBadgeText = pc.groupHasCf ? 'Pre-Final (Merged)' : 'Pre-Final (Component Final)';
        compBadgeClass = pc.groupHasCf ? 'p3h-badge-final' : 'p3h-badge-part';
      } else if (pc.mbookClosedNoFinal && pc.partBillsInComp.length === 0) {
        actCategoryKey = 'mbook_closed_no_final';
        compBadgeText = 'M-Book Closed (No Final)';
        compBadgeClass = 'p3h-badge-mbook-closed';
      } else if (pc.mbookClosedNoFinal && pc.partBillsInComp.length > 0) {
        actCategoryKey = 'part_only';
        compBadgeText = `M-Book Closed + ${pc.partBillsInComp.length} Part (No Final)`;
        compBadgeClass = 'p3h-badge-mbook-closed';
      } else if (pc.partBillsInComp.length > 0) {
        actCategoryKey = 'part_only';
        compBadgeText = `Part Bills (${pc.partBillsInComp.length})`;
        compBadgeClass = 'p3h-badge-part';
      } else if (!c.hasEBillStage) {
        if (c.hasPostTender || c.hasSiteHandover || c.hasEmbook) {
          actCategoryKey = 'nobill';
          compBadgeText = c.stageName || 'Post-Tender (No e-Bills)';
          compBadgeClass = 'p3h-badge-nobill';
        } else {
          actCategoryKey = 'dpr';
          compBadgeText = 'DPR Only';
          compBadgeClass = 'p3h-badge-dpr';
        }
      } else if (pc.drafts.length > 0 && pc.active.length === 0) {
        actCategoryKey = 'nobill';
        compBadgeText = `Draft Only (${pc.drafts.length})`;
        compBadgeClass = 'p3h-badge-nobill';
      } else if (pc.cancelled.length > 0 && pc.active.length === 0) {
        actCategoryKey = 'cancelled';
        compBadgeText = `Cancelled (${pc.cancelled.length})`;
        compBadgeClass = 'p3h-badge-cancelled';
      } else {
        actCategoryKey = 'nobill';
        compBadgeText = 'No Bills';
        compBadgeClass = 'p3h-badge-nobill';
      }

      return {
        ...c,
        activityName: pc.activityName,
        estimateCode: pc.estimateCode,
        activityKey: pc.activityKey,
        isHelper: pc.isHelper,
        isCompositeFinal: pc.isCompositeFinalComp,
        isCompositeGroupMember: pc.isCompositeGroupMember,
        isCompositeSibling: pc.isCompositeSibling,
        groupHasCf: pc.groupHasCf,
        isDeactivated: pc.isComponentDeactivated,
        isExecutionActivity: pc.isExecutionActivity,
        isFinalized: pc.isFinalized,
        isTerminallySubmitted,
        isMbookClosed: pc.isMbookClosed,
        isMbookOpen: pc.isMbookOpen,
        mbookClosedNoFinal: pc.mbookClosedNoFinal,
        isManuallyArchived: pc.isManuallyArchived,
        manualArchive: pc.effectiveManualArchive,
        lifecycleState,
        categoryKey: actCategoryKey,
        draftCount: pc.drafts.length,
        compTotalActiveAmount: pc.compTotalActiveAmount,
        bills: pc.bills,
        compBadgeText,
        compBadgeClass,
      };
    });

    const nonHelper = analyzedComps.filter((c) => !c.isHelper);
    const hasAnyExecution = nonHelper.some((c) => c.isExecutionActivity && !c.isDeactivated);
    analyzedComps.forEach((c) => {
      c.isDeactivatedDpr = Boolean(
        c.isDeactivated || (!c.isHelper && hasAnyExecution && !c.isExecutionActivity)
      );
    });

    const allBills = [];
    const nonArchivedBills = [];
    let ebillCompCount = 0;
    let finalizedEBillCompCount = 0;
    let mbookClosedNoFinalCount = 0;
    let hasAnyBillsFetchFailed = false;

    analyzedComps.forEach((c) => {
      if (c.isHelper || c.isDeactivated || c.isDeactivatedDpr) return;
      if (c._billsFetchFailed && !c.isManuallyArchived) {
        hasAnyBillsFetchFailed = true;
      }
      if (c.hasEBillStage && !c.isManuallyArchived) {
        ebillCompCount++;
        if (c.isFinalized) finalizedEBillCompCount++;
      }
      if (c.mbookClosedNoFinal && !c.isManuallyArchived) {
        mbookClosedNoFinalCount++;
      }
      (c.bills || []).forEach((b) => {
        allBills.push(b);
        if (!c.isManuallyArchived) nonArchivedBills.push(b);
      });
    });

    const activeNonHelper = nonHelper.filter((c) => !c.isDeactivatedDpr);
    const nonDeactivatedAny = analyzedComps.filter((c) => !c.isDeactivated && !c.isDeactivatedDpr);
    const allNonHelperDeactivated =
      nonHelper.length > 0 && nonHelper.every((c) => c.isDeactivated);

    const activities = allNonHelperDeactivated
      ? []
      : activeNonHelper.length > 0
      ? activeNonHelper
      : nonDeactivatedAny;

    const isCompositeWork = Boolean(
      groupsWithCfComp.size > 0 ||
        workHasCompositeFinal ||
        activities.some((a) => a.isCompositeGroupMember || a.isCompositeFinal)
    );
    const singleCompositeGroup =
      activities.length > 1 &&
      activities.every((a) => a.isCompositeGroupMember || a.isCompositeFinal) &&
      new Set(activities.map((a) => (a.workGroup || '').toLowerCase())).size === 1;
    const hasIndependentActivities = activities.length > 1 && !singleCompositeGroup;
    const nonArchivedActivities = activities.filter((a) => !a.isManuallyArchived);
    const isFullyManuallyArchived = Boolean(
      workManualArchive || (activities.length > 0 && nonArchivedActivities.length === 0)
    );
    const hasAnyManualArchive = Boolean(
      workManualArchive || activities.some((a) => a.isManuallyArchived)
    );

    const execPool = nonArchivedActivities.filter((a) => a.isExecutionActivity);
    const rawTrackable = execPool.length > 0 ? execPool : nonArchivedActivities;
    const compositeGroupsWithSiblings = new Set();
    rawTrackable.forEach((a) => {
      if (a.isCompositeSibling) compositeGroupsWithSiblings.add((a.workGroup || '').toLowerCase());
    });
    const effectiveTrackable = rawTrackable.filter((a) => {
      const gk = (a.workGroup || '').toLowerCase();
      if (a.groupHasCf && a.isCompositeSibling) return false;
      if (!a.groupHasCf && a.isCompositeFinal && compositeGroupsWithSiblings.has(gk)) return false;
      return true;
    });

    const trackableCompCount = effectiveTrackable.length;
    const finalizedTrackableCompCount = effectiveTrackable.filter((a) => a.isFinalized).length;
    const isFullyFinalized =
      !isFullyManuallyArchived &&
      !allNonHelperDeactivated &&
      trackableCompCount > 0 &&
      finalizedTrackableCompCount >= trackableCompCount;
    const hasPartialFinal =
      !isFullyManuallyArchived &&
      !allNonHelperDeactivated &&
      finalizedTrackableCompCount > 0 &&
      finalizedTrackableCompCount < trackableCompCount;

    const activePoolComps = isFullyManuallyArchived ? allBills : nonArchivedBills;
    const hasEBillStage = ebillCompCount > 0;
    const hasPostTenderStage = analyzedComps.some(
      (c) =>
        !c.isManuallyArchived &&
        !c.isHelper &&
        !c.isDeactivated &&
        !c.isDeactivatedDpr &&
        (c.hasEBillStage || c.hasPostTender || c.hasSiteHandover || c.hasEmbook || c.isMbookClosed)
    );
    const active = activePoolComps.filter((b) => !b.isCancelled && !b.isDraft);
    const billableActive = active.filter((b) => b.includedInWorkTotal);
    const finals = active.filter((b) => b.kind === 'Final');
    const preFinals = active.filter((b) => b.kind === 'Pre-Final');
    const parts = active.filter((b) => b.kind === 'Part');
    const drafts = activePoolComps.filter((b) => b.isDraft);
    const cancelled = activePoolComps.filter((b) => b.isCancelled);
    const totalActiveAmount = billableActive.reduce((acc, b) => acc + parseInr(b.grandTotal), 0);
    const hasAnyFinal = finals.length > 0;
    const hasFinal = isFullyFinalized;

    let categoryKey = 'nobill';
    let label = 'No Bills';
    let badgeClass = 'p3h-badge-nobill';

    if (isFullyManuallyArchived) {
      categoryKey = 'manually_archived';
      label = 'Manually Archived';
      badgeClass = 'p3h-badge-manual-arch';
    } else if (allNonHelperDeactivated) {
      categoryKey = 'deactivated';
      label = 'Deactivated';
      badgeClass = 'p3h-badge-cancelled';
    } else if (isFullyFinalized) {
      categoryKey = 'final';
      if (workHasCompositeFinal && parts.length > 0) {
        label = `Composite Final + ${parts.length} Part`;
      } else if (workHasCompositeFinal) {
        label = 'Composite Final (Merged)';
      } else if (parts.length > 0) {
        label = `Final + ${parts.length} Part`;
      } else {
        label = 'Final Bill Generated';
      }
      badgeClass = 'p3h-badge-final';
    } else if (hasPartialFinal) {
      categoryKey = 'partial_final';
      label = `Partial Final (${finalizedTrackableCompCount}/${trackableCompCount})`;
      if (mbookClosedNoFinalCount > 0) {
        label += ` · ${mbookClosedNoFinalCount} M-Book Closed`;
      }
      badgeClass = 'p3h-badge-part';
    } else if (preFinals.length > 0) {
      categoryKey = 'prefinal_only';
      label = 'Pre-Final (Awaiting Composite Final)';
      badgeClass = 'p3h-badge-part';
    } else if (mbookClosedNoFinalCount > 0 && parts.length === 0) {
      categoryKey = 'mbook_closed_no_final';
      label = 'M-Book Closed (No Final Bill)';
      badgeClass = 'p3h-badge-mbook-closed';
    } else if (parts.length > 0) {
      categoryKey = 'part_only';
      label =
        `${parts.length} Part Bill(s) (No Final)` +
        (mbookClosedNoFinalCount > 0 ? ' · M-Book Closed' : '');
      badgeClass = 'p3h-badge-part';
    } else if (drafts.length > 0) {
      categoryKey = 'nobill';
      label = 'Draft Bill Only';
      badgeClass = 'p3h-badge-nobill';
    } else if (cancelled.length > 0) {
      categoryKey = 'cancelled';
      label = 'Cancelled Bill Only';
      badgeClass = 'p3h-badge-cancelled';
    } else if (!hasEBillStage && !hasPostTenderStage) {
      categoryKey = 'dpr';
      label = 'DPR / Pre-Tender';
      badgeClass = 'p3h-badge-dpr';
    }

    const latestPool = billableActive.length ? billableActive : active.length ? active : allBills;
    const latestBill = pickLatestBill(latestPool);
    const activityNames = uniqArr(activities.map((a) => a.activityName).filter(Boolean));
    const activeOpenMbookActivities = nonArchivedActivities.filter(
      (a) => !a.isFinalized && a.isMbookOpen
    );

    return {
      scanned: true,
      categoryKey,
      label,
      badgeClass,
      hasAnyBills: allBills.length > 0,
      hasAnyBillsFetchFailed,
      allNonHelperDeactivated,
      hasFinal,
      isFullyFinalized,
      hasPartialFinal,
      hasAnyFinal,
      hasPart: parts.length > 0,
      hasPreFinal: preFinals.length > 0,
      hasCompositeFinal: workHasCompositeFinal,
      isCompositeWork,
      hasIndependentActivities,
      hasMbookClosedNoFinal: mbookClosedNoFinalCount > 0,
      mbookClosedNoFinalCount,
      isFullyManuallyArchived,
      hasAnyManualArchive,
      partCount: parts.length,
      preFinalCount: preFinals.length,
      finalCount: finals.length,
      draftCount: drafts.length,
      cancelledCount: cancelled.length,
      ebillCompCount,
      finalizedEBillCompCount,
      trackableCompCount,
      finalizedTrackableCompCount,
      totalActiveAmount,
      latestBill,
      components: analyzedComps,
      activities,
      activityNames,
      activeOpenMbookActivities,
    };
  }

  function summarizeWork(workRecord) {
    return analyzeWorkRecord(workRecord);
  }

  function getMissingFields(workRecord, summary) {
    const sum = summary || analyzeWorkRecord(workRecord);
    if (!workRecord || !sum.scanned) {
      return { isIncomplete: true, missing: ['Not Scanned'], needsV3Upgrade: true };
    }
    const pd = workRecord.projectDetails;
    if (!pd || !pd.fetchedAt) {
      return { isIncomplete: true, missing: ['Project Details'], needsV3Upgrade: true };
    }

    const missing = [];
    const needsV3Upgrade = !pd.extractorVersion || pd.extractorVersion < EXTRACTOR_VERSION;
    if (needsV3Upgrade) missing.push('Needs Refresh (M-Book/Activities)');

    const comps = (sum.components || []).filter(
      (c) => !c.isHelper && !c.isDeactivated && !c.isDeactivatedDpr && !c.isManuallyArchived
    );
    if ((sum.allNonHelperDeactivated || comps.length === 0) && !needsV3Upgrade) {
      return { isIncomplete: false, missing: [], needsV3Upgrade: false };
    }

    if (!pd.constituency) missing.push('Constituency');
    if (!pd.periodText) missing.push('Period');

    const pastDpr =
      sum.categoryKey !== 'dpr' ||
      comps.some(
        (c) => c.hasPreTender || c.hasPostTender || c.hasSiteHandover || c.hasEmbook || c.hasEBillStage
      );
    if (pastDpr) {
      if (!pd.asNo) missing.push('AS No.');
      if (!pd.tsNo) missing.push('TS No.');
    }

    const hasExecutionStage =
      comps.some((c) => c.hasPostTender || c.hasSiteHandover || c.hasEmbook || c.hasEBillStage) ||
      sum.hasAnyBills;
    if (hasExecutionStage) {
      if (!(pd.contractor && pd.contractor.name)) missing.push('Contractor');
      if (!pd.shoDate) missing.push('SHO Date');
      if (pd.hasLoa && !pd.agreementNo && !pd.isUrgentPreAgreement) {
        missing.push('Agreement No.');
      }
    }

    const nonArchivedActivities = (sum.activities || []).filter((a) => !a.isManuallyArchived);
    if (nonArchivedActivities.length > 1) {
      const missingActDetails = nonArchivedActivities.some((a) => !a.details || !a.details.fetchedAt);
      if (missingActDetails) missing.push('Activity Details');
    }

    return {
      isIncomplete: missing.length > 0,
      missing,
      needsV3Upgrade,
    };
  }

  // -------------------------------------------------------------------------
  // Full Work & Per-Activity Live Portal Fetcher (Wave-Barrier Batched & Token-Safe)
  // -------------------------------------------------------------------------

  function createEmptyDetails(comp) {
    const hoIds = (comp && comp.handoverEstIds) || [];
    const basicIds = (comp && comp.basicEstIds) || [];
    const handoverEstId = hoIds.length ? hoIds[hoIds.length - 1] : '';
    const basicEstId = basicIds.length ? basicIds[basicIds.length - 1] : '';
    const loaList = (comp && comp.loaCalls) || [];
    const lastLoa = loaList.length ? loaList[loaList.length - 1] : null;
    const sbdList = (comp && comp.sbdIds) || [];

    return {
      fetchedAt: new Date().toISOString(),
      extractorVersion: EXTRACTOR_VERSION,
      primaryEstId: handoverEstId || basicEstId || '',
      handoverEstId,
      sbdId: sbdList.length ? sbdList[sbdList.length - 1] : '',
      postTenderId: lastLoa ? lastLoa.posttenderid : '',
      cwEstId: lastLoa ? lastLoa.cwEstId : '',
      hasLoa: loaList.length > 0,
      isUrgentPreAgreement: false,
      asNo: '',
      asDate: '',
      asAmount: '',
      asAuthority: '',
      tsNo: '',
      tsDate: '',
      tsAmount: '',
      tsAuthority: '',
      agreementNo: '',
      agreementDate: '',
      agreedPac: '',
      estimatePac: '',
      negotiatedRate: '',
      executionOffice: '',
      contractor: {
        name: '',
        pan: '',
        mobile: '',
        email: '',
        applicantType: '',
        licenseSource: '',
      },
      periodYears: 0,
      periodMonths: 0,
      periodDays: 0,
      periodText: '',
      workPriority: '',
      workExecutionMode: '',
      contractorSignedDate: '',
      handoverInitiatedDate: '',
      handoverCountersignedDate: '',
      wcaShoDate: '',
      deemedShoDate: '',
      shoDate: '',
      completionDate: '',
      constituency: '',
      parliamentConstituency: '',
      mbookStatus: '',
      wcaStage: '',
    };
  }

  function formatWcaStageText(wca) {
    if (!wca) return '';
    return uniqArr([
      wca.mbookCurrentStage,
      wca.mbookCurrentTask,
      wca.estimateStage,
      wca.estimateTask,
      wca.ebillStatus,
    ])
      .filter(Boolean)
      .join(' | ');
  }

  function buildDirectEagreementParams(comp, fileId, loa) {
    if (!comp || !loa) return null;
    const posttenderid = String(loa.posttenderid || '').trim();
    const fid = String(fileId || '').trim();
    const mbIds = comp.mbookActivityIds || [];
    const workactivityid = mbIds.length ? String(mbIds[mbIds.length - 1]).trim() : '';
    const hoIds = comp.handoverEstIds || [];
    const basicIds = comp.basicEstIds || [];
    const estid = String(
      (hoIds.length ? hoIds[hoIds.length - 1] : '') ||
        (basicIds.length ? basicIds[basicIds.length - 1] : '') ||
        ''
    ).trim();
    const estmainid = String(comp.estmainid || comp.reEstMainId || '').trim();
    const cwEstId = String(
      (hoIds.length ? hoIds[hoIds.length - 1] : '') || loa.cwEstId || estid || ''
    ).trim();
    if (!posttenderid || !fid || !workactivityid || !estid || !estmainid) {
      return null;
    }
    return {
      posttenderid,
      fileid: fid,
      workactivityid,
      estid,
      estmainid,
      cwEstId,
    };
  }

  function buildLoaPostParams(loa) {
    const params = { posttenderid: String(loa.posttenderid) };
    if (loa.cwEstId) {
      params.cwEstId = String(loa.cwEstId);
      params.estId = String(loa.cwEstId);
    }
    return params;
  }

  function mergeParsedAsTs(details, parsedAsTs) {
    if (!parsedAsTs) return;
    if (!details.asNo && parsedAsTs.asNo) details.asNo = parsedAsTs.asNo;
    if (!details.asDate && parsedAsTs.asDate) details.asDate = parsedAsTs.asDate;
    if (!details.asAmount && parsedAsTs.asAmount) details.asAmount = parsedAsTs.asAmount;
    if (!details.asAuthority && parsedAsTs.asAuthority) details.asAuthority = parsedAsTs.asAuthority;
    if (!details.tsNo && parsedAsTs.tsNo) details.tsNo = parsedAsTs.tsNo;
    if (!details.tsDate && parsedAsTs.tsDate) details.tsDate = parsedAsTs.tsDate;
    if (!details.tsAmount && parsedAsTs.tsAmount) details.tsAmount = parsedAsTs.tsAmount;
    if (!details.tsAuthority && parsedAsTs.tsAuthority) details.tsAuthority = parsedAsTs.tsAuthority;
  }

  function applyEagDataToDetails(details, eagData, posttenderid, cwEstId) {
    if (!eagData) return;
    details.postTenderId = posttenderid || details.postTenderId;
    details.cwEstId = cwEstId || details.cwEstId;
    if (eagData.agreementNo) details.agreementNo = eagData.agreementNo;
    if (eagData.agreementDate) details.agreementDate = eagData.agreementDate;
    if (eagData.agreedPac) details.agreedPac = eagData.agreedPac;
    if (eagData.estimatePac) details.estimatePac = eagData.estimatePac;
    if (eagData.negotiatedRate) details.negotiatedRate = eagData.negotiatedRate;
    if (eagData.executionOffice) details.executionOffice = eagData.executionOffice;
    if (eagData.contractor && eagData.contractor.name) {
      details.contractor = { ...eagData.contractor };
    }
  }

  function applyCompStateFromCache(st, workCtx, anchorDetails, responseCache, includeDetails) {
    const rawComp = st.rawComp;
    const inheritShared = Boolean(anchorDetails && st.isCompositeSibling);

    // Always evaluate M-Book / WCA status (both full scan and quick M-Book refresh)
    if (st.isTrackable && st.mbRev.length > 0) {
      let resolvedMb = '';
      let resolvedWcaStage = '';
      let resolvedWcaSho = '';
      let resolvedAsOn = '';
      let resolvedAsBy = '';
      let resolvedTsOn = '';
      let resolvedTsBy = '';
      let sawFreshWcaOrMb = false;

      for (let i = 0; i < st.mbRev.length; i++) {
        const mbId = st.mbRev[i];
        const wcaHtml = responseCache.get(
          makeRequestKey('work_component_analysis.pro', { workactivityId: mbId })
        );
        if (wcaHtml) {
          sawFreshWcaOrMb = true;
          const wca = parseWorkComponentAnalysisHtml(wcaHtml);
          if (!resolvedMb && wca.mbookStatus) resolvedMb = wca.mbookStatus;
          const stageStr = formatWcaStageText(wca);
          if (!resolvedWcaStage && stageStr) resolvedWcaStage = stageStr;
          if (!resolvedWcaSho && wca.wcaShoDate) resolvedWcaSho = wca.wcaShoDate;
          if (!resolvedAsOn && wca.asApprovedOn) resolvedAsOn = wca.asApprovedOn;
          if (!resolvedAsBy && wca.asApprovedBy) resolvedAsBy = wca.asApprovedBy;
          if (!resolvedTsOn && wca.tsApprovedOn) resolvedTsOn = wca.tsApprovedOn;
          if (!resolvedTsBy && wca.tsApprovedBy) resolvedTsBy = wca.tsApprovedBy;
        }
        if (!resolvedMb) {
          const mvHtml = responseCache.get(makeRequestKey('mbook_view.pro', { activityid: mbId }));
          if (mvHtml) {
            sawFreshWcaOrMb = true;
            if (parseMbookViewClosedHtml(mvHtml)) {
              resolvedMb = 'Closed';
            }
          }
        }
        if (resolvedMb || resolvedWcaStage) break;
      }

      if (sawFreshWcaOrMb) {
        if (resolvedMb) st.mbookStatus = resolvedMb;
        if (resolvedWcaStage) st.wcaStage = resolvedWcaStage;
        if (!st.fetchMeta && st.details) {
          st.details = {
            ...st.details,
            ...(resolvedMb ? { mbookStatus: resolvedMb } : {}),
            ...(resolvedWcaStage ? { wcaStage: resolvedWcaStage } : {}),
          };
        }
      }
      st.wcaMeta = {
        mbookStatus: resolvedMb || st.mbookStatus || '',
        wcaStage: resolvedWcaStage || st.wcaStage || '',
        wcaShoDate: resolvedWcaSho,
        asApprovedOn: resolvedAsOn,
        asApprovedBy: resolvedAsBy,
        tsApprovedOn: resolvedTsOn,
        tsApprovedBy: resolvedTsBy,
      };
    }

    if (!st.fetchMeta) {
      return st.details;
    }

    const d = createEmptyDetails(rawComp);
    const wcaMeta = st.wcaMeta || {};
    if (wcaMeta.mbookStatus) d.mbookStatus = wcaMeta.mbookStatus;
    if (wcaMeta.wcaStage) d.wcaStage = wcaMeta.wcaStage;
    if (wcaMeta.wcaShoDate) d.wcaShoDate = wcaMeta.wcaShoDate;

    // 1. Period of Completion & Constituency
    if (inheritShared && anchorDetails.periodText) {
      d.periodYears = anchorDetails.periodYears || 0;
      d.periodMonths = anchorDetails.periodMonths || 0;
      d.periodDays = anchorDetails.periodDays || 0;
      d.periodText = anchorDetails.periodText || '';
      d.workPriority = anchorDetails.workPriority || '';
      d.workExecutionMode = anchorDetails.workExecutionMode || '';
    } else if (st.estIdForAttr) {
      const pHtml = responseCache.get(
        makeRequestKey('addattribute_view.pro', { estid: st.estIdForAttr })
      );
      if (pHtml) Object.assign(d, parsePeriodHtml(pHtml));
    }

    if (inheritShared && anchorDetails.constituency) {
      d.constituency = anchorDetails.constituency || '';
      d.parliamentConstituency = anchorDetails.parliamentConstituency || '';
    } else if (st.estIdForAttr) {
      const cHtml = responseCache.get(
        makeRequestKey('addattribute_constituency_view.pro', { estid: st.estIdForAttr })
      );
      if (cHtml) Object.assign(d, parseConstituencyHtml(cHtml));
    }

    // 2. AS & TS Details (generatedraft.pro + WCA fallbacks)
    if (inheritShared && anchorDetails.asNo && anchorDetails.tsNo) {
      d.sbdId = anchorDetails.sbdId || d.sbdId;
      d.asNo = anchorDetails.asNo;
      d.asDate = anchorDetails.asDate;
      d.asAmount = anchorDetails.asAmount;
      d.asAuthority = anchorDetails.asAuthority;
      d.tsNo = anchorDetails.tsNo;
      d.tsDate = anchorDetails.tsDate;
      d.tsAmount = anchorDetails.tsAmount;
      d.tsAuthority = anchorDetails.tsAuthority;
    } else {
      for (let i = 0; i < st.sbdRev.length; i++) {
        const sbdId = st.sbdRev[i];
        const sbdHtml = responseCache.get(makeRequestKey('generatedraft.pro', { sbdId }));
        if (!sbdHtml) continue;
        mergeParsedAsTs(d, parseAsTsHtml(sbdHtml));
        if (d.asNo && d.tsNo) {
          d.sbdId = sbdId;
          break;
        }
      }
      if (!d.asDate && wcaMeta.asApprovedOn) d.asDate = wcaMeta.asApprovedOn;
      if (!d.asAuthority && wcaMeta.asApprovedBy) d.asAuthority = wcaMeta.asApprovedBy;
      if (!d.tsDate && wcaMeta.tsApprovedOn) d.tsDate = wcaMeta.tsApprovedOn;
      if (!d.tsAuthority && wcaMeta.tsApprovedBy) d.tsAuthority = wcaMeta.tsApprovedBy;
    }

    // 3. Agreement & Contractor (Direct calleagreement -> LOA fallback -> Negotiated Rate + Bidder)
    if (inheritShared && anchorDetails.contractor && anchorDetails.contractor.name) {
      d.agreementNo = anchorDetails.agreementNo;
      d.agreementDate = anchorDetails.agreementDate;
      d.agreedPac = anchorDetails.agreedPac || d.agreedPac;
      d.estimatePac = anchorDetails.estimatePac || d.estimatePac;
      d.negotiatedRate = anchorDetails.negotiatedRate;
      d.executionOffice = anchorDetails.executionOffice;
      d.contractor = { ...anchorDetails.contractor };
      d.postTenderId = anchorDetails.postTenderId;
      d.cwEstId = anchorDetails.cwEstId;
      d.hasLoa = anchorDetails.hasLoa;
      d.isUrgentPreAgreement = anchorDetails.isUrgentPreAgreement;
    } else {
      let resolvedAgreement = false;
      if (st.directEagAttempt) {
        const directHtml = responseCache.get(st.directEagAttempt.key);
        if (directHtml) {
          const eagData = parseAgreementAndContractorHtml(directHtml);
          applyEagDataToDetails(
            d,
            eagData,
            st.directEagAttempt.loa.posttenderid,
            st.directEagAttempt.params.cwEstId
          );
          if (d.agreementNo || (d.contractor && d.contractor.name)) {
            resolvedAgreement = true;
          }
        }
      }

      if (!resolvedAgreement) {
        for (let i = 0; i < st.loaRev.length; i++) {
          const loa = st.loaRev[i];
          const loaHtml = responseCache.get(makeRequestKey('loa.pro', buildLoaPostParams(loa)));
          if (!loaHtml) continue;
          const eagParams = parseLoaEagreementParams(loaHtml, {
            ...loa,
            handoverEstId: st.handoverEstId,
          });
          if (!eagParams) continue;
          const eagHtml = responseCache.get(makeRequestKey('calleagreement.pro', eagParams));
          if (!eagHtml) continue;
          const eagData = parseAgreementAndContractorHtml(eagHtml);
          applyEagDataToDetails(
            d,
            eagData,
            loa.posttenderid,
            eagParams.cwEstId || loa.cwEstId || ''
          );
          if (d.agreementNo || (d.contractor && d.contractor.name)) {
            resolvedAgreement = true;
            break;
          }
        }
      }

      if (!d.contractor.name && st.ptSbdRev.length > 0) {
        for (let i = 0; i < st.ptSbdRev.length; i++) {
          const sbdid = st.ptSbdRev[i];
          const negHtml = responseCache.get(makeRequestKey('negotiatedetilsview.pro', { sbdid }));
          const neg = negHtml ? parseNegotiatedRateHtml(negHtml) : null;
          if (!neg || !neg.contractorName) continue;

          d.contractor.name = neg.contractorName;
          if (neg.contractorPan) d.contractor.pan = neg.contractorPan;
          if (neg.negotiatedRate) d.negotiatedRate = neg.negotiatedRate;
          if (neg.estimatePac && !d.estimatePac) d.estimatePac = neg.estimatePac;
          if (parseInr(neg.negotiatedPac) > 0 && !d.agreedPac) {
            d.agreedPac = neg.negotiatedPac;
          }

          const ptHtml = responseCache.get(makeRequestKey('posttendermain.pro', { sbdid }));
          const ptIds = ptHtml ? parsePostTenderIdsHtml(ptHtml) : null;
          if (ptIds && ptIds.ptid) {
            d.postTenderId = d.postTenderId || ptIds.ptid;
            const bHtml = responseCache.get(
              makeRequestKey('bidderview.pro', {
                ptid: ptIds.ptid,
                sbdid: ptIds.sbdid || sbdid,
              })
            );
            const bInfo = bHtml
              ? parseBidderViewHtml(bHtml, neg.contractorPan, neg.contractorName)
              : null;
            if (bInfo) {
              if (!d.contractor.name && bInfo.name) d.contractor.name = bInfo.name;
              if (!d.contractor.pan && bInfo.pan) d.contractor.pan = bInfo.pan;
              if (bInfo.mobile) d.contractor.mobile = bInfo.mobile;
              if (bInfo.email) d.contractor.email = bInfo.email;
              if (bInfo.applicantType) d.contractor.applicantType = bInfo.applicantType;
            }
          }
          break;
        }
      }

      d.isUrgentPreAgreement = Boolean(!d.hasLoa && /urgent/i.test(d.workPriority || ''));
    }

    // 4. Fallback for TS & Agreed PAC via pricehandeover.do
    if (inheritShared && anchorDetails.tsNo && anchorDetails.agreedPac) {
      if (!d.tsNo) d.tsNo = anchorDetails.tsNo;
      if (!d.tsDate) d.tsDate = anchorDetails.tsDate;
      if (!d.tsAmount) d.tsAmount = anchorDetails.tsAmount || '';
      if (!d.tsAuthority) d.tsAuthority = anchorDetails.tsAuthority;
      if (!d.agreedPac) d.agreedPac = anchorDetails.agreedPac;
      if (!d.estimatePac) d.estimatePac = anchorDetails.estimatePac || '';
    } else if (!d.tsNo || !d.tsDate || !d.tsAmount || !d.agreedPac) {
      for (let i = 0; i < st.hoRev.length; i++) {
        const phHtml = responseCache.get(
          makeRequestKey('pricehandeover.do', { estid: st.hoRev[i] })
        );
        if (!phHtml) continue;
        const fb = parseTsFromHandoverHtml(phHtml);
        if (!d.tsNo && fb.tsNo) d.tsNo = fb.tsNo;
        if (!d.tsDate && fb.tsDate) d.tsDate = fb.tsDate;
        if (!d.tsAmount && fb.tsAmount) d.tsAmount = fb.tsAmount;
        if (!d.tsAuthority && fb.tsAuthority) d.tsAuthority = fb.tsAuthority;
        if (!d.agreedPac && fb.agreedPac) d.agreedPac = fb.agreedPac;
        if (!d.estimatePac && fb.estimatePac) d.estimatePac = fb.estimatePac;
        if (d.tsNo && d.agreedPac) break;
      }
    }

    // 5. Site Handing Over History & Effective SHO Date
    if (inheritShared && anchorDetails.shoDate) {
      d.contractorSignedDate = anchorDetails.contractorSignedDate;
      d.handoverInitiatedDate = anchorDetails.handoverInitiatedDate;
      d.handoverCountersignedDate = anchorDetails.handoverCountersignedDate;
      d.wcaShoDate = d.wcaShoDate || anchorDetails.wcaShoDate;
      d.deemedShoDate = anchorDetails.deemedShoDate;
      d.shoDate = anchorDetails.shoDate;
    } else {
      for (let i = 0; i < st.hoRev.length; i++) {
        const hhHtml = responseCache.get(
          makeRequestKey('handoverhistory.pro', { estid: st.hoRev[i] })
        );
        if (!hhHtml) continue;
        const hh = parseHandoverHistoryHtml(hhHtml);
        if (hh.contractorSignedDate || hh.handoverInitiatedDate || hh.handoverCountersignedDate) {
          d.contractorSignedDate = hh.contractorSignedDate;
          d.handoverInitiatedDate = hh.handoverInitiatedDate;
          d.handoverCountersignedDate = hh.handoverCountersignedDate;
          break;
        }
      }
    }

    const resolvedSched = resolveScheduleDates(d, null);
    d.deemedShoDate = resolvedSched.deemedShoDate;
    d.shoDate = resolvedSched.shoDate;
    d.completionDate = resolvedSched.completionDate;

    st.details = d;
    if (!includeDetails && st.existingComp) {
      st.mbookStatus = d.mbookStatus || st.mbookStatus;
      st.wcaStage = d.wcaStage || st.wcaStage;
    }
    return d;
  }

  function rollupProjectDetails(anchorDetails, activityDetailsList) {
    const base = anchorDetails
      ? { ...anchorDetails, contractor: { ...(anchorDetails.contractor || {}) } }
      : createEmptyDetails(null);

    const fillIfEmpty = (src) => {
      if (!src) return;
      const scalarKeys = [
        'asNo',
        'asDate',
        'asAmount',
        'asAuthority',
        'tsNo',
        'tsDate',
        'tsAmount',
        'tsAuthority',
        'agreementNo',
        'agreementDate',
        'agreedPac',
        'estimatePac',
        'negotiatedRate',
        'executionOffice',
        'constituency',
        'parliamentConstituency',
        'shoDate',
        'deemedShoDate',
        'contractorSignedDate',
        'handoverInitiatedDate',
        'handoverCountersignedDate',
        'wcaShoDate',
        'completionDate',
        'workPriority',
        'workExecutionMode',
      ];
      scalarKeys.forEach((k) => {
        if (!base[k] && src[k]) base[k] = src[k];
      });
      if (!hasPositivePeriodTuple(base) && (hasPositivePeriodTuple(src) || (!base.periodText && src.periodText))) {
        base.periodYears = src.periodYears || 0;
        base.periodMonths = src.periodMonths || 0;
        base.periodDays = src.periodDays || 0;
        base.periodText = src.periodText || base.periodText || '';
      }
      if (src.contractor) {
        Object.keys(src.contractor).forEach((ck) => {
          if (!base.contractor[ck] && src.contractor[ck]) {
            base.contractor[ck] = src.contractor[ck];
          }
        });
      }
      if (src.hasLoa) base.hasLoa = true;
      if (src.isUrgentPreAgreement && !base.hasLoa) base.isUrgentPreAgreement = true;
    };

    (activityDetailsList || []).forEach(fillIfEmpty);
    const sched = resolveScheduleDates(base, null);
    base.deemedShoDate = sched.deemedShoDate || base.deemedShoDate;
    base.shoDate = sched.shoDate || base.shoDate;
    base.completionDate = sched.completionDate || base.completionDate;
    base.periodText = sched.periodText || base.periodText;
    base.fetchedAt = new Date().toISOString();
    base.extractorVersion = EXTRACTOR_VERSION;
    return base;
  }

  function buildCompState(rawComp, existingComp, anchorComp, fileId, includeDetails, existingRecord) {
    const basicIds = rawComp.basicEstIds || [];
    const hoIds = rawComp.handoverEstIds || [];
    const mbIds = rawComp.mbookActivityIds || [];
    const estIdForAttr =
      (basicIds.length ? basicIds[basicIds.length - 1] : '') ||
      (hoIds.length ? hoIds[hoIds.length - 1] : '') ||
      '';
    const handoverEstId = hoIds.length ? hoIds[hoIds.length - 1] : '';
    const isCompositeSibling = Boolean(
      anchorComp &&
        anchorComp.isCompositeFinal &&
        rawComp !== anchorComp &&
        !rawComp.isHelper &&
        !rawComp.isDeactivated &&
        (rawComp.workGroup || '').toLowerCase() === (anchorComp.workGroup || '').toLowerCase() &&
        (rawComp.isCompositeFinal || /^composite\b/i.test(rawComp.activityName || ''))
    );
    const isAnchor = rawComp === anchorComp;
    const isTrackable = !rawComp.isHelper && !rawComp.isDeactivated;
    const hasExistingPd = Boolean(
      existingRecord && existingRecord.projectDetails && existingRecord.projectDetails.fetchedAt
    );
    const fetchMeta = Boolean(isTrackable && (includeDetails || (isAnchor && !hasExistingPd)));
    const ebillIds =
      rawComp.isDeactivated || rawComp.isHelper || !rawComp.hasEBillStage
        ? []
        : uniqArr([...(rawComp.ebillEstMainIds || []), rawComp.estmainid]);

    return {
      rawComp,
      existingComp,
      fileId,
      isAnchor,
      isCompositeSibling,
      isTrackable,
      fetchMeta,
      estIdForAttr,
      handoverEstId,
      sbdRev: [...(rawComp.sbdIds || [])].reverse(),
      mbRev: [...mbIds].reverse(),
      hoRev: [...hoIds].reverse(),
      loaRev: [...(rawComp.loaCalls || [])].reverse(),
      ptSbdRev: [...(rawComp.postTenderSbdIds || [])].reverse(),
      ebillIds,
      directEagAttempt: null,
      loaAttemptedAll: false,
      eagPending: false,
      details: existingComp && existingComp.details ? existingComp.details : null,
      mbookStatus: !includeDetails && existingComp && existingComp.mbookStatus ? existingComp.mbookStatus : '',
      wcaStage: !includeDetails && existingComp && existingComp.wcaStage ? existingComp.wcaStage : '',
      wcaMeta: null,
    };
  }

  function applyWorkFromCache(workCtx, responseCache, includeDetails) {
    let anchorDetails = null;
    if (workCtx.anchorState && workCtx.anchorState.fetchMeta) {
      anchorDetails = applyCompStateFromCache(
        workCtx.anchorState,
        workCtx,
        null,
        responseCache,
        includeDetails
      );
    } else if (workCtx.anchorState && !workCtx.anchorState.fetchMeta && workCtx.anchorState.isTrackable) {
      applyCompStateFromCache(workCtx.anchorState, workCtx, null, responseCache, includeDetails);
    }
    workCtx.compStates.forEach((st) => {
      if (st === workCtx.anchorState) return;
      applyCompStateFromCache(st, workCtx, anchorDetails, responseCache, includeDetails);
    });
    return anchorDetails;
  }

  function parseBillsFromCache(ebillIds, responseCache) {
    const bills = [];
    let billsFetchFailed = false;
    const seenBills = new Set();

    for (let bIdx = 0; bIdx < ebillIds.length; bIdx++) {
      const eid = String(ebillIds[bIdx]);
      const bHtml = responseCache.get(makeRequestKey('showbilllist.pro', { estmainid: eid }));
      if (!bHtml || isPortalErrorHtml(bHtml)) {
        billsFetchFailed = true;
        continue;
      }
      const bDoc = parseHtmlString(bHtml);
      const bTable =
        bDoc.querySelector('#pt-file_table_list') ||
        bDoc.querySelector('table.dataTable') ||
        bDoc.querySelector('table');
      if (!bTable) {
        billsFetchFailed = true;
        continue;
      }
      bTable.querySelectorAll('tbody tr').forEach((tr) => {
        if (tr.querySelector('td.dataTables_empty')) return;
        const tds = getDirectRowCells(tr, true);
        if (tds.length < 10) return;
        const firstTxt = cleanSingleLine(tds[0].textContent);
        if (/no data available/i.test(firstTxt)) return;

        const bill = {
          billRowNo: firstTxt,
          billTypeAndNo: cleanSingleLine(tds[1].textContent),
          grandTotal: cleanSingleLine(tds[2].textContent),
          totalRecoveries: cleanSingleLine(tds[3].textContent),
          chequeAmount: cleanSingleLine(tds[4].textContent),
          initiatedBy: cleanText(tds[5]),
          initiatedOn: cleanSingleLine(tds[6].textContent),
          validatedOn: cleanSingleLine(tds[7].textContent),
          pendingWith: cleanText(tds[8]),
          status: cleanSingleLine(tds[9].textContent),
        };
        const dedupKey = `${bill.billRowNo}|${bill.billTypeAndNo}|${bill.initiatedOn}|${bill.grandTotal}|${bill.status}`;
        if (!seenBills.has(dedupKey)) {
          seenBills.add(dedupKey);
          bills.push(bill);
        }
      });
    }
    return { bills, billsFetchFailed };
  }

  async function fetchBatchWorksFromPortal(rowMetaList, options) {
    const rows = Array.isArray(rowMetaList) ? rowMetaList.filter((r) => r && r.fileId) : [];
    const opts = options || {};
    const concurrency = Math.max(1, Math.min(12, parseInt(opts.concurrency, 10) || 6));
    const delayMs = typeof opts.delayMs === 'number' && opts.delayMs >= 0 ? opts.delayMs : 0;
    const includeDetails = opts.includeDetails !== false;
    const existingByFileId =
      opts.existingByFileId && typeof opts.existingByFileId === 'object' ? opts.existingByFileId : {};
    const signal = opts.signal;

    if (rows.length === 0) {
      return { results: [], errors: [] };
    }

    const responseCache = new Map();
    const attemptedKeys = new Set();

    const enqueueIfNeeded = (specList, endpoint, params, isAjax) => {
      const key = makeRequestKey(endpoint, params);
      if (responseCache.has(key) || attemptedKeys.has(key)) return key;
      specList.push({
        key,
        endpoint,
        params: params || {},
        isAjax: isAjax !== false,
      });
      return key;
    };

    const fetchMissingSpecs = async (specList) => {
      const uncached = [];
      const localSeen = new Set();
      for (let i = 0; i < specList.length; i++) {
        const s = specList[i];
        const key = makeRequestKey(s.endpoint, s.params, s.key);
        if (responseCache.has(key) || attemptedKeys.has(key) || localSeen.has(key)) continue;
        localSeen.add(key);
        attemptedKeys.add(key);
        uncached.push({ ...s, key });
      }
      if (uncached.length === 0) return new Map();
      const res = await postBatchWave(uncached, { concurrency, delayMs, signal });
      res.resultsByKey.forEach((html, k) => {
        if (html && !isPortalErrorHtml(html)) {
          responseCache.set(k, html);
        }
      });
      return res.errorsByKey;
    };

    try {
      // Phase 1: Discovery Wave (getworkfiledetails.pro across batch)
      const discoverySpecs = rows.map((rowMeta) => ({
        key: makeRequestKey('getworkfiledetails.pro', {
          fileId: String(rowMeta.fileId),
          page: 'undefined',
        }),
        endpoint: 'getworkfiledetails.pro',
        params: { fileId: String(rowMeta.fileId), page: 'undefined' },
        isAjax: false,
      }));
      const discRes = await postBatchWave(discoverySpecs, { concurrency, delayMs, signal });

      const workContexts = [];
      const errors = [];

      rows.forEach((rowMeta) => {
        const fid = String(rowMeta.fileId);
        const existingRecord =
          isSafeKey(fid) && Object.hasOwn(existingByFileId, fid) ? existingByFileId[fid] : null;
        const discKey = makeRequestKey('getworkfiledetails.pro', {
          fileId: fid,
          page: 'undefined',
        });
        const html = discRes.resultsByKey.get(discKey);
        const discErr = discRes.errorsByKey.get(discKey);

        if (!html || discErr || isPortalErrorHtml(html)) {
          errors.push({
            fileId: fid,
            fileNumber: rowMeta.fileNumber || '',
            error: (discErr && discErr.message) || 'PORTAL_ERROR_HTML',
          });
          return;
        }
        const doc = parseHtmlString(html);
        const hasMenuRoot = Boolean(
          doc && doc.querySelector && doc.querySelector('#pt-side-menu-full')
        );
        if (
          !hasMenuRoot &&
          !/id=["']pt-info["']|id=["']pt-heading["']|getworkfiledetails/i.test(html)
        ) {
          errors.push({
            fileId: fid,
            fileNumber: rowMeta.fileNumber || '',
            error: 'PORTAL_ERROR_HTML',
          });
          return;
        }

        const struct = parseSideMenuStructure(doc);
        const existingCompMap = new Map();
        ((existingRecord && existingRecord.components) || []).forEach((ec) => {
          const k = getActivityKey(ec);
          if (k) existingCompMap.set(k, ec);
        });

        let anchorState = null;
        const compStates = struct.components.map((rawComp) => {
          const existingComp = existingCompMap.get(getActivityKey(rawComp)) || null;
          const st = buildCompState(
            rawComp,
            existingComp,
            struct.anchorComponent,
            fid,
            includeDetails,
            existingRecord
          );
          if (rawComp === struct.anchorComponent) anchorState = st;
          return st;
        });

        workContexts.push({
          fileId: fid,
          rowMeta,
          existingRecord,
          struct,
          anchorState,
          compStates,
        });
      });

      if (workContexts.length === 0) {
        return { results: [], errors };
      }

      // Phase 2: Primary Sub-Views Wave (skip loa.pro when IDs are complete; defer pricehandeover.do)
      const phase2Specs = [];
      workContexts.forEach((workCtx) => {
        workCtx.compStates.forEach((st) => {
          st.ebillIds.forEach((eid) => {
            enqueueIfNeeded(phase2Specs, 'showbilllist.pro', { estmainid: String(eid) }, true);
          });

          if (!st.isTrackable) return;

          const existingMb = (st.existingComp && st.existingComp.mbookStatus) || '';
          const existingWca = (st.existingComp && st.existingComp.wcaStage) || '';
          const needWcaCheck =
            st.mbRev.length > 0 &&
            (st.fetchMeta ||
              (!includeDetails && (!/^closed$/i.test(existingMb) || !existingWca)));
          if (needWcaCheck) {
            enqueueIfNeeded(
              phase2Specs,
              'work_component_analysis.pro',
              { workactivityId: st.mbRev[0] },
              true
            );
          }

          if (!st.fetchMeta || (st.isCompositeSibling && !st.isAnchor)) {
            return;
          }

          if (st.estIdForAttr) {
            enqueueIfNeeded(phase2Specs, 'addattribute_view.pro', { estid: st.estIdForAttr }, true);
            enqueueIfNeeded(
              phase2Specs,
              'addattribute_constituency_view.pro',
              { estid: st.estIdForAttr },
              true
            );
          }
          if (st.sbdRev.length > 0) {
            enqueueIfNeeded(phase2Specs, 'generatedraft.pro', { sbdId: st.sbdRev[0] }, true);
          }
          if (st.loaRev.length > 0) {
            const firstLoa = st.loaRev[0];
            const directParams = buildDirectEagreementParams(st.rawComp, workCtx.fileId, firstLoa);
            if (directParams) {
              const key = enqueueIfNeeded(phase2Specs, 'calleagreement.pro', directParams, true);
              st.directEagAttempt = { loa: firstLoa, params: directParams, key };
            } else {
              enqueueIfNeeded(phase2Specs, 'loa.pro', buildLoaPostParams(firstLoa), true);
            }
          } else if (st.ptSbdRev.length > 0) {
            enqueueIfNeeded(
              phase2Specs,
              'negotiatedetilsview.pro',
              { sbdid: st.ptSbdRev[0] },
              true
            );
            enqueueIfNeeded(phase2Specs, 'posttendermain.pro', { sbdid: st.ptSbdRev[0] }, true);
          }
          if (st.hoRev.length > 0) {
            enqueueIfNeeded(phase2Specs, 'handoverhistory.pro', { estid: st.hoRev[0] }, true);
          }
        });
      });

      await fetchMissingSpecs(phase2Specs);

      // Phase 3a: Conditional Fallbacks & Dependent Sub-Requests
      const phase3aSpecs = [];
      workContexts.forEach((workCtx) => {
        const anchorDetails = applyWorkFromCache(workCtx, responseCache, includeDetails);

        workCtx.compStates.forEach((st) => {
          if (!st.isTrackable) return;
          st.eagPending = false;

          // M-Book fallback (mbook_view.pro + older retendered M-Book IDs)
          if (st.mbRev.length > 0) {
            const wcaMeta = st.wcaMeta || {};
            const hasFreshMbStatus = Boolean(
              wcaMeta.mbookStatus && /^closed$/i.test(wcaMeta.mbookStatus)
            );
            const needMbookView = st.fetchMeta
              ? !(st.details && st.details.mbookStatus)
              : !includeDetails && !hasFreshMbStatus && !/^closed$/i.test(st.mbookStatus);
            if (needMbookView) {
              enqueueIfNeeded(phase3aSpecs, 'mbook_view.pro', { activityid: st.mbRev[0] }, true);
              for (let mIdx = 1; mIdx < st.mbRev.length; mIdx++) {
                enqueueIfNeeded(
                  phase3aSpecs,
                  'work_component_analysis.pro',
                  { workactivityId: st.mbRev[mIdx] },
                  true
                );
                enqueueIfNeeded(
                  phase3aSpecs,
                  'mbook_view.pro',
                  { activityid: st.mbRev[mIdx] },
                  true
                );
              }
            }
          }

          if (!st.fetchMeta) return;
          const d = st.details;

          // Composite sibling fallback for fields left blank by anchorDetails
          if (st.isCompositeSibling) {
            if (!d.periodText && st.estIdForAttr) {
              enqueueIfNeeded(
                phase3aSpecs,
                'addattribute_view.pro',
                { estid: st.estIdForAttr },
                true
              );
            }
            if (!d.constituency && st.estIdForAttr) {
              enqueueIfNeeded(
                phase3aSpecs,
                'addattribute_constituency_view.pro',
                { estid: st.estIdForAttr },
                true
              );
            }
            if ((!d.asNo || !d.tsNo) && st.sbdRev.length > 0) {
              st.sbdRev.forEach((sbdId) => {
                enqueueIfNeeded(phase3aSpecs, 'generatedraft.pro', { sbdId }, true);
              });
            }
            if (!d.contractor.name && st.loaRev.length > 0) {
              const firstLoa = st.loaRev[0];
              const directParams = buildDirectEagreementParams(
                st.rawComp,
                workCtx.fileId,
                firstLoa
              );
              if (directParams) {
                const key = enqueueIfNeeded(phase3aSpecs, 'calleagreement.pro', directParams, true);
                st.directEagAttempt = { loa: firstLoa, params: directParams, key };
                st.eagPending = true;
              } else {
                enqueueIfNeeded(phase3aSpecs, 'loa.pro', buildLoaPostParams(firstLoa), true);
              }
            }
            if (!d.shoDate && !d.contractorSignedDate && st.hoRev.length > 0) {
              st.hoRev.forEach((estid) => {
                enqueueIfNeeded(phase3aSpecs, 'handoverhistory.pro', { estid }, true);
              });
            }
          }

          // Older retendered SBD / Handover History fallbacks
          if ((!d.asNo || !d.tsNo) && st.sbdRev.length > 1) {
            for (let i = 1; i < st.sbdRev.length; i++) {
              enqueueIfNeeded(phase3aSpecs, 'generatedraft.pro', { sbdId: st.sbdRev[i] }, true);
            }
          }
          if (
            !d.contractorSignedDate &&
            !d.handoverInitiatedDate &&
            !d.handoverCountersignedDate &&
            st.hoRev.length > 1
          ) {
            for (let i = 1; i < st.hoRev.length; i++) {
              enqueueIfNeeded(phase3aSpecs, 'handoverhistory.pro', { estid: st.hoRev[i] }, true);
            }
          }

          // LOA -> EAgreement resolution & direct-call failure fallback
          if (
            st.loaRev.length > 0 &&
            !d.agreementNo &&
            !(d.contractor && d.contractor.name) &&
            !st.eagPending
          ) {
            if (st.directEagAttempt) {
              // Direct calleagreement.pro returned blank/error -> fall back to loa.pro across loaRev
              st.loaRev.forEach((loa) => {
                enqueueIfNeeded(phase3aSpecs, 'loa.pro', buildLoaPostParams(loa), true);
              });
              st.loaAttemptedAll = true;
            } else {
              let queuedEagFromLoa = false;
              for (let i = 0; i < st.loaRev.length; i++) {
                const loa = st.loaRev[i];
                const loaHtml = responseCache.get(
                  makeRequestKey('loa.pro', buildLoaPostParams(loa))
                );
                if (!loaHtml) continue;
                const eagParams = parseLoaEagreementParams(loaHtml, {
                  ...loa,
                  handoverEstId: st.handoverEstId,
                });
                if (eagParams) {
                  enqueueIfNeeded(phase3aSpecs, 'calleagreement.pro', eagParams, true);
                  st.eagPending = true;
                  queuedEagFromLoa = true;
                  break;
                }
              }
              if (!queuedEagFromLoa && !st.loaAttemptedAll && st.loaRev.length > 1) {
                for (let i = 1; i < st.loaRev.length; i++) {
                  enqueueIfNeeded(phase3aSpecs, 'loa.pro', buildLoaPostParams(st.loaRev[i]), true);
                }
                st.loaAttemptedAll = true;
              }
            }
          }

          // Urgent / pre-agreement bidderview.pro & retendered postTenderSbdIds
          if (!d.contractor.name && st.ptSbdRev.length > 0) {
            if (st.loaRev.length > 0 && !st.eagPending && !st.loaAttemptedAll) {
              st.ptSbdRev.forEach((sbdid) => {
                enqueueIfNeeded(phase3aSpecs, 'negotiatedetilsview.pro', { sbdid }, true);
                enqueueIfNeeded(phase3aSpecs, 'posttendermain.pro', { sbdid }, true);
              });
            } else if (st.loaRev.length === 0) {
              for (let i = 1; i < st.ptSbdRev.length; i++) {
                enqueueIfNeeded(
                  phase3aSpecs,
                  'negotiatedetilsview.pro',
                  { sbdid: st.ptSbdRev[i] },
                  true
                );
                enqueueIfNeeded(phase3aSpecs, 'posttendermain.pro', { sbdid: st.ptSbdRev[i] }, true);
              }
            }
          }
          for (let i = 0; i < st.ptSbdRev.length; i++) {
            const sbdid = st.ptSbdRev[i];
            const negHtml = responseCache.get(
              makeRequestKey('negotiatedetilsview.pro', { sbdid })
            );
            const neg = negHtml ? parseNegotiatedRateHtml(negHtml) : null;
            if (!neg || !neg.contractorName) continue;
            const ptHtml = responseCache.get(makeRequestKey('posttendermain.pro', { sbdid }));
            const ptIds = ptHtml ? parsePostTenderIdsHtml(ptHtml) : null;
            if (ptIds && ptIds.ptid) {
              enqueueIfNeeded(
                phase3aSpecs,
                'bidderview.pro',
                { ptid: ptIds.ptid, sbdid: ptIds.sbdid || sbdid },
                true
              );
              break;
            }
          }

          // Conditional pricehandeover.do fallback (only if EAgreement isn't still pending)
          if (
            !st.eagPending &&
            !st.loaAttemptedAll &&
            !(anchorDetails && st.isCompositeSibling && anchorDetails.tsNo && anchorDetails.agreedPac) &&
            (!d.tsNo || !d.tsDate || !d.tsAmount || !d.agreedPac) &&
            st.hoRev.length > 0
          ) {
            st.hoRev.forEach((estid) => {
              enqueueIfNeeded(phase3aSpecs, 'pricehandeover.do', { estid }, true);
            });
          }
        });
      });

      if (phase3aSpecs.length > 0) {
        await fetchMissingSpecs(phase3aSpecs);
      }

      // Phase 3b: 2nd-hop fallbacks (calleagreement after Phase 3a loa.pro, bidderview, pricehandeover)
      const phase3bSpecs = [];
      workContexts.forEach((workCtx) => {
        const anchorDetails = applyWorkFromCache(workCtx, responseCache, includeDetails);

        workCtx.compStates.forEach((st) => {
          if (!st.isTrackable || !st.fetchMeta) return;
          const d = st.details;
          st.eagPending = false;

          if (!d.agreementNo && !(d.contractor && d.contractor.name) && st.loaRev.length > 0) {
            for (let i = 0; i < st.loaRev.length; i++) {
              const loa = st.loaRev[i];
              const loaHtml = responseCache.get(makeRequestKey('loa.pro', buildLoaPostParams(loa)));
              if (!loaHtml) continue;
              const eagParams = parseLoaEagreementParams(loaHtml, {
                ...loa,
                handoverEstId: st.handoverEstId,
              });
              if (eagParams) {
                const key = makeRequestKey('calleagreement.pro', eagParams);
                if (!responseCache.has(key) && !attemptedKeys.has(key)) {
                  enqueueIfNeeded(phase3bSpecs, 'calleagreement.pro', eagParams, true);
                  st.eagPending = true;
                  break;
                }
              }
            }
          }

          if (!d.contractor.name && st.ptSbdRev.length > 0) {
            for (let i = 0; i < st.ptSbdRev.length; i++) {
              const sbdid = st.ptSbdRev[i];
              const negKey = makeRequestKey('negotiatedetilsview.pro', { sbdid });
              const ptKey = makeRequestKey('posttendermain.pro', { sbdid });
              if (!responseCache.has(negKey) && !attemptedKeys.has(negKey) && !st.eagPending) {
                enqueueIfNeeded(phase3bSpecs, 'negotiatedetilsview.pro', { sbdid }, true);
                enqueueIfNeeded(phase3bSpecs, 'posttendermain.pro', { sbdid }, true);
                continue;
              }
              const negHtml = responseCache.get(negKey);
              const neg = negHtml ? parseNegotiatedRateHtml(negHtml) : null;
              if (!neg || !neg.contractorName) continue;
              const ptHtml = responseCache.get(ptKey);
              const ptIds = ptHtml ? parsePostTenderIdsHtml(ptHtml) : null;
              if (ptIds && ptIds.ptid) {
                enqueueIfNeeded(
                  phase3bSpecs,
                  'bidderview.pro',
                  { ptid: ptIds.ptid, sbdid: ptIds.sbdid || sbdid },
                  true
                );
                break;
              }
            }
          }

          if (
            !st.eagPending &&
            !(anchorDetails && st.isCompositeSibling && anchorDetails.tsNo && anchorDetails.agreedPac) &&
            (!d.tsNo || !d.tsDate || !d.tsAmount || !d.agreedPac) &&
            st.hoRev.length > 0
          ) {
            st.hoRev.forEach((estid) => {
              enqueueIfNeeded(phase3bSpecs, 'pricehandeover.do', { estid }, true);
            });
          }
        });
      });

      if (phase3bSpecs.length > 0) {
        await fetchMissingSpecs(phase3bSpecs);
      }

      // Phase 3c: Rare 3rd-hop fallback (pricehandeover / urgent bidder after Phase 3b LOA->EAgreement)
      const phase3cSpecs = [];
      workContexts.forEach((workCtx) => {
        const anchorDetails = applyWorkFromCache(workCtx, responseCache, includeDetails);

        workCtx.compStates.forEach((st) => {
          if (!st.isTrackable || !st.fetchMeta) return;
          const d = st.details;
          if (!d.contractor.name && st.ptSbdRev.length > 0) {
            for (let i = 0; i < st.ptSbdRev.length; i++) {
              const sbdid = st.ptSbdRev[i];
              const negHtml = responseCache.get(
                makeRequestKey('negotiatedetilsview.pro', { sbdid })
              );
              const neg = negHtml ? parseNegotiatedRateHtml(negHtml) : null;
              const ptHtml = responseCache.get(makeRequestKey('posttendermain.pro', { sbdid }));
              const ptIds = ptHtml ? parsePostTenderIdsHtml(ptHtml) : null;
              if (neg && neg.contractorName && ptIds && ptIds.ptid) {
                enqueueIfNeeded(
                  phase3cSpecs,
                  'bidderview.pro',
                  { ptid: ptIds.ptid, sbdid: ptIds.sbdid || sbdid },
                  true
                );
                break;
              }
            }
          }
          if (
            !(anchorDetails && st.isCompositeSibling && anchorDetails.tsNo && anchorDetails.agreedPac) &&
            (!d.tsNo || !d.tsDate || !d.tsAmount || !d.agreedPac) &&
            st.hoRev.length > 0
          ) {
            st.hoRev.forEach((estid) => {
              enqueueIfNeeded(phase3cSpecs, 'pricehandeover.do', { estid }, true);
            });
          }
        });
      });

      if (phase3cSpecs.length > 0) {
        await fetchMissingSpecs(phase3cSpecs);
      }

      // Final Record Assembly
      const results = workContexts.map((workCtx) => {
        const anchorDetails = applyWorkFromCache(workCtx, responseCache, includeDetails);
        const components = [];
        const activityDetailsList = [];

        if (!includeDetails && anchorDetails) {
          activityDetailsList.push(anchorDetails);
        }

        workCtx.compStates.forEach((st) => {
          const rawComp = st.rawComp;
          const compDetails = st.details || null;
          const mbookStatus =
            st.mbookStatus ||
            (compDetails && compDetails.mbookStatus) ||
            (st.existingComp && st.existingComp.mbookStatus) ||
            '';
          const wcaStage =
            st.wcaStage ||
            (compDetails && compDetails.wcaStage) ||
            (st.existingComp && st.existingComp.wcaStage) ||
            '';

          if (includeDetails && st.isTrackable && compDetails) {
            activityDetailsList.push(compDetails);
          }

          const { bills, billsFetchFailed } = parseBillsFromCache(st.ebillIds, responseCache);
          const mbArr = rawComp.mbookActivityIds || [];
          components.push({
            estmainid: rawComp.estmainid,
            hasEBillStage: rawComp.hasEBillStage,
            hasEmbook: rawComp.hasEmbook,
            hasSiteHandover: rawComp.hasSiteHandover,
            hasPostTender: rawComp.hasPostTender,
            hasPreTender: rawComp.hasPreTender,
            workGroup: rawComp.workGroup,
            componentLabel: rawComp.componentLabel,
            activityName: rawComp.activityName,
            estimateCode: rawComp.estimateCode,
            isCompositeFinal: rawComp.isCompositeFinal,
            isHelper: rawComp.isHelper,
            isDeactivated: Boolean(rawComp.isDeactivated),
            mbookActivityId: mbArr.length ? mbArr[mbArr.length - 1] : '',
            mbookStatus,
            wcaStage,
            stageName: rawComp.stageName,
            bills,
            ...(billsFetchFailed ? { _billsFetchFailed: true } : {}),
            ...(compDetails ? { details: compDetails } : {}),
          });
        });

        const existingRecord = workCtx.existingRecord;
        let projectDetails =
          existingRecord && existingRecord.projectDetails ? existingRecord.projectDetails : null;
        if (includeDetails || !projectDetails || !projectDetails.fetchedAt) {
          projectDetails = rollupProjectDetails(anchorDetails, activityDetailsList);
        }

        const rowMeta = workCtx.rowMeta;
        return {
          fileId: workCtx.fileId,
          rowNo: rowMeta.rowNo || (existingRecord && existingRecord.rowNo) || '',
          fileNumber: rowMeta.fileNumber || (existingRecord && existingRecord.fileNumber) || '',
          subject: rowMeta.subject || (existingRecord && existingRecord.subject) || '',
          createdBy: rowMeta.createdBy || (existingRecord && existingRecord.createdBy) || '',
          createdOn: rowMeta.createdOn || (existingRecord && existingRecord.createdOn) || '',
          scannedAt: new Date().toISOString(),
          components,
          projectDetails,
        };
      });

      return { results, errors };
    } finally {
      responseCache.clear();
    }
  }

  async function fetchSingleWorkFromPortal(rowMeta, options) {
    const opts = typeof options === 'number' ? { delayMs: options } : options || {};
    const delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 0;
    const concurrency = Math.max(1, Math.min(12, parseInt(opts.concurrency, 10) || 6));
    const includeDetails = opts.includeDetails !== false;
    const existingRecord = opts.existingRecord || null;
    const signal = opts.signal;
    const fid = rowMeta && rowMeta.fileId ? String(rowMeta.fileId) : '';

    const batchRes = await fetchBatchWorksFromPortal([rowMeta], {
      concurrency,
      delayMs,
      includeDetails,
      existingByFileId: fid && existingRecord ? { [fid]: existingRecord } : {},
      signal,
    });
    if (batchRes.results.length > 0) {
      return batchRes.results[0];
    }
    const errMsg =
      (batchRes.errors[0] && batchRes.errors[0].error) || 'PORTAL_ERROR_HTML';
    throw new Error(errMsg);
  }

  /**
   * Fetches updated bills, M-Book status, and missing activity/project metadata in one pass.
   */
  async function fetchMissingDetailsForWork(existingRecord, delayMs) {
    return fetchSingleWorkFromPortal(existingRecord, {
      delayMs: typeof delayMs === 'number' ? delayMs : 0,
      includeDetails: true,
      existingRecord,
    });
  }

  const extractorApi = Object.freeze({
    BASE_URL,
    EXTRACTOR_VERSION,
    sleep,
    cleanSingleLine,
    cleanText,
    parseInr,
    formatInr,
    parseDmyDate,
    formatDmyDate,
    normalizeDmyDate,
    toIsoDate,
    dmyToUtcMs,
    compareDmyDates,
    getTodayDmy,
    addCalendarPeriod,
    shiftDmyDays,
    formatPeriodText,
    computeEffectiveShoDate,
    computeCompletionDate,
    resolveScheduleDates,
    computeScheduleStatus,
    parseNegotiatedRatePct,
    computeAdjustedTsAmount,
    computeFinancialStatus,
    computeWorkFinancialStatus,
    computePeriodProgress,
    pickLatestBill,
    isTerminalBillStatus,
    syncBridgeCall,
    getToken,
    setToken,
    extractTokensFromResponse,
    extractTokenFromResponse,
    resolveWaveWinningToken,
    postForm,
    postBatchWave,
    buildDirectEagreementParams,
    isPortalErrorHtml,
    extractActivityName,
    extractEstimateCode,
    isHelperActivity,
    getActivityKey,
    parseSideMenuStructure,
    parseSideMenuIds,
    parsePeriodHtml,
    parseConstituencyHtml,
    parseAsTsHtml,
    parseTsFromHandoverHtml,
    parseLoaEagreementParams,
    parseAgreementAndContractorHtml,
    parseHandoverHistoryHtml,
    parseWorkComponentAnalysisHtml,
    parseMbookViewClosedHtml,
    parseNegotiatedRateHtml,
    parsePostTenderIdsHtml,
    parseBidderViewHtml,
    classifyBillKind,
    analyzeWorkRecord,
    summarizeWork,
    getMissingFields,
    rollupProjectDetails,
    fetchBatchWorksFromPortal,
    fetchSingleWorkFromPortal,
    fetchMissingDetailsForWork,
  });

  globalScope.__P3H__ = globalScope.__P3H__ || {};
  globalScope.__P3H__.extractor = extractorApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = extractorApi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
