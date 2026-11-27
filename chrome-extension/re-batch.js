/**
 * PRICE 3.0 Helper — Revised Estimate (RE) Batch "To Be Executed" Manager
 *
 * Integrates directly into PRICE 3.0's Revised Estimate workspace to inspect
 * and batch-clear "To Be Executed" measurements cleanly without DOM click-timing
 * hacks, monkey-patched dialogs, or N redundant table reloads.
 *
 * Uses extractor.postForm() so rotating CSRF tokens (price_token / GTOKEN) are
 * strictly preserved via sequential execution.
 */
(function (globalScope) {
  'use strict';

  const hasDocument = typeof document !== 'undefined';
  if (hasDocument && globalScope.__P3H_RE_BATCH_LOADED__) return;
  if (hasDocument) {
    globalScope.__P3H_RE_BATCH_LOADED__ = true;
  }

  const P3H = (globalScope.__P3H__ = globalScope.__P3H__ || {});
  const db = P3H.db || (typeof require === 'function' ? require('./db.js') : null);
  const extractor =
    P3H.extractor || (typeof require === 'function' ? require('./extractor.js') : null);

  const RE_INTERNAL_SELECTOR =
    '#p3h-toolbar, #p3h-drawer, #p3h-drawer-backdrop, #p3h-register-modal, .p3h-cell-meta, #pt-file_table_list, .dataTables_wrapper, #p3h-re-modal-overlay, #p3h-re-batch-btn, .p3h-re-trigger-btn, #p3h-re-helper-btn, .p3h-re-helper-btn, .p3h-re-item-helper';

  const QTY_EPS = 0.0005;

  function cleanSingleLine(str) {
    if (extractor && typeof extractor.cleanSingleLine === 'function') {
      return extractor.cleanSingleLine(str);
    }
    return String(str == null ? '' : str)
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeHtml(str) {
    if (db && typeof db.escapeHtml === 'function') {
      return db.escapeHtml(str);
    }
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatInr(num) {
    if (extractor && typeof extractor.formatInr === 'function') {
      return extractor.formatInr(num);
    }
    return (Number(num) || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function hasClass(el, clsName) {
    if (!el) return false;
    if (el.classList && typeof el.classList.contains === 'function') {
      return el.classList.contains(clsName);
    }
    return String(el.className || '')
      .split(/\s+/)
      .includes(clsName);
  }

  /**
   * Parses the numeric headspecid argument from a PRICE 3.0 `re_to_be_executed(<id>)` onclick attribute.
   */
  function parseHeadSpecIdFromOnclick(onclickStr) {
    const m = String(onclickStr || '').match(/re_to_be_executed\(\s*['"]?(\d+)['"]?\s*\)/);
    return m && m[1] ? m[1] : '';
  }

  /**
   * Parses the numeric estHeadid argument from a PRICE 3.0 `re_change_heading(<id>)` onclick attribute.
   */
  function parseHeadIdFromOnclick(onclickStr) {
    const m = String(onclickStr || '').match(/re_change_heading\(\s*['"]?(\d+)['"]?\s*\)/);
    return m && m[1] ? m[1] : '';
  }

  /**
   * Parses a formatted INR string (e.g. "₹ 25,733.25") into a finite number (or 0).
   */
  function parseAmountNumber(text) {
    const cleaned = String(text == null ? '' : text).replace(/,/g, '');
    const m = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (!m) return 0;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Parses the leading numeric quantity from a qty/unit string (e.g. "25.0 point" -> 25).
   */
  function parseQtyNumber(text) {
    const cleaned = String(text == null ? '' : text).replace(/,/g, '');
    const m = cleaned.match(/^\s*([+-]?\d+(?:\.\d+)?)/);
    if (!m) return 0;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Parses a signed number string (e.g. "-0.40000", "1,192.56") returning null when non-numeric.
   */
  function parseSignedNumberOrNull(text) {
    const cleaned = cleanSingleLine(text).replace(/,/g, '');
    if (!cleaned) return null;
    const m = cleaned.match(/^([+-]?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  function roundQty(num) {
    const n = Number(num);
    if (!Number.isFinite(n)) return 0;
    const r = Math.round(n * 100000) / 100000;
    return Object.is(r, -0) ? 0 : r;
  }

  function formatQty(num) {
    if (num === null || num === undefined || !Number.isFinite(Number(num))) return '—';
    const rounded = Math.round(Number(num) * 1000) / 1000;
    const safe = Object.is(rounded, -0) ? 0 : rounded;
    return safe.toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
    });
  }

  function roundQty3(num) {
    const n = Number(num);
    if (!Number.isFinite(n)) return 0;
    const r = Math.round(n * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
  }

  function formatEditableQty(num) {
    if (num === null || num === undefined || num === '' || !Number.isFinite(Number(num))) return '';
    return String(roundQty3(num));
  }

  function parseEditableQtyInput(rawText) {
    const trimmed = String(rawText == null ? '' : rawText).trim();
    if (!trimmed) {
      return { kind: 'blank', value: null };
    }
    const cleaned = trimmed.replace(/,/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
      return {
        kind: 'invalid',
        error: 'Enter a non-negative number (up to 3 decimals)',
      };
    }
    const num = Number(cleaned);
    if (!Number.isFinite(num) || num < 0) {
      return {
        kind: 'invalid',
        error: 'Enter a non-negative number (up to 3 decimals)',
      };
    }
    return { kind: 'valid', value: roundQty3(num) };
  }

  function parseUnitRateNumber(rateText) {
    const cleaned = String(rateText == null ? '' : rateText).replace(/,/g, '');
    const m = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }

  function extractQtyUnit(qtyText) {
    const cleaned = cleanSingleLine(qtyText);
    const m = cleaned.match(/^[+-]?[\d,.]+\s*(.*)$/);
    return m && m[1] ? m[1].trim() : '';
  }

  /**
   * Compacts Observed Data specification codes (e.g. "OD254840/2022-2023" -> "OD254840")
   * while leaving DSR codes unchanged.
   */
  function formatCompactSpecCode(specCode) {
    const raw = cleanSingleLine(specCode);
    if (!raw) return '-';
    const m = raw.match(/^(OD\s*\d+)\s*\/\s*\d{4}(?:\s*-\s*\d{2,4})?$/i);
    if (m && m[1]) {
      return m[1].replace(/\s+/g, '').toUpperCase();
    }
    return raw;
  }

  /**
   * Computes percentage deviation between DPR sanctioned quantity and RE total quantity.
   */
  function computeQtyDeviation(dprQty, reTotalQty) {
    if (
      dprQty === null ||
      dprQty === undefined ||
      reTotalQty === null ||
      reTotalQty === undefined ||
      !Number.isFinite(Number(dprQty)) ||
      !Number.isFinite(Number(reTotalQty))
    ) {
      return { devPct: null, deltaQty: null, kind: 'unknown', label: '—' };
    }
    const dpr = roundQty(dprQty);
    const re = roundQty(reTotalQty);
    const delta = roundQty(re - dpr);

    if (Math.abs(dpr) <= QTY_EPS) {
      if (Math.abs(re) <= QTY_EPS) {
        return { devPct: 0, deltaQty: 0, kind: 'zero', label: '0%' };
      }
      return { devPct: null, deltaQty: delta, kind: 'extra', label: 'Extra' };
    }

    const rawPct = ((re - dpr) / dpr) * 100;
    const rounded1 = Math.round(rawPct * 10) / 10;
    const rounded2 = Math.round(rawPct * 100) / 100;

    if (Math.abs(delta) <= QTY_EPS || Math.abs(rawPct) < 0.05) {
      return { devPct: 0, deltaQty: 0, kind: 'zero', label: '0%' };
    }
    if (rawPct < 0) {
      return { devPct: rounded2, deltaQty: delta, kind: 'neg', label: `${rounded1.toFixed(1)}%` };
    }
    if (rawPct > 25) {
      return { devPct: rounded2, deltaQty: delta, kind: 'high', label: `+${rounded1.toFixed(1)}%` };
    }
    return { devPct: rounded2, deltaQty: delta, kind: 'pos', label: `+${rounded1.toFixed(1)}%` };
  }

  function readInputValue(el) {
    if (!el) return '';
    if (el.value !== undefined && el.value !== null && String(el.value).trim() !== '') {
      return String(el.value).trim();
    }
    if (typeof el.getAttribute === 'function') {
      return String(el.getAttribute('value') || '').trim();
    }
    return '';
  }

  function extractBaseEstimateCode(rawText) {
    const matches = Array.from(String(rawText || '').matchAll(/\[\s*([^\]]+?)\s*\]/g));
    for (let i = 0; i < matches.length; i++) {
      const candidate = cleanSingleLine(matches[i][1]);
      if (!candidate) continue;
      if (/\/RE\s*[-_]?\s*\d+$/i.test(candidate) || /^(?:PWD|LSGD|IRR|KWA|KSEB|NH)\//i.test(candidate)) {
        return {
          reEstimateCode: candidate,
          baseEstimateCode: candidate.replace(/\s*\/?\s*RE\s*[-_]?\s*\d+\s*$/i, '').trim(),
        };
      }
    }
    return { reEstimateCode: '', baseEstimateCode: '' };
  }

  function matchSidebarComponentForRe(rootDoc, baseEstimateCode) {
    if (!rootDoc || !extractor || typeof extractor.parseSideMenuStructure !== 'function') {
      return null;
    }
    const struct = extractor.parseSideMenuStructure(rootDoc);
    const comps = (struct && Array.isArray(struct.components) ? struct.components : []).filter(Boolean);
    if (comps.length === 0) return null;

    const activePool = comps.filter((c) => !c.isDeactivated);
    const pool = activePool.length > 0 ? activePool : comps;

    if (baseEstimateCode) {
      const target = baseEstimateCode.toUpperCase();
      const exact = pool.find((c) => String(c.estimateCode || '').toUpperCase() === target);
      if (exact) return exact;
      const prefix = pool.find(
        (c) => c.estimateCode && target.startsWith(String(c.estimateCode).toUpperCase())
      );
      if (prefix) return prefix;
    }

    const withMbook = pool.filter(
      (c) => !c.isHelper && Array.isArray(c.mbookActivityIds) && c.mbookActivityIds.length > 0
    );
    if (withMbook.length === 1) return withMbook[0];

    const withRe = pool.filter((c) => !c.isHelper && c.reEstMainId);
    if (withRe.length === 1) return withRe[0];

    if (typeof rootDoc.querySelector === 'function') {
      const activeMenuLink = rootDoc.querySelector('#pt-side-menu-full a.active');
      if (activeMenuLink && typeof activeMenuLink.closest === 'function') {
        const li = activeMenuLink.closest('li');
        const liText = cleanSingleLine(li ? li.textContent : '');
        const byActive = pool.find((c) => c.estimateCode && liText.includes(c.estimateCode));
        if (byActive) return byActive;
      }
    }
    return null;
  }

  /**
   * Resolves the active RE identifiers (`reEstId`, `headId`, `headOrderNo`, `estEditId`)
   * and matching sidebar work activity (`activityId`, `dprEstId`, `estMainId`).
   */
  function resolveReWorkContext(rootDoc, bridgeCtx) {
    const ctx = bridgeCtx && typeof bridgeCtx === 'object' ? bridgeCtx : {};
    const extracted = extractReSpecItems(rootDoc);

    let reEstId = String(ctx.gestId || '').trim();
    if (!reEstId && rootDoc && typeof rootDoc.querySelector === 'function') {
      const syncBtn = rootDoc.querySelector(
        '#updateMeasurementsMbook, [onclick*="updateREMbookMeasurements"], [onclick*="call_basic_revised_estimation"], [onclick*="call_revised_estimation_basic"]'
      );
      if (syncBtn && typeof syncBtn.getAttribute === 'function') {
        const oc = syncBtn.getAttribute('onclick') || '';
        const m =
          oc.match(/updateREMbookMeasurements\(\s*['"]?(\d+)['"]?\s*\)/) ||
          oc.match(/call_(?:basic_revised_estimation|revised_estimation_basic)\([^)]*?['"](\d+)['"]\s*\)/);
        if (m && m[1]) reEstId = m[1];
      }
      if (!reEstId) {
        const estHidden = rootDoc.querySelector('#est_id, input[id^="heading_Est_id"]');
        reEstId = readInputValue(estHidden);
      }
    }

    let estEditId = String(ctx.estEditId || '').trim();
    if (!estEditId && rootDoc && typeof rootDoc.querySelector === 'function') {
      estEditId = readInputValue(rootDoc.querySelector('#estEditId'));
    }

    const headId = String(ctx.curHeadId || extracted.headId || '').trim();
    let headOrderNo = String(ctx.headOrderNo || '').trim();
    if (!headOrderNo && headId && rootDoc && typeof rootDoc.querySelector === 'function') {
      headOrderNo = readInputValue(rootDoc.querySelector('#headorderNo' + headId));
    }
    if (!headOrderNo && rootDoc && typeof rootDoc.querySelector === 'function') {
      const activeNumEl = rootDoc.querySelector('.pt-left-est .pt-number-scroll a.active .num');
      const numTxt = cleanSingleLine(activeNumEl ? activeNumEl.textContent : '');
      if (/^\d+$/.test(numTxt)) headOrderNo = numTxt;
    }
    if (!headOrderNo && headId) headOrderNo = '1';

    let headingBannerText = '';
    if (rootDoc && typeof rootDoc.querySelector === 'function') {
      const hdEl = rootDoc.querySelector('#pt-heading .heading') || rootDoc.querySelector('#pt-heading');
      headingBannerText = cleanSingleLine(hdEl ? hdEl.textContent : '');
    }
    const { reEstimateCode, baseEstimateCode } = extractBaseEstimateCode(headingBannerText);
    const matchedComp = matchSidebarComponentForRe(rootDoc, baseEstimateCode);

    return {
      reEstId,
      estEditId,
      headId,
      headOrderNo,
      headingName: extracted.headingName,
      isExtraHead: extracted.isExtraHead,
      reEstimateCode,
      baseEstimateCode,
      activityId:
        matchedComp && Array.isArray(matchedComp.mbookActivityIds) && matchedComp.mbookActivityIds[0]
          ? String(matchedComp.mbookActivityIds[0])
          : '',
      dprEstId:
        matchedComp && Array.isArray(matchedComp.basicEstIds) && matchedComp.basicEstIds[0]
          ? String(matchedComp.basicEstIds[0])
          : '',
      estMainId: matchedComp ? String(matchedComp.reEstMainId || matchedComp.estmainid || '') : '',
      activityName: matchedComp ? String(matchedComp.activityName || '') : '',
      selTab: String(ctx.selTab || '').trim(),
      selItem: String(ctx.selItem || '').trim(),
      hasMeasurementFormOpen: Boolean(ctx.hasMeasurementFormOpen),
    };
  }

  /**
   * Returns true when the Revised Estimate preparation workspace is active in the document.
   */
  function isReEditorPresent(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    return Boolean(
      doc.querySelector(
        '#pt-slide-right ul#tabs #tobeexecuted, #user_address_button_delete[onclick*="revised_estimation_Delete"], #pt-specifications td.text-center[onclick^="re_to_be_executed"]'
      )
    );
  }

  /**
   * Collects the sibling rows belonging to a single RE specification item block starting at `trTop`.
   */
  function collectSpecBlockRows(table, trTop, headspecid) {
    const rows = [];
    let cur = trTop && trTop.nextElementSibling ? trTop.nextElementSibling : null;
    while (cur) {
      if (hasClass(cur, 'pt-sp-top') || hasClass(cur, 'current-specification')) break;
      if (
        typeof cur.querySelector === 'function' &&
        cur.querySelector('td.text-center[onclick^="re_to_be_executed"]')
      ) {
        break;
      }
      rows.push(cur);
      cur = cur.nextElementSibling || null;
    }
    if (rows.length === 0 && table && headspecid && typeof table.querySelectorAll === 'function') {
      table.querySelectorAll('tr.specSelect' + headspecid).forEach((r) => {
        if (r !== trTop) rows.push(r);
      });
    }
    return rows;
  }

  /**
   * Extracts the list of RE headings from the left sidebar navigation (`.pt-left-est .pt-number-scroll a`).
   */
  function extractReHeadingsList(rootDoc) {
    if (!rootDoc || typeof rootDoc.querySelectorAll !== 'function') return [];
    const links = Array.from(rootDoc.querySelectorAll('.pt-left-est .pt-number-scroll a'));
    const seen = new Set();
    const out = [];
    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      const oc = typeof a.getAttribute === 'function' ? a.getAttribute('onclick') : '';
      const headId = parseHeadIdFromOnclick(oc);
      if (!headId || seen.has(headId)) continue;
      seen.add(headId);
      const numEl = typeof a.querySelector === 'function' ? a.querySelector('.num') : null;
      let orderNo = cleanSingleLine(numEl ? numEl.textContent : '');
      if (!orderNo && typeof rootDoc.getElementById === 'function') {
        const orderInput = rootDoc.getElementById('headorderNo' + headId);
        if (orderInput) {
          orderNo = cleanSingleLine(
            orderInput.value !== undefined && orderInput.value !== ''
              ? orderInput.value
              : typeof orderInput.getAttribute === 'function'
              ? orderInput.getAttribute('value') || ''
              : ''
          );
        }
      }
      const textEl = typeof a.querySelector === 'function' ? a.querySelector('.text') : null;
      const name = cleanSingleLine(textEl ? textEl.textContent : a.textContent || '') || `Heading ${headId}`;
      const label = orderNo ? `${orderNo}. ${name}` : name;
      out.push({
        headId,
        orderNo,
        name,
        label,
        isActive: hasClass(a, 'active'),
      });
    }
    return out;
  }

  /**
   * Extracts active RE heading metadata and row-anchored specification items from `#pt-specifications`.
   * Anchoring each item directly from its own `trTop` prevents `.bg-fix` index misalignment.
   */
  function extractReSpecItems(rootDoc) {
    if (!rootDoc || typeof rootDoc.querySelector !== 'function') {
      return { headingName: '', headId: '', isExtraHead: false, items: [] };
    }

    const table = rootDoc.querySelector('#pt-specifications') || rootDoc;
    const headingBannerEl = table.querySelector('tr.current-specification .sp-heading');
    const activeHeadingLink = rootDoc.querySelector('.pt-left-est .pt-number-scroll a.active');
    const activeHeadingTextEl = activeHeadingLink ? activeHeadingLink.querySelector('.text') : null;

    const headingName = cleanSingleLine(
      (headingBannerEl && headingBannerEl.textContent) ||
        (activeHeadingTextEl && activeHeadingTextEl.textContent) ||
        ''
    );
    const headId = parseHeadIdFromOnclick(
      activeHeadingLink ? activeHeadingLink.getAttribute('onclick') : ''
    );

    const extraHeadInput = rootDoc.querySelector('#isextraHead');
    const extraHeadVal = extraHeadInput
      ? extraHeadInput.value !== undefined && extraHeadInput.value !== ''
        ? extraHeadInput.value
        : extraHeadInput.getAttribute('value')
      : '';
    const isExtraHead = String(extraHeadVal || '').trim().toLowerCase() === 'true';

    const cells =
      typeof table.querySelectorAll === 'function'
        ? Array.from(table.querySelectorAll('td.text-center[onclick^="re_to_be_executed"]'))
        : [];

    const seenSpecIds = new Set();
    const items = [];

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const headspecid = parseHeadSpecIdFromOnclick(cell.getAttribute('onclick'));
      if (!headspecid || seenSpecIds.has(headspecid)) continue;
      seenSpecIds.add(headspecid);

      const slNo = cleanSingleLine(cell.textContent);
      const trTop = typeof cell.closest === 'function' ? cell.closest('tr') : null;
      const specEl = trTop && trTop.querySelector ? trTop.querySelector('span.sp-version') : null;
      const specCode = cleanSingleLine(specEl ? specEl.textContent : '');

      const itemRows = collectSpecBlockRows(table, trTop, headspecid);
      const trMiddle =
        itemRows.find(
          (r) =>
            hasClass(r, 'pt-sp-middle') ||
            (typeof r.querySelector === 'function' && Boolean(r.querySelector('p.sp-content')))
        ) ||
        itemRows[0] ||
        null;

      const bottomCandidates = itemRows.filter(
        (r) =>
          hasClass(r, 'pt-sp-bottom') ||
          (typeof r.querySelector === 'function' && Boolean(r.querySelector('span.amount-single')))
      );
      const isBgFix = Boolean(
        hasClass(trTop, 'bg-fix') || itemRows.some((r) => hasClass(r, 'bg-fix'))
      );
      const trBottom =
        bottomCandidates.find((r) => !hasClass(r, 'bg-fix')) || bottomCandidates[0] || null;

      const pContent =
        trMiddle && typeof trMiddle.querySelector === 'function'
          ? trMiddle.querySelector('p.sp-content')
          : null;
      const rawDesc = pContent
        ? extractor && typeof extractor.cleanText === 'function'
          ? extractor.cleanText(pContent)
          : pContent.textContent
        : trMiddle
        ? trMiddle.textContent
        : '';
      const desc = cleanSingleLine(rawDesc) || 'No description';

      const tds =
        trBottom && typeof trBottom.querySelectorAll === 'function'
          ? Array.from(trBottom.querySelectorAll('td'))
          : [];
      const qtyText = cleanSingleLine(tds[0] ? tds[0].textContent : '');
      const qty = parseQtyNumber(qtyText);
      const rateText = cleanSingleLine(tds[1] ? tds[1].textContent : '');
      const amountEl =
        (trBottom && typeof trBottom.querySelector === 'function'
          ? trBottom.querySelector('span.amount-single')
          : null) ||
        tds[2] ||
        null;
      const amountText = cleanSingleLine(amountEl ? amountEl.textContent : '');
      const amount = parseAmountNumber(amountText);

      items.push({
        index: items.length,
        slNo,
        headspecid,
        specCode,
        desc,
        qtyText,
        qty,
        rateText,
        amountText,
        amount,
        isBgFix,
      });
    }

    return { headingName, headId, isExtraHead, items };
  }

  function isSafePortalEndpoint(url) {
    return Boolean(url && /^[a-z0-9_.-]+\.(?:pro|do)$/i.test(String(url).trim()));
  }

  /**
   * CSP-safe recursive-descent evaluator for PRICE 3.0 measurement expressions
   * (`[0-9 . + - * / ( )]` with optional whitespace). Never uses eval/Function.
   */
  function evalMeasurementExpr(rawExpr) {
    const trimmed = String(rawExpr == null ? '' : rawExpr).trim();
    if (!trimmed) {
      return { ok: false, empty: true, error: 'Empty expression' };
    }
    if (!/^[.0-9+\-*/() ]+$/.test(trimmed)) {
      return { ok: false, error: 'Only digits, decimals, + - * / and ( ) allowed' };
    }

    const isPlainNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed);
    const tokens = [];
    let i = 0;
    while (i < trimmed.length) {
      const ch = trimmed[i];
      if (ch === ' ') {
        i++;
        continue;
      }
      if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
        tokens.push({ type: 'op', val: ch });
        i++;
        continue;
      }
      if ((ch >= '0' && ch <= '9') || ch === '.') {
        let j = i;
        let dotCount = 0;
        let digitCount = 0;
        while (j < trimmed.length) {
          const c = trimmed[j];
          if (c >= '0' && c <= '9') {
            digitCount++;
            j++;
          } else if (c === '.') {
            dotCount++;
            if (dotCount > 1) {
              return { ok: false, error: 'Malformed decimal number' };
            }
            j++;
          } else {
            break;
          }
        }
        if (digitCount === 0) {
          return { ok: false, error: 'Invalid decimal point' };
        }
        const numVal = Number(trimmed.slice(i, j));
        if (!Number.isFinite(numVal)) {
          return { ok: false, error: 'Invalid number' };
        }
        tokens.push({ type: 'num', val: numVal });
        i = j;
        continue;
      }
      return { ok: false, error: 'Unexpected character' };
    }

    if (tokens.length === 0) {
      return { ok: false, empty: true, error: 'Empty expression' };
    }

    let pos = 0;
    let evalErr = '';

    function parseExpr() {
      let left = parseTerm();
      if (evalErr) return NaN;
      while (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].val === '+' || tokens[pos].val === '-')) {
        const op = tokens[pos++].val;
        const right = parseTerm();
        if (evalErr) return NaN;
        left = op === '+' ? left + right : left - right;
      }
      return left;
    }

    function parseTerm() {
      let left = parseUnary();
      if (evalErr) return NaN;
      while (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].val === '*' || tokens[pos].val === '/')) {
        const op = tokens[pos++].val;
        const right = parseUnary();
        if (evalErr) return NaN;
        if (op === '/') {
          if (Math.abs(right) <= 1e-12) {
            evalErr = 'Division by zero';
            return NaN;
          }
          left = left / right;
        } else {
          left = left * right;
        }
      }
      return left;
    }

    function parseUnary() {
      if (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].val === '+' || tokens[pos].val === '-')) {
        const op = tokens[pos++].val;
        const inner = parseUnary();
        if (evalErr) return NaN;
        return op === '-' ? -inner : inner;
      }
      return parsePrimary();
    }

    function parsePrimary() {
      if (pos >= tokens.length) {
        evalErr = 'Incomplete expression';
        return NaN;
      }
      const tok = tokens[pos];
      if (tok.type === 'num') {
        pos++;
        return tok.val;
      }
      if (tok.type === 'op' && tok.val === '(') {
        pos++;
        const inner = parseExpr();
        if (evalErr) return NaN;
        if (pos >= tokens.length || tokens[pos].type !== 'op' || tokens[pos].val !== ')') {
          evalErr = 'Unbalanced parentheses';
          return NaN;
        }
        pos++;
        return inner;
      }
      evalErr = 'Unexpected token';
      return NaN;
    }

    const value = parseExpr();
    if (evalErr) {
      return { ok: false, error: evalErr };
    }
    if (pos !== tokens.length) {
      return { ok: false, error: 'Unexpected trailing expression' };
    }
    if (!Number.isFinite(value)) {
      return { ok: false, error: 'Result is not finite' };
    }
    return {
      ok: true,
      value: Object.is(value, -0) ? 0 : value,
      isFormula: !isPlainNumber,
    };
  }

  function formatDimensionForSubmit(rawExpr, precision) {
    const trimmed = String(rawExpr == null ? '' : rawExpr).trim();
    if (!trimmed) return '';
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n.toFixed(precision) : trimmed;
    }
    return trimmed;
  }

  function computeMeasurementRowQty(row) {
    const r = row && typeof row === 'object' ? row : {};
    const desc = cleanSingleLine(r.itemDesc);
    const nStr = String(r.itemN == null ? '' : r.itemN).trim();
    const lStr = String(r.itemLength == null ? '' : r.itemLength).trim();
    const bStr = String(r.itemBreadth == null ? '' : r.itemBreadth).trim();
    const dStr = String(r.itemDepth == null ? '' : r.itemDepth).trim();
    const cfStr = String(r.itemCf == null ? '' : r.itemCf).trim();

    if (!desc && !nStr && !lStr && !bStr && !dStr && !cfStr) {
      return { kind: 'blank', qty: null };
    }
    if (!nStr) {
      return { kind: 'invalid', field: 'itemN', error: 'No is required' };
    }

    const nRes = evalMeasurementExpr(nStr);
    if (!nRes.ok) {
      return { kind: 'invalid', field: 'itemN', error: nRes.error || 'Invalid No' };
    }

    const dimFields = [
      ['itemLength', lStr],
      ['itemBreadth', bStr],
      ['itemDepth', dStr],
    ];
    const dimVals = {};
    for (let i = 0; i < dimFields.length; i++) {
      const [fname, fval] = dimFields[i];
      if (!fval) {
        dimVals[fname] = 1;
        continue;
      }
      const res = evalMeasurementExpr(fval);
      if (!res.ok || res.value < 0) {
        return {
          kind: 'invalid',
          field: fname,
          error: res.ok ? 'Must be non-negative' : res.error || 'Invalid dimension',
        };
      }
      dimVals[fname] = res.value;
    }

    let cfVal = 1;
    if (cfStr) {
      if (!/^\+?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(cfStr)) {
        return {
          kind: 'invalid',
          field: 'itemCf',
          error: 'Coefficient must be non-negative numeric (up to 6 decimals)',
        };
      }
      const parsedCf = Number(cfStr);
      if (!Number.isFinite(parsedCf) || parsedCf < 0) {
        return {
          kind: 'invalid',
          field: 'itemCf',
          error: 'Coefficient must be non-negative numeric (up to 6 decimals)',
        };
      }
      cfVal = parsedCf;
    }

    const rawProd = Number(
      (nRes.value * dimVals.itemLength * dimVals.itemBreadth * dimVals.itemDepth * cfVal).toFixed(10)
    );
    const qty = roundQty3(rawProd);
    return {
      kind: 'valid',
      qty,
      isDeduction: qty < 0,
      evaluated: {
        n: nRes.value,
        l: dimVals.itemLength,
        b: dimVals.itemBreadth,
        h: dimVals.itemDepth,
        cf: cfVal,
      },
      isFormulaN: nRes.isFormula,
    };
  }

  function hasDetailedSplitUp(parsedTbe) {
    if (!parsedTbe || parsedTbe.kind !== 'has_measurements') return false;
    const details = Array.isArray(parsedTbe.headDetails) ? parsedTbe.headDetails : [];
    if ((Number(parsedTbe.count) || 0) > 1 || details.length > 1) return true;
    if (details.length === 0) return false;
    const rows = Array.isArray(details[0] && details[0].rows) ? details[0].rows : [];
    if (rows.length > 1) return true;
    if (rows.length === 1) {
      const r = rows[0] || {};
      if (cleanSingleLine(r.itemDesc)) return true;
      if (
        String(r.itemLength || '').trim() ||
        String(r.itemBreadth || '').trim() ||
        String(r.itemDepth || '').trim() ||
        String(r.itemCf || '').trim()
      ) {
        return true;
      }
      const nRes = evalMeasurementExpr(r.itemN);
      if (nRes.ok && (nRes.isFormula || nRes.value < 0)) return true;
    }
    return false;
  }

  function buildMeasurementHeadFormParams(headInput) {
    const cleanDesc = cleanSingleLine(headInput && headInput.headDesc) || '1';
    const rawRows = Array.isArray(headInput && headInput.rows) ? headInput.rows : [];
    const activeEntries = [];
    for (let i = 0; i < rawRows.length; i++) {
      const row = rawRows[i] || {};
      const calc = computeMeasurementRowQty(row);
      if (calc.kind === 'blank') continue;
      if (calc.kind !== 'valid') {
        return {
          ok: false,
          error: `Row ${i + 1}: ${calc.error}`,
          invalidRowIndex: i,
          invalidField: calc.field || '',
        };
      }
      activeEntries.push({ row, calc });
    }
    if (activeEntries.length === 0) {
      return { ok: false, error: 'Add at least one measurement row before saving' };
    }

    const params = { itemHeadDesc: cleanDesc };
    let sum = 0;
    for (let k = 0; k < activeEntries.length; k++) {
      const idx = k + 1;
      const { row, calc } = activeEntries[k];
      params[`measureList[${idx}].itemDesc`] = cleanSingleLine(row.itemDesc);
      params[`measureList[${idx}].itemN`] = formatDimensionForSubmit(row.itemN, 3);
      params[`measureList[${idx}].itemLength`] = formatDimensionForSubmit(row.itemLength, 3);
      params[`measureList[${idx}].itemBreadth`] = formatDimensionForSubmit(row.itemBreadth, 3);
      params[`measureList[${idx}].itemDepth`] = formatDimensionForSubmit(row.itemDepth, 3);
      params[`measureList[${idx}].itemCf`] = formatDimensionForSubmit(row.itemCf, 6);
      params[`measureList[${idx}].itemQty`] = calc.qty.toFixed(3);
      sum += calc.qty;
    }
    const headTotal = roundQty3(sum);
    return {
      ok: true,
      params,
      headTotal,
      grandtotal: headTotal.toFixed(3),
      rowCount: activeEntries.length,
    };
  }

  /**
   * Parses the server response from `POST call_to_be_executed.pro`.
   * Classifies into `has_measurements`, `empty`, `session_expired`, or `error`.
   */
  function parseToBeExecutedHtml(html, expectedHeadSpecId) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return {
        kind: 'error',
        measurementIds: [],
        count: 0,
        tbeQty: null,
        heads: [],
        headDetails: [],
        error: 'Empty response',
      };
    }

    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const obj = JSON.parse(raw);
        const status = String((obj && obj.status) || '')
          .trim()
          .toUpperCase();
        if (status === 'A') {
          return {
            kind: 'session_expired',
            measurementIds: [],
            count: 0,
            tbeQty: null,
            heads: [],
            headDetails: [],
            error: 'Session expired',
          };
        }
        const busstatus = String((obj && obj.busstatus) || '')
          .trim()
          .toUpperCase();
        if (busstatus === 'F') {
          return {
            kind: 'empty',
            measurementIds: [],
            count: 0,
            tbeQty: 0,
            heads: [],
            headDetails: [],
            note: (obj && obj.message) || 'No To-Be-Executed measurements',
          };
        }
        return {
          kind: 'error',
          measurementIds: [],
          count: 0,
          tbeQty: null,
          heads: [],
          headDetails: [],
          error: (obj && obj.message) || 'Unexpected JSON response',
        };
      } catch (_e) {}
    }

    const hasTbeMarkers =
      /estmeasureheaddetails|measurementcheckbox|itemHeadDesc|estimation_measurement|save_re_to_be_executed|call_to_be_executed|pt-popaddMeasureForm/i.test(
        raw
      );
    if (
      !hasTbeMarkers &&
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return {
        kind: 'error',
        measurementIds: [],
        count: 0,
        tbeQty: null,
        heads: [],
        headDetails: [],
        error: 'Portal returned an error page',
      };
    }

    if (typeof DOMParser === 'undefined') {
      return {
        kind: 'error',
        measurementIds: [],
        count: 0,
        tbeQty: null,
        heads: [],
        headDetails: [],
        error: 'DOMParser unavailable',
      };
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const expectedId =
      expectedHeadSpecId !== undefined && expectedHeadSpecId !== null
        ? String(expectedHeadSpecId).trim()
        : '';

    if (expectedId) {
      const actionEls = Array.from(
        doc.querySelectorAll(
          '[onclick*="save_re_to_be_executed"], [onclick*="call_to_be_executed_between"], .pt-popaddMeasureForm[onclick]'
        )
      );
      const foundIds = [];
      for (let i = 0; i < actionEls.length; i++) {
        const attr = actionEls[i].getAttribute('onclick') || '';
        const m = attr.match(/\(\s*['"]?(\d+)['"]?/);
        if (m && m[1]) foundIds.push(m[1]);
      }
      if (foundIds.length > 0 && !foundIds.includes(expectedId)) {
        return {
          kind: 'error',
          measurementIds: [],
          count: 0,
          tbeQty: null,
          heads: [],
          headDetails: [],
          error: 'Spec ID mismatch in server response',
        };
      }
    }

    let cbs = Array.from(
      doc.querySelectorAll('input[type="checkbox"][name="measurementcheckbox"].measurementcheckboxes')
    );
    if (cbs.length === 0) {
      cbs = Array.from(doc.querySelectorAll('input[type="checkbox"][name="measurementcheckbox"]'));
    }

    const seenIds = new Set();
    const measurementIds = [];
    const heads = [];
    const headDetails = [];
    for (let i = 0; i < cbs.length; i++) {
      const cb = cbs[i];
      if (cb.id === 'estmeasureheaddetails' || cb.disabled || cb.hasAttribute('disabled')) {
        continue;
      }
      const rawVal =
        cb.getAttribute('value') !== null && cb.getAttribute('value') !== undefined
          ? cb.getAttribute('value')
          : cb.value;
      const val = String(rawVal == null ? '' : rawVal).trim();
      if (!val || seenIds.has(val)) continue;
      seenIds.add(val);
      measurementIds.push(val);

      const tr = typeof cb.closest === 'function' ? cb.closest('tr') : null;
      const toggle =
        tr && typeof tr.querySelector === 'function'
          ? tr.querySelector('.pt-dropdown-toggle, a.pt-dropdown-toggle')
          : null;
      const headDesc = cleanSingleLine(toggle ? toggle.textContent : '') || '1';
      heads.push({ id: val, headDesc });

      const headOrderFallback = String(headDetails.length + 1);
      const trTds = tr && typeof tr.querySelectorAll === 'function' ? Array.from(tr.querySelectorAll('td')) : [];
      const mgn = trTds.length >= 4 ? cleanSingleLine(trTds[1].textContent) : '';
      let headQty = null;
      let headUnit = '';
      if (trTds.length >= 4 && trTds[3]) {
        const qtyCellText = cleanSingleLine(trTds[3].textContent);
        const parsedHeadQty = parseSignedNumberOrNull(qtyCellText);
        if (parsedHeadQty !== null) headQty = roundQty3(parsedHeadQty);
        const unitMatch = qtyCellText.match(/^[+-]?[\d,.]+\s*\/?\s*(.*)$/);
        if (unitMatch && unitMatch[1]) headUnit = unitMatch[1].trim();
      }

      let overlayId = 'pt-measure-overlay' + headOrderFallback;
      let itemHeadOrder = headOrderFallback;
      if (tr && typeof tr.querySelectorAll === 'function') {
        const innerEls = Array.from(tr.querySelectorAll('[onclick*="callInnerMeasurements"]'));
        for (let k = 0; k < innerEls.length; k++) {
          const oc = innerEls[k].getAttribute('onclick') || '';
          const mOv = oc.match(/callInnerMeasurements\(\s*['"]([^'"]+)['"]/);
          if (mOv && mOv[1]) {
            overlayId = mOv[1].trim();
            break;
          }
        }
        const btwEls = Array.from(tr.querySelectorAll('[onclick*="call_to_be_executed_between"]'));
        for (let k = 0; k < btwEls.length; k++) {
          const oc = btwEls[k].getAttribute('onclick') || '';
          const mOrd = oc.match(
            /call_to_be_executed_between\(\s*['"]?\d+['"]?\s*,\s*['"]?(\d+)['"]?\s*\)/
          );
          if (mOrd && mOrd[1]) {
            itemHeadOrder = mOrd[1].trim();
            break;
          }
        }
      }

      let measureTbody = doc.querySelector('#measure' + val);
      if (!measureTbody && overlayId) {
        const ovEl = doc.querySelector('#' + overlayId);
        if (ovEl) measureTbody = ovEl.querySelector('tbody');
      }

      const rows = [];
      if (measureTbody && typeof measureTbody.querySelectorAll === 'function') {
        const rTrs = Array.from(measureTbody.querySelectorAll('tr'));
        for (let r = 0; r < rTrs.length; r++) {
          const rTr = rTrs[r];
          if (hasClass(rTr, 'est_from_list') || rTr.id === 'measurement' + val) continue;
          const descInp = rTr.querySelector('input[name="itemDesc"], input[id^="itemDesc"]');
          const nInp = rTr.querySelector('input[name="itemN"], input[id^="itemN"]');
          const lInp = rTr.querySelector('input[name="itemLength"], input[id^="itemLength"]');
          const bInp = rTr.querySelector('input[name="itemBreadth"], input[id^="itemBreadth"]');
          const dInp = rTr.querySelector('input[name="itemDepth"], input[id^="itemDepth"]');
          const cfInp = rTr.querySelector('input[name="itemCf"], input[id^="itemCf"]');
          const qtyInp = rTr.querySelector('input[name="itemQty"], input[id^="itemQty"]');
          if (!nInp && !qtyInp) continue;

          const rowDesc = readInputValue(descInp);
          const rowN = readInputValue(nInp);
          const rowL = readInputValue(lInp);
          const rowB = readInputValue(bInp);
          const rowD = readInputValue(dInp);
          const rowCf = readInputValue(cfInp);
          let rowQty = parseSignedNumberOrNull(readInputValue(qtyInp));
          if (rowQty === null) {
            const calc = computeMeasurementRowQty({
              itemDesc: rowDesc,
              itemN: rowN,
              itemLength: rowL,
              itemBreadth: rowB,
              itemDepth: rowD,
              itemCf: rowCf,
            });
            rowQty = calc.kind === 'valid' ? calc.qty : 0;
          } else {
            rowQty = roundQty3(rowQty);
          }

          let rowUnit = headUnit;
          const rTds = Array.from(rTr.querySelectorAll('td'));
          if (rTds.length > 0) {
            const lastTd = rTds[rTds.length - 1];
            if (lastTd && !lastTd.querySelector('input')) {
              const uTxt = cleanSingleLine(lastTd.textContent);
              if (uTxt) rowUnit = uTxt;
            }
          }

          rows.push({
            rowIndex: rows.length + 1,
            itemDesc: rowDesc,
            itemN: rowN,
            itemLength: rowL,
            itemBreadth: rowB,
            itemDepth: rowD,
            itemCf: rowCf,
            itemQty: rowQty,
            unit: rowUnit,
          });
        }
      }

      if (headQty === null && rows.length > 0) {
        headQty = roundQty3(rows.reduce((sum, rr) => sum + (Number(rr.itemQty) || 0), 0));
      }

      headDetails.push({
        id: val,
        mgn,
        headDesc,
        headQty,
        unit: headUnit,
        itemHeadOrder,
        overlayId,
        rows,
      });
    }

    if (measurementIds.length > 0) {
      let tbeQty = null;
      const totalEl = doc.querySelector('#measrementTotal, #measurementTotal');
      if (totalEl) {
        const parsedTotal = parseSignedNumberOrNull(totalEl.textContent);
        if (parsedTotal !== null) tbeQty = roundQty3(parsedTotal);
      }
      if (tbeQty === null) {
        const qtyInputs = Array.from(doc.querySelectorAll('#measureTable input[name="itemQty"], input[name="itemQty"]'));
        let sum = 0;
        let foundAny = false;
        for (let i = 0; i < qtyInputs.length; i++) {
          const val = parseSignedNumberOrNull(readInputValue(qtyInputs[i]));
          if (val !== null) {
            sum += val;
            foundAny = true;
          }
        }
        if (foundAny) tbeQty = roundQty3(sum);
      }

      return {
        kind: 'has_measurements',
        measurementIds,
        count: measurementIds.length,
        tbeQty,
        heads,
        headDetails,
      };
    }

    const emptyMarker = doc.querySelector(
      'input[name="itemHeadDesc"], #itemHeadDesc, form#estimation_measurement, #estmeasureheaddetails, .pt-popaddMeasureForm, [onclick*="save_re_to_be_executed"]'
    );
    if (emptyMarker) {
      return {
        kind: 'empty',
        measurementIds: [],
        count: 0,
        tbeQty: 0,
        heads: [],
        headDetails: [],
        note: 'No To-Be-Executed measurements',
      };
    }

    return {
      kind: 'error',
      measurementIds: [],
      count: 0,
      tbeQty: null,
      heads: [],
      headDetails: [],
      error: 'Unrecognized To-Be-Executed response',
    };
  }

  /**
   * Parses the server response from `POST save_re_to_be_executed.pro` or
   * `POST save_re_to_be_executed_edit.pro`.
   */
  function parseSaveReTbeResponse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) {
      return { ok: false, error: 'Empty save response' };
    }

    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const obj = JSON.parse(raw);
        const status = String((obj && obj.status) || '')
          .trim()
          .toUpperCase();
        if (status === 'A') {
          return { ok: false, sessionExpired: true, error: 'Session expired' };
        }
        const busstatus = String((obj && obj.busstatus) || '')
          .trim()
          .toUpperCase();
        if (busstatus === 'T') {
          return {
            ok: true,
            message: (obj && obj.message) || 'Saved',
            specid:
              obj && obj.specid !== undefined && obj.specid !== null ? String(obj.specid) : '',
            curheadid:
              obj && obj.curheadid !== undefined && obj.curheadid !== null
                ? String(obj.curheadid)
                : obj && obj.headid !== undefined && obj.headid !== null
                ? String(obj.headid)
                : '',
            estheadspecid:
              obj && obj.estheadspecid !== undefined && obj.estheadspecid !== null
                ? String(obj.estheadspecid)
                : '',
            followUpUrl: obj && obj.url ? String(obj.url).trim() : '',
          };
        }
        return {
          ok: false,
          error:
            (obj && obj.message) ||
            'Save rejected (' + String((obj && obj.busstatus) || 'unknown') + ')',
        };
      } catch (_e) {}
    }

    if (
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return { ok: false, error: 'Portal returned an error page' };
    }

    const parsed = parseToBeExecutedHtml(raw);
    if (parsed.kind === 'has_measurements') {
      return { ok: true, message: 'Saved', parsedHtml: parsed };
    }
    return { ok: false, error: 'Unexpected save response' };
  }

  /**
   * Builds the 1-based `#estimation_measurement` form fields (`measureList[1].*`) for a
   * single direct-quantity TBE measurement entry.
   */
  function buildSingleRowTbeFormParams(targetQty, headDesc) {
    const qtyVal = roundQty3(targetQty);
    const qtyFixed = qtyVal.toFixed(3);
    const desc = cleanSingleLine(headDesc) || '1';
    return {
      itemHeadDesc: desc,
      'measureList[1].itemDesc': '',
      'measureList[1].itemN': qtyFixed,
      'measureList[1].itemLength': '',
      'measureList[1].itemBreadth': '',
      'measureList[1].itemDepth': '',
      'measureList[1].itemCf': '',
      'measureList[1].itemQty': qtyFixed,
    };
  }

  /**
   * Parses the server response from `POST delete_re_to_be_executed.pro`.
   */
  function parseDeleteReResponse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) {
      return { ok: false, error: 'Empty delete response' };
    }

    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const obj = JSON.parse(raw);
        const status = String((obj && obj.status) || '')
          .trim()
          .toUpperCase();
        if (status === 'A') {
          return { ok: false, sessionExpired: true, error: 'Session expired' };
        }
        const busstatus = String((obj && obj.busstatus) || '')
          .trim()
          .toUpperCase();
        if (busstatus === 'T') {
          return {
            ok: true,
            message: (obj && obj.message) || 'Deleted',
            headid: obj && obj.headid !== undefined && obj.headid !== null ? String(obj.headid) : '',
            estheadspecid:
              obj && obj.estheadspecid !== undefined && obj.estheadspecid !== null
                ? String(obj.estheadspecid)
                : '',
            followUpUrl: obj && obj.url ? String(obj.url).trim() : '',
          };
        }
        return {
          ok: false,
          error:
            (obj && obj.message) ||
            'Delete rejected (' + String((obj && obj.busstatus) || 'unknown') + ')',
        };
      } catch (_e) {}
    }

    if (
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return { ok: false, error: 'Portal returned an error page' };
    }

    const parsed = parseToBeExecutedHtml(raw);
    if (parsed.kind === 'empty') {
      return { ok: true, message: 'Deleted' };
    }
    return { ok: false, error: 'Measurements persisted after delete' };
  }

  function isSessionAuthError(err) {
    const msg = err && err.message ? err.message : String(err || '');
    return msg === 'SESSION_EXPIRED' || msg === 'NO_TOKEN';
  }

  function checkJsonSessionOrEmpty(raw) {
    if (!raw || !raw.startsWith('{') || !raw.endsWith('}')) return null;
    try {
      const obj = JSON.parse(raw);
      const status = String((obj && obj.status) || '')
        .trim()
        .toUpperCase();
      if (status === 'A') {
        return { kind: 'session_expired', error: 'Session expired' };
      }
      const busstatus = String((obj && obj.busstatus) || '')
        .trim()
        .toUpperCase();
      if (busstatus === 'F') {
        return { kind: 'empty', message: (obj && obj.message) || '' };
      }
      return { kind: 'json', obj };
    } catch (_e) {
      return null;
    }
  }

  function extractHeadSpecIdFromNodes(nodes) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || typeof n.querySelectorAll !== 'function') continue;
      const idEls = Array.from(n.querySelectorAll('[id^="add"]'));
      for (let j = 0; j < idEls.length; j++) {
        const m = String(idEls[j].id || '').match(/^add(\d+)$/);
        if (m && m[1]) return m[1];
      }
      const ocEls = Array.from(n.querySelectorAll('[onclick*="addRESpecRemark"]'));
      for (let j = 0; j < ocEls.length; j++) {
        const m = String(ocEls[j].getAttribute('onclick') || '').match(
          /addRESpecRemark\(\s*['"]?(\d+)['"]?/
        );
        if (m && m[1]) return m[1];
      }
    }
    return '';
  }

  /**
   * Parses the 17-column Comparative / Deviation Statement table (`re_deviation_statement.pro`).
   * Because Column 1 (`No`) has `rowspan="3"` on `trTop`, `trBottom` contains 16 `<td>` cells:
   *   [0]=DPR Qty, [5]=RE Executed, [6]=RE TBE, [7]=RE Total, [8]=TS Rate, [9]=RE Amount, [15]=% Var.
   */
  function parseReDeviationStatementHtml(html) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return { ok: false, error: 'Empty deviation response', items: [], bySpecId: new Map(), bySlAndCode: new Map() };
    }
    const jsonState = checkJsonSessionOrEmpty(raw);
    if (jsonState) {
      if (jsonState.kind === 'session_expired') {
        return { ok: false, sessionExpired: true, error: 'Session expired', items: [], bySpecId: new Map(), bySlAndCode: new Map() };
      }
      if (jsonState.kind === 'empty') {
        return { ok: true, items: [], bySpecId: new Map(), bySlAndCode: new Map() };
      }
      return { ok: false, error: (jsonState.obj && jsonState.obj.message) || 'Unexpected JSON response', items: [], bySpecId: new Map(), bySlAndCode: new Map() };
    }
    if (
      !/pt-specifications/i.test(raw) &&
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return { ok: false, error: 'Portal returned an error page', items: [], bySpecId: new Map(), bySlAndCode: new Map() };
    }
    if (typeof DOMParser === 'undefined') {
      return { ok: false, error: 'DOMParser unavailable', items: [], bySpecId: new Map(), bySlAndCode: new Map() };
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const table = doc.querySelector('table#pt-specifications') || doc.querySelector('table');
    if (!table) {
      return { ok: false, error: 'Deviation table not found', items: [], bySpecId: new Map(), bySlAndCode: new Map() };
    }

    const allTrs = Array.from(table.querySelectorAll('tr')).filter((tr) => {
      if (typeof tr.closest === 'function' && tr.closest('thead')) return false;
      if (typeof tr.querySelectorAll === 'function' && tr.querySelectorAll('th').length > 0) return false;
      return true;
    });

    const items = [];
    const bySpecId = new Map();
    const bySlAndCode = new Map();

    for (let i = 0; i < allTrs.length; i++) {
      const trTop = allTrs[i];
      const topTds = Array.from(trTop.querySelectorAll('td'));
      if (topTds.length < 3) continue;
      const isRowSpan3 = topTds[0].getAttribute('rowspan') === '3';
      const slNo = cleanSingleLine(topTds[0].textContent);
      if (!isRowSpan3 && !(topTds.length === 4 && /^\d+(?:\.\d+)?$/.test(slNo))) {
        continue;
      }

      const specCode = cleanSingleLine(topTds[1].textContent);
      const unit = cleanSingleLine(topTds[2].textContent);

      const next1 = allTrs[i + 1] || null;
      const next2 = allTrs[i + 2] || null;
      const tds1 = next1 ? Array.from(next1.querySelectorAll('td')) : [];
      const tds2 = next2 ? Array.from(next2.querySelectorAll('td')) : [];

      let trMiddle = null;
      let trBottom = null;
      let bottomTds = [];
      if (tds1.length >= 15) {
        trBottom = next1;
        bottomTds = tds1;
      } else if (tds2.length >= 15) {
        trMiddle = next1;
        trBottom = next2;
        bottomTds = tds2;
      } else {
        continue;
      }

      const headspecid = extractHeadSpecIdFromNodes([trTop, trMiddle, trBottom]);
      const desc = trMiddle ? cleanSingleLine(trMiddle.textContent) : '';

      const row = {
        slNo,
        headspecid,
        specCode,
        unit,
        desc,
        dprQty: parseSignedNumberOrNull(bottomTds[0] ? bottomTds[0].textContent : ''),
        origRate: parseSignedNumberOrNull(bottomTds[1] ? bottomTds[1].textContent : ''),
        origAmount: parseSignedNumberOrNull(bottomTds[2] ? bottomTds[2].textContent : ''),
        reExecutedQty: parseSignedNumberOrNull(bottomTds[5] ? bottomTds[5].textContent : ''),
        reTbeQty: parseSignedNumberOrNull(bottomTds[6] ? bottomTds[6].textContent : ''),
        reTotalQty: parseSignedNumberOrNull(bottomTds[7] ? bottomTds[7].textContent : ''),
        reRate: parseSignedNumberOrNull(bottomTds[8] ? bottomTds[8].textContent : ''),
        reAmount: parseSignedNumberOrNull(bottomTds[9] ? bottomTds[9].textContent : ''),
        pctVariation: parseSignedNumberOrNull(bottomTds[15] ? bottomTds[15].textContent : ''),
      };

      items.push(row);
      if (headspecid) bySpecId.set(headspecid, row);
      const slKey = `${slNo}|${specCode}`;
      if (!bySlAndCode.has(slKey)) bySlAndCode.set(slKey, row);

      i += trMiddle ? 2 : 1;
    }

    return { ok: true, items, bySpecId, bySlAndCode };
  }

  /**
   * Parses cumulative spec-wise e-MBook totals (`<b id="spectotal<headspecid>">`) from
   * `embookAE_pending.pro` or `embookAE_pending_head.pro`.
   */
  function parseEmbookSpecTotalsHtml(html) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return { ok: true, totalsBySpecId: new Map() };
    }
    const jsonState = checkJsonSessionOrEmpty(raw);
    if (jsonState) {
      if (jsonState.kind === 'session_expired') {
        return { ok: false, sessionExpired: true, error: 'Session expired', totalsBySpecId: new Map() };
      }
      return { ok: true, totalsBySpecId: new Map() };
    }
    if (
      !/spectotal|pt-specifications/i.test(raw) &&
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return { ok: false, error: 'Portal returned an error page', totalsBySpecId: new Map() };
    }
    if (typeof DOMParser === 'undefined') {
      return { ok: false, error: 'DOMParser unavailable', totalsBySpecId: new Map() };
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const totalsBySpecId = new Map();
    const totalEls = Array.from(doc.querySelectorAll('[id^="spectotal"]'));
    for (let i = 0; i < totalEls.length; i++) {
      const el = totalEls[i];
      const m = String(el.id || '').match(/^spectotal(\d+)$/);
      if (!m || !m[1]) continue;
      const val = parseSignedNumberOrNull(el.textContent);
      if (val !== null) {
        totalsBySpecId.set(m[1], roundQty(val));
      }
    }
    return { ok: true, totalsBySpecId };
  }

  function getPrevElementSibling(el) {
    if (!el) return null;
    if (el.previousElementSibling !== undefined) return el.previousElementSibling;
    const p = el.parentElement;
    if (!p || !Array.isArray(p.children)) return null;
    const idx = p.children.indexOf(el);
    return idx > 0 ? p.children[idx - 1] : null;
  }

  /**
   * Parses pending AE check-measurement entries (`0%` check-measured) from `mbook_pending_ae.pro`
   * and sums quantities algebraically per `estheadspecid`.
   */
  function parseMbookPendingAeHtml(html) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return { ok: true, pendingBySpecId: new Map(), entriesBySpecId: new Map() };
    }
    const jsonState = checkJsonSessionOrEmpty(raw);
    if (jsonState) {
      if (jsonState.kind === 'session_expired') {
        return {
          ok: false,
          sessionExpired: true,
          error: 'Session expired',
          pendingBySpecId: new Map(),
          entriesBySpecId: new Map(),
        };
      }
      return { ok: true, pendingBySpecId: new Map(), entriesBySpecId: new Map() };
    }
    if (
      !/callnewmeasurementright_pending|pt-specifications|no\s+data|activate_mbook/i.test(raw) &&
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return {
        ok: false,
        error: 'Portal returned an error page',
        pendingBySpecId: new Map(),
        entriesBySpecId: new Map(),
      };
    }
    if (typeof DOMParser === 'undefined') {
      return {
        ok: false,
        error: 'DOMParser unavailable',
        pendingBySpecId: new Map(),
        entriesBySpecId: new Map(),
      };
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const pendingBySpecId = new Map();
    const entriesBySpecId = new Map();
    const seenEntryIds = new Set();
    const triggers = Array.from(doc.querySelectorAll('[onclick*="callnewmeasurementright_pending"]'));

    for (let i = 0; i < triggers.length; i++) {
      const oc = triggers[i].getAttribute('onclick') || '';
      const m = oc.match(
        /callnewmeasurementright_pending\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*(?:,\s*['"]?(\d+)['"]?)?/
      );
      if (!m || !m[1]) continue;
      const specId = m[1];
      const activityId = m[2] || '';
      const entryHeadId = m[3] || '';
      const entryId = entryHeadId ? `${specId}:${entryHeadId}` : `${specId}:idx:${i}`;
      if (seenEntryIds.has(entryId)) continue;
      seenEntryIds.add(entryId);

      const trMiddle = typeof triggers[i].closest === 'function' ? triggers[i].closest('tr') : null;
      const trTopCandidate = getPrevElementSibling(trMiddle);
      const trTop = trTopCandidate && hasClass(trTopCandidate, 'pt-sp-top') ? trTopCandidate : null;
      const trTotal = trMiddle ? trMiddle.nextElementSibling : null;
      const tds = trTotal ? Array.from(trTotal.querySelectorAll('td')) : [];
      let qty = null;
      let qtyIdx = -1;
      if (tds.length >= 2) {
        qty = parseSignedNumberOrNull(tds[1].textContent);
        if (qty !== null) qtyIdx = 1;
      }
      if (qty === null) {
        for (let k = 0; k < tds.length; k++) {
          const val = parseSignedNumberOrNull(tds[k].textContent);
          if (val !== null) {
            qty = val;
            qtyIdx = k;
            break;
          }
        }
      }
      if (qty === null) continue;

      let slNo = '';
      let mgn = '';
      let specCode = '';
      let entryDate = '';
      if (trTop) {
        const topTds = Array.from(trTop.querySelectorAll('td'));
        for (let t = 0; t < topTds.length; t++) {
          const cellText = cleanSingleLine(topTds[t].textContent);
          if (!cellText) continue;
          const mgnMatch = cellText.match(/\bMGN\s*:\s*([A-Za-z0-9_.\-/]+)/i);
          if (mgnMatch && !mgn) {
            mgn = mgnMatch[1];
            continue;
          }
          const dateMatch = cellText.match(/\b(\d{2}-\d{2}-\d{4})\b/);
          if (dateMatch && !entryDate) {
            entryDate = dateMatch[1];
            continue;
          }
          if (t === 0 && /^\d+$/.test(cellText) && !slNo) {
            slNo = cellText;
            continue;
          }
          if (!specCode && !/^\d+$/.test(cellText)) {
            specCode = cellText;
          }
        }
      }

      const pContent =
        trMiddle && typeof trMiddle.querySelector === 'function'
          ? trMiddle.querySelector('p.sp-content')
          : null;
      const desc = cleanSingleLine(
        pContent ? pContent.textContent : trMiddle ? trMiddle.textContent : ''
      );
      let unit = '';
      if (tds.length > 0) {
        for (let u = (qtyIdx >= 0 ? qtyIdx + 1 : 0); u < tds.length; u++) {
          const candidate = cleanSingleLine(tds[u].textContent);
          if (candidate && parseSignedNumberOrNull(candidate) === null && !/^total$/i.test(candidate)) {
            unit = candidate;
            break;
          }
        }
      }

      const roundedQty = roundQty(qty);
      const prev = pendingBySpecId.get(specId) || { pendingQty: 0, entryCount: 0 };
      pendingBySpecId.set(specId, {
        pendingQty: roundQty(prev.pendingQty + roundedQty),
        entryCount: prev.entryCount + 1,
      });

      const list = entriesBySpecId.get(specId) || [];
      list.push({
        entryHeadId,
        activityId,
        specId,
        slNo,
        mgn,
        specCode,
        entryDate,
        desc,
        qty: roundedQty,
        unit,
      });
      entriesBySpecId.set(specId, list);
    }

    return { ok: true, pendingBySpecId, entriesBySpecId };
  }

  /**
   * Parses Draft (`#t6`) measurement rows returned by `POST newrightmeasurement_pending.pro`.
   */
  function parseMbookEntryDetailsHtml(html) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return { ok: true, rows: [], canEdit: false, canDelete: false, unit: '' };
    }
    const jsonState = checkJsonSessionOrEmpty(raw);
    if (jsonState) {
      if (jsonState.kind === 'session_expired') {
        return {
          ok: false,
          sessionExpired: true,
          error: 'Session expired',
          rows: [],
          canEdit: false,
          canDelete: false,
          unit: '',
        };
      }
      return { ok: true, rows: [], canEdit: false, canDelete: false, unit: '' };
    }
    if (
      !/pt-specifications2|mcheckbox|edit_measurement|delete_measurement_common|\bt6\b/i.test(raw) &&
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return {
        ok: false,
        error: 'Portal returned an error page',
        rows: [],
        canEdit: false,
        canDelete: false,
        unit: '',
      };
    }
    if (typeof DOMParser === 'undefined') {
      return {
        ok: false,
        error: 'DOMParser unavailable',
        rows: [],
        canEdit: false,
        canDelete: false,
        unit: '',
      };
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const draftContainer = doc.querySelector('#t6');
    if (!draftContainer) {
      return { ok: true, rows: [], canEdit: false, canDelete: false, unit: '' };
    }

    const canEdit = Boolean(
      draftContainer.querySelector('[onclick*="edit_measurement"]') ||
        doc.querySelector('#t6 [onclick*="edit_measurement"], #menuContent [onclick*="edit_measurement"]')
    );
    const canDelete = Boolean(
      draftContainer.querySelector('[onclick*="delete_measurement_common"]') ||
        doc.querySelector(
          '#t6 [onclick*="delete_measurement_common"], #menuContent [onclick*="delete_measurement_common"]'
        )
    );

    const normalizeDimCell = (txt) => {
      const s = cleanSingleLine(txt);
      return !s || s === '-' || s === '—' ? '' : s;
    };

    const rows = [];
    let commonUnit = '';
    const trs = Array.from(draftContainer.querySelectorAll('tr'));
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      const cbs = Array.from(tr.querySelectorAll('input[name="mcheckbox"]'));
      const cb = cbs.find((el) => {
        const elId = String(el.id || '');
        const elName = String(el.getAttribute('name') || '');
        return elId !== 'coefficientvalDraft' && elName === 'mcheckbox';
      });
      if (!cb) continue;
      const measurementId = readInputValue(cb);
      if (!measurementId) continue;

      const tds = Array.from(tr.querySelectorAll('td'));
      const desc = cleanSingleLine(tds[1] ? tds[1].textContent : '');
      const no = normalizeDimCell(tds[2] ? tds[2].textContent : '');
      const length = normalizeDimCell(tds[3] ? tds[3].textContent : '');
      const breadth = normalizeDimCell(tds[4] ? tds[4].textContent : '');
      const depth = normalizeDimCell(tds[5] ? tds[5].textContent : '');
      const cf = normalizeDimCell(tds[6] ? tds[6].textContent : '');
      const qty = parseSignedNumberOrNull(tds[7] ? tds[7].textContent : '');
      const unit = cleanSingleLine(tds[8] ? tds[8].textContent : '');
      if (!commonUnit && unit) commonUnit = unit;

      rows.push({
        measurementId,
        desc,
        no,
        length,
        breadth,
        depth,
        cf,
        qty,
        unit,
      });
    }

    return { ok: true, rows, canEdit, canDelete, unit: commonUnit };
  }

  /**
   * Parses `#addmeasurementtabsaveform` from `POST mbookmeasurementedit.pro` using 0-based
   * `eMbookMeasurementsPojoItems[i].*` field names.
   */
  function parseMbookEditFormHtml(html, fallbackEntryHeadId) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return { ok: false, error: 'Empty edit form response' };
    }
    const jsonState = checkJsonSessionOrEmpty(raw);
    if (jsonState) {
      if (jsonState.kind === 'session_expired') {
        return { ok: false, sessionExpired: true, error: 'Session expired' };
      }
      return { ok: false, error: 'Edit form not returned by portal' };
    }
    if (
      !/addmeasurementtabsaveform|eMbookMeasurementsPojoItems|saveMeasurementsEmbook/i.test(raw) &&
      extractor &&
      typeof extractor.isPortalErrorHtml === 'function' &&
      extractor.isPortalErrorHtml(raw)
    ) {
      return { ok: false, error: 'Portal returned an error page' };
    }
    if (typeof DOMParser === 'undefined') {
      return { ok: false, error: 'DOMParser unavailable' };
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const formEl = doc.querySelector('#addmeasurementtabsaveform');
    const hasPojoInRaw = /eMbookMeasurementsPojoItems/i.test(raw);
    if (!formEl && !hasPojoInRaw) {
      return { ok: false, error: 'Edit form not found in portal response' };
    }
    const scope = formEl || doc;

    let entryHeadId = '';
    const saveMatch = raw.match(/saveMeasurementsEmbook\(\s*['"]?(\d+)['"]?\s*\)/);
    if (saveMatch && saveMatch[1]) {
      entryHeadId = saveMatch[1];
    } else {
      const saveBtn = doc.querySelector('[onclick*="saveMeasurementsEmbook"]');
      if (saveBtn) {
        const oc = saveBtn.getAttribute('onclick') || '';
        const m2 = oc.match(/saveMeasurementsEmbook\(\s*['"]?(\d+)['"]?\s*\)/);
        if (m2 && m2[1]) entryHeadId = m2[1];
      }
    }
    if (!entryHeadId) entryHeadId = String(fallbackEntryHeadId || '').trim();

    const spanEl =
      scope.querySelector('#span_Text_global') || scope.querySelector('input[name="span_Text_global"]');
    const spanTextGlobal = spanEl ? readInputValue(spanEl) : '';

    const specEl =
      scope.querySelector('#estheadspec_id') || scope.querySelector('input[name="estheadspecid"]');
    const estheadspecid = specEl ? readInputValue(specEl) : '';

    const byIdx = new Map();
    const collectInputs = (inputs) => {
      for (let i = 0; i < inputs.length; i++) {
        const inp = inputs[i];
        const name = inp.getAttribute('name') || '';
        const m = name.match(/^eMbookMeasurementsPojoItems\[(\d+)\]\.(\w+)$/);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        const prop = m[2];
        if (!byIdx.has(idx)) byIdx.set(idx, { index: idx });
        byIdx.get(idx)[prop] = readInputValue(inp);
      }
    };

    let rowTrs = Array.from(scope.querySelectorAll('tr[id^="rec-"]'));
    if (rowTrs.length === 0) {
      rowTrs = Array.from(scope.querySelectorAll('tbody tr'));
    }
    for (let r = 0; r < rowTrs.length; r++) {
      collectInputs(Array.from(rowTrs[r].querySelectorAll('input')));
    }
    if (byIdx.size === 0) {
      collectInputs(Array.from(scope.querySelectorAll('input')));
    }

    const sortedIndices = Array.from(byIdx.keys()).sort((a, b) => a - b);
    const rows = sortedIndices.map((idx) => {
      const rawRow = byIdx.get(idx);
      return {
        index: idx,
        dataId: String(rawRow.dataId || '').trim(),
        measurementId: String(rawRow.measurementId || '').trim(),
        desc: String(rawRow.measureddescription || '').trim(),
        no: String(rawRow.measuredno || '').trim(),
        length: String(rawRow.measuredlength || '').trim(),
        breadth: String(rawRow.measuredbreadth || '').trim(),
        depth: String(rawRow.measureddepth || '').trim(),
        combobxId: String(rawRow.combobx_id || '').trim(),
        combobx: String(rawRow.combobx || '').trim(),
        qty: String(rawRow.measuredquantity || '').trim(),
      };
    });

    let coefficient = 'na';
    const selectEl =
      scope.querySelector('#coefficient') || scope.querySelector('select[name="coefficient"]');
    const optionVals = new Set();
    let selectedVal = '';
    if (selectEl) {
      const opts = Array.from(selectEl.querySelectorAll('option'));
      for (let o = 0; o < opts.length; o++) {
        const opt = opts[o];
        const v = String(opt.getAttribute('value') !== null ? opt.getAttribute('value') : readInputValue(opt)).trim();
        if (v) optionVals.add(v);
        if (opt.hasAttribute('selected') || opt.selected === true) {
          selectedVal = v;
        }
      }
    }
    if (selectedVal && selectedVal !== '-1') {
      coefficient = selectedVal;
    } else {
      const rowCoeff = rows.find((r) => r.combobxId && (optionVals.size === 0 || optionVals.has(r.combobxId)));
      if (rowCoeff) {
        coefficient = rowCoeff.combobxId;
      } else {
        coefficient = 'na';
      }
    }

    return {
      ok: true,
      entryHeadId,
      spanTextGlobal,
      estheadspecid,
      coefficient,
      rows,
    };
  }

  /**
   * Validates and computes a single live e-MBook measurement row using plain numbers only
   * (PRICE 3.0's `saveMeasurementsEmbook` validator rejects arithmetic formulas).
   */
  function validateAndComputeMbookRow(row) {
    const r = row && typeof row === 'object' ? row : {};
    const desc = cleanSingleLine(r.desc !== undefined ? r.desc : r.measureddescription);
    const noStr = String(r.no !== undefined ? r.no : r.measuredno || '').trim().replace(/,/g, '');
    const lStr = String(r.length !== undefined ? r.length : r.measuredlength || '').trim().replace(/,/g, '');
    const bStr = String(r.breadth !== undefined ? r.breadth : r.measuredbreadth || '').trim().replace(/,/g, '');
    const dStr = String(r.depth !== undefined ? r.depth : r.measureddepth || '').trim().replace(/,/g, '');
    const cfStr = String(r.combobx !== undefined ? r.combobx : '').trim().replace(/,/g, '');

    if (!noStr) {
      return { kind: 'invalid', field: 'no', error: 'No is required' };
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(noStr)) {
      return { kind: 'invalid', field: 'no', error: 'Plain number only (formulas not supported in e-MBook)' };
    }
    const noVal = Number(noStr);
    if (!Number.isFinite(noVal)) {
      return { kind: 'invalid', field: 'no', error: 'Invalid No' };
    }

    const optDimFields = [
      ['length', lStr],
      ['breadth', bStr],
      ['depth', dStr],
    ];
    const dimVals = {};
    const dimFormatted = {};
    for (let i = 0; i < optDimFields.length; i++) {
      const [fname, fval] = optDimFields[i];
      if (!fval) {
        dimVals[fname] = 1;
        dimFormatted[fname] = '';
        continue;
      }
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(fval)) {
        return {
          kind: 'invalid',
          field: fname,
          error: 'Non-negative plain number only',
        };
      }
      const numVal = Number(fval);
      if (!Number.isFinite(numVal) || numVal < 0) {
        return { kind: 'invalid', field: fname, error: 'Must be non-negative' };
      }
      dimVals[fname] = numVal;
      dimFormatted[fname] = numVal.toFixed(3);
    }

    let cfFactor = 1;
    if (cfStr) {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cfStr)) {
        return { kind: 'invalid', field: 'combobx', error: 'Unsupported non-numeric coefficient' };
      }
      const parsedCf = Number(cfStr);
      if (!Number.isFinite(parsedCf)) {
        return { kind: 'invalid', field: 'combobx', error: 'Invalid coefficient' };
      }
      cfFactor = parsedCf;
    }

    const qty = roundQty3(noVal * dimVals.length * dimVals.breadth * dimVals.depth * cfFactor);
    return {
      kind: 'valid',
      desc,
      noVal,
      qty,
      isDeduction: qty < -QTY_EPS,
      formatted: {
        measureddescription: desc,
        measuredno: noVal.toFixed(3),
        measuredlength: dimFormatted.length,
        measuredbreadth: dimFormatted.breadth,
        measureddepth: dimFormatted.depth,
        measuredquantity: qty.toFixed(3),
      },
    };
  }

  /**
   * Builds the 0-based `POST updateMeasurementsEmbook.pro` payload without `mcheckbox`.
   */
  function buildMbookUpdateParams(editMeta, rows) {
    if (!editMeta || !editMeta.entryHeadId || !editMeta.estheadspecid) {
      return { ok: false, error: 'Missing e-MBook entry head or specification ID' };
    }
    const metaRows = Array.isArray(editMeta.rows) ? editMeta.rows : [];
    const draftRows = Array.isArray(rows) ? rows : [];
    if (metaRows.length === 0 || draftRows.length !== metaRows.length) {
      return { ok: false, error: 'e-MBook edit row count mismatch — reload and try again' };
    }

    const coeff =
      editMeta.coefficient && String(editMeta.coefficient).trim() !== '-1'
        ? String(editMeta.coefficient).trim()
        : 'na';

    const params = {
      mbookentryheadid: String(editMeta.entryHeadId),
      span_Text_global: String(editMeta.spanTextGlobal || ''),
      estheadspecid: String(editMeta.estheadspecid),
      coefficient: coeff,
    };

    let totalQty = 0;
    const rowQtys = [];

    for (let i = 0; i < metaRows.length; i++) {
      const mRow = metaRows[i];
      const dRow = draftRows[i] || {};
      if (!mRow || !mRow.dataId || !mRow.measurementId) {
        return { ok: false, error: `Missing row metadata at row ${i + 1}`, rowIndex: i };
      }
      if (dRow.measurementId && String(dRow.measurementId) !== String(mRow.measurementId)) {
        return {
          ok: false,
          error: `Measurement ID mismatch at row ${i + 1} — reload and try again`,
          rowIndex: i,
        };
      }

      const calc = validateAndComputeMbookRow({
        desc: dRow.desc !== undefined ? dRow.desc : mRow.desc,
        no: dRow.no !== undefined ? dRow.no : mRow.no,
        length: dRow.length !== undefined ? dRow.length : mRow.length,
        breadth: dRow.breadth !== undefined ? dRow.breadth : mRow.breadth,
        depth: dRow.depth !== undefined ? dRow.depth : mRow.depth,
        combobx: mRow.combobx,
      });
      if (calc.kind !== 'valid') {
        return {
          ok: false,
          error: `Row ${i + 1}: ${calc.error}`,
          field: calc.field,
          rowIndex: i,
        };
      }

      const prefix = `eMbookMeasurementsPojoItems[${i}].`;
      params[prefix + 'dataId'] = String(mRow.dataId);
      params[prefix + 'measurementId'] = String(mRow.measurementId);
      params[prefix + 'measureddescription'] = calc.formatted.measureddescription;
      params[prefix + 'measuredno'] = calc.formatted.measuredno;
      params[prefix + 'measuredlength'] = calc.formatted.measuredlength;
      params[prefix + 'measuredbreadth'] = calc.formatted.measuredbreadth;
      params[prefix + 'measureddepth'] = calc.formatted.measureddepth;
      params[prefix + 'combobx_id'] = String(mRow.combobxId || '');
      params[prefix + 'combobx'] = String(mRow.combobx || '');
      params[prefix + 'measuredquantity'] = calc.formatted.measuredquantity;

      totalQty = roundQty3(totalQty + calc.qty);
      rowQtys.push(calc.qty);
    }

    return { ok: true, params, totalQty, rowQtys };
  }

  /**
   * Parses JSON responses from `updateMeasurementsEmbook.pro` (`save`) and
   * `delete_measurement_common.pro` (`delete`).
   */
  function parseMbookMutationResponse(text, kind) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) {
      return { ok: false, error: 'Empty response from portal' };
    }

    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch (_e) {
      return { ok: false, error: 'Unexpected non-JSON response from portal' };
    }
    if (!obj || typeof obj !== 'object') {
      return { ok: false, error: 'Invalid response from portal' };
    }

    const status = String(obj.status || '').toUpperCase();
    const busstatus = String(obj.busstatus || '').toUpperCase();
    const reqstatus = String(obj.reqstatus || '').toUpperCase();
    const msg = cleanSingleLine(obj.message || obj.msg || '');

    if (status === 'A') {
      return { ok: false, sessionExpired: true, error: 'Session expired' };
    }

    if (kind === 'delete') {
      if (busstatus === 'T') {
        return { ok: true, message: msg || 'Deleted from e-MBook' };
      }
      return { ok: false, error: msg || 'Portal rejected measurement deletion' };
    }

    if (
      busstatus === 'F' ||
      reqstatus === 'F' ||
      status === 'F' ||
      /\b(fail|failed|error|invalid|cannot|not\s+allowed|denied|exception|choose\s+coefficient)\b/i.test(
        msg
      )
    ) {
      return { ok: false, error: msg || 'Portal rejected e-MBook measurement update' };
    }

    return { ok: true, message: msg || 'Saved to e-MBook' };
  }

  /**
   * Fallback parser for Original Sanctioned Estimate (DPR) views (`approvedEstimationView.pro` /
   * `showApprovedHeadSpecs.pro`) keyed by `headspecid`.
   */
  function parseApprovedDprSpecsHtml(html) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) return { ok: true, dprQtyBySpecId: new Map() };
    const jsonState = checkJsonSessionOrEmpty(raw);
    if (jsonState) {
      if (jsonState.kind === 'session_expired') {
        return { ok: false, sessionExpired: true, error: 'Session expired', dprQtyBySpecId: new Map() };
      }
      return { ok: true, dprQtyBySpecId: new Map() };
    }
    if (typeof DOMParser === 'undefined') {
      return { ok: false, error: 'DOMParser unavailable', dprQtyBySpecId: new Map() };
    }

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const dprQtyBySpecId = new Map();
    const topRows = Array.from(doc.querySelectorAll('tr.pt-sp-top'));

    for (let i = 0; i < topRows.length; i++) {
      const trTop = topRows[i];
      let headspecid = '';
      const oc = trTop.getAttribute('onclick') || '';
      const mOc = oc.match(/showApprovedMeasurementHeadingList\(\s*['"]?(\d+)['"]?\s*\)/);
      if (mOc && mOc[1]) {
        headspecid = mOc[1];
      } else {
        const mCls = String(trTop.className || '').match(/\bspecSelect(\d+)\b/);
        if (mCls && mCls[1]) headspecid = mCls[1];
      }
      if (!headspecid || dprQtyBySpecId.has(headspecid)) continue;

      let cur = trTop.nextElementSibling;
      let trBottom = null;
      while (cur) {
        if (hasClass(cur, 'pt-sp-top')) break;
        if (hasClass(cur, 'pt-sp-bottom')) {
          trBottom = cur;
          break;
        }
        cur = cur.nextElementSibling;
      }
      if (!trBottom) continue;
      const tds = Array.from(trBottom.querySelectorAll('td'));
      const qty = parseSignedNumberOrNull(tds[0] ? tds[0].textContent : '');
      if (qty !== null) {
        dprQtyBySpecId.set(headspecid, roundQty(qty));
      }
    }

    return { ok: true, dprQtyBySpecId };
  }

  /**
   * Combines RE spec items with parsed Deviation Statement, DPR fallback, e-MBook cumulative totals,
   * and AE-Inbox pending entries into a per-item helper diagnostic model.
   */
  function buildReHelperRowModel(specItems, sources) {
    const src = sources && typeof sources === 'object' ? sources : {};
    const devBySpecId = src.devBySpecId instanceof Map ? src.devBySpecId : new Map();
    const devBySlAndCode = src.devBySlAndCode instanceof Map ? src.devBySlAndCode : new Map();
    const dprQtyBySpecId = src.dprQtyBySpecId instanceof Map ? src.dprQtyBySpecId : new Map();
    const mbookTotalsBySpecId =
      src.mbookTotalsBySpecId instanceof Map ? src.mbookTotalsBySpecId : null;
    const mbookPendingBySpecId =
      src.mbookPendingBySpecId instanceof Map ? src.mbookPendingBySpecId : null;
    const hasDevSource = Boolean(src.hasDevSource || devBySpecId.size > 0 || devBySlAndCode.size > 0);
    const hasMbookSource = Boolean(src.hasMbookSource || mbookTotalsBySpecId !== null);

    const rows = [];
    const bySpecId = new Map();
    const list = Array.isArray(specItems) ? specItems : [];

    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it || !it.headspecid) continue;
      const sid = String(it.headspecid);
      const dev = devBySpecId.get(sid) || devBySlAndCode.get(`${it.slNo}|${it.specCode}`) || null;

      let dprQty = null;
      if (dev && dev.dprQty !== null) dprQty = roundQty(dev.dprQty);
      else if (dprQtyBySpecId.has(sid)) dprQty = roundQty(dprQtyBySpecId.get(sid));

      const reExecutedQty = dev && dev.reExecutedQty !== null ? roundQty(dev.reExecutedQty) : null;
      const reTbeQty = dev && dev.reTbeQty !== null ? roundQty(dev.reTbeQty) : null;
      const reTotalQty =
        dev && dev.reTotalQty !== null ? roundQty(dev.reTotalQty) : roundQty(it.qty);

      let mbookTotalQty = null;
      let mbookPendingQty = 0;
      let mbookPendingCount = 0;
      let mbookAcceptedQty = null;

      if (hasMbookSource) {
        mbookTotalQty =
          mbookTotalsBySpecId && mbookTotalsBySpecId.has(sid)
            ? roundQty(mbookTotalsBySpecId.get(sid))
            : 0;
        const pendObj =
          mbookPendingBySpecId && mbookPendingBySpecId.has(sid)
            ? mbookPendingBySpecId.get(sid)
            : null;
        mbookPendingQty = pendObj ? roundQty(pendObj.pendingQty) : 0;
        mbookPendingCount = pendObj ? Number(pendObj.entryCount) || 0 : 0;
        mbookAcceptedQty = roundQty(mbookTotalQty - mbookPendingQty);
      }

      const effDpr = dprQty !== null ? dprQty : 0;
      const effExec = reExecutedQty !== null ? reExecutedQty : 0;
      const effTbe = reTbeQty !== null ? reTbeQty : 0;
      const effAccepted = mbookAcceptedQty !== null ? mbookAcceptedQty : effExec;

      const isExtraItem =
        dprQty !== null && Math.abs(effDpr) <= QTY_EPS && (reTotalQty > QTY_EPS || hasDevSource);
      const isDoubledTbe =
        dprQty !== null &&
        effDpr > QTY_EPS &&
        effExec > QTY_EPS &&
        reTbeQty !== null &&
        Math.abs(effTbe - effDpr) <= QTY_EPS;
      const hasPendingAe = Math.abs(mbookPendingQty) > QTY_EPS;
      const hasUnsyncedMbook =
        hasMbookSource &&
        reExecutedQty !== null &&
        Math.abs(mbookAcceptedQty - effExec) > QTY_EPS;
      const isFullyExecutedInMbook = dprQty !== null && effDpr > QTY_EPS && effAccepted + QTY_EPS >= effDpr;
      const hasTbe = reTbeQty !== null ? effTbe > QTY_EPS : null;
      const hasMbook = hasMbookSource
        ? Math.abs(mbookTotalQty) > QTY_EPS
        : reExecutedQty !== null
        ? Math.abs(effExec) > QTY_EPS
        : null;

      const deviation = computeQtyDeviation(dprQty, reTotalQty);
      const dprBalanceQty =
        dprQty !== null && reExecutedQty !== null
          ? roundQty3(Math.max(0, dprQty - reExecutedQty))
          : null;

      const row = {
        headspecid: sid,
        dprQty,
        origAmount: dev ? dev.origAmount : null,
        reExecutedQty,
        reTbeQty,
        reTotalQty,
        mbookAcceptedQty,
        mbookPendingQty,
        mbookPendingCount,
        mbookTotalQty,
        hasDevSource,
        hasMbookSource,
        isExtraItem,
        isDoubledTbe,
        hasPendingAe,
        hasUnsyncedMbook,
        isFullyExecutedInMbook,
        hasTbe,
        hasMbook,
        deviation,
        dprBalanceQty,
      };
      rows.push(row);
      bySpecId.set(sid, row);
    }

    return { rows, bySpecId };
  }

  function sumDeviationTotals(devParsed) {
    let dprTotalAmt = 0;
    let reTotalAmt = 0;
    let hasOrigAmt = false;
    let rowCount = 0;
    const rows = devParsed && Array.isArray(devParsed.items) ? devParsed.items : [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      rowCount++;
      if (r.origAmount !== null && Number.isFinite(Number(r.origAmount))) {
        dprTotalAmt += Number(r.origAmount);
        hasOrigAmt = true;
      }
      if (r.reAmount !== null && Number.isFinite(Number(r.reAmount))) {
        reTotalAmt += Number(r.reAmount);
      }
    }
    return { ok: rowCount > 0, dprTotalAmt, reTotalAmt, hasOrigAmt, rowCount };
  }

  function formatReImpactSummary(dprAmt, reAmt, hasOrigAmt) {
    const reVal = Number(reAmt) || 0;
    const dprVal = Number(dprAmt) || 0;
    if (hasOrigAmt && dprVal > 0) {
      const pct = ((reVal - dprVal) / dprVal) * 100;
      const pctRounded = Math.round(pct * 10) / 10;
      const pctSign = pctRounded > 0 ? '+' : '';
      return {
        text: `DPR: ₹${formatInr(dprVal)} → RE: ₹${formatInr(reVal)} (${pctSign}${pctRounded.toFixed(1)}%)`,
        tone: pctRounded > 0 ? 'over' : pctRounded < 0 ? 'under' : 'flat',
      };
    }
    return {
      text: `DPR: — → RE: ₹${formatInr(reVal)}`,
      tone: 'flat',
    };
  }

  function parseHeadingTotalsTable(tbl, activeHeadId) {
    if (!tbl || typeof tbl.querySelectorAll !== 'function') {
      return {
        ok: false,
        rowCount: 0,
        specHeadIds: [],
        matchedActiveHead: false,
        specsTotal: 0,
        otherSpecsAmt: 0,
        extraChargesAmt: 0,
        grandTotal: 0,
      };
    }

    let rowCount = 0;
    const specHeadIds = [];
    let matchedActiveHead = false;
    let specsTotal = 0;
    let otherSpecsAmt = 0;
    let extraChargesAmt = 0;
    const activeId = String(activeHeadId || '').trim();

    const rows = Array.from(tbl.querySelectorAll('tr'));
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];
      if (!hasClass(tr, 'pt-sp-top')) continue;
      const rawId = String(tr.getAttribute('id') || '').trim();
      const mId = rawId.match(/^tr-(\d+)$/);
      const headId = mId ? mId[1] : '';
      const tds = Array.from(tr.querySelectorAll('td'));
      const noTd = tds.length >= 5 ? tds[1] : tds[0];
      const amtTd = tds.length >= 5 ? tds[3] : tds[2];
      const noText = cleanSingleLine(noTd ? noTd.textContent : '');
      const inputs = Array.from(tr.querySelectorAll('input'));
      const inp =
        inputs.find(
          (el) =>
            hasClass(el, 'headtotal') ||
            el.getAttribute('name') === 'headtotal' ||
            /^headtotal\d+$/i.test(String(el.getAttribute('id') || ''))
        ) || null;
      const rawInpVal = inp ? readInputValue(inp) : '';
      const parsedAmt = parseSignedNumberOrNull(
        rawInpVal !== '' ? rawInpVal : amtTd ? amtTd.textContent : ''
      );
      const amt = parsedAmt !== null ? parsedAmt : 0;

      rowCount++;
      if (rawId === 'tr-0' || /^[LC]$/i.test(noText)) {
        extraChargesAmt += amt;
      } else {
        specsTotal += amt;
        if (headId && headId !== '0') {
          if (!specHeadIds.includes(headId)) specHeadIds.push(headId);
          if (activeId && headId === activeId) matchedActiveHead = true;
          else otherSpecsAmt += amt;
        }
      }
    }

    return {
      ok: rowCount > 0,
      rowCount,
      specHeadIds,
      matchedActiveHead,
      specsTotal,
      otherSpecsAmt,
      extraChargesAmt,
      grandTotal: specsTotal + extraChargesAmt,
    };
  }

  function extractRePageTotalsFromDoc(rootDoc, activeHeadId) {
    const tbl =
      rootDoc && typeof rootDoc.querySelector === 'function'
        ? rootDoc.querySelector('#pt-specifications2')
        : null;
    const t = parseHeadingTotalsTable(tbl, activeHeadId);
    return {
      ok: t.ok,
      specHeadIds: t.specHeadIds,
      matchedActiveHead: t.matchedActiveHead,
      specsReTotal: t.specsTotal,
      otherSpecsReAmt: t.otherSpecsAmt,
      extraChargesReAmt: t.extraChargesAmt,
      grandReTotal: t.grandTotal,
    };
  }

  function parseApprovedDprHeadingTotalsHtml(html) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return {
        ok: false,
        rowCount: 0,
        specsDprTotal: 0,
        extraChargesDprAmt: 0,
        grandDprTotal: 0,
      };
    }
    const jsonCheck = checkJsonSessionOrEmpty(raw);
    if (jsonCheck && jsonCheck.kind === 'session_expired') {
      return {
        ok: false,
        sessionExpired: true,
        error: 'Session expired',
        rowCount: 0,
        specsDprTotal: 0,
        extraChargesDprAmt: 0,
        grandDprTotal: 0,
      };
    }
    if (typeof DOMParser === 'undefined') {
      return {
        ok: false,
        error: 'DOMParser unavailable',
        rowCount: 0,
        specsDprTotal: 0,
        extraChargesDprAmt: 0,
        grandDprTotal: 0,
      };
    }
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const t = parseHeadingTotalsTable(doc.querySelector('#pt-specifications2'), '');
    return {
      ok: t.ok,
      rowCount: t.rowCount,
      specsDprTotal: t.specsTotal,
      extraChargesDprAmt: t.extraChargesAmt,
      grandDprTotal: t.grandTotal,
    };
  }

  const helperCache = {
    byHeadingKey: new Map(),
    pendingAeByActivityId: new Map(),
    pendingEntriesAeByActivityId: new Map(),
    dprTotalsByDprEstId: new Map(),
  };

  function makeHelperCacheKey(reEstId, headId) {
    return `${String(reEstId || '').trim()}|${String(headId || '').trim()}`;
  }

  function extractEstEditIdFromHtml(html) {
    const raw = String(html || '');
    const m =
      raw.match(/<input[^>]*\bid=["']estEditId["'][^>]*\bvalue=["']([^"']+)["']/i) ||
      raw.match(/<input[^>]*\bvalue=["']([^"']+)["'][^>]*\bid=["']estEditId["']/i);
    return m && m[1] ? m[1].trim() : '';
  }

  /**
   * Restores the active PRICE 3.0 Revised Estimate server-side session context after calling
   * deviation, DPR, or e-MBook endpoints. Best-effort unless auth fails.
   */
  async function restoreReSession(ctx, postForm, doc, onStatus) {
    if (!ctx || typeof postForm !== 'function') return;
    try {
      if (typeof onStatus === 'function') onStatus('Restoring RE session...');
      if (ctx.reEstId) {
        const reHtml = await postForm('revised_estimation.pro', { estid: ctx.reEstId }, true);
        const nextEditId = extractEstEditIdFromHtml(reHtml);
        if (nextEditId && doc && typeof doc.getElementById === 'function') {
          const editEl = doc.getElementById('estEditId');
          if (editEl && 'value' in editEl) editEl.value = nextEditId;
          ctx.estEditId = nextEditId;
        }
      }
      if (ctx.headId) {
        await postForm(
          'change_re_heading.pro',
          {
            estHeadid: ctx.headId,
            headorderNo: ctx.headOrderNo || '1',
            issimilarspec: 'F',
          },
          true
        );
      }
      if (ctx.selItem && ctx.selTab === 'AM') {
        await postForm('call_to_be_executed.pro', { headspecid: ctx.selItem }, true);
      }
    } catch (_restoreErr) {
      // Best-effort session restore; never mask fetched/mutated results
    }
  }

  /**
   * Updates `pendingAeByActivityId`, `pendingEntriesAeByActivityId`, and every cached heading
   * bundle sharing `activityId` after a live e-MBook save or delete.
   */
  function syncHelperCachesAfterMbookChange(cache, activityId, freshPendingParsed) {
    if (!cache || !activityId || !freshPendingParsed) return;
    const actId = String(activityId);
    const nextPendingMap =
      freshPendingParsed.pendingBySpecId instanceof Map ? freshPendingParsed.pendingBySpecId : new Map();
    const nextEntriesMap =
      freshPendingParsed.entriesBySpecId instanceof Map ? freshPendingParsed.entriesBySpecId : new Map();

    if (cache.pendingAeByActivityId instanceof Map) {
      cache.pendingAeByActivityId.set(actId, nextPendingMap);
    }
    if (cache.pendingEntriesAeByActivityId instanceof Map) {
      cache.pendingEntriesAeByActivityId.set(actId, nextEntriesMap);
    }
    if (!(cache.byHeadingKey instanceof Map)) return;

    cache.byHeadingKey.forEach((bundle) => {
      if (!bundle || !bundle.context || String(bundle.context.activityId || '') !== actId) return;
      const oldPendingMap =
        bundle.mbookPendingBySpecId instanceof Map ? bundle.mbookPendingBySpecId : new Map();

      if (bundle.mbookTotalsBySpecId instanceof Map) {
        const allSids = new Set([
          ...bundle.mbookTotalsBySpecId.keys(),
          ...oldPendingMap.keys(),
          ...nextPendingMap.keys(),
        ]);
        allSids.forEach((sid) => {
          const oldPendObj = oldPendingMap.get(sid);
          const newPendObj = nextPendingMap.get(sid);
          const oldPend = oldPendObj ? Number(oldPendObj.pendingQty) || 0 : 0;
          const newPend = newPendObj ? Number(newPendObj.pendingQty) || 0 : 0;
          const prevTotal = bundle.mbookTotalsBySpecId.has(sid)
            ? Number(bundle.mbookTotalsBySpecId.get(sid)) || 0
            : oldPend;
          const accepted = roundQty(prevTotal - oldPend);
          bundle.mbookTotalsBySpecId.set(sid, roundQty(accepted + newPend));
        });
      }

      bundle.mbookPendingBySpecId = nextPendingMap;
      bundle.mbookPendingEntriesBySpecId = nextEntriesMap;
    });
  }

  /**
   * Sequentially fetches DPR / RE Deviation / e-MBook Totals / Pending AE Inbox for the active
   * RE heading while preserving PRICE 3.0's rotating `price_token` (`GTOKEN`) and restoring the
   * server-side RE session context in `finally`.
   */
  async function fetchReHeadingHelperData(options) {
    const opts = options || {};
    const doc = opts.doc || (hasDocument ? document : null);
    const postForm = opts.postForm || (extractor && extractor.postForm);
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
    const cache = opts.cache || helperCache;
    const bridgeCtx =
      opts.bridgeCtx !== undefined
        ? opts.bridgeCtx
        : extractor && typeof extractor.syncBridgeCall === 'function'
        ? ((r) => (r && r.ok && r.result) || {})(extractor.syncBridgeCall('re:getContext', {}))
        : {};

    const ctx = Object.assign(resolveReWorkContext(doc, bridgeCtx), opts.contextOverride || {});
    if (ctx.hasMeasurementFormOpen) {
      return {
        ok: false,
        formOpen: true,
        error: 'Measurement entry screen is currently open. Close or save it before loading DPR & MBook.',
      };
    }
    if (typeof postForm !== 'function') {
      return { ok: false, error: 'HTTP client unavailable' };
    }

    const cacheKey = makeHelperCacheKey(ctx.reEstId, ctx.headId);
    if (!opts.forceRefresh && cache.byHeadingKey.has(cacheKey)) {
      const cachedBundle = cache.byHeadingKey.get(cacheKey);
      cachedBundle.pageTotals = extractRePageTotalsFromDoc(doc, ctx.headId);
      cachedBundle.dprTotals =
        (ctx.dprEstId &&
          cache.dprTotalsByDprEstId instanceof Map &&
          cache.dprTotalsByDprEstId.get(ctx.dprEstId)) ||
        cachedBundle.dprTotals ||
        null;
      return { ok: true, fromCache: true, context: ctx, bundle: cachedBundle };
    }

    let didMutateSession = false;
    let sessionExpired = false;
    let aborted = false;
    const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
    let devParsed = { ok: false, items: [], bySpecId: new Map(), bySlAndCode: new Map() };
    let dprFallback = { ok: true, dprQtyBySpecId: new Map() };
    let dprTotals = null;
    let mbTotals = { ok: false, totalsBySpecId: new Map() };
    let mbPending = { ok: false, pendingBySpecId: new Map(), entriesBySpecId: new Map() };
    const warnings = [];

    try {
      if (shouldAbort && shouldAbort()) {
        aborted = true;
        return { ok: false, aborted: true };
      }
      if (ctx.reEstId && !ctx.activityId) {
        onStatus('Resolving work activity...');
        didMutateSession = true;
        try {
          const basicHtml = await postForm(
            'revised_estimation_basic_details.pro',
            { estid: ctx.reEstId },
            true
          );
          const { baseEstimateCode } = extractBaseEstimateCode(basicHtml);
          if (baseEstimateCode) {
            const comp = matchSidebarComponentForRe(doc, baseEstimateCode);
            if (comp) {
              ctx.baseEstimateCode = baseEstimateCode;
              ctx.activityId = (comp.mbookActivityIds && comp.mbookActivityIds[0]) || '';
              ctx.dprEstId = (comp.basicEstIds && comp.basicEstIds[0]) || '';
              ctx.estMainId = String(comp.reEstMainId || comp.estmainid || '');
              ctx.activityName = String(comp.activityName || '');
            }
          }
        } catch (err) {
          if (isSessionAuthError(err)) {
            sessionExpired = true;
            throw err;
          }
          warnings.push('Could not resolve work activity from basic details');
        }
      }

      if (!ctx.isExtraHead && ctx.reEstId) {
        onStatus('Loading RE deviation & DPR...');
        didMutateSession = true;
        const devHtml = await postForm(
          're_deviation_statement.pro',
          { estid: ctx.reEstId, estHeadId: ctx.headId || '' },
          true
        );
        devParsed = parseReDeviationStatementHtml(devHtml);
        if (devParsed.sessionExpired) {
          sessionExpired = true;
          throw new Error('SESSION_EXPIRED');
        }
        if (!devParsed.ok) warnings.push(devParsed.error || 'Deviation load failed');
      }

      if ((!devParsed.ok || devParsed.items.length === 0) && ctx.dprEstId) {
        onStatus('Loading DPR estimate...');
        didMutateSession = true;
        const dprEndpoint = ctx.headId ? 'showApprovedHeadSpecs.pro' : 'approvedEstimationView.pro';
        const dprParams = ctx.headId
          ? { estId: ctx.dprEstId, estHeadId: ctx.headId }
          : { estId: ctx.dprEstId };
        const dprHtml = await postForm(dprEndpoint, dprParams, true);
        dprFallback = parseApprovedDprSpecsHtml(dprHtml);
        if (dprFallback.sessionExpired) {
          sessionExpired = true;
          throw new Error('SESSION_EXPIRED');
        }
      }

      if (ctx.dprEstId && cache.dprTotalsByDprEstId instanceof Map) {
        if (!opts.forceRefresh && cache.dprTotalsByDprEstId.has(ctx.dprEstId)) {
          dprTotals = cache.dprTotalsByDprEstId.get(ctx.dprEstId);
        } else {
          onStatus('Loading Original DPR totals...');
          didMutateSession = true;
          let dprListHtml = await postForm('showApprovedHeadingList.pro', { estId: ctx.dprEstId }, true);
          let parsedDprTotals = parseApprovedDprHeadingTotalsHtml(dprListHtml);
          if (parsedDprTotals.sessionExpired) {
            sessionExpired = true;
            throw new Error('SESSION_EXPIRED');
          }
          if (!parsedDprTotals.ok) {
            const primeHtml = await postForm('approvedEstimationView.pro', { estId: ctx.dprEstId }, true);
            const primeJson = checkJsonSessionOrEmpty(String(primeHtml == null ? '' : primeHtml).trim());
            if (primeJson && primeJson.kind === 'session_expired') {
              sessionExpired = true;
              throw new Error('SESSION_EXPIRED');
            }
            dprListHtml = await postForm('showApprovedHeadingList.pro', { estId: ctx.dprEstId }, true);
            parsedDprTotals = parseApprovedDprHeadingTotalsHtml(dprListHtml);
            if (parsedDprTotals.sessionExpired) {
              sessionExpired = true;
              throw new Error('SESSION_EXPIRED');
            }
          }
          if (parsedDprTotals.ok) {
            dprTotals = parsedDprTotals;
            cache.dprTotalsByDprEstId.set(ctx.dprEstId, dprTotals);
          }
        }
      }

      if (ctx.activityId && ctx.headId) {
        if (shouldAbort && shouldAbort()) {
          aborted = true;
          return { ok: false, aborted: true };
        }
        onStatus('Loading e-MBook totals...');
        didMutateSession = true;
        const mbHtml = await postForm(
          'embookAE_pending_head.pro',
          {
            activityid: ctx.activityId,
            headOrder: ctx.headOrderNo || '1',
            estHeadId: ctx.headId,
          },
          true
        );
        mbTotals = parseEmbookSpecTotalsHtml(mbHtml);
        if (mbTotals.sessionExpired) {
          sessionExpired = true;
          throw new Error('SESSION_EXPIRED');
        }
        if (!mbTotals.ok) warnings.push(mbTotals.error || 'e-MBook totals load failed');
      } else if (!ctx.activityId) {
        warnings.push('No e-MBook activity linked to this work');
      }

      if (ctx.activityId) {
        if (shouldAbort && shouldAbort()) {
          aborted = true;
          return { ok: false, aborted: true };
        }
        if (!opts.forceRefresh && cache.pendingAeByActivityId.has(ctx.activityId)) {
          mbPending = {
            ok: true,
            pendingBySpecId: cache.pendingAeByActivityId.get(ctx.activityId),
            entriesBySpecId:
              cache.pendingEntriesAeByActivityId instanceof Map &&
              cache.pendingEntriesAeByActivityId.has(ctx.activityId)
                ? cache.pendingEntriesAeByActivityId.get(ctx.activityId)
                : new Map(),
          };
        } else {
          onStatus('Checking AE MBook inbox...');
          didMutateSession = true;
          const pendHtml = await postForm('mbook_pending_ae.pro', { activityid: ctx.activityId }, true);
          mbPending = parseMbookPendingAeHtml(pendHtml);
          if (mbPending.sessionExpired) {
            sessionExpired = true;
            throw new Error('SESSION_EXPIRED');
          }
          if (mbPending.ok) {
            cache.pendingAeByActivityId.set(ctx.activityId, mbPending.pendingBySpecId);
            if (cache.pendingEntriesAeByActivityId instanceof Map) {
              cache.pendingEntriesAeByActivityId.set(ctx.activityId, mbPending.entriesBySpecId);
            }
          } else {
            warnings.push(mbPending.error || 'AE pending MBook check failed');
          }
        }
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || 'Request failed');
      if (isSessionAuthError(err)) {
        sessionExpired = true;
        return {
          ok: false,
          sessionExpired: true,
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, error: msg };
    } finally {
      if (didMutateSession && !sessionExpired) {
        const restoreTarget = opts.restoreCtx || ctx;
        await restoreReSession(restoreTarget, postForm, doc, onStatus);
      }
    }
    if (aborted) return { ok: false, aborted: true };

    const pageTotals = extractRePageTotalsFromDoc(doc, ctx.headId);

    const bundle = {
      cacheKey,
      fetchedAt: Date.now(),
      context: ctx,
      hasDevSource: Boolean(devParsed.ok && devParsed.items.length > 0),
      hasMbookSource: Boolean(mbTotals.ok),
      devBySpecId: devParsed.bySpecId,
      devBySlAndCode: devParsed.bySlAndCode,
      pageTotals,
      dprTotals,
      dprQtyBySpecId: dprFallback.dprQtyBySpecId,
      mbookTotalsBySpecId: mbTotals.ok ? mbTotals.totalsBySpecId : null,
      mbookPendingBySpecId: mbPending.ok ? mbPending.pendingBySpecId : new Map(),
      mbookPendingEntriesBySpecId:
        mbPending.ok && mbPending.entriesBySpecId instanceof Map
          ? mbPending.entriesBySpecId
          : new Map(),
      warnings,
    };

    cache.byHeadingKey.set(cacheKey, bundle);
    return { ok: true, fromCache: false, context: ctx, bundle };
  }

  function resolveControllerReContext(opts) {
    const doc = opts.doc || (hasDocument ? document : null);
    const postForm = opts.postForm || (extractor && extractor.postForm);
    const cache = opts.cache || helperCache;
    const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
    let ctx = opts.ctx || null;
    if (!ctx) {
      const bridgeCtx =
        opts.bridgeCtx !== undefined
          ? opts.bridgeCtx
          : extractor && typeof extractor.syncBridgeCall === 'function'
          ? ((r) => (r && r.ok && r.result) || {})(extractor.syncBridgeCall('re:getContext', {}))
          : {};
      ctx = Object.assign(resolveReWorkContext(doc, bridgeCtx), opts.contextOverride || {});
    }
    return { doc, postForm, cache, onStatus, ctx };
  }

  function formatControllerRequestError(err) {
    const msg = err && err.message ? String(err.message) : String(err || 'Request failed');
    const ep = err && typeof err.endpoint === 'string' ? err.endpoint.trim() : '';
    const detail = err && typeof err.detail === 'string' ? cleanSingleLine(err.detail) : '';
    if (/^HTTP_\d+$/.test(msg) && (ep || detail)) {
      return `${msg}${ep ? ' (' + ep + ')' : ''}${detail ? ': ' + detail : ''}`;
    }
    return msg;
  }

  /**
   * Loads Draft (`#t6`) measurement rows and `#addmeasurementtabsaveform` edit metadata
   * for every pending AE entry on `specId`, restoring the RE session context in `finally`.
   */
  async function loadMbookPendingEntries(options) {
    const opts = options || {};
    const specId = String(opts.specId || '').trim();
    const { doc, postForm, cache, onStatus, ctx } = resolveControllerReContext(opts);

    if (ctx && ctx.hasMeasurementFormOpen) {
      return {
        ok: false,
        formOpen: true,
        error: 'Measurement entry screen is currently open. Close or save it before editing e-MBook entries.',
      };
    }
    if (!specId) return { ok: false, error: 'Missing specification ID' };
    if (typeof postForm !== 'function') return { ok: false, error: 'HTTP client unavailable' };

    let didMutateSession = false;
    let sessionExpired = false;

    try {
      let entries = Array.isArray(opts.entries) ? opts.entries.slice() : [];
      if (
        entries.length === 0 &&
        ctx &&
        ctx.activityId &&
        cache.pendingEntriesAeByActivityId instanceof Map &&
        cache.pendingEntriesAeByActivityId.has(ctx.activityId)
      ) {
        const cachedEntriesMap = cache.pendingEntriesAeByActivityId.get(ctx.activityId);
        if (cachedEntriesMap instanceof Map && cachedEntriesMap.has(specId)) {
          entries = cachedEntriesMap.get(specId).slice();
        }
      }

      if (entries.length === 0 && ctx && ctx.activityId) {
        onStatus('Loading pending AE e-MBook entries...');
        didMutateSession = true;
        const pendHtml = await postForm('mbook_pending_ae.pro', { activityid: ctx.activityId }, true);
        const pendParsed = parseMbookPendingAeHtml(pendHtml);
        if (pendParsed.sessionExpired) {
          sessionExpired = true;
          throw new Error('SESSION_EXPIRED');
        }
        if (!pendParsed.ok) {
          return { ok: false, error: pendParsed.error || 'Failed to load pending AE entries' };
        }
        syncHelperCachesAfterMbookChange(cache, ctx.activityId, pendParsed);
        entries = (pendParsed.entriesBySpecId.get(specId) || []).slice();
      }

      const loadedEntries = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] || {};
        const actId = String(entry.activityId || (ctx && ctx.activityId) || '').trim();
        const entryHeadId = String(entry.entryHeadId || '').trim();
        if (!actId || !entryHeadId) {
          loadedEntries.push({
            ...entry,
            loadError: 'Missing activity or entry head ID',
            details: null,
            editMeta: null,
          });
          continue;
        }

        let entryDetails = null;
        try {
          onStatus(`Loading pending entry ${i + 1}/${entries.length}...`);
          didMutateSession = true;
          const detailHtml = await postForm(
            'newrightmeasurement_pending.pro',
            {
              estheadspecid: specId,
              activityid: actId,
              mbookentryheadId: entryHeadId,
              measuredqty: '',
            },
            true
          );
          const details = parseMbookEntryDetailsHtml(detailHtml);
          if (details.sessionExpired) {
            sessionExpired = true;
            throw new Error('SESSION_EXPIRED');
          }
          if (!details.ok) {
            loadedEntries.push({
              ...entry,
              loadError: details.error || 'Failed to load pending entry rows',
              details,
              editMeta: null,
            });
            continue;
          }
          entryDetails = details;
          if (details.rows.length === 0) {
            loadedEntries.push({
              ...entry,
              loadError: 'No Draft (0% check-measured) rows found for this entry',
              details,
              editMeta: null,
            });
            continue;
          }

          const colList = details.rows.map((r) => r.measurementId).join(',');
          const editHtml = await postForm(
            'mbookmeasurementedit.pro',
            {
              colList,
              activityid: actId,
              estheadspecid: specId,
              specorder: '',
              headorder: '',
              span_text: '',
            },
            true
          );
          const editMeta = parseMbookEditFormHtml(editHtml, entryHeadId);
          if (editMeta.sessionExpired) {
            sessionExpired = true;
            throw new Error('SESSION_EXPIRED');
          }
          if (!editMeta.ok) {
            loadedEntries.push({
              ...entry,
              loadError: editMeta.error || 'Failed to load e-MBook edit form',
              details,
              editMeta: null,
            });
            continue;
          }
          if (
            editMeta.rows.length !== details.rows.length ||
            editMeta.rows.some((r) => !r.dataId || !r.measurementId)
          ) {
            loadedEntries.push({
              ...entry,
              loadError: 'Edit form rows do not match Draft entry rows',
              details,
              editMeta: null,
            });
            continue;
          }

          loadedEntries.push({
            ...entry,
            activityId: actId,
            entryHeadId,
            unit: entry.unit || details.unit || '',
            details,
            editMeta,
            loadError: '',
          });
        } catch (entryErr) {
          if (isSessionAuthError(entryErr) || (entryErr && entryErr.message === 'SESSION_EXPIRED')) {
            throw entryErr;
          }
          loadedEntries.push({
            ...entry,
            activityId: actId,
            entryHeadId,
            unit: entry.unit || (entryDetails && entryDetails.unit) || '',
            loadError: formatControllerRequestError(entryErr),
            details: entryDetails,
            editMeta: null,
          });
        }
      }

      return { ok: true, entries: loadedEntries };
    } catch (err) {
      const msg = formatControllerRequestError(err);
      if (isSessionAuthError(err)) {
        sessionExpired = true;
        return {
          ok: false,
          sessionExpired: true,
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, error: msg };
    } finally {
      if (didMutateSession && !sessionExpired) {
        await restoreReSession(ctx, postForm, doc, onStatus);
      }
    }
  }

  /**
   * Reloads Draft rows and `#addmeasurementtabsaveform` right before saving to guarantee
   * fresh server state, saves via `updateMeasurementsEmbook.pro`, refreshes `mbook_pending_ae.pro`,
   * and restores the RE session in `finally`.
   */
  async function saveMbookPendingEntry(options) {
    const opts = options || {};
    const specId = String(opts.specId || '').trim();
    const entry = opts.entry || {};
    const draftRows = Array.isArray(opts.rows) ? opts.rows : [];
    const expectedIds = Array.isArray(opts.expectedMeasurementIds)
      ? opts.expectedMeasurementIds.map((x) => String(x))
      : [];
    const { doc, postForm, cache, onStatus, ctx } = resolveControllerReContext(opts);

    if (ctx && ctx.hasMeasurementFormOpen) {
      return {
        ok: false,
        formOpen: true,
        error: 'Measurement entry screen is currently open. Close or save it before editing e-MBook entries.',
      };
    }
    const actId = String(entry.activityId || (ctx && ctx.activityId) || '').trim();
    const entryHeadId = String(entry.entryHeadId || '').trim();
    if (!specId || !actId || !entryHeadId || expectedIds.length === 0) {
      return { ok: false, error: 'Missing required e-MBook entry identifiers' };
    }
    if (typeof postForm !== 'function') return { ok: false, error: 'HTTP client unavailable' };

    let didMutateSession = false;
    let sessionExpired = false;

    try {
      onStatus('Verifying live e-MBook entry...');
      didMutateSession = true;

      const detailHtml = await postForm(
        'newrightmeasurement_pending.pro',
        {
          estheadspecid: specId,
          activityid: actId,
          mbookentryheadId: entryHeadId,
          measuredqty: '',
        },
        true
      );
      const details = parseMbookEntryDetailsHtml(detailHtml);
      if (details.sessionExpired) {
        sessionExpired = true;
        throw new Error('SESSION_EXPIRED');
      }
      if (!details.ok) {
        return { ok: false, error: details.error || 'Failed to verify pending e-MBook entry' };
      }

      const liveIds = details.rows.map((r) => String(r.measurementId));
      const idsMatch =
        liveIds.length === expectedIds.length &&
        liveIds.every((id, idx) => id === expectedIds[idx]);
      if (!idsMatch) {
        return {
          ok: false,
          stale: true,
          error:
            'Pending e-MBook entry changed on server (possibly check-measured or edited in another tab). Reload and try again.',
        };
      }

      onStatus('Loading fresh e-MBook edit form...');
      const editHtml = await postForm(
        'mbookmeasurementedit.pro',
        {
          colList: liveIds.join(','),
          activityid: actId,
          estheadspecid: specId,
          specorder: '',
          headorder: '',
          span_text: '',
        },
        true
      );
      const editMeta = parseMbookEditFormHtml(editHtml, entryHeadId);
      if (editMeta.sessionExpired) {
        sessionExpired = true;
        throw new Error('SESSION_EXPIRED');
      }
      if (!editMeta.ok) {
        return { ok: false, error: editMeta.error || 'Failed to load fresh e-MBook edit form' };
      }
      if (
        editMeta.rows.length !== expectedIds.length ||
        editMeta.rows.some((r, idx) => !r.dataId || String(r.measurementId) !== expectedIds[idx])
      ) {
        return {
          ok: false,
          stale: true,
          error: 'e-MBook edit form rows do not match expected Draft rows. Reload and try again.',
        };
      }

      const built = buildMbookUpdateParams(editMeta, draftRows);
      if (!built.ok) {
        return { ok: false, error: built.error || 'Invalid e-MBook measurement values' };
      }

      onStatus('Saving changes to live e-MBook...');
      const saveText = await postForm('updateMeasurementsEmbook.pro', built.params, true);
      const saveRes = parseMbookMutationResponse(saveText, 'save');
      if (saveRes.sessionExpired) {
        sessionExpired = true;
        throw new Error('SESSION_EXPIRED');
      }
      if (!saveRes.ok) {
        return { ok: false, error: saveRes.error || 'Failed to save e-MBook entry' };
      }

      onStatus('Refreshing pending e-MBook totals...');
      const pendHtml = await postForm('mbook_pending_ae.pro', { activityid: actId }, true);
      const freshPending = parseMbookPendingAeHtml(pendHtml);
      if (freshPending.sessionExpired) {
        sessionExpired = true;
        throw new Error('SESSION_EXPIRED');
      }
      if (!freshPending.ok) {
        return {
          ok: false,
          error: freshPending.error || 'Saved, but failed to refresh pending AE totals',
        };
      }

      syncHelperCachesAfterMbookChange(cache, actId, freshPending);
      return {
        ok: true,
        message: saveRes.message,
        totalQty: built.totalQty,
        pendingBySpecId: freshPending.pendingBySpecId,
        entriesBySpecId: freshPending.entriesBySpecId,
      };
    } catch (err) {
      const msg = formatControllerRequestError(err);
      if (isSessionAuthError(err)) {
        sessionExpired = true;
        return {
          ok: false,
          sessionExpired: true,
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, error: msg };
    } finally {
      if (didMutateSession && !sessionExpired) {
        await restoreReSession(ctx, postForm, doc, onStatus);
      }
    }
  }

  /**
   * Reloads `#t6` Draft rows right before deletion to confirm target `measurementIds` are still
   * pending in Draft status, deletes via `delete_measurement_common.pro`, refreshes
   * `mbook_pending_ae.pro`, and restores the RE session in `finally`.
   */
  async function deleteMbookPendingRows(options) {
    const opts = options || {};
    const specId = String(opts.specId || '').trim();
    const entry = opts.entry || {};
    const targetIds = Array.isArray(opts.measurementIds)
      ? opts.measurementIds.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const { doc, postForm, cache, onStatus, ctx } = resolveControllerReContext(opts);

    if (ctx && ctx.hasMeasurementFormOpen) {
      return {
        ok: false,
        formOpen: true,
        error: 'Measurement entry screen is currently open. Close or save it before deleting e-MBook entries.',
      };
    }
    const actId = String(entry.activityId || (ctx && ctx.activityId) || '').trim();
    const entryHeadId = String(entry.entryHeadId || '').trim();
    if (!specId || !actId || !entryHeadId || targetIds.length === 0) {
      return { ok: false, error: 'Missing required e-MBook deletion identifiers' };
    }
    if (typeof postForm !== 'function') return { ok: false, error: 'HTTP client unavailable' };

    let didMutateSession = false;
    let sessionExpired = false;

    try {
      onStatus('Verifying Draft status before delete...');
      didMutateSession = true;

      const detailHtml = await postForm(
        'newrightmeasurement_pending.pro',
        {
          estheadspecid: specId,
          activityid: actId,
          mbookentryheadId: entryHeadId,
          measuredqty: '',
        },
        true
      );
      const details = parseMbookEntryDetailsHtml(detailHtml);
      if (details.sessionExpired) {
        sessionExpired = true;
        throw new Error('SESSION_EXPIRED');
      }
      if (!details.ok) {
        return { ok: false, error: details.error || 'Failed to verify Draft rows before delete' };
      }

      const liveIdSet = new Set(details.rows.map((r) => String(r.measurementId)));
      const allPresent = targetIds.every((id) => liveIdSet.has(id));
      if (!details.canDelete || !allPresent) {
        return {
          ok: false,
          stale: true,
          error:
            'One or more measurement rows are no longer in Draft pending status (may have been check-measured). Reload and try again.',
        };
      }

      onStatus('Deleting measurement(s) from live e-MBook...');
      const delText = await postForm(
        'delete_measurement_common.pro',
        {
          colList: targetIds.join(','),
          estheadspecid: specId,
          activityid: actId,
        },
        true
      );
      const delRes = parseMbookMutationResponse(delText, 'delete');
      if (delRes.sessionExpired) {
        sessionExpired = true;
        throw new Error('SESSION_EXPIRED');
      }
      if (!delRes.ok) {
        return { ok: false, error: delRes.error || 'Failed to delete e-MBook measurement(s)' };
      }

      onStatus('Refreshing pending e-MBook totals...');
      const pendHtml = await postForm('mbook_pending_ae.pro', { activityid: actId }, true);
      const freshPending = parseMbookPendingAeHtml(pendHtml);
      if (freshPending.sessionExpired) {
        sessionExpired = true;
        throw new Error('SESSION_EXPIRED');
      }
      if (!freshPending.ok) {
        return {
          ok: false,
          error: freshPending.error || 'Deleted, but failed to refresh pending AE totals',
        };
      }

      syncHelperCachesAfterMbookChange(cache, actId, freshPending);
      return {
        ok: true,
        message: delRes.message || 'Deleted from e-MBook',
        pendingBySpecId: freshPending.pendingBySpecId,
        entriesBySpecId: freshPending.entriesBySpecId,
      };
    } catch (err) {
      const msg = formatControllerRequestError(err);
      if (isSessionAuthError(err)) {
        sessionExpired = true;
        return {
          ok: false,
          sessionExpired: true,
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, error: msg };
    } finally {
      if (didMutateSession && !sessionExpired) {
        await restoreReSession(ctx, postForm, doc, onStatus);
      }
    }
  }

  /**
   * Read-only sequential pre-scan across RE items to count "To Be Executed" measurement heads.
   * Never aborts in-flight requests so rotating price_token headers are always preserved.
   */
  async function scanItemsTbe(items, deps) {
    const options = deps || {};
    const postForm = options.postForm || (extractor && extractor.postForm);
    const isCancelled =
      typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
    const list = Array.isArray(items) ? items : [];

    const resultsBySpecId = new Map();
    let scanned = 0;
    let withTbe = 0;
    let empty = 0;
    let errors = 0;
    let stopped = false;
    let sessionExpired = false;

    for (let i = 0; i < list.length; i++) {
      if (isCancelled()) {
        stopped = true;
        break;
      }
      const item = list[i];
      if (!item || !item.headspecid) continue;

      if (typeof options.onProgress === 'function') {
        options.onProgress(i, list.length, item);
      }

      let parsed;
      try {
        const html = await postForm('call_to_be_executed.pro', { headspecid: item.headspecid }, true);
        parsed = parseToBeExecutedHtml(html, item.headspecid);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err || 'Request failed');
        if (isSessionAuthError(err)) {
          sessionExpired = true;
          parsed = {
            kind: 'session_expired',
            measurementIds: [],
            count: 0,
            error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
          };
          resultsBySpecId.set(item.headspecid, parsed);
          errors++;
          if (typeof options.onItemResult === 'function') {
            options.onItemResult(item, parsed);
          }
          break;
        }
        parsed = { kind: 'error', measurementIds: [], count: 0, error: msg };
      }

      resultsBySpecId.set(item.headspecid, parsed);
      if (parsed.kind === 'session_expired') {
        sessionExpired = true;
        errors++;
        if (typeof options.onItemResult === 'function') {
          options.onItemResult(item, parsed);
        }
        break;
      }

      scanned++;
      if (parsed.kind === 'has_measurements') withTbe++;
      else if (parsed.kind === 'empty') empty++;
      else errors++;

      if (typeof options.onItemResult === 'function') {
        options.onItemResult(item, parsed);
      }
    }

    return {
      scanned,
      withTbe,
      empty,
      errors,
      stopped,
      sessionExpired,
      resultsBySpecId,
    };
  }

  /**
   * Sequentially deletes "To Be Executed" measurements for selected RE items with automatic retries.
   * Uses cached TBE IDs from a prior Check TBE pass when available (1 POST/item, 0 POSTs for empty).
   */
  async function deleteItemsTbe(items, deps) {
    const options = deps || {};
    const postForm = options.postForm || (extractor && extractor.postForm);
    const cachedIdsBySpecId = options.cachedIdsBySpecId || null;
    const maxRetries = Number.isFinite(options.maxRetries) ? Math.max(0, options.maxRetries) : 2;
    const retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? Math.max(0, options.retryDelayMs)
      : 400;
    const sleep =
      options.sleep ||
      (extractor && extractor.sleep) ||
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const isCancelled =
      typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
    const list = Array.isArray(items) ? items.filter((it) => it && it.headspecid) : [];

    const attemptedDeleteSet = new Set();
    const resultsBySpecId = new Map();
    let lastHeadId = '';
    let lastHeadSpecId = '';
    let sessionExpired = false;
    let stopped = false;

    async function processOne(item, isRetry) {
      let measurementIds = null;

      if (!isRetry && cachedIdsBySpecId && cachedIdsBySpecId.has(item.headspecid)) {
        const cached = cachedIdsBySpecId.get(item.headspecid) || [];
        if (!cached.length) {
          return { status: 'skipped', deletedCount: 0, note: 'No To-Be-Executed measurements' };
        }
        measurementIds = cached;
      } else {
        const html = await postForm('call_to_be_executed.pro', { headspecid: item.headspecid }, true);
        const parsed = parseToBeExecutedHtml(html, item.headspecid);
        if (parsed.kind === 'session_expired') {
          throw new Error('SESSION_EXPIRED');
        }
        if (parsed.kind === 'empty') {
          if (isRetry && attemptedDeleteSet.has(item.headspecid)) {
            return { status: 'deleted', deletedCount: 0, note: 'Verified cleared on retry' };
          }
          return {
            status: 'skipped',
            deletedCount: 0,
            note: parsed.note || 'No To-Be-Executed measurements',
          };
        }
        if (parsed.kind !== 'has_measurements') {
          return {
            status: 'error',
            error: parsed.error || 'Failed to load To-Be-Executed measurements',
          };
        }
        measurementIds = parsed.measurementIds;
      }

      attemptedDeleteSet.add(item.headspecid);
      const delText = await postForm(
        'delete_re_to_be_executed.pro',
        { colList: measurementIds.join(','), headspecid: item.headspecid },
        true
      );
      const delParsed = parseDeleteReResponse(delText);
      if (delParsed.sessionExpired) {
        throw new Error('SESSION_EXPIRED');
      }
      if (delParsed.ok) {
        if (delParsed.headid) lastHeadId = delParsed.headid;
        lastHeadSpecId = delParsed.estheadspecid || item.headspecid;
        return {
          status: 'deleted',
          deletedCount: measurementIds.length,
          headid: delParsed.headid || '',
          message: delParsed.message || 'Deleted',
        };
      }
      return { status: 'error', error: delParsed.error || 'Delete failed' };
    }

    async function runPass(batch, isRetry) {
      for (let i = 0; i < batch.length; i++) {
        if (isCancelled()) {
          stopped = true;
          break;
        }
        const item = batch[i];
        if (typeof options.onProgress === 'function') {
          options.onProgress(i, batch.length, item, isRetry);
        }

        let res;
        try {
          res = await processOne(item, isRetry);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err || 'Request failed');
          if (isSessionAuthError(err)) {
            sessionExpired = true;
            res = {
              status: 'error',
              sessionExpired: true,
              error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
            };
            resultsBySpecId.set(item.headspecid, res);
            if (typeof options.onItemResult === 'function') {
              options.onItemResult(item, res);
            }
            break;
          }
          res = { status: 'error', error: msg };
        }

        resultsBySpecId.set(item.headspecid, res);
        if (typeof options.onItemResult === 'function') {
          options.onItemResult(item, res);
        }
      }
    }

    await runPass(list, false);

    let attempt = 1;
    while (!stopped && !sessionExpired && attempt <= maxRetries) {
      const failedItems = list.filter((item) => {
        const res = resultsBySpecId.get(item.headspecid);
        return res && res.status === 'error';
      });
      if (failedItems.length === 0) break;
      if (isCancelled()) {
        stopped = true;
        break;
      }
      if (typeof options.onRetryStart === 'function') {
        options.onRetryStart(attempt, maxRetries, failedItems.length);
      }
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs * attempt);
      }
      if (isCancelled()) {
        stopped = true;
        break;
      }
      await runPass(failedItems, true);
      attempt++;
    }

    let deleted = 0;
    let skipped = 0;
    let errors = 0;
    resultsBySpecId.forEach((res) => {
      if (!res) return;
      if (res.status === 'deleted') deleted++;
      else if (res.status === 'skipped') skipped++;
      else if (res.status === 'error') errors++;
    });

    return {
      deleted,
      skipped,
      errors,
      stopped,
      sessionExpired,
      lastHeadId,
      lastHeadSpecId,
      resultsBySpecId,
    };
  }

  /**
   * Creates, updates (in-place via `save_re_to_be_executed_edit.pro`), consolidates, or
   * deletes "To Be Executed" measurements for a single RE specification item.
   */
  async function upsertItemTbeQty(item, targetQty, deps) {
    const options = deps || {};
    const postForm = options.postForm || (extractor && extractor.postForm);
    const headId = String(options.headId || '').trim();
    const followFollowUpUrl = options.followFollowUpUrl !== false;
    const preserveDetailedSplitUps = Boolean(options.preserveDetailedSplitUps);

    if (!item || !item.headspecid) {
      return { ok: false, status: 'error', error: 'Missing specification item ID' };
    }
    if (typeof postForm !== 'function') {
      return { ok: false, status: 'error', error: 'HTTP client unavailable' };
    }
    const parsedTarget = Number(targetQty);
    if (!Number.isFinite(parsedTarget) || parsedTarget < 0) {
      return { ok: false, status: 'error', error: 'Invalid To-Be-Executed quantity' };
    }

    const sid = String(item.headspecid).trim();
    const normalizedQty = roundQty3(parsedTarget);

    try {
      const html = await postForm('call_to_be_executed.pro', { headspecid: sid }, true);
      const current = parseToBeExecutedHtml(html, sid);
      if (current.kind === 'session_expired') {
        return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
      }
      if (current.kind !== 'empty' && current.kind !== 'has_measurements') {
        return {
          ok: false,
          status: 'error',
          error: current.error || 'Failed to load To-Be-Executed measurements',
        };
      }

      if (normalizedQty <= QTY_EPS) {
        if (current.kind === 'empty') {
          return {
            ok: true,
            status: 'unchanged',
            tbeQty: 0,
            measurementIds: [],
            headDetails: [],
            hasDetailed: false,
            headid: headId,
            estheadspecid: sid,
            note: 'Already 0 TBE',
          };
        }

        const delText = await postForm(
          'delete_re_to_be_executed.pro',
          { colList: current.measurementIds.join(','), headspecid: sid },
          true
        );
        const delParsed = parseDeleteReResponse(delText);
        if (delParsed.sessionExpired) {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        if (!delParsed.ok) {
          return { ok: false, status: 'error', error: delParsed.error || 'Delete failed' };
        }
        if (followFollowUpUrl && isSafePortalEndpoint(delParsed.followUpUrl)) {
          const delFollowHtml = await postForm(
            delParsed.followUpUrl,
            {
              specid: delParsed.estheadspecid || sid,
              curheadid: delParsed.headid || headId || '',
            },
            true
          );
          const delFollowParsed = parseToBeExecutedHtml(delFollowHtml, sid);
          if (delFollowParsed.kind === 'session_expired') {
            return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
          }
        }
        return {
          ok: true,
          status: 'deleted',
          tbeQty: 0,
          deletedCount: current.measurementIds.length,
          measurementIds: [],
          headDetails: [],
          hasDetailed: false,
          headid: delParsed.headid || headId,
          estheadspecid: delParsed.estheadspecid || sid,
          message: delParsed.message || 'Deleted',
        };
      }

      if (preserveDetailedSplitUps && hasDetailedSplitUp(current)) {
        return {
          ok: false,
          status: 'blocked_split_up',
          blockedBySplitUp: true,
          parsed: current,
          tbeQty: current.tbeQty !== null ? roundQty3(current.tbeQty) : null,
          measurementIds: current.measurementIds.slice(),
          headDetails: current.headDetails || [],
          error: 'Detailed split-ups exist — edit in split-up panel',
        };
      }

      if (
        current.kind === 'has_measurements' &&
        current.tbeQty !== null &&
        Math.abs(current.tbeQty - normalizedQty) <= QTY_EPS
      ) {
        return {
          ok: true,
          status: 'unchanged',
          tbeQty: roundQty3(current.tbeQty),
          measurementIds: current.measurementIds.slice(),
          headDetails: current.headDetails || [],
          hasDetailed: hasDetailedSplitUp(current),
          headid: headId,
          estheadspecid: sid,
          note: 'Unchanged',
        };
      }

      const qtyFixed = normalizedQty.toFixed(3);
      let saveText = '';
      let fallbackHeadIds = [];
      let isEditMode = false;

      if (current.kind === 'empty') {
        saveText = await postForm(
          'save_re_to_be_executed.pro',
          {
            ...buildSingleRowTbeFormParams(normalizedQty, '1'),
            headspecid: sid,
            grandtotal: qtyFixed,
          },
          true
        );
      } else {
        isEditMode = true;
        const head0 = current.measurementIds[0];
        const head0Desc = (current.heads && current.heads[0] && current.heads[0].headDesc) || '1';
        fallbackHeadIds = [head0];

        if (current.measurementIds.length > 1) {
          const extraIds = current.measurementIds.slice(1);
          const delExtraText = await postForm(
            'delete_re_to_be_executed.pro',
            { colList: extraIds.join(','), headspecid: sid },
            true
          );
          const delExtraParsed = parseDeleteReResponse(delExtraText);
          if (delExtraParsed.sessionExpired) {
            return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
          }
          if (!delExtraParsed.ok) {
            return {
              ok: false,
              status: 'error',
              error: delExtraParsed.error || 'Failed to consolidate multiple TBE heads',
            };
          }
          await postForm('call_to_be_executed.pro', { headspecid: sid }, true);
        }

        const editFormHtml = await postForm(
          'revised_estimation_edit_measurement.pro',
          { headspecid: sid, measureheadid: head0 },
          true
        );
        const editRaw = String(editFormHtml == null ? '' : editFormHtml).trim();
        const jsonState = checkJsonSessionOrEmpty(editRaw);
        if (jsonState && jsonState.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        const hasEditMarkers = /save_re_to_be_executed_edit|estimation_measurement|itemHeadDesc/i.test(
          editRaw
        );
        if (
          !editRaw ||
          (!hasEditMarkers &&
            extractor &&
            typeof extractor.isPortalErrorHtml === 'function' &&
            extractor.isPortalErrorHtml(editRaw))
        ) {
          return { ok: false, status: 'error', error: 'Failed to load TBE edit form' };
        }
        const smMatch = editRaw.match(/save_re_to_be_executed_edit\(\s*['"]?(\d+)['"]?\s*\)/);
        const specmeasureheadid = smMatch && smMatch[1] ? smMatch[1] : head0;
        fallbackHeadIds = [specmeasureheadid];

        saveText = await postForm(
          'save_re_to_be_executed_edit.pro',
          {
            ...buildSingleRowTbeFormParams(normalizedQty, head0Desc),
            specmeasureheadid,
            grandtotal: qtyFixed,
          },
          true
        );
      }

      const saveParsed = parseSaveReTbeResponse(saveText);
      if (saveParsed.sessionExpired) {
        return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
      }
      if (!saveParsed.ok) {
        return { ok: false, status: 'error', error: saveParsed.error || 'Save failed' };
      }

      let nextMeasurementIds = saveParsed.parsedHtml
        ? saveParsed.parsedHtml.measurementIds
        : fallbackHeadIds;
      let nextTbeQty = normalizedQty;
      let nextHeadDetails = saveParsed.parsedHtml ? saveParsed.parsedHtml.headDetails || [] : [];
      let nextHasDetailed = saveParsed.parsedHtml ? hasDetailedSplitUp(saveParsed.parsedHtml) : false;

      if (followFollowUpUrl && isSafePortalEndpoint(saveParsed.followUpUrl)) {
        const followHtml = await postForm(
          saveParsed.followUpUrl,
          {
            specid: saveParsed.specid || saveParsed.estheadspecid || sid,
            curheadid: saveParsed.curheadid || headId || '',
          },
          true
        );
        const followParsed = parseToBeExecutedHtml(followHtml, sid);
        if (followParsed.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        if (followParsed.kind === 'has_measurements') {
          nextMeasurementIds = followParsed.measurementIds;
          nextHeadDetails = followParsed.headDetails || [];
          nextHasDetailed = hasDetailedSplitUp(followParsed);
          if (followParsed.tbeQty !== null) {
            nextTbeQty = roundQty3(followParsed.tbeQty);
          }
        }
      }

      return {
        ok: true,
        status: isEditMode ? 'edited' : 'added',
        tbeQty: nextTbeQty,
        measurementIds: nextMeasurementIds,
        headDetails: nextHeadDetails,
        hasDetailed: nextHasDetailed,
        headid: saveParsed.curheadid || headId,
        estheadspecid: saveParsed.estheadspecid || sid,
        message: saveParsed.message || 'Saved',
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || 'Request failed');
      if (isSessionAuthError(err)) {
        return {
          ok: false,
          sessionExpired: true,
          status: 'error',
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, status: 'error', error: msg };
    }
  }

  /**
   * Fetches all TBE measurement sub-headings and L/B/H/Cf split-up rows for a spec item
   * via a single `POST call_to_be_executed.pro`.
   */
  async function fetchItemTbeDetails(headspecid, deps) {
    const options = deps || {};
    const postForm = options.postForm || (extractor && extractor.postForm);
    const sid = String(headspecid == null ? '' : headspecid).trim();
    if (!sid) {
      return { ok: false, status: 'error', error: 'Missing specification item ID' };
    }
    if (typeof postForm !== 'function') {
      return { ok: false, status: 'error', error: 'HTTP client unavailable' };
    }

    try {
      const html = await postForm('call_to_be_executed.pro', { headspecid: sid }, true);
      const parsed = parseToBeExecutedHtml(html, sid);
      if (parsed.kind === 'session_expired') {
        return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
      }
      if (parsed.kind !== 'has_measurements' && parsed.kind !== 'empty') {
        return {
          ok: false,
          status: 'error',
          error: parsed.error || 'Failed to load To-Be-Executed split-ups',
        };
      }
      return {
        ok: true,
        kind: parsed.kind,
        tbeQty: parsed.kind === 'empty' ? 0 : parsed.tbeQty,
        measurementIds: parsed.measurementIds,
        heads: parsed.heads,
        headDetails: parsed.headDetails || [],
        hasDetailed: hasDetailedSplitUp(parsed),
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || 'Request failed');
      if (isSessionAuthError(err)) {
        return {
          ok: false,
          sessionExpired: true,
          status: 'error',
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, status: 'error', error: msg };
    }
  }

  /**
   * Saves a TBE measurement sub-heading (`add_first`, `add_between`, or `edit`)
   * with full multi-row L/B/H/No/Cf split-ups and refreshes the recalculated heads.
   */
  async function saveItemTbeHead(specInput, deps) {
    const options = deps || {};
    const postForm = options.postForm || (extractor && extractor.postForm);
    const headId = String(options.headId || '').trim();
    const followFollowUpUrl = options.followFollowUpUrl !== false;
    const input = specInput && typeof specInput === 'object' ? specInput : {};
    const sid = String(input.headspecid || '').trim();
    const mode = String(input.mode || (input.measureheadid ? 'edit' : 'add_first')).trim();
    const measureheadid = String(input.measureheadid || '').trim();

    if (!sid) {
      return { ok: false, status: 'error', error: 'Missing specification item ID' };
    }
    if (typeof postForm !== 'function') {
      return { ok: false, status: 'error', error: 'HTTP client unavailable' };
    }
    if (mode === 'edit' && !measureheadid) {
      return { ok: false, status: 'error', error: 'Missing measurement head ID for edit' };
    }

    const built = buildMeasurementHeadFormParams({
      headDesc: input.headDesc,
      rows: input.rows,
    });
    if (!built.ok) {
      return {
        ok: false,
        status: 'validation_error',
        error: built.error,
        invalidRowIndex: built.invalidRowIndex,
        invalidField: built.invalidField,
      };
    }

    try {
      let saveText = '';
      let fallbackHeadIds = measureheadid ? [measureheadid] : [];

      if (mode === 'add_first') {
        const initHtml = await postForm('call_to_be_executed.pro', { headspecid: sid }, true);
        const initJson = checkJsonSessionOrEmpty(String(initHtml == null ? '' : initHtml).trim());
        if (initJson && initJson.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        saveText = await postForm(
          'save_re_to_be_executed.pro',
          {
            ...built.params,
            headspecid: sid,
            grandtotal: built.grandtotal,
          },
          true
        );
      } else if (mode === 'add_between') {
        const orderStr = String(input.itemheadorder || '1').trim() || '1';
        const btwHtml = await postForm(
          'call_to_be_executed_between.pro',
          { specid: sid, itemheadorder: orderStr },
          true
        );
        const btwJson = checkJsonSessionOrEmpty(String(btwHtml == null ? '' : btwHtml).trim());
        if (btwJson && btwJson.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        saveText = await postForm(
          'call_to_be_executed_between_save.pro',
          {
            ...built.params,
            headspecid: sid,
            itemheadorder: orderStr,
            grandtotal: built.grandtotal,
          },
          true
        );
      } else {
        const editFormHtml = await postForm(
          'revised_estimation_edit_measurement.pro',
          { headspecid: sid, measureheadid },
          true
        );
        const editRaw = String(editFormHtml == null ? '' : editFormHtml).trim();
        const jsonState = checkJsonSessionOrEmpty(editRaw);
        if (jsonState && jsonState.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        const hasEditMarkers = /save_re_to_be_executed_edit|estimation_measurement|itemHeadDesc/i.test(
          editRaw
        );
        if (
          !editRaw ||
          (!hasEditMarkers &&
            extractor &&
            typeof extractor.isPortalErrorHtml === 'function' &&
            extractor.isPortalErrorHtml(editRaw))
        ) {
          return { ok: false, status: 'error', error: 'Failed to load TBE edit form' };
        }
        const smMatch = editRaw.match(/save_re_to_be_executed_edit\(\s*['"]?(\d+)['"]?\s*\)/);
        const specmeasureheadid = smMatch && smMatch[1] ? smMatch[1] : measureheadid;
        fallbackHeadIds = [specmeasureheadid];

        saveText = await postForm(
          'save_re_to_be_executed_edit.pro',
          {
            ...built.params,
            specmeasureheadid,
            grandtotal: built.grandtotal,
          },
          true
        );
      }

      const saveParsed = parseSaveReTbeResponse(saveText);
      if (saveParsed.sessionExpired) {
        return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
      }
      if (!saveParsed.ok) {
        return { ok: false, status: 'error', error: saveParsed.error || 'Save failed' };
      }

      let refreshed = saveParsed.parsedHtml || null;
      if (followFollowUpUrl && isSafePortalEndpoint(saveParsed.followUpUrl)) {
        const followHtml = await postForm(
          saveParsed.followUpUrl,
          {
            specid: saveParsed.specid || saveParsed.estheadspecid || sid,
            curheadid: saveParsed.curheadid || headId || '',
          },
          true
        );
        const followParsed = parseToBeExecutedHtml(followHtml, sid);
        if (followParsed.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        if (followParsed.kind === 'has_measurements' || followParsed.kind === 'empty') {
          refreshed = followParsed;
        }
      }

      if (!refreshed || (refreshed.kind !== 'has_measurements' && refreshed.kind !== 'empty')) {
        const reHtml = await postForm('call_to_be_executed.pro', { headspecid: sid }, true);
        const reParsed = parseToBeExecutedHtml(reHtml, sid);
        if (reParsed.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        if (reParsed.kind === 'has_measurements' || reParsed.kind === 'empty') {
          refreshed = reParsed;
        }
      }

      const nextIds =
        refreshed && Array.isArray(refreshed.measurementIds)
          ? refreshed.measurementIds
          : fallbackHeadIds;
      const nextHeads = refreshed && Array.isArray(refreshed.heads) ? refreshed.heads : [];
      const nextHeadDetails =
        refreshed && Array.isArray(refreshed.headDetails) ? refreshed.headDetails : [];
      const nextTbeQty =
        refreshed && refreshed.tbeQty !== null && refreshed.tbeQty !== undefined
          ? roundQty3(refreshed.tbeQty)
          : built.headTotal;

      return {
        ok: true,
        status: mode === 'edit' ? 'edited' : 'added',
        tbeQty: nextTbeQty,
        measurementIds: nextIds,
        heads: nextHeads,
        headDetails: nextHeadDetails,
        hasDetailed: refreshed ? hasDetailedSplitUp(refreshed) : false,
        headid: saveParsed.curheadid || headId,
        estheadspecid: saveParsed.estheadspecid || sid,
        savedMeasureHeadId: saveParsed.specid || measureheadid || '',
        message: saveParsed.message || 'Saved',
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || 'Request failed');
      if (isSessionAuthError(err)) {
        return {
          ok: false,
          sessionExpired: true,
          status: 'error',
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, status: 'error', error: msg };
    }
  }

  /**
   * Deletes a single TBE measurement sub-heading (`measureheadid`) and follows
   * the server recalculation endpoint to return updated `headDetails`.
   */
  async function deleteItemTbeHead(headspecid, measureheadid, deps) {
    const options = deps || {};
    const postForm = options.postForm || (extractor && extractor.postForm);
    const headId = String(options.headId || '').trim();
    const followFollowUpUrl = options.followFollowUpUrl !== false;
    const sid = String(headspecid == null ? '' : headspecid).trim();
    const mhId = String(measureheadid == null ? '' : measureheadid).trim();

    if (!sid || !mhId) {
      return { ok: false, status: 'error', error: 'Missing specification or measurement head ID' };
    }
    if (typeof postForm !== 'function') {
      return { ok: false, status: 'error', error: 'HTTP client unavailable' };
    }

    try {
      const delText = await postForm(
        'delete_re_to_be_executed.pro',
        { colList: mhId, headspecid: sid },
        true
      );
      const delParsed = parseDeleteReResponse(delText);
      if (delParsed.sessionExpired) {
        return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
      }
      if (!delParsed.ok) {
        return { ok: false, status: 'error', error: delParsed.error || 'Delete failed' };
      }

      let refreshed = null;
      if (followFollowUpUrl && isSafePortalEndpoint(delParsed.followUpUrl)) {
        const followHtml = await postForm(
          delParsed.followUpUrl,
          {
            specid: delParsed.estheadspecid || sid,
            curheadid: delParsed.headid || headId || '',
          },
          true
        );
        const followParsed = parseToBeExecutedHtml(followHtml, sid);
        if (followParsed.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        if (followParsed.kind === 'has_measurements' || followParsed.kind === 'empty') {
          refreshed = followParsed;
        }
      }

      if (!refreshed) {
        const reHtml = await postForm('call_to_be_executed.pro', { headspecid: sid }, true);
        const reParsed = parseToBeExecutedHtml(reHtml, sid);
        if (reParsed.kind === 'session_expired') {
          return { ok: false, sessionExpired: true, status: 'error', error: 'Session expired' };
        }
        if (reParsed.kind === 'has_measurements' || reParsed.kind === 'empty') {
          refreshed = reParsed;
        }
      }

      const kind = refreshed ? refreshed.kind : 'empty';
      const nextTbeQty =
        refreshed && refreshed.kind === 'has_measurements' && refreshed.tbeQty !== null
          ? roundQty3(refreshed.tbeQty)
          : 0;

      return {
        ok: true,
        status: 'deleted',
        kind,
        tbeQty: nextTbeQty,
        measurementIds: refreshed ? refreshed.measurementIds : [],
        heads: refreshed ? refreshed.heads : [],
        headDetails: refreshed ? refreshed.headDetails || [] : [],
        hasDetailed: refreshed ? hasDetailedSplitUp(refreshed) : false,
        headid: delParsed.headid || headId,
        estheadspecid: delParsed.estheadspecid || sid,
        message: delParsed.message || 'Deleted',
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || 'Request failed');
      if (isSessionAuthError(err)) {
        return {
          ok: false,
          sessionExpired: true,
          status: 'error',
          error: msg === 'NO_TOKEN' ? 'Missing security token' : 'Session expired',
        };
      }
      return { ok: false, status: 'error', error: msg };
    }
  }

  // -------------------------------------------------------------------------
  // Browser UI Integration & Lifecycle
  // -------------------------------------------------------------------------

  function asyncBridgeCall(action, payload, timeoutMs) {
    if (
      typeof document === 'undefined' ||
      typeof CustomEvent === 'undefined'
    ) {
      return Promise.resolve({ bridged: false, ok: false, result: null });
    }
    const reqId = `p3h_re_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        document.removeEventListener('p3h:bridge:res', onRes);
      };
      const onRes = (ev) => {
        try {
          const data = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : ev.detail;
          if (!data || data.id !== reqId) return;
          if (done) return;
          done = true;
          cleanup();
          resolve({ bridged: true, ...data });
        } catch (_e) {}
      };
      document.addEventListener('p3h:bridge:res', onRes);
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ bridged: false, ok: false, result: null, error: 'Bridge timeout' });
      }, waitMs);
      try {
        document.dispatchEvent(
          new CustomEvent('p3h:bridge:req', {
            detail: JSON.stringify({ id: reqId, action, payload: payload || null }),
          })
        );
      } catch (err) {
        if (!done) {
          done = true;
          cleanup();
          resolve({ bridged: false, ok: false, result: null, error: err && err.message ? err.message : String(err) });
        }
      }
    });
  }

  const uiState = {
    lastBtnSig: '',
    modalActive: false,
    mbookModalActive: false,
    closeMbookModalHook: null,
    closeSplitCardHook: null,
    isRunning: false,
    activeSaveCount: 0,
    helperLoading: false,
    inlineHelpersHidden: false,
    cancelRequested: false,
    canCloseModalHook: null,
    closeModalHook: null,
  };

  function getActiveCachedHelperBundle(doc, bridgeCtx) {
    const ctx = resolveReWorkContext(doc, bridgeCtx);
    const key = makeHelperCacheKey(ctx.reEstId, ctx.headId);
    return { ctx, key, bundle: helperCache.byHeadingKey.get(key) || null };
  }

  function renderInlineHelperHtml(model) {
    if (!model) return '';
    const chips = [];

    if (model.dprQty !== null) {
      if (model.isExtraItem) {
        chips.push(
          `<span class="p3h-re-qchip p3h-re-qchip-dpr" title="Extra item (not in Original DPR)">DPR: 0 (Extra)</span>`
        );
      } else {
        chips.push(
          `<span class="p3h-re-qchip p3h-re-qchip-dpr" title="Original Sanctioned Estimate (DPR) Quantity">DPR: ${escapeHtml(
            formatQty(model.dprQty)
          )}</span>`
        );
      }
    }

    if (model.hasMbookSource) {
      if (model.hasPendingAe) {
        chips.push(
          `<span class="p3h-re-qchip p3h-re-qchip-pending" title="AE-Accepted MBook: ${escapeHtml(
            formatQty(model.mbookAcceptedQty)
          )} | Pending AE Check-Measurement (${model.mbookPendingCount}): ${escapeHtml(
            formatQty(model.mbookPendingQty)
          )} | Total Recorded MBook: ${escapeHtml(
            formatQty(model.mbookTotalQty)
          )}">MBook: ${escapeHtml(formatQty(model.mbookAcceptedQty))} (+${escapeHtml(
            formatQty(model.mbookPendingQty)
          )} Pend = ${escapeHtml(formatQty(model.mbookTotalQty))})</span>`
        );
      } else if (model.hasMbook) {
        chips.push(
          `<span class="p3h-re-qchip p3h-re-qchip-mbook" title="Cumulative e-MBook Quantity (AE-Accepted)">MBook: ${escapeHtml(
            formatQty(model.mbookAcceptedQty)
          )}</span>`
        );
      } else {
        chips.push(
          `<span class="p3h-re-qchip p3h-re-qchip-muted" title="No entries recorded in e-MBook">MBook: 0</span>`
        );
      }
    }

    if (model.reExecutedQty !== null || model.reTbeQty !== null) {
      chips.push(
        `<span class="p3h-re-qchip p3h-re-qchip-exec" title="RE Executed (synced from e-MBook) and To Be Executed (TBE)">Exec: ${escapeHtml(
          formatQty(model.reExecutedQty)
        )} · TBE: ${escapeHtml(formatQty(model.reTbeQty))}</span>`
      );
    }

    if (model.isDoubledTbe) {
      chips.push(
        `<span class="p3h-re-qchip p3h-re-qchip-warn" title="TBE still equals DPR while Executed > 0 (quantity inflated)">⚠ Doubled (+${escapeHtml(
          formatQty(model.reExecutedQty)
        )})</span>`
      );
    }

    if (model.hasUnsyncedMbook) {
      chips.push(
        `<span class="p3h-re-qchip p3h-re-qchip-sync" title="AE-Accepted MBook (${escapeHtml(
          formatQty(model.mbookAcceptedQty)
        )}) differs from RE Executed (${escapeHtml(
          formatQty(model.reExecutedQty)
        )}). Click 'Update Measurements From e-Mbook' to sync.">⚡ Unsynced MB (${escapeHtml(
          formatQty(model.mbookAcceptedQty)
        )} vs ${escapeHtml(formatQty(model.reExecutedQty))})</span>`
      );
    }

    return chips.join('');
  }

  function clearInlineReHelpers(rootDoc) {
    if (!rootDoc || typeof rootDoc.querySelector !== 'function') return 0;
    const scope = rootDoc.querySelector('#pt-specifications') || rootDoc;
    if (typeof scope.querySelectorAll !== 'function') return 0;
    const nodes = Array.from(scope.querySelectorAll('.p3h-re-item-helper'));
    nodes.forEach((n) => n.remove());
    return nodes.length;
  }

  function renderInlineReHelpers(rootDoc, bundle) {
    if (!rootDoc || typeof rootDoc.querySelector !== 'function') return 0;
    const table = rootDoc.querySelector('#pt-specifications');
    if (!table) return 0;

    const extracted = extractReSpecItems(rootDoc);
    if (!bundle) {
      table.querySelectorAll('.p3h-re-item-helper').forEach((n) => n.remove());
      return 0;
    }

    const { bySpecId } = buildReHelperRowModel(extracted.items, bundle);
    let rendered = 0;

    extracted.items.forEach((it) => {
      const model = bySpecId.get(it.headspecid);
      if (!model) return;
      const trTop =
        (typeof rootDoc.getElementById === 'function' && rootDoc.getElementById('td-' + it.headspecid)) ||
        (() => {
          const td = table.querySelector(`td[onclick^="re_to_be_executed(${it.headspecid})"]`);
          return td && typeof td.closest === 'function' ? td.closest('tr') : null;
        })();
      if (!trTop) return;

      const blockRows = collectSpecBlockRows(table, trTop, it.headspecid);
      const trMiddle =
        blockRows.find(
          (r) =>
            hasClass(r, 'pt-sp-middle') ||
            (typeof r.querySelector === 'function' && Boolean(r.querySelector('p.sp-content')))
        ) || blockRows[0];
      if (!trMiddle) return;

      let wz = trMiddle.querySelector('.pt-wz');
      if (!wz) {
        const descTd = Array.from(trMiddle.querySelectorAll('td')).find((td) =>
          Boolean(td.querySelector('p.sp-content, .sp-content-wrap'))
        );
        if (!descTd) return;
        wz = rootDoc.createElement('div');
        wz.className = 'pt-wz';
        descTd.appendChild(wz);
      }

      const chipsHtml = renderInlineHelperHtml(model);
      const sig = `${bundle.fetchedAt}|${it.headspecid}|${chipsHtml.length}`;
      let box = wz.querySelector('.p3h-re-item-helper');
      if (box && box.getAttribute('data-p3h-helper-sig') === sig) {
        rendered++;
        return;
      }
      if (!box) {
        box = rootDoc.createElement('div');
        box.className = 'p3h-re-item-helper';
        wz.appendChild(box);
      }
      box.setAttribute('data-p3h-helper-sig', sig);
      box.innerHTML = chipsHtml;
      rendered++;
    });

    return rendered;
  }

  function closeReBatchModal(force) {
    if (uiState.isRunning || uiState.activeSaveCount > 0) return;
    if (!force && typeof uiState.canCloseModalHook === 'function' && !uiState.canCloseModalHook()) {
      return;
    }
    uiState.canCloseModalHook = null;
    uiState.mbookModalActive = false;
    uiState.closeMbookModalHook = null;
    uiState.closeSplitCardHook = null;
    const hook = uiState.closeModalHook;
    uiState.closeModalHook = null;
    if (typeof hook === 'function') {
      hook();
    }
    const overlay = typeof document !== 'undefined' && document.getElementById('p3h-re-modal-overlay');
    if (overlay) overlay.remove();
    uiState.modalActive = false;
    uiState.cancelRequested = false;
  }

  function formatModalDprCellHtml(model) {
    if (!model || model.dprQty === null) return '<span class="p3h-re-cell-muted">—</span>';
    const extraTag = model.isExtraItem ? '<div class="p3h-re-amt-sub">Extra item</div>' : '';
    return `<div>${escapeHtml(formatQty(model.dprQty))}</div>${extraTag}`;
  }

  function formatModalMbookCellHtml(model, specId) {
    if (!model || !model.hasMbookSource) return '<span class="p3h-re-cell-muted">—</span>';
    const base = `<div>${escapeHtml(formatQty(model.mbookAcceptedQty))}</div>`;
    const sid = specId !== undefined && specId !== null ? String(specId) : '';
    const pendTitle = `Edit / delete LIVE e-MBook entries pending with AE (${model.mbookPendingCount} entry(s))`;
    const pendText = `+${escapeHtml(formatQty(model.mbookPendingQty))} Pend (${escapeHtml(
      formatQty(model.mbookTotalQty)
    )})`;
    const pend = model.hasPendingAe
      ? sid
        ? `<button type="button" class="p3h-re-mb-pending p3h-re-mb-pending-btn" data-specid="${escapeHtml(
            sid
          )}" title="${escapeHtml(pendTitle)}">✎ ${pendText}</button>`
        : `<div class="p3h-re-mb-pending" title="${model.mbookPendingCount} pending entry(s) in AE Inbox">${pendText}</div>`
      : '';
    const sync = model.hasUnsyncedMbook
      ? `<div class="p3h-re-mb-unsynced" title="RE Executed is ${escapeHtml(
          formatQty(model.reExecutedQty)
        )}">⚡ Unsynced</div>`
      : '';
    return base + pend + sync;
  }

  function formatModalExecCellHtml(model) {
    if (!model || model.reExecutedQty === null) {
      return '<span class="p3h-re-cell-muted">—</span>';
    }
    return `<div>${escapeHtml(formatQty(model.reExecutedQty))}</div>`;
  }

  function formatModalTbeCellHtml(item, model) {
    const sid = item && item.headspecid ? String(item.headspecid) : '';
    const valStr = model && model.reTbeQty !== null ? formatEditableQty(model.reTbeQty) : '';
    const doubledCls = model && model.isDoubledTbe ? ' p3h-re-tbe-doubled' : '';
    const doubledHint =
      model && model.isDoubledTbe
        ? ' title="Doubled: TBE equals DPR while Executed &gt; 0"'
        : '';
    const hasBal = Boolean(model && model.dprBalanceQty !== null);
    const balTitle = hasBal
      ? `Set TBE to balance DPR (${formatEditableQty(model.dprBalanceQty)} = max(0, DPR − Exec))`
      : 'Load DPR & MBook to calculate DPR balance';
    return `<div class="p3h-re-tbe-edit-wrap">
      <span class="p3h-re-tbe-state" data-row-state="${escapeHtml(sid)}"></span>
      <input type="text" inputmode="decimal" class="p3h-input p3h-re-tbe-input${doubledCls}" data-specid="${escapeHtml(
        sid
      )}" value="${escapeHtml(valStr)}" placeholder="—"${doubledHint}>
      <button type="button" class="p3h-re-row-bal-btn" data-specid="${escapeHtml(
        sid
      )}" title="${escapeHtml(balTitle)}"${hasBal ? '' : ' disabled'}>Bal</button>
      <button type="button" class="p3h-re-row-del-btn" data-specid="${escapeHtml(
        sid
      )}" title="Delete To Be Executed quantity (set to 0)">✕</button>
    </div>`;
  }

  function formatModalAmtCellHtml(item) {
    return `<div>${escapeHtml((item && item.qtyText) || '0')}</div>
      <div class="p3h-re-amt-sub">₹${escapeHtml(formatInr((item && item.amount) || 0))}</div>`;
  }

  function formatModalDevCellHtml(model, item, overrideDeviation) {
    const dev = overrideDeviation || (model && model.deviation) || null;
    if (!dev || dev.kind === 'unknown') {
      return '<span class="p3h-re-cell-muted">—</span>';
    }
    const clsMap = {
      zero: 'p3h-re-dev-pill p3h-re-dev-zero',
      neg: 'p3h-re-dev-pill p3h-re-dev-neg',
      pos: 'p3h-re-dev-pill p3h-re-dev-pos',
      high: 'p3h-re-dev-pill p3h-re-dev-high',
      extra: 'p3h-re-dev-pill p3h-re-dev-extra',
    };
    const cls = clsMap[dev.kind] || 'p3h-re-dev-pill p3h-re-dev-zero';
    const dprVal = model && model.dprQty !== null ? formatQty(model.dprQty) : '—';
    const reVal =
      model && model.reTotalQty !== null
        ? formatQty(model.reTotalQty)
        : item
        ? formatQty(item.qty)
        : '—';
    const deltaStr =
      dev.deltaQty !== null ? `${dev.deltaQty > 0 ? '+' : ''}${formatQty(dev.deltaQty)}` : '—';
    const title = `DPR: ${dprVal} → RE: ${reVal} (${deltaStr} / ${dev.label})`;
    return `<span class="${cls}" title="${escapeHtml(title)}">${escapeHtml(dev.label)}</span>`;
  }

  function openReBatchModal() {
    if (!hasDocument || document.getElementById('p3h-re-modal-overlay')) return;

    const ctxRes =
      extractor && typeof extractor.syncBridgeCall === 'function'
        ? extractor.syncBridgeCall('re:getContext', {})
        : { bridged: false, ok: false };
    let ctx = (ctxRes && ctxRes.ok && ctxRes.result) || {};
    let extracted = extractReSpecItems(document);
    let headingsList = extractReHeadingsList(document);
    let currentHeadId = String(
      ctx.curHeadId || extracted.headId || (headingsList.find((h) => h.isActive) || {}).headId || ''
    );
    let items = extracted.items;
    let itemBySpecId = new Map(items.map((it) => [it.headspecid, it]));

    let activeItems = items.filter((i) => i.amount > 0 || i.qty > 0);
    let zeroItemsCount = items.length - activeItems.length;
    let showZeroItems = true;
    const selectedSet = new Set();
    const cachedIdsBySpecId = new Map();
    const committedTbeBySpecId = new Map();
    const tbeDetailsBySpecId = new Map();
    let activeSplitSpecId = null;
    const loadingSplitSpecIds = new Set();
    const splitErrorsBySpecId = new Map();
    const dirtyHeadsBySpecId = new Map();
    const rowStatuses = new Map();
    const savingRowIds = new Set();
    let rowMutationChain = Promise.resolve();
    let skipBlurSpecId = '';
    let hasDirtyPortalChanges = false;
    let hasSessionExpired = false;
    let dirtyLastHeadId = currentHeadId;
    let dirtyLastHeadSpecId = '';
    let lastFailedItems = [];
    let lastClickedIndex = null;
    let newHeadSeq = 1;
    let bgSyncTimer = null;
    let bgSyncPromise = null;
    let bgAbortRequested = false;

    const cachedInfo = getActiveCachedHelperBundle(document, ctx);
    let currentBundle = cachedInfo.bundle;
    let helperModelBySpecId = currentBundle
      ? buildReHelperRowModel(items, currentBundle).bySpecId
      : new Map();

    items.forEach((it) => {
      const m = helperModelBySpecId.get(it.headspecid) || null;
      if (m && m.reTbeQty !== null) {
        committedTbeBySpecId.set(it.headspecid, roundQty3(m.reTbeQty));
      }
    });

    function buildModalTbodyRowsHtml(list) {
      if (!list || list.length === 0) {
        return `<tr><td colspan="10" style="text-align:center;padding:28px;color:#64748b;">No items found in the active heading.</td></tr>`;
      }
      return list
        .map((it) => {
          const m = helperModelBySpecId.get(it.headspecid) || null;
          const compactSpec = formatCompactSpecCode(it.specCode);
          const sidEsc = escapeHtml(it.headspecid);
          return `
                  <tr class="p3h-re-row" data-specid="${sidEsc}" data-idx="${it.index}">
                    <td style="text-align:center;"><input type="checkbox" class="p3h-re-cb" data-specid="${sidEsc}" ${
            selectedSet.has(it.headspecid) ? 'checked' : ''
          }></td>
                    <td class="p3h-re-sl">${escapeHtml(it.slNo || String(it.index + 1))}</td>
                    <td class="p3h-re-spec">
                      <span class="p3h-re-spec-code" title="${escapeHtml(it.specCode || '-')}">${escapeHtml(
            compactSpec
          )}</span>
                      ${it.isBgFix ? '<span class="p3h-re-bgfix-tag">BG-FIX</span>' : ''}
                    </td>
                    <td class="p3h-re-desc">${escapeHtml(it.desc)}</td>
                    <td class="p3h-re-num p3h-re-col-dpr">${formatModalDprCellHtml(m)}</td>
                    <td class="p3h-re-num p3h-re-col-mbook">${formatModalMbookCellHtml(m, it.headspecid)}</td>
                    <td class="p3h-re-num p3h-re-col-exec">${formatModalExecCellHtml(m)}</td>
                    <td class="p3h-re-num p3h-re-col-tbe">${formatModalTbeCellHtml(it, m)}</td>
                    <td class="p3h-re-amt p3h-re-col-amt">${formatModalAmtCellHtml(it)}</td>
                    <td class="p3h-re-col-dev" data-dev-cell="${sidEsc}">${formatModalDevCellHtml(
            m,
            it
          )}</td>
                  </tr>`;
        })
        .join('');
    }

    function buildHeadingOptionsHtml() {
      const workCtx = resolveReWorkContext(document, ctx);
      const list =
        headingsList.length > 0
          ? headingsList
          : [
              {
                headId: currentHeadId || 'current',
                orderNo: '',
                name: extracted.headingName || 'Current Heading',
                label: extracted.headingName || 'Current Heading',
                isActive: true,
              },
            ];
      return list
        .map((h) => {
          const isCached = Boolean(
            workCtx.reEstId &&
              h.headId &&
              helperCache.byHeadingKey.has(makeHelperCacheKey(workCtx.reEstId, h.headId))
          );
          const prefix = isCached ? '✓ ' : '';
          const sel = String(h.headId) === String(currentHeadId) ? ' selected' : '';
          return `<option value="${escapeHtml(h.headId)}"${sel}>${escapeHtml(prefix + h.label)}</option>`;
        })
        .join('');
    }

    const overlay = document.createElement('div');
    overlay.id = 'p3h-re-modal-overlay';
    overlay.className = 'p3h-re-modal-overlay';

    const warnHtml = ctx.hasMeasurementFormOpen
      ? `<div class="p3h-re-warn-banner">Measurement entry screen is currently open. Close or save it before editing or deleting items.</div>`
      : '';
    const multiHeadDisabled = headingsList.length <= 1 ? ' disabled' : '';

    overlay.innerHTML = `
      <div class="p3h-re-modal" role="dialog" aria-modal="true" aria-labelledby="p3h-re-modal-title">
        <div class="p3h-re-progress-track"><div class="p3h-re-progress-fill" id="p3h-re-pbar"></div></div>
        <div class="p3h-re-header">
          <div class="p3h-re-title-wrap">
            <h3 id="p3h-re-modal-title">RE Helper</h3>
            <div class="p3h-re-heading-switcher">
              <button type="button" class="p3h-re-head-nav-btn" id="p3h-re-head-prev" title="Previous heading"${multiHeadDisabled}>‹</button>
              <select class="p3h-select p3h-re-heading-select" id="p3h-re-heading-select" aria-label="Active Estimate Heading"${multiHeadDisabled}>${buildHeadingOptionsHtml()}</select>
              <button type="button" class="p3h-re-head-nav-btn" id="p3h-re-head-next" title="Next heading"${multiHeadDisabled}>›</button>
              <span class="p3h-re-bg-sync-pill" id="p3h-re-bg-sync-pill" style="display:none;"></span>
            </div>
            <span class="p3h-re-status-badge" id="p3h-re-status" style="display:none;"></span>
          </div>
          <button type="button" class="p3h-re-close-x" id="p3h-re-close-x" title="Close">×</button>
        </div>
        ${warnHtml}
        <div class="p3h-re-tip">
          <span>Compare DPR, e-MBook &amp; RE quantities across headings. Edit flat <strong>TBE Qty</strong> inline (saves on blur / <kbd class="p3h-re-kbd">Enter</kbd>), click a locked TBE field (or double-click any TBE field) to open the <strong>Split-Up Card</strong>, click <strong>Bal</strong> to match DPR, or <strong>✕</strong> to clear.</span>
        </div>
        <div class="p3h-re-toolbar" id="p3h-re-toolbar">
          <input type="text" class="p3h-input p3h-re-search" id="p3h-re-search" placeholder="Filter by #, spec code, or description...">
          <select class="p3h-select p3h-re-view-filter" id="p3h-re-view-filter" title="Filter visible items by RE diagnostic status" ${
            currentBundle ? '' : 'disabled'
          }>
            <option value="all">All Items</option>
            <option value="doubled">⚠ Doubled TBE</option>
            <option value="excess">Excess (Dev &gt; 0%)</option>
            <option value="savings">Savings (Dev &lt; 0%)</option>
            <option value="tbe_gt_0">TBE &gt; 0</option>
            <option value="mbook_issue">AE Pending / Unsynced</option>
            <option value="extra">Extra Items (DPR = 0)</option>
          </select>
          <div class="p3h-re-tool-btns">
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-all-btn">All</button>
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-none-btn">None</button>
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-invert-btn">Invert</button>
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-sel-doubled-btn" title="Select only items where TBE equals DPR while Executed > 0" ${
              currentBundle ? '' : 'disabled'
            }>Doubled</button>
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-sel-exec-btn" title="Select items fully executed in e-MBook (MBook ≥ DPR) that still have TBE" ${
              currentBundle ? '' : 'disabled'
            }>MBook ≥ DPR</button>
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-sel-tbe-btn" title="Select only items with RE TBE > 0" ${
              currentBundle ? '' : 'disabled'
            }>TBE &gt; 0</button>
            ${
              zeroItemsCount > 0
                ? `<label class="p3h-re-zero-toggle" id="p3h-re-zero-label"><input type="checkbox" id="p3h-re-zero-cb" ${
                    showZeroItems ? 'checked' : ''
                  }> Show ₹0 items (${zeroItemsCount})</label>`
                : ''
            }
            <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-register" id="p3h-re-modal-helper-btn" title="Fetch DPR, e-MBook & RE Executed/TBE breakdown for all items in this heading">${
              currentBundle ? 'Refresh DPR & MBook' : 'Load DPR & MBook'
            }</button>
            <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-primary" id="p3h-re-scan-btn" title="Read-only pre-check to inspect TBE measurement heads and quantities">Check TBE</button>
          </div>
        </div>
        <div class="p3h-re-content-wrap">
          <div class="p3h-re-content" id="p3h-re-content">
            <table class="p3h-re-table">
              <thead>
                <tr>
                  <th width="34" style="text-align:center;"><input type="checkbox" id="p3h-re-header-cb"></th>
                  <th width="40">#</th>
                  <th width="86">Spec</th>
                  <th>Description</th>
                  <th width="76" style="text-align:right;">DPR Qty</th>
                  <th width="116" style="text-align:right;">MBook Qty</th>
                  <th width="74" style="text-align:right;">RE Exec</th>
                  <th width="186" style="text-align:right;">TBE Qty</th>
                  <th width="114" style="text-align:right;">RE Total / Amt</th>
                  <th width="86" style="text-align:center;">Dev %</th>
                </tr>
              </thead>
              <tbody id="p3h-re-tbody">
                ${buildModalTbodyRowsHtml(items)}
              </tbody>
            </table>
          </div>
          <div class="p3h-re-sync-overlay" id="p3h-re-sync-overlay" aria-live="polite" style="display:none;">
            <div class="p3h-re-sync-card">
              <div class="p3h-re-sync-head">
                <span class="p3h-re-sync-spinner" aria-hidden="true"></span>
                <div class="p3h-re-sync-copy">
                  <div class="p3h-re-sync-title" id="p3h-re-sync-title">Syncing…</div>
                  <div class="p3h-re-sync-step" id="p3h-re-sync-step">Please wait…</div>
                </div>
              </div>
              <div class="p3h-re-sync-bar-track">
                <div class="p3h-re-sync-bar-fill" id="p3h-re-sync-bar-fill"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="p3h-re-footer">
          <div class="p3h-re-summary" id="p3h-re-summary">
            <div class="p3h-re-summary-row" id="p3h-re-summary-head"></div>
            <div class="p3h-re-summary-row p3h-re-summary-est" id="p3h-re-summary-est" style="display:none;"></div>
          </div>
          <div class="p3h-re-footer-actions">
            <button type="button" class="p3h-btn p3h-btn-warn" id="p3h-re-stop-btn" style="display:none;">Stop</button>
            <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-re-retry-btn" style="display:none;">Retry Failed (0)</button>
            <button type="button" class="p3h-btn p3h-btn-muted-danger" id="p3h-re-delete-btn">Clear Selected TBE</button>
            <button type="button" class="p3h-btn p3h-re-close-footer-btn" id="p3h-re-cancel-btn">Close</button>
          </div>
        </div>
        <div id="p3h-re-split-backdrop" class="p3h-re-split-backdrop" style="display:none;">
          <div id="p3h-re-split-card" class="p3h-re-split-card" role="dialog" aria-modal="true" aria-labelledby="p3h-re-split-card-title"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    uiState.modalActive = true;
    uiState.isRunning = false;
    uiState.activeSaveCount = 0;
    uiState.cancelRequested = false;
    uiState.closeSplitCardHook = () => {
      if (activeSplitSpecId !== null) {
        closeSplitCard({ revertDrafts: true });
        return true;
      }
      return false;
    };
    uiState.canCloseModalHook = () => {
      if (hasAnyUnsavedSplitEdits()) {
        return confirm('You have unsaved TBE split-up changes. Discard changes and close?');
      }
      return true;
    };
    uiState.closeModalHook = () => {
      bgAbortRequested = true;
      if (bgSyncTimer) {
        clearTimeout(bgSyncTimer);
        bgSyncTimer = null;
      }
      if (hasDirtyPortalChanges && !hasSessionExpired) {
        if (extractor && typeof extractor.syncBridgeCall === 'function') {
          extractor.syncBridgeCall('re:refreshAfterDelete', {
            headId: dirtyLastHeadId || ctx.curHeadId || extracted.headId,
            lastHeadSpecId: dirtyLastHeadSpecId,
          });
        }
      }
    };

    const modalEl = overlay.querySelector('.p3h-re-modal');
    const pbar = overlay.querySelector('#p3h-re-pbar');
    const statusBadge = overlay.querySelector('#p3h-re-status');
    const headingSelect = overlay.querySelector('#p3h-re-heading-select');
    const headPrevBtn = overlay.querySelector('#p3h-re-head-prev');
    const headNextBtn = overlay.querySelector('#p3h-re-head-next');
    const bgSyncPill = overlay.querySelector('#p3h-re-bg-sync-pill');
    const syncOverlayEl = overlay.querySelector('#p3h-re-sync-overlay');
    const syncTitleEl = overlay.querySelector('#p3h-re-sync-title');
    const syncStepEl = overlay.querySelector('#p3h-re-sync-step');
    const syncBarFill = overlay.querySelector('#p3h-re-sync-bar-fill');
    const splitBackdropEl = overlay.querySelector('#p3h-re-split-backdrop');
    const splitCardEl = overlay.querySelector('#p3h-re-split-card');
    const closeXBtn = overlay.querySelector('#p3h-re-close-x');
    const searchInput = overlay.querySelector('#p3h-re-search');
    const viewFilterSelect = overlay.querySelector('#p3h-re-view-filter');
    const allBtn = overlay.querySelector('#p3h-re-all-btn');
    const noneBtn = overlay.querySelector('#p3h-re-none-btn');
    const invertBtn = overlay.querySelector('#p3h-re-invert-btn');
    const selDoubledBtn = overlay.querySelector('#p3h-re-sel-doubled-btn');
    const selExecBtn = overlay.querySelector('#p3h-re-sel-exec-btn');
    const selTbeBtn = overlay.querySelector('#p3h-re-sel-tbe-btn');
    const zeroCb = overlay.querySelector('#p3h-re-zero-cb');
    const modalHelperBtn = overlay.querySelector('#p3h-re-modal-helper-btn');
    const scanBtn = overlay.querySelector('#p3h-re-scan-btn');
    const headerCb = overlay.querySelector('#p3h-re-header-cb');
    const tbody = overlay.querySelector('#p3h-re-tbody');
    const summaryEl = overlay.querySelector('#p3h-re-summary');
    const summaryHeadEl = overlay.querySelector('#p3h-re-summary-head');
    const summaryEstEl = overlay.querySelector('#p3h-re-summary-est');
    let pageTotals = extractRePageTotalsFromDoc(document, ctx.curHeadId || extracted.headId);
    let modalDprEstId = resolveReWorkContext(document, ctx).dprEstId;
    const stopBtn = overlay.querySelector('#p3h-re-stop-btn');
    const retryBtn = overlay.querySelector('#p3h-re-retry-btn');
    const cancelBtn = overlay.querySelector('#p3h-re-cancel-btn');
    const deleteBtn = overlay.querySelector('#p3h-re-delete-btn');
    let rowNodes = Array.from(tbody.querySelectorAll('tr.p3h-re-row'));

    function itemMatchesSearch(item, term) {
      if (!term) return true;
      const hay = (
        item.slNo +
        ' ' +
        item.specCode +
        ' ' +
        item.desc +
        ' ' +
        item.qtyText +
        ' ' +
        item.amountText
      ).toLowerCase();
      return hay.includes(term);
    }

    function itemMatchesViewFilter(item, filterKey) {
      if (!filterKey || filterKey === 'all' || !currentBundle) return true;
      const m = helperModelBySpecId.get(item.headspecid);
      if (!m) return false;
      if (filterKey === 'doubled') return Boolean(m.isDoubledTbe);
      if (filterKey === 'excess') {
        return Boolean(m.deviation && (m.deviation.kind === 'pos' || m.deviation.kind === 'high'));
      }
      if (filterKey === 'savings') {
        return Boolean(m.deviation && m.deviation.kind === 'neg');
      }
      if (filterKey === 'tbe_gt_0') return m.hasTbe === true;
      if (filterKey === 'mbook_issue') return Boolean(m.hasPendingAe || m.hasUnsyncedMbook);
      if (filterKey === 'extra') return Boolean(m.isExtraItem);
      return true;
    }

    function getVisibleItems() {
      const term = (searchInput.value || '').trim().toLowerCase();
      const filterKey = viewFilterSelect ? viewFilterSelect.value : 'all';
      return items.filter((it) => {
        if (!showZeroItems && it.amount <= 0 && it.qty <= 0) return false;
        if (!itemMatchesViewFilter(it, filterKey)) return false;
        return itemMatchesSearch(it, term);
      });
    }

    function applyVisibilityFilter() {
      const visibleIds = new Set(getVisibleItems().map((it) => it.headspecid));
      rowNodes.forEach((tr) => {
        const sid = tr.getAttribute('data-specid');
        const isVisible = visibleIds.has(sid);
        tr.style.display = isVisible ? '' : 'none';
      });
      syncSelectionUi();
    }

    function syncActionLockUi() {
      const rowSavingActive = savingRowIds.size > 0;
      const batchLocked = uiState.isRunning || rowSavingActive;
      uiState.activeSaveCount = savingRowIds.size;

      searchInput.disabled = batchLocked;
      if (viewFilterSelect) viewFilterSelect.disabled = batchLocked || !currentBundle;
      allBtn.disabled = batchLocked;
      noneBtn.disabled = batchLocked;
      invertBtn.disabled = batchLocked;
      selDoubledBtn.disabled = batchLocked || !currentBundle;
      selExecBtn.disabled = batchLocked || !currentBundle;
      selTbeBtn.disabled = batchLocked || !currentBundle;
      modalHelperBtn.disabled = batchLocked;
      scanBtn.disabled = batchLocked;
      headerCb.disabled = batchLocked;
      if (zeroCb) zeroCb.disabled = batchLocked;
      closeXBtn.disabled = batchLocked;
      cancelBtn.disabled = batchLocked;
      deleteBtn.disabled = batchLocked || selectedSet.size === 0;
      retryBtn.disabled = batchLocked;

      if (headingSelect) headingSelect.disabled = batchLocked || headingsList.length <= 1;
      const activeHeadIdx = headingsList.findIndex((h) => String(h.headId) === String(currentHeadId));
      if (headPrevBtn) headPrevBtn.disabled = batchLocked || headingsList.length <= 1 || activeHeadIdx <= 0;
      if (headNextBtn) {
        headNextBtn.disabled =
          batchLocked || headingsList.length <= 1 || activeHeadIdx < 0 || activeHeadIdx >= headingsList.length - 1;
      }

      rowNodes.forEach((tr) => {
        const sid = tr.getAttribute('data-specid');
        const m = helperModelBySpecId.get(sid) || null;
        const details = tbeDetailsBySpecId.get(sid) || null;
        const hasDetailed = Boolean(details && details.hasDetailed);
        const isRowSaving = savingRowIds.has(sid);
        const rowLocked = uiState.isRunning || isRowSaving;
        tr.classList.toggle('p3h-re-row-saving', isRowSaving);
        const cb = tr.querySelector('.p3h-re-cb');
        const inp = tr.querySelector('.p3h-re-tbe-input');
        const balRowBtn = tr.querySelector('.p3h-re-row-bal-btn');
        const delRowBtn = tr.querySelector('.p3h-re-row-del-btn');
        const mbPendBtn = tr.querySelector('.p3h-re-mb-pending-btn');
        if (cb) cb.disabled = rowLocked;
        if (inp) inp.disabled = rowLocked;
        if (balRowBtn) {
          balRowBtn.disabled = rowLocked || hasDetailed || !(m && m.dprBalanceQty !== null);
        }
        if (delRowBtn) delRowBtn.disabled = rowLocked;
        if (mbPendBtn) mbPendBtn.disabled = rowLocked;
      });

      if (activeSplitSpecId && splitCardEl) {
        const splitLocked = uiState.isRunning || savingRowIds.has(activeSplitSpecId);
        const headMap = dirtyHeadsBySpecId.get(activeSplitSpecId);
        let anyDirtyOrNew = false;
        let anyInvalid = false;
        if (headMap) {
          headMap.forEach((d) => {
            if (d && (d.dirty || d.isNew)) {
              anyDirtyOrNew = true;
              if (computeDraftHeadSummary(d).hasInvalid) anyInvalid = true;
            }
          });
        }
        splitCardEl.querySelectorAll('input, button').forEach((ctrl) => {
          if (ctrl.classList.contains('p3h-re-split-save-btn')) {
            ctrl.disabled = splitLocked || (anyDirtyOrNew && anyInvalid);
          } else {
            ctrl.disabled = splitLocked;
          }
        });
      }
    }

    function syncSelectionUi() {
      const visibleRows = rowNodes.filter((tr) => tr.style.display !== 'none');
      let visSelected = 0;
      rowNodes.forEach((tr) => {
        const sid = tr.getAttribute('data-specid');
        const cb = tr.querySelector('.p3h-re-cb');
        const checked = selectedSet.has(sid);
        if (cb) cb.checked = checked;
        if (tr.style.display !== 'none' && checked) visSelected++;
      });

      headerCb.checked = visibleRows.length > 0 && visSelected === visibleRows.length;
      headerCb.indeterminate = visSelected > 0 && visSelected < visibleRows.length;

      let totalSelectedAmt = 0;
      let totalDprAmt = 0;
      let totalReAmt = 0;
      let hasOrigAmt = false;
      items.forEach((it) => {
        if (selectedSet.has(it.headspecid)) {
          totalSelectedAmt += Number(it.amount) || 0;
        }
        totalReAmt += Number(it.amount) || 0;
        const m = helperModelBySpecId.get(it.headspecid);
        if (m && m.origAmount !== null) {
          totalDprAmt += Number(m.origAmount) || 0;
          hasOrigAmt = true;
        }
      });

      let headingFinSuffix = '';
      if (currentBundle && (currentBundle.hasDevSource || totalReAmt > 0)) {
        headingFinSuffix = ` · Heading ${formatReImpactSummary(totalDprAmt, totalReAmt, hasOrigAmt).text}`;
      }

      const headText = `${selectedSet.size} of ${items.length} selected · ₹${formatInr(
        totalSelectedAmt
      )}${headingFinSuffix}`;
      if (summaryHeadEl) {
        summaryHeadEl.textContent = headText;
      } else {
        summaryEl.textContent = headText;
      }

      if (summaryEstEl) {
        if (pageTotals && pageTotals.ok) {
          const dprTotals =
            (currentBundle && currentBundle.dprTotals) ||
            (modalDprEstId && helperCache.dprTotalsByDprEstId.get(modalDprEstId)) ||
            null;
          const liveSpecsRe = pageTotals.matchedActiveHead
            ? pageTotals.otherSpecsReAmt + totalReAmt
            : pageTotals.specsReTotal;
          const liveGrandRe = liveSpecsRe + pageTotals.extraChargesReAmt;
          const hasExtra =
            pageTotals.extraChargesReAmt > 0 ||
            Boolean(dprTotals && dprTotals.extraChargesDprAmt > 0);
          if (dprTotals && dprTotals.ok) {
            const specsImp = formatReImpactSummary(
              dprTotals.specsDprTotal,
              liveSpecsRe,
              dprTotals.specsDprTotal > 0
            );
            if (hasExtra) {
              const grandImp = formatReImpactSummary(
                dprTotals.grandDprTotal,
                liveGrandRe,
                dprTotals.grandDprTotal > 0
              );
              summaryEstEl.textContent = `Estimate Specs — ${specsImp.text} · Grand (incl. L/C) — ${grandImp.text}`;
              summaryEstEl.className = `p3h-re-summary-row p3h-re-summary-est p3h-re-impact-${grandImp.tone}`;
            } else {
              summaryEstEl.textContent = `Estimate Total — ${specsImp.text}`;
              summaryEstEl.className = `p3h-re-summary-row p3h-re-summary-est p3h-re-impact-${specsImp.tone}`;
            }
          } else {
            const grandPart =
              pageTotals.extraChargesReAmt > 0
                ? ` · Grand (incl. L/C): ₹${formatInr(liveGrandRe)}`
                : '';
            summaryEstEl.textContent = `Estimate RE: ₹${formatInr(liveSpecsRe)}${grandPart}`;
            summaryEstEl.className = 'p3h-re-summary-row p3h-re-summary-est p3h-re-impact-flat';
          }
          summaryEstEl.style.display = '';
        } else {
          summaryEstEl.textContent = '';
          summaryEstEl.style.display = 'none';
        }
      }
      if (!uiState.isRunning && deleteBtn) {
        deleteBtn.textContent =
          selectedSet.size > 0 ? `Clear Selected TBE (${selectedSet.size})` : 'Clear Selected TBE';
      }
      syncActionLockUi();
    }

    function setRowStatus(headspecid, stateKey, htmlText, titleText) {
      rowStatuses.set(headspecid, stateKey);
      const tr = tbody.querySelector(`tr[data-specid="${headspecid}"]`);
      if (!tr) return;
      tr.classList.remove(
        'p3h-re-row-active',
        'p3h-re-row-deleted',
        'p3h-re-row-skipped',
        'p3h-re-row-error',
        'p3h-re-row-checked'
      );
      if (stateKey === 'active') tr.classList.add('p3h-re-row-active');
      else if (stateKey === 'deleted') tr.classList.add('p3h-re-row-deleted');
      else if (stateKey === 'skipped') tr.classList.add('p3h-re-row-skipped');
      else if (stateKey === 'error') tr.classList.add('p3h-re-row-error');
      else if (stateKey === 'checked') tr.classList.add('p3h-re-row-checked');

      const stateEl = tr.querySelector('.p3h-re-tbe-state');
      if (stateEl) {
        const iconMap = {
          active: { txt: '⏳', cls: 'p3h-re-tbe-state p3h-re-state-active' },
          deleted: { txt: '✓', cls: 'p3h-re-tbe-state p3h-re-state-ok' },
          skipped: { txt: '⊘', cls: 'p3h-re-tbe-state p3h-re-state-skip' },
          error: { txt: '!', cls: 'p3h-re-tbe-state p3h-re-state-err' },
          checked: { txt: '•', cls: 'p3h-re-tbe-state p3h-re-state-info' },
        };
        const cfg = iconMap[stateKey] || { txt: '', cls: 'p3h-re-tbe-state' };
        stateEl.textContent = cfg.txt;
        stateEl.className = cfg.cls;
        const plainBadge = cleanSingleLine(String(htmlText || '').replace(/<[^>]+>/g, ' '));
        const tip = titleText || plainBadge;
        if (tip) stateEl.setAttribute('title', tip);
        else stateEl.removeAttribute('title');
      }
    }

    function setRowTbeInputValue(sid, qtyValue, onlyIfUnfocused) {
      const normalized =
        qtyValue === null || qtyValue === undefined || !Number.isFinite(Number(qtyValue))
          ? null
          : roundQty3(qtyValue);
      committedTbeBySpecId.set(sid, normalized);
      const tr = tbody.querySelector(`tr[data-specid="${sid}"]`);
      if (!tr) return;
      const inp = tr.querySelector('.p3h-re-tbe-input');
      if (!inp) return;
      if (onlyIfUnfocused && (document.activeElement === inp || savingRowIds.has(sid))) return;
      inp.value = formatEditableQty(normalized);
      inp.classList.remove('p3h-re-input-invalid');
    }

    function updateLocalModelAfterTbeChange(item, nextTbeQty) {
      if (!item || !item.headspecid) return;
      const sid = item.headspecid;
      const roundedTbe = roundQty3(nextTbeQty);
      const prevCommitted = committedTbeBySpecId.has(sid) ? committedTbeBySpecId.get(sid) : null;

      if (currentBundle) {
        let dev =
          currentBundle.devBySpecId.get(sid) ||
          currentBundle.devBySlAndCode.get(`${item.slNo}|${item.specCode}`) ||
          null;
        if (!dev) {
          const inferredExec =
            prevCommitted !== null
              ? roundQty3(Math.max(0, (Number(item.qty) || 0) - prevCommitted))
              : 0;
          dev = {
            slNo: item.slNo,
            headspecid: sid,
            specCode: item.specCode,
            unit: extractQtyUnit(item.qtyText),
            desc: item.desc,
            dprQty: null,
            origRate: null,
            origAmount: null,
            reExecutedQty: inferredExec,
            reTbeQty: roundedTbe,
            reTotalQty: roundQty3(inferredExec + roundedTbe),
            reRate: parseUnitRateNumber(item.rateText),
            reAmount: null,
            pctVariation: null,
          };
          currentBundle.devBySpecId.set(sid, dev);
        } else {
          const execBase = dev.reExecutedQty !== null ? dev.reExecutedQty : 0;
          dev.reTbeQty = roundedTbe;
          dev.reTotalQty = roundQty3(execBase + roundedTbe);
          if (dev.reRate !== null) {
            dev.reAmount = Math.round(dev.reTotalQty * dev.reRate * 100) / 100;
          }
        }
        helperModelBySpecId = buildReHelperRowModel(items, currentBundle).bySpecId;
      }

      const model = helperModelBySpecId.get(sid) || null;
      let newTotalQty;
      if (model && model.reTotalQty !== null && (model.reExecutedQty !== null || model.reTbeQty !== null)) {
        newTotalQty = roundQty3(model.reTotalQty);
      } else if (prevCommitted !== null) {
        newTotalQty = roundQty3(Math.max(0, (Number(item.qty) || 0) - prevCommitted) + roundedTbe);
      } else {
        newTotalQty = roundQty3(item.qty);
      }

      item.qty = newTotalQty;
      const unit = extractQtyUnit(item.qtyText);
      item.qtyText = unit ? `${newTotalQty.toFixed(1)} ${unit}` : String(newTotalQty);
      const rate = parseUnitRateNumber(item.rateText);
      if (rate !== null) {
        item.amount = Math.round(newTotalQty * rate * 100) / 100;
        item.amountText = '₹' + formatInr(item.amount);
      }

      const tr = tbody.querySelector(`tr[data-specid="${sid}"]`);
      if (tr) {
        const dprTd = tr.querySelector('.p3h-re-col-dpr');
        const mbTd = tr.querySelector('.p3h-re-col-mbook');
        const exTd = tr.querySelector('.p3h-re-col-exec');
        const amtTd = tr.querySelector('.p3h-re-col-amt');
        const devTd = tr.querySelector('.p3h-re-col-dev');
        const inp = tr.querySelector('.p3h-re-tbe-input');
        const balBtn = tr.querySelector('.p3h-re-row-bal-btn');
        if (dprTd) dprTd.innerHTML = formatModalDprCellHtml(model);
        if (mbTd) mbTd.innerHTML = formatModalMbookCellHtml(model, sid);
        if (exTd) exTd.innerHTML = formatModalExecCellHtml(model);
        if (amtTd) amtTd.innerHTML = formatModalAmtCellHtml(item);
        if (devTd) devTd.innerHTML = formatModalDevCellHtml(model, item);
        if (inp) {
          inp.classList.toggle('p3h-re-tbe-doubled', Boolean(model && model.isDoubledTbe));
          if (model && model.isDoubledTbe) {
            inp.setAttribute('title', 'Doubled: TBE equals DPR while Executed > 0');
          } else {
            inp.removeAttribute('title');
          }
        }
        if (balBtn) {
          const hasBal = Boolean(model && model.dprBalanceQty !== null);
          balBtn.title = hasBal
            ? `Set TBE to balance DPR (${formatEditableQty(model.dprBalanceQty)} = max(0, DPR − Exec))`
            : 'Load DPR & MBook to calculate DPR balance';
        }
      }

      if (currentBundle) {
        if (uiState.inlineHelpersHidden) {
          clearInlineReHelpers(document);
        } else {
          renderInlineReHelpers(document, currentBundle);
        }
      }
      syncSelectionUi();
    }

    function getInferredExecQty(item, model) {
      if (model && model.reExecutedQty !== null) return model.reExecutedQty;
      const prevCommitted =
        item && committedTbeBySpecId.has(item.headspecid)
          ? committedTbeBySpecId.get(item.headspecid)
          : null;
      if (prevCommitted !== null && item) {
        return roundQty3(Math.max(0, (Number(item.qty) || 0) - prevCommitted));
      }
      return null;
    }

    function restoreRowCommittedPreview(sid) {
      const item = itemBySpecId.get(sid);
      const model = helperModelBySpecId.get(sid) || null;
      const tr = tbody.querySelector(`tr[data-specid="${sid}"]`);
      if (!item || !tr) return;
      const amtTd = tr.querySelector('.p3h-re-col-amt');
      const devTd = tr.querySelector('.p3h-re-col-dev');
      if (amtTd) amtTd.innerHTML = formatModalAmtCellHtml(item);
      if (devTd) devTd.innerHTML = formatModalDevCellHtml(model, item);
    }

    function updateRowLivePreview(sid, previewTbeQty) {
      const item = itemBySpecId.get(sid);
      const model = helperModelBySpecId.get(sid) || null;
      const tr = tbody.querySelector(`tr[data-specid="${sid}"]`);
      if (!item || !tr) return;
      const execQty = getInferredExecQty(item, model);
      if (execQty === null) return;
      const previewTotal = roundQty3(execQty + previewTbeQty);
      const rate = parseUnitRateNumber(item.rateText);
      const previewAmt = rate !== null ? Math.round(previewTotal * rate * 100) / 100 : item.amount;
      const unit = extractQtyUnit(item.qtyText);
      const previewQtyText = unit ? `${previewTotal.toFixed(1)} ${unit}` : String(previewTotal);

      const amtTd = tr.querySelector('.p3h-re-col-amt');
      const devTd = tr.querySelector('.p3h-re-col-dev');
      if (amtTd) {
        amtTd.innerHTML = formatModalAmtCellHtml({ qtyText: previewQtyText, amount: previewAmt });
      }
      if (devTd && model) {
        const previewDev = computeQtyDeviation(model.dprQty, previewTotal);
        devTd.innerHTML = formatModalDevCellHtml(
          { ...model, reTotalQty: previewTotal },
          { ...item, qty: previewTotal },
          previewDev
        );
      }
    }

    function focusRow(headspecid) {
      rowNodes.forEach((r) => r.classList.remove('p3h-re-row-active'));
      const tr = tbody.querySelector(`tr[data-specid="${headspecid}"]`);
      if (tr) {
        tr.classList.add('p3h-re-row-active');
        if (typeof tr.scrollIntoView === 'function') {
          tr.scrollIntoView({ behavior: 'auto', block: 'nearest' });
        }
      }
    }

    function updateSyncOverlay(cfg) {
      if (!syncOverlayEl) return;
      const c = cfg || {};
      if (syncTitleEl && c.title !== undefined) syncTitleEl.textContent = c.title;
      if (syncStepEl && c.step !== undefined) syncStepEl.textContent = c.step;
      const isIndet = Boolean(c.indeterminate);
      pbar.classList.toggle('p3h-re-pbar-indeterminate', isIndet);
      if (syncBarFill) {
        syncBarFill.classList.toggle('p3h-re-pbar-indeterminate', isIndet);
        if (!isIndet && typeof c.percent === 'number') {
          const pct = Math.max(0, Math.min(100, c.percent));
          syncBarFill.style.width = `${pct}%`;
          pbar.style.width = `${pct}%`;
        } else if (isIndet) {
          syncBarFill.style.width = '100%';
          pbar.style.width = '100%';
        }
      } else if (!isIndet && typeof c.percent === 'number') {
        pbar.style.width = `${Math.max(0, Math.min(100, c.percent))}%`;
      }
    }

    function setRunningUi(running, modeLabel, opts) {
      const cfg = opts || {};
      uiState.isRunning = running;
      uiState.cancelRequested = false;
      modalEl.classList.toggle('p3h-re-processing', running);

      if (running) {
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'p3h-re-status-badge';
        statusBadge.textContent = modeLabel || 'Working...';
        pbar.style.background = '#2563eb';
        if (syncOverlayEl) syncOverlayEl.style.display = 'flex';
        updateSyncOverlay({
          title: modeLabel || 'Working...',
          step: cfg.step || 'Connecting to PRICE 3.0...',
          percent: 0,
          indeterminate: Boolean(cfg.indeterminate),
        });
        stopBtn.style.display = cfg.hideStop ? 'none' : 'inline-flex';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        retryBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        deleteBtn.style.display = 'none';
      } else {
        if (syncOverlayEl) syncOverlayEl.style.display = 'none';
        pbar.classList.remove('p3h-re-pbar-indeterminate');
        if (syncBarFill) syncBarFill.classList.remove('p3h-re-pbar-indeterminate');
        stopBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-flex';
        deleteBtn.style.display = 'inline-flex';
      }
      syncSelectionUi();
    }

    function applyHelperBundleToModal(bundle, updateSelectionFromTbe) {
      if (!bundle) return;
      currentBundle = bundle;
      if (bundle.pageTotals && bundle.pageTotals.ok) pageTotals = bundle.pageTotals;
      helperModelBySpecId = buildReHelperRowModel(items, bundle).bySpecId;
      modalHelperBtn.textContent = 'Refresh DPR & MBook';

      rowNodes.forEach((tr) => {
        const sid = tr.getAttribute('data-specid');
        const m = helperModelBySpecId.get(sid) || null;
        const it = itemBySpecId.get(sid);
        const dprTd = tr.querySelector('.p3h-re-col-dpr');
        const mbTd = tr.querySelector('.p3h-re-col-mbook');
        const exTd = tr.querySelector('.p3h-re-col-exec');
        const devTd = tr.querySelector('.p3h-re-col-dev');
        const inp = tr.querySelector('.p3h-re-tbe-input');
        const balBtn = tr.querySelector('.p3h-re-row-bal-btn');
        if (dprTd) dprTd.innerHTML = formatModalDprCellHtml(m);
        if (mbTd) mbTd.innerHTML = formatModalMbookCellHtml(m, sid);
        if (exTd) exTd.innerHTML = formatModalExecCellHtml(m);
        if (devTd) devTd.innerHTML = formatModalDevCellHtml(m, it);
        if (inp) {
          inp.classList.toggle('p3h-re-tbe-doubled', Boolean(m && m.isDoubledTbe));
          if (m && m.isDoubledTbe) {
            inp.setAttribute('title', 'Doubled: TBE equals DPR while Executed > 0');
          } else {
            inp.removeAttribute('title');
          }
        }
        if (balBtn) {
          const hasBal = Boolean(m && m.dprBalanceQty !== null);
          balBtn.title = hasBal
            ? `Set TBE to balance DPR (${formatEditableQty(m.dprBalanceQty)} = max(0, DPR − Exec))`
            : 'Load DPR & MBook to calculate DPR balance';
        }
        if (m && m.reTbeQty !== null) {
          setRowTbeInputValue(sid, m.reTbeQty, true);
        }
        syncRowSplitLockUi(sid);
        if (activeSplitSpecId === sid) {
          renderSplitUpPanel(sid);
        }

        const curStatus = rowStatuses.get(sid);
        if (
          m &&
          m.reTbeQty !== null &&
          curStatus !== 'deleted' &&
          curStatus !== 'error' &&
          curStatus !== 'checked'
        ) {
          if (m.reTbeQty <= QTY_EPS) {
            if (updateSelectionFromTbe) selectedSet.delete(sid);
            cachedIdsBySpecId.set(sid, []);
            setRowStatus(
              sid,
              'skipped',
              `<span class="p3h-re-pill-skip">⊘ TBE = 0</span>`,
              'Deviation statement reports TBE = 0'
            );
          } else {
            setRowStatus(
              sid,
              'checked',
              `<span class="p3h-re-pill-info">TBE: ${escapeHtml(formatQty(m.reTbeQty))}</span>`,
              'To Be Executed quantity from Deviation Statement'
            );
          }
        }
      });
      syncSelectionUi();
    }

    function selectVisibleByPredicate(predicate) {
      if (uiState.isRunning || savingRowIds.size > 0 || !currentBundle) return;
      getVisibleItems().forEach((it) => {
        const m = helperModelBySpecId.get(it.headspecid);
        if (m && predicate(m, it)) selectedSet.add(it.headspecid);
        else selectedSet.delete(it.headspecid);
      });
      syncSelectionUi();
    }

    function refreshHeadingSelectLabels(bgActiveLabel) {
      const workCtx = resolveReWorkContext(document, ctx);
      if (headingSelect) {
        headingSelect.innerHTML = buildHeadingOptionsHtml();
        headingSelect.value = currentHeadId;
      }
      if (bgSyncPill) {
        if (headingsList.length <= 1) {
          bgSyncPill.style.display = 'none';
        } else {
          const syncedCount = headingsList.filter((h) =>
            Boolean(
              workCtx.reEstId &&
                h.headId &&
                helperCache.byHeadingKey.has(makeHelperCacheKey(workCtx.reEstId, h.headId))
            )
          ).length;
          if (bgActiveLabel) {
            bgSyncPill.textContent = `Pre-syncing ${bgActiveLabel} (${syncedCount}/${headingsList.length})`;
            bgSyncPill.style.display = 'inline-block';
          } else if (syncedCount > 0 && syncedCount < headingsList.length) {
            bgSyncPill.textContent = `Pre-synced ${syncedCount}/${headingsList.length}`;
            bgSyncPill.style.display = 'inline-block';
          } else if (syncedCount === headingsList.length) {
            bgSyncPill.textContent = `All ${headingsList.length} headings synced`;
            bgSyncPill.style.display = 'inline-block';
          } else {
            bgSyncPill.style.display = 'none';
          }
        }
      }
      syncActionLockUi();
    }

    function canRunBackgroundPreSync() {
      if (
        !uiState.modalActive ||
        uiState.isRunning ||
        uiState.helperLoading ||
        savingRowIds.size > 0 ||
        activeSplitSpecId !== null ||
        uiState.mbookModalActive ||
        hasSessionExpired
      ) {
        return false;
      }
      if (ctx && ctx.hasMeasurementFormOpen) return false;
      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      if (activeEl && activeEl.classList && activeEl.classList.contains('p3h-re-tbe-input')) {
        return false;
      }
      return true;
    }

    async function pauseAndAwaitBackgroundSync() {
      bgAbortRequested = true;
      if (bgSyncTimer) {
        clearTimeout(bgSyncTimer);
        bgSyncTimer = null;
      }
      if (bgSyncPromise) {
        try {
          await bgSyncPromise;
        } catch (_e) {}
      }
    }

    function scheduleBackgroundHeadingPreSync(delayMs) {
      if (!uiState.modalActive || headingsList.length <= 1 || hasSessionExpired) return;
      if (bgSyncTimer) {
        clearTimeout(bgSyncTimer);
        bgSyncTimer = null;
      }
      const workCtx = resolveReWorkContext(document, ctx);
      if (!workCtx.reEstId) return;
      const nextHead = headingsList.find(
        (h) =>
          String(h.headId) !== String(currentHeadId) &&
          !helperCache.byHeadingKey.has(makeHelperCacheKey(workCtx.reEstId, h.headId))
      );
      if (!nextHead) {
        refreshHeadingSelectLabels('');
        return;
      }
      bgAbortRequested = false;
      bgSyncTimer = setTimeout(() => {
        bgSyncTimer = null;
        if (!uiState.modalActive || bgAbortRequested || hasSessionExpired) return;
        if (!canRunBackgroundPreSync()) {
          scheduleBackgroundHeadingPreSync(1500);
          return;
        }
        const liveRestoreCtx = resolveReWorkContext(document, ctx);
        if (!liveRestoreCtx.reEstId || String(liveRestoreCtx.reEstId) !== String(workCtx.reEstId)) return;
        const headLabel = nextHead.orderNo ? `#${nextHead.orderNo}` : nextHead.name;
        refreshHeadingSelectLabels(headLabel);
        bgSyncPromise = (async () => {
          try {
            const res = await fetchReHeadingHelperData({
              doc: document,
              bridgeCtx: ctx,
              contextOverride: {
                headId: nextHead.headId,
                headOrderNo: nextHead.orderNo,
                headingName: nextHead.name,
              },
              restoreCtx: liveRestoreCtx,
              forceRefresh: false,
              shouldAbort: () => bgAbortRequested || !canRunBackgroundPreSync(),
            });
            if (res && res.sessionExpired) hasSessionExpired = true;
          } finally {
            bgSyncPromise = null;
            if (uiState.modalActive) {
              refreshHeadingSelectLabels('');
              if (!bgAbortRequested && !hasSessionExpired) {
                scheduleBackgroundHeadingPreSync(600);
              }
            }
          }
        })();
      }, typeof delayMs === 'number' ? delayMs : 1100);
    }

    async function loadModalHelperData(forceRefresh, opts) {
      const cfg = opts || {};
      if (!cfg.alreadyRunning && (uiState.isRunning || savingRowIds.size > 0)) return;
      await pauseAndAwaitBackgroundSync();
      const t0 = Date.now();
      setRunningUi(true, 'Loading DPR & e-MBook...', {
        indeterminate: true,
        hideStop: true,
        step: 'Fetching deviation & e-MBook totals...',
      });

      const res = await fetchReHeadingHelperData({
        doc: document,
        bridgeCtx: ctx,
        forceRefresh: Boolean(forceRefresh),
        onStatus: (msg) => {
          statusBadge.textContent = msg;
          if (syncStepEl) syncStepEl.textContent = msg;
        },
      });

      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      pbar.style.width = '100%';
      setRunningUi(false);

      if (res.ok && res.bundle) {
        applyHelperBundleToModal(res.bundle, true);
        if (uiState.inlineHelpersHidden) {
          clearInlineReHelpers(document);
        } else {
          renderInlineReHelpers(document, res.bundle);
        }
        syncReTriggerButton();
        const doubledCnt = Array.from(helperModelBySpecId.values()).filter((m) => m.isDoubledTbe).length;
        const pendCnt = Array.from(helperModelBySpecId.values()).filter((m) => m.hasPendingAe).length;
        pbar.style.background = res.bundle.warnings.length > 0 ? '#d97706' : '#16a34a';
        statusBadge.style.display = 'inline-block';
        statusBadge.className = `p3h-re-status-badge ${
          res.bundle.warnings.length > 0 ? 'p3h-re-status-warn' : 'p3h-re-status-ok'
        }`;
        statusBadge.textContent = `Loaded (${elapsedSec}s): ${doubledCnt} doubled · ${pendCnt} AE pending`;
        refreshHeadingSelectLabels('');
        scheduleBackgroundHeadingPreSync(1100);
      } else {
        if (res.sessionExpired) hasSessionExpired = true;
        pbar.style.background = '#dc2626';
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'p3h-re-status-badge p3h-re-status-err';
        statusBadge.textContent = res.error || 'Failed to load DPR & MBook';
      }
    }

    async function switchModalHeading(targetHeadId) {
      const targetId = String(targetHeadId || '').trim();
      if (uiState.isRunning || savingRowIds.size > 0 || !targetId || targetId === String(currentHeadId)) {
        return;
      }
      if (hasAnyUnsavedSplitEdits()) {
        const ok = confirm('You have unsaved TBE split-up changes. Discard changes and switch heading?');
        if (!ok) {
          if (headingSelect) headingSelect.value = currentHeadId;
          return;
        }
      }
      if (activeSplitSpecId !== null) {
        closeSplitCard({ revertDrafts: true });
      }

      await pauseAndAwaitBackgroundSync();
      const targetMeta = headingsList.find((h) => String(h.headId) === targetId);
      const targetLabel = targetMeta ? targetMeta.label : `Heading ${targetId}`;
      setRunningUi(true, `Switching to ${targetLabel}...`, {
        indeterminate: true,
        hideStop: true,
        step: 'Loading heading items from PRICE 3.0...',
      });

      const swRes = await asyncBridgeCall('re:switchHeading', { headId: targetId }, 10000);
      const bridgeResult = swRes && swRes.result ? swRes.result : null;
      if (!swRes || !swRes.ok || !bridgeResult || bridgeResult.ok === false) {
        setRunningUi(false);
        if (headingSelect) headingSelect.value = currentHeadId;
        pbar.style.width = '100%';
        pbar.style.background = '#d97706';
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'p3h-re-status-badge p3h-re-status-warn';
        statusBadge.textContent =
          (bridgeResult && bridgeResult.error) || (swRes && swRes.error) || 'Could not switch heading';
        return;
      }

      const freshCtxRes =
        extractor && typeof extractor.syncBridgeCall === 'function'
          ? extractor.syncBridgeCall('re:getContext', {})
          : { bridged: false, ok: false };
      ctx = (freshCtxRes && freshCtxRes.ok && freshCtxRes.result) || {};
      extracted = extractReSpecItems(document);
      headingsList = extractReHeadingsList(document);
      currentHeadId = String(ctx.curHeadId || extracted.headId || targetId);

      items = extracted.items;
      itemBySpecId = new Map(items.map((it) => [it.headspecid, it]));
      activeItems = items.filter((i) => i.amount > 0 || i.qty > 0);
      zeroItemsCount = items.length - activeItems.length;
      const zeroLabel = overlay.querySelector('#p3h-re-zero-label');
      if (zeroLabel) {
        const cbInput = zeroLabel.querySelector('#p3h-re-zero-cb');
        zeroLabel.textContent = '';
        if (cbInput) zeroLabel.appendChild(cbInput);
        zeroLabel.appendChild(document.createTextNode(` Show ₹0 items (${zeroItemsCount})`));
        zeroLabel.style.display = zeroItemsCount > 0 ? '' : 'none';
      }

      selectedSet.clear();
      cachedIdsBySpecId.clear();
      committedTbeBySpecId.clear();
      tbeDetailsBySpecId.clear();
      loadingSplitSpecIds.clear();
      splitErrorsBySpecId.clear();
      dirtyHeadsBySpecId.clear();
      rowStatuses.clear();
      lastFailedItems = [];
      lastClickedIndex = null;
      activeSplitSpecId = null;
      hasDirtyPortalChanges = false;
      dirtyLastHeadId = currentHeadId;
      dirtyLastHeadSpecId = '';
      pageTotals = extractRePageTotalsFromDoc(document, currentHeadId);
      modalDprEstId = resolveReWorkContext(document, ctx).dprEstId;

      const nextCached = getActiveCachedHelperBundle(document, ctx);
      currentBundle = nextCached.bundle;
      helperModelBySpecId = currentBundle ? buildReHelperRowModel(items, currentBundle).bySpecId : new Map();

      items.forEach((it) => {
        const m = helperModelBySpecId.get(it.headspecid) || null;
        if (m && m.reTbeQty !== null) {
          committedTbeBySpecId.set(it.headspecid, roundQty3(m.reTbeQty));
        }
      });

      tbody.innerHTML = buildModalTbodyRowsHtml(items);
      rowNodes = Array.from(tbody.querySelectorAll('tr.p3h-re-row'));
      modalHelperBtn.textContent = currentBundle ? 'Refresh DPR & MBook' : 'Load DPR & MBook';

      if (currentBundle) {
        applyHelperBundleToModal(currentBundle, false);
        if (uiState.inlineHelpersHidden) {
          clearInlineReHelpers(document);
        } else {
          renderInlineReHelpers(document, currentBundle);
        }
        syncReTriggerButton();
        applyVisibilityFilter();
        setRunningUi(false);
        pbar.style.width = '100%';
        pbar.style.background = '#16a34a';
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'p3h-re-status-badge p3h-re-status-ok';
        statusBadge.textContent = `Switched to ${targetLabel} (cached)`;
        refreshHeadingSelectLabels('');
        scheduleBackgroundHeadingPreSync(900);
      } else {
        applyVisibilityFilter();
        refreshHeadingSelectLabels('');
        if (!ctx.hasMeasurementFormOpen && items.length > 0) {
          await loadModalHelperData(false, { alreadyRunning: true });
        } else {
          setRunningUi(false);
        }
      }
    }

    function refreshModalAndPageAfterMbookChange(sid) {
      if (!currentBundle) return;
      helperModelBySpecId = buildReHelperRowModel(items, currentBundle).bySpecId;
      const model = helperModelBySpecId.get(sid) || null;
      const item = itemBySpecId.get(sid);
      const tr = tbody.querySelector(`tr.p3h-re-row[data-specid="${sid}"]`);
      if (tr) {
        const mbTd = tr.querySelector('.p3h-re-col-mbook');
        if (mbTd) mbTd.innerHTML = formatModalMbookCellHtml(model, sid);
      }
      if (uiState.inlineHelpersHidden) {
        clearInlineReHelpers(document);
      } else {
        renderInlineReHelpers(document, currentBundle);
      }
      syncReTriggerButton();
      syncSelectionUi();
      if (item && model && !model.hasPendingAe) {
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'p3h-re-status-badge p3h-re-status-ok';
        statusBadge.textContent = `Updated live e-MBook for #${item.slNo || item.index + 1} (0 pending)`;
      }
    }

    function openMbookPendingModal(sid) {
      if (!sid || uiState.isRunning || savingRowIds.has(sid)) return;
      const item = itemBySpecId.get(sid);
      const model = helperModelBySpecId.get(sid) || null;
      if (!item || !model || !model.hasPendingAe) return;

      if (ctx.hasMeasurementFormOpen) {
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'p3h-re-status-badge p3h-re-status-warn';
        statusBadge.textContent =
          'Close or save the open measurement form on the page before editing live e-MBook entries.';
        return;
      }

      const existingPopup = overlay.querySelector('#p3h-re-mbook-modal-backdrop');
      if (existingPopup) existingPopup.remove();

      const backdrop = document.createElement('div');
      backdrop.id = 'p3h-re-mbook-modal-backdrop';
      backdrop.className = 'p3h-re-mbook-modal-backdrop';

      const itemUnit = extractQtyUnit(item.qtyText) || '';
      const acceptedQty = model.mbookAcceptedQty !== null ? model.mbookAcceptedQty : 0;
      const reExecQty = model.reExecutedQty !== null ? model.reExecutedQty : null;

      backdrop.innerHTML = `
        <div class="p3h-re-mbook-modal" id="p3h-re-mbook-modal" role="dialog" aria-modal="true" aria-labelledby="p3h-re-mb-title">
          <div class="p3h-re-mb-header">
            <div class="p3h-re-mb-title-wrap">
              <span class="p3h-re-mb-live-tag">LIVE e-MBOOK · PENDING WITH AE</span>
              <h4 id="p3h-re-mb-title">Edit / Delete Pending e-MBook Quantity — #${escapeHtml(
                item.slNo || String(item.index + 1)
              )} (${escapeHtml(formatCompactSpecCode(item.specCode))})</h4>
            </div>
            <button type="button" class="p3h-re-close-x" id="p3h-re-mb-close-x" title="Close e-MBook popup">×</button>
          </div>
          <div class="p3h-re-mb-warn-banner">
            <strong>⚠ Live e-MBook Modification (Not RE TBE):</strong> Changes saved or deleted here directly modify or permanently delete <strong>actual e-MBook measurement entries</strong> pending check-measurement with AE (<code>0%</code> check-measured). Revised Estimate <strong>To Be Executed (TBE)</strong> quantities are <strong>not</strong> altered.
          </div>
          <div class="p3h-re-mb-qty-strip">
            <div class="p3h-re-mb-metric"><span>AE-Accepted MBook</span><strong id="p3h-re-mb-accepted">${escapeHtml(
              formatQty(acceptedQty)
            )}</strong></div>
            <div class="p3h-re-mb-metric"><span>Pending with AE (Live)</span><strong id="p3h-re-mb-pending">${escapeHtml(
              formatQty(model.mbookPendingQty)
            )}</strong></div>
            <div class="p3h-re-mb-metric"><span>Resulting Total MBook</span><strong id="p3h-re-mb-total">${escapeHtml(
              formatQty(model.mbookTotalQty)
            )}</strong></div>
            <div class="p3h-re-mb-metric"><span>RE Executed</span><strong>${escapeHtml(
              reExecQty !== null ? formatQty(reExecQty) : '—'
            )}</strong></div>
          </div>
          <div class="p3h-re-mb-status" id="p3h-re-mb-status">Loading live pending e-MBook entries...</div>
          <div class="p3h-re-mb-body" id="p3h-re-mb-body">
            <div class="p3h-re-split-loading">Fetching pending AE Draft rows and edit form...</div>
          </div>
          <div class="p3h-re-mb-footer">
            <div class="p3h-re-mb-foot-note">Dates shown are server-managed by PRICE 3.0 (read-only).</div>
            <div class="p3h-re-mb-foot-actions">
              <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-danger" id="p3h-re-mb-del-all-btn" style="display:none;">Delete All Pending from e-MBook</button>
              <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-mb-reload-btn">↻ Reload</button>
              <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-mb-close-btn">Close</button>
            </div>
          </div>
        </div>
      `;

      overlay.appendChild(backdrop);
      uiState.mbookModalActive = true;

      const bodyEl = backdrop.querySelector('#p3h-re-mb-body');
      const mbStatusEl = backdrop.querySelector('#p3h-re-mb-status');
      const pendStatEl = backdrop.querySelector('#p3h-re-mb-pending');
      const totStatEl = backdrop.querySelector('#p3h-re-mb-total');
      const closeXEl = backdrop.querySelector('#p3h-re-mb-close-x');
      const closeBtnEl = backdrop.querySelector('#p3h-re-mb-close-btn');
      const reloadBtnEl = backdrop.querySelector('#p3h-re-mb-reload-btn');
      const delAllBtnEl = backdrop.querySelector('#p3h-re-mb-del-all-btn');

      let cardStates = [];
      let isPopupBusy = false;

      function hasUnsavedPopupEdits() {
        return cardStates.some((c) => c.dirty);
      }

      function closeMbookPopup(force) {
        if (isPopupBusy || savingRowIds.has(sid)) return;
        if (
          !force &&
          hasUnsavedPopupEdits() &&
          !confirm('Discard unsaved live e-MBook draft edits and close?')
        ) {
          return;
        }
        backdrop.remove();
        uiState.mbookModalActive = false;
        uiState.closeMbookModalHook = null;
      }

      uiState.closeMbookModalHook = closeMbookPopup;

      function setPopupStatus(text, tone) {
        mbStatusEl.textContent = text || '';
        mbStatusEl.className = 'p3h-re-mb-status' + (tone ? ' p3h-re-mb-status-' + tone : '');
      }

      function computeCardStateSummary(card) {
        const calcs = (card.draftRows || []).map((r) => validateAndComputeMbookRow(r));
        let subtotal = 0;
        let hasInvalid = false;
        let firstError = '';
        for (let i = 0; i < calcs.length; i++) {
          const c = calcs[i];
          if (c.kind === 'valid') {
            subtotal = roundQty3(subtotal + c.qty);
          } else {
            hasInvalid = true;
            if (!firstError) firstError = `Row ${i + 1}: ${c.error}`;
          }
        }
        return { calcs, subtotal, hasInvalid, firstError };
      }

      function updatePopupMetrics() {
        let totalPend = 0;
        cardStates.forEach((c) => {
          totalPend = roundQty(totalPend + computeCardStateSummary(c).subtotal);
        });
        const curModel = helperModelBySpecId.get(sid) || model;
        const curAccepted =
          curModel && curModel.mbookAcceptedQty !== null ? curModel.mbookAcceptedQty : acceptedQty;
        pendStatEl.textContent = formatQty(totalPend);
        totStatEl.textContent = formatQty(roundQty(curAccepted + totalPend));
      }

      function syncPopupBusyUi() {
        const disabled = isPopupBusy || savingRowIds.has(sid);
        closeXEl.disabled = disabled;
        closeBtnEl.disabled = disabled;
        reloadBtnEl.disabled = disabled;
        delAllBtnEl.disabled = disabled;
        bodyEl.querySelectorAll('input, button').forEach((el) => {
          if (disabled) {
            el.disabled = true;
          } else if (el.classList.contains('p3h-re-mb-save-btn')) {
            const cIdx = parseInt(el.getAttribute('data-cardidx'), 10);
            const card = cardStates[cIdx];
            const sum = card ? computeCardStateSummary(card) : { hasInvalid: true };
            el.disabled = !card || !card.dirty || sum.hasInvalid;
          } else if (el.classList.contains('p3h-re-mb-reset-btn')) {
            const cIdx = parseInt(el.getAttribute('data-cardidx'), 10);
            const card = cardStates[cIdx];
            el.disabled = !card || !card.dirty;
          } else {
            el.disabled = false;
          }
        });
      }

      function updateCardLiveDom(cIdx) {
        const card = cardStates[cIdx];
        const cardEl = bodyEl.querySelector(`.p3h-re-mb-entry-card[data-cardidx="${cIdx}"]`);
        if (!card || !cardEl) return;
        const sum = computeCardStateSummary(card);
        cardEl.classList.toggle('p3h-re-head-dirty', Boolean(card.dirty));
        const dirtyTag = cardEl.querySelector('.p3h-re-head-dirty-tag');
        if (dirtyTag) dirtyTag.style.display = card.dirty ? '' : 'none';
        const subEl = cardEl.querySelector('.p3h-re-mb-card-subtotal');
        if (subEl) subEl.textContent = sum.subtotal.toFixed(3);
        const errEl = cardEl.querySelector('.p3h-re-head-err');
        if (errEl) errEl.textContent = sum.firstError || '';
        const saveBtn = cardEl.querySelector('.p3h-re-mb-save-btn');
        if (saveBtn) saveBtn.disabled = isPopupBusy || !card.dirty || sum.hasInvalid;
        const resetBtn = cardEl.querySelector('.p3h-re-mb-reset-btn');
        if (resetBtn) resetBtn.disabled = isPopupBusy || !card.dirty;

        const rowTrs = Array.from(cardEl.querySelectorAll('tr.p3h-re-mb-dim-row'));
        rowTrs.forEach((rTr, rIdx) => {
          const calc = sum.calcs[rIdx];
          if (!calc) return;
          rTr.classList.toggle('p3h-re-dim-deduction', calc.kind === 'valid' && calc.isDeduction);
          const qtyTd = rTr.querySelector('.p3h-re-dim-qty');
          if (qtyTd) {
            qtyTd.classList.toggle('p3h-re-dim-qty-invalid', calc.kind !== 'valid');
            qtyTd.textContent = calc.kind === 'valid' ? calc.qty.toFixed(3) : '!';
            qtyTd.title = calc.kind !== 'valid' ? calc.error : '';
          }
          ['no', 'length', 'breadth', 'depth'].forEach((fname) => {
            const inp = rTr.querySelector(`input[data-field="${fname}"]`);
            if (inp) {
              inp.classList.toggle('p3h-re-dim-invalid', calc.kind === 'invalid' && calc.field === fname);
            }
          });
        });

        updatePopupMetrics();
      }

      function renderCards() {
        const totalRowsAcrossCards = cardStates.reduce(
          (acc, c) => acc + (Array.isArray(c.draftRows) ? c.draftRows.length : 0),
          0
        );
        delAllBtnEl.style.display = totalRowsAcrossCards > 0 ? 'inline-flex' : 'none';

        if (cardStates.length === 0) {
          bodyEl.innerHTML = `<div class="p3h-re-split-empty">No live e-MBook entries pending with AE for this specification item.</div>`;
          updatePopupMetrics();
          syncPopupBusyUi();
          return;
        }

        bodyEl.innerHTML = cardStates
          .map((card, cIdx) => {
            const mgnLabel = card.entry.mgn ? `MGN: ${card.entry.mgn}` : `Entry #${card.entry.entryHeadId || cIdx + 1}`;
            const dateLabel = card.entry.entryDate || 'Server date';
            const unitLabel = card.entry.unit || itemUnit || '';

            if (card.loadError || !card.editMeta) {
              const canFallbackDelete =
                card.expectedIds.length > 0 &&
                card.entry.details &&
                card.entry.details.canDelete;
              return `<div class="p3h-re-mb-entry-card" data-cardidx="${cIdx}">
                <div class="p3h-re-mb-card-head">
                  <div class="p3h-re-head-title-group">
                    <span class="p3h-re-mb-mgn">${escapeHtml(mgnLabel)}</span>
                    <span class="p3h-re-mb-date" title="Date maintained server-side by PRICE 3.0">${escapeHtml(dateLabel)}</span>
                  </div>
                  <div class="p3h-re-head-ctrl-group">
                    <span><strong>${escapeHtml(formatQty(card.entry.qty))}</strong> ${escapeHtml(unitLabel)}</span>
                    ${
                      canFallbackDelete
                        ? `<button type="button" class="p3h-btn p3h-btn-sm p3h-btn-danger p3h-re-mb-del-entry-btn" data-cardidx="${cIdx}">Delete Entry from e-MBook</button>`
                        : ''
                    }
                  </div>
                </div>
                <div class="p3h-re-split-empty p3h-re-split-error">${escapeHtml(
                  card.loadError || 'Unable to load edit form for this entry.'
                )}</div>
              </div>`;
            }

            const sum = computeCardStateSummary(card);
            const rowsHtml = card.draftRows
              .map((r, rIdx) => {
                const calc = sum.calcs[rIdx];
                const isInv = calc.kind !== 'valid';
                const invField = isInv ? calc.field : '';
                const isDed = calc.kind === 'valid' && calc.isDeduction;
                const qtyDisplay = calc.kind === 'valid' ? calc.qty.toFixed(3) : '!';
                return `
                  <tr class="p3h-re-mb-dim-row${isDed ? ' p3h-re-dim-deduction' : ''}" data-rowidx="${rIdx}">
                    <td class="p3h-re-dim-idx">${rIdx + 1}</td>
                    <td><input type="text" class="p3h-re-dim-input p3h-re-mb-input" data-cardidx="${cIdx}" data-rowidx="${rIdx}" data-field="desc" value="${escapeHtml(
                  r.desc
                )}" placeholder="Description"></td>
                    <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num p3h-re-mb-input${
                      invField === 'no' ? ' p3h-re-dim-invalid' : ''
                    }" data-cardidx="${cIdx}" data-rowidx="${rIdx}" data-field="no" value="${escapeHtml(
                  r.no
                )}" placeholder="No"></td>
                    <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num p3h-re-mb-input${
                      invField === 'length' ? ' p3h-re-dim-invalid' : ''
                    }" data-cardidx="${cIdx}" data-rowidx="${rIdx}" data-field="length" value="${escapeHtml(
                  r.length
                )}" placeholder="—"></td>
                    <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num p3h-re-mb-input${
                      invField === 'breadth' ? ' p3h-re-dim-invalid' : ''
                    }" data-cardidx="${cIdx}" data-rowidx="${rIdx}" data-field="breadth" value="${escapeHtml(
                  r.breadth
                )}" placeholder="—"></td>
                    <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num p3h-re-mb-input${
                      invField === 'depth' ? ' p3h-re-dim-invalid' : ''
                    }" data-cardidx="${cIdx}" data-rowidx="${rIdx}" data-field="depth" value="${escapeHtml(
                  r.depth
                )}" placeholder="—"></td>
                    <td class="p3h-re-mb-cf" title="${escapeHtml(
                      r.combobxId ? `Coeff ID: ${r.combobxId}` : 'No coefficient'
                    )}">${escapeHtml(r.combobx || '—')}</td>
                    <td class="p3h-re-dim-qty${isInv ? ' p3h-re-dim-qty-invalid' : ''}" title="${escapeHtml(
                  isInv ? calc.error : ''
                )}">${escapeHtml(qtyDisplay)}</td>
                    <td style="text-align:center;">
                      <button type="button" class="p3h-re-dim-icon-btn p3h-re-del-row-btn p3h-re-mb-del-row-btn" data-cardidx="${cIdx}" data-rowidx="${rIdx}" title="Delete this row from LIVE e-MBook">×</button>
                    </td>
                  </tr>`;
              })
              .join('');

            return `
              <div class="p3h-re-mb-entry-card${card.dirty ? ' p3h-re-head-dirty' : ''}" data-cardidx="${cIdx}">
                <div class="p3h-re-mb-card-head">
                  <div class="p3h-re-head-title-group">
                    <span class="p3h-re-mb-mgn">${escapeHtml(mgnLabel)}</span>
                    <span class="p3h-re-mb-date" title="Measurement date is generated/maintained server-side by PRICE 3.0">📅 ${escapeHtml(
                      dateLabel
                    )}</span>
                    <span class="p3h-re-head-dirty-tag" style="${card.dirty ? '' : 'display:none;'}">Unsaved</span>
                  </div>
                  <div class="p3h-re-head-ctrl-group">
                    <span class="p3h-re-head-subtotal-wrap">Entry Qty: <strong class="p3h-re-mb-card-subtotal">${escapeHtml(
                      sum.subtotal.toFixed(3)
                    )}</strong> ${escapeHtml(unitLabel)}</span>
                    <button type="button" class="p3h-btn p3h-btn-sm p3h-re-mb-reset-btn" data-cardidx="${cIdx}"${
              card.dirty ? '' : ' disabled'
            }>Reset</button>
                    <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-danger p3h-re-mb-del-entry-btn" data-cardidx="${cIdx}">Delete Entry from e-MBook</button>
                    <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-primary p3h-re-mb-save-btn" data-cardidx="${cIdx}"${
              !card.dirty || sum.hasInvalid ? ' disabled' : ''
            }>Save to e-MBook</button>
                  </div>
                </div>
                <table class="p3h-re-dim-table">
                  <thead>
                    <tr>
                      <th width="30" style="text-align:center;">#</th>
                      <th>Measurement Description</th>
                      <th width="78" style="text-align:right;">No</th>
                      <th width="76" style="text-align:right;">L</th>
                      <th width="76" style="text-align:right;">B</th>
                      <th width="76" style="text-align:right;">H</th>
                      <th width="56" style="text-align:right;">Cf</th>
                      <th width="86" style="text-align:right;">Qty</th>
                      <th width="42" style="text-align:center;">Del</th>
                    </tr>
                  </thead>
                  <tbody>${rowsHtml}</tbody>
                </table>
                <div class="p3h-re-head-card-foot">
                  <span class="p3h-re-mb-foot-hint">Plain numbers only in e-MBook (no formulas).</span>
                  <span class="p3h-re-head-err">${escapeHtml(sum.firstError || '')}</span>
                </div>
              </div>`;
          })
          .join('');

        updatePopupMetrics();
        syncPopupBusyUi();
      }

      async function reloadPopupEntries() {
        isPopupBusy = true;
        savingRowIds.add(sid);
        syncActionLockUi();
        syncPopupBusyUi();
        setPopupStatus('Loading live pending e-MBook entries...', 'info');

        rowMutationChain = rowMutationChain
          .then(async () => {
            const entriesMap =
              currentBundle && currentBundle.mbookPendingEntriesBySpecId instanceof Map
                ? currentBundle.mbookPendingEntriesBySpecId
                : null;
            const initialEntries = entriesMap && entriesMap.has(sid) ? entriesMap.get(sid) : [];
            const res = await loadMbookPendingEntries({
              specId: sid,
              entries: initialEntries,
              ctx,
              doc: document,
              onStatus: (msg) => setPopupStatus(msg, 'info'),
            });

            if (res.ok) {
              cardStates = (res.entries || []).map((entryObj) => {
                const baseRows =
                  entryObj.editMeta && Array.isArray(entryObj.editMeta.rows)
                    ? entryObj.editMeta.rows.map((r) => ({ ...r }))
                    : [];
                const fallbackRows =
                  entryObj.details && Array.isArray(entryObj.details.rows)
                    ? entryObj.details.rows
                    : [];
                return {
                  entry: entryObj,
                  editMeta: entryObj.editMeta,
                  loadError: entryObj.loadError || '',
                  originalRows: baseRows.map((r) => ({ ...r })),
                  draftRows: baseRows.map((r) => ({ ...r })),
                  expectedIds: (baseRows.length > 0 ? baseRows : fallbackRows).map((r) =>
                    String(r.measurementId)
                  ),
                  dirty: false,
                };
              });
              renderCards();
              setPopupStatus(
                cardStates.length > 0
                  ? `Loaded ${cardStates.length} live pending e-MBook entry(s).`
                  : 'No live pending e-MBook entries remain.',
                'ok'
              );
            } else {
              if (res.sessionExpired) hasSessionExpired = true;
              bodyEl.innerHTML = `<div class="p3h-re-split-empty p3h-re-split-error">${escapeHtml(
                res.error || 'Failed to load pending e-MBook entries'
              )}</div>`;
              setPopupStatus(res.error || 'Failed to load pending e-MBook entries', 'err');
            }
          })
          .catch((err) => {
            const msg = (err && err.message) || 'Failed to load pending e-MBook entries';
            bodyEl.innerHTML = `<div class="p3h-re-split-empty p3h-re-split-error">${escapeHtml(msg)}</div>`;
            setPopupStatus(msg, 'err');
          })
          .finally(() => {
            isPopupBusy = false;
            savingRowIds.delete(sid);
            syncActionLockUi();
            syncPopupBusyUi();
          });

        return rowMutationChain;
      }

      async function handleSaveCard(cIdx) {
        const card = cardStates[cIdx];
        if (!card || !card.editMeta || isPopupBusy || savingRowIds.has(sid)) return;
        const sum = computeCardStateSummary(card);
        if (sum.hasInvalid) {
          updateCardLiveDom(cIdx);
          return;
        }
        const mgnName = card.entry.mgn || `#${card.entry.entryHeadId}`;
        const unitLabel = card.entry.unit || itemUnit || '';
        const oldQty = Number(card.entry.qty || 0).toFixed(3);
        const newQty = sum.subtotal.toFixed(3);
        if (
          !confirm(
            `Save changes to LIVE e-MBook entry ${mgnName} (pending with AE)?\n\nEntry Qty: ${oldQty} → ${newQty}${
              unitLabel ? ' ' + unitLabel : ''
            }\nNote: This modifies actual e-MBook records, not RE TBE.`
          )
        ) {
          return;
        }

        isPopupBusy = true;
        savingRowIds.add(sid);
        syncActionLockUi();
        syncPopupBusyUi();
        setPopupStatus(`Saving ${mgnName} to live e-MBook...`, 'info');

        let shouldReload = false;
        await (rowMutationChain = rowMutationChain
          .then(async () => {
            const res = await saveMbookPendingEntry({
              specId: sid,
              entry: card.entry,
              rows: card.draftRows,
              expectedMeasurementIds: card.expectedIds,
              ctx,
              doc: document,
              onStatus: (msg) => setPopupStatus(msg, 'info'),
            });

            if (res.ok) {
              refreshModalAndPageAfterMbookChange(sid);
              setPopupStatus(res.message || 'Saved changes to live e-MBook.', 'ok');
              shouldReload = true;
            } else {
              if (res.sessionExpired) hasSessionExpired = true;
              setPopupStatus(res.error || 'Failed to save e-MBook entry', 'err');
            }
          })
          .catch((err) => {
            setPopupStatus((err && err.message) || 'Failed to save e-MBook entry', 'err');
          })
          .finally(() => {
            isPopupBusy = false;
            savingRowIds.delete(sid);
            syncActionLockUi();
            syncPopupBusyUi();
          }));

        if (shouldReload) {
          const nextModel = helperModelBySpecId.get(sid) || null;
          if (!nextModel || !nextModel.hasPendingAe) {
            closeMbookPopup(true);
          } else {
            await reloadPopupEntries();
          }
        }
      }

      async function handleDeleteRows(entry, measurementIds, label) {
        if (!entry || !measurementIds.length || isPopupBusy || savingRowIds.has(sid)) return;
        if (
          !confirm(
            `Permanently delete ${measurementIds.length} measurement row(s) from LIVE e-MBook (${label}) pending with AE?\n\nThis deletes actual e-MBook Draft measurements and cannot be undone.`
          )
        ) {
          return;
        }

        isPopupBusy = true;
        savingRowIds.add(sid);
        syncActionLockUi();
        syncPopupBusyUi();
        setPopupStatus(`Deleting ${measurementIds.length} row(s) from live e-MBook...`, 'info');

        let shouldReload = false;
        await (rowMutationChain = rowMutationChain
          .then(async () => {
            const res = await deleteMbookPendingRows({
              specId: sid,
              entry,
              measurementIds,
              ctx,
              doc: document,
              onStatus: (msg) => setPopupStatus(msg, 'info'),
            });
            if (res.ok) {
              refreshModalAndPageAfterMbookChange(sid);
              setPopupStatus(res.message || 'Deleted from live e-MBook.', 'ok');
              shouldReload = true;
            } else {
              if (res.sessionExpired) hasSessionExpired = true;
              setPopupStatus(res.error || 'Failed to delete e-MBook row(s)', 'err');
            }
          })
          .catch((err) => {
            setPopupStatus((err && err.message) || 'Failed to delete e-MBook row(s)', 'err');
          })
          .finally(() => {
            isPopupBusy = false;
            savingRowIds.delete(sid);
            syncActionLockUi();
            syncPopupBusyUi();
          }));

        if (shouldReload) {
          const nextModel = helperModelBySpecId.get(sid) || null;
          if (!nextModel || !nextModel.hasPendingAe) {
            closeMbookPopup(true);
          } else {
            await reloadPopupEntries();
          }
        }
      }

      async function handleDeleteAllPending() {
        const validCards = cardStates.filter((c) => c.expectedIds && c.expectedIds.length > 0);
        if (validCards.length === 0 || isPopupBusy || savingRowIds.has(sid)) return;
        const totalRowCount = validCards.reduce((acc, c) => acc + c.expectedIds.length, 0);
        if (
          !confirm(
            `Permanently delete ALL ${totalRowCount} pending measurement row(s) across ${validCards.length} entry(s) from LIVE e-MBook?\n\nThis deletes actual e-MBook Draft measurements and cannot be undone.`
          )
        ) {
          return;
        }

        isPopupBusy = true;
        savingRowIds.add(sid);
        syncActionLockUi();
        syncPopupBusyUi();
        setPopupStatus(`Deleting all ${totalRowCount} pending row(s) from live e-MBook...`, 'info');

        let failedErr = '';
        await (rowMutationChain = rowMutationChain
          .then(async () => {
            for (let i = 0; i < validCards.length; i++) {
              const c = validCards[i];
              const res = await deleteMbookPendingRows({
                specId: sid,
                entry: c.entry,
                measurementIds: c.expectedIds,
                ctx,
                doc: document,
                onStatus: (msg) => setPopupStatus(msg, 'info'),
              });
              if (!res.ok) {
                if (res.sessionExpired) hasSessionExpired = true;
                failedErr = res.error || 'Failed to delete e-MBook entry';
                break;
              }
            }
            refreshModalAndPageAfterMbookChange(sid);
          })
          .catch((err) => {
            failedErr = (err && err.message) || 'Failed to delete e-MBook entries';
          })
          .finally(() => {
            isPopupBusy = false;
            savingRowIds.delete(sid);
            syncActionLockUi();
            syncPopupBusyUi();
          }));

        if (failedErr) {
          setPopupStatus(failedErr, 'err');
          await reloadPopupEntries();
        } else {
          const nextModel = helperModelBySpecId.get(sid) || null;
          if (!nextModel || !nextModel.hasPendingAe) {
            closeMbookPopup(true);
          } else {
            await reloadPopupEntries();
          }
        }
      }

      closeXEl.addEventListener('click', () => closeMbookPopup(false));
      closeBtnEl.addEventListener('click', () => closeMbookPopup(false));
      reloadBtnEl.addEventListener('click', () => reloadPopupEntries());
      delAllBtnEl.addEventListener('click', () => handleDeleteAllPending());
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeMbookPopup(false);
      });

      bodyEl.addEventListener('input', (e) => {
        const inp = e.target && e.target.closest ? e.target.closest('.p3h-re-mb-input') : null;
        if (!inp) return;
        const cIdx = parseInt(inp.getAttribute('data-cardidx'), 10);
        const rIdx = parseInt(inp.getAttribute('data-rowidx'), 10);
        const field = inp.getAttribute('data-field') || '';
        const card = cardStates[cIdx];
        if (!card || !card.draftRows[rIdx] || !field) return;
        card.draftRows[rIdx][field] = inp.value;
        card.dirty = true;
        updateCardLiveDom(cIdx);
      });

      bodyEl.addEventListener('click', (e) => {
        const resetBtn = e.target && e.target.closest ? e.target.closest('.p3h-re-mb-reset-btn') : null;
        if (resetBtn) {
          const cIdx = parseInt(resetBtn.getAttribute('data-cardidx'), 10);
          const card = cardStates[cIdx];
          if (!card || isPopupBusy) return;
          card.draftRows = card.originalRows.map((r) => ({ ...r }));
          card.dirty = false;
          renderCards();
          return;
        }

        const saveBtn = e.target && e.target.closest ? e.target.closest('.p3h-re-mb-save-btn') : null;
        if (saveBtn) {
          const cIdx = parseInt(saveBtn.getAttribute('data-cardidx'), 10);
          handleSaveCard(cIdx);
          return;
        }

        const delEntryBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-mb-del-entry-btn') : null;
        if (delEntryBtn) {
          const cIdx = parseInt(delEntryBtn.getAttribute('data-cardidx'), 10);
          const card = cardStates[cIdx];
          if (!card) return;
          const mgnLabel = card.entry.mgn ? `MGN ${card.entry.mgn}` : `Entry #${card.entry.entryHeadId}`;
          handleDeleteRows(card.entry, card.expectedIds, mgnLabel);
          return;
        }

        const delRowBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-mb-del-row-btn') : null;
        if (delRowBtn) {
          const cIdx = parseInt(delRowBtn.getAttribute('data-cardidx'), 10);
          const rIdx = parseInt(delRowBtn.getAttribute('data-rowidx'), 10);
          const card = cardStates[cIdx];
          if (!card || !card.expectedIds[rIdx]) return;
          const mgnLabel = card.entry.mgn ? `MGN ${card.entry.mgn}` : `Entry #${card.entry.entryHeadId}`;
          handleDeleteRows(card.entry, [card.expectedIds[rIdx]], `${mgnLabel}, row ${rIdx + 1}`);
        }
      });

      reloadPopupEntries();
    }

    function createBlankDraftRow() {
      return {
        itemDesc: '',
        itemN: '',
        itemLength: '',
        itemBreadth: '',
        itemDepth: '',
        itemCf: '',
      };
    }

    function cloneHeadToDraft(h) {
      const rawRows = Array.isArray(h && h.rows) ? h.rows : [];
      return {
        key: String(h.id),
        isNew: false,
        id: String(h.id),
        mgn: h.mgn || '',
        itemHeadOrder: h.itemHeadOrder || '',
        headDesc: h.headDesc || '1',
        rows:
          rawRows.length > 0
            ? rawRows.map((r) => ({
                itemDesc: r.itemDesc || '',
                itemN: r.itemN || '',
                itemLength: r.itemLength || '',
                itemBreadth: r.itemBreadth || '',
                itemDepth: r.itemDepth || '',
                itemCf: r.itemCf || '',
              }))
            : [createBlankDraftRow()],
        dirty: false,
      };
    }

    function syncDraftMapFromDetails(sid, details, savedDraftKey) {
      const existing = dirtyHeadsBySpecId.get(sid);
      const next = new Map();
      const headList = (details && Array.isArray(details.headDetails) ? details.headDetails : []) || [];
      const preservedDirty = new Map();
      if (existing && savedDraftKey !== '*') {
        existing.forEach((d, k) => {
          if (k === savedDraftKey) return;
          if (d && d.dirty) preservedDirty.set(k, d);
        });
      }
      headList.forEach((h) => {
        const hid = String(h.id);
        if (preservedDirty.has(hid)) {
          next.set(hid, preservedDirty.get(hid));
          preservedDirty.delete(hid);
        } else {
          next.set(hid, cloneHeadToDraft(h));
        }
      });
      preservedDirty.forEach((d, k) => {
        if (d.isNew) next.set(k, d);
      });
      dirtyHeadsBySpecId.set(sid, next);
      return next;
    }

    function getOrInitDraftMap(sid) {
      if (dirtyHeadsBySpecId.has(sid)) {
        return dirtyHeadsBySpecId.get(sid);
      }
      const details = tbeDetailsBySpecId.get(sid) || null;
      return syncDraftMapFromDetails(sid, details);
    }

    function hasAnyUnsavedSplitEdits() {
      let dirty = false;
      dirtyHeadsBySpecId.forEach((headMap) => {
        if (!headMap) return;
        headMap.forEach((d) => {
          if (d && d.dirty) dirty = true;
        });
      });
      return dirty;
    }

    function computeDraftHeadSummary(draft) {
      const rows = Array.isArray(draft && draft.rows) ? draft.rows : [];
      const rowResults = [];
      let sum = 0;
      let activeCount = 0;
      let firstError = '';
      let firstInvalidIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const calc = computeMeasurementRowQty(rows[i]);
        rowResults.push(calc);
        if (calc.kind === 'valid') {
          sum += calc.qty;
          activeCount++;
        } else if (calc.kind === 'invalid' && !firstError) {
          firstError = `Row ${i + 1}: ${calc.error}`;
          firstInvalidIndex = i;
        }
      }
      if (activeCount === 0 && !firstError) {
        firstError = 'Add at least one measurement row';
      }
      return {
        rowResults,
        subtotal: roundQty3(sum),
        activeCount,
        hasInvalid: Boolean(firstError),
        firstError,
        firstInvalidIndex,
      };
    }

    function computeSpecSplitTotal(sid) {
      const headMap = getOrInitDraftMap(sid);
      let sum = 0;
      let hasInvalid = false;
      headMap.forEach((d) => {
        const s = computeDraftHeadSummary(d);
        sum += s.subtotal;
        if (s.hasInvalid) hasInvalid = true;
      });
      return { total: roundQty3(sum), hasInvalid };
    }

    function syncRowSplitLockUi(sid) {
      const tr = tbody.querySelector(`tr.p3h-re-row[data-specid="${sid}"]`);
      if (!tr) return;
      const details = tbeDetailsBySpecId.get(sid) || null;
      const hasDetailed = Boolean(details && details.hasDetailed);
      const inp = tr.querySelector('.p3h-re-tbe-input');
      const balBtn = tr.querySelector('.p3h-re-row-bal-btn');
      const m = helperModelBySpecId.get(sid) || null;

      if (inp) {
        inp.readOnly = hasDetailed;
        inp.classList.toggle('p3h-re-tbe-locked', hasDetailed);
        if (hasDetailed) {
          inp.setAttribute('title', 'Existing TBE split-up data — click to view or edit');
        } else if (m && m.isDoubledTbe) {
          inp.setAttribute('title', 'Doubled: TBE equals DPR while Executed > 0');
        } else {
          inp.removeAttribute('title');
        }
      }

      if (balBtn) {
        const rowLocked = uiState.isRunning || savingRowIds.has(sid);
        balBtn.disabled = rowLocked || hasDetailed || !(m && m.dprBalanceQty !== null);
        if (hasDetailed) {
          balBtn.title = 'Disabled: detailed split-ups exist — click TBE field to edit';
        } else {
          const hasBal = Boolean(m && m.dprBalanceQty !== null);
          balBtn.title = hasBal
            ? `Set TBE to balance DPR (${formatEditableQty(m.dprBalanceQty)} = max(0, DPR − Exec))`
            : 'Load DPR & MBook to calculate DPR balance';
        }
      }
    }

    function renderSplitUpPanel(sid) {
      if (!splitCardEl) return;
      const item = itemBySpecId.get(sid);
      const model = helperModelBySpecId.get(sid) || null;
      const unit = extractQtyUnit(item ? item.qtyText : '');
      const sidEsc = escapeHtml(sid);

      if (loadingSplitSpecIds.has(sid) && !tbeDetailsBySpecId.has(sid)) {
        splitCardEl.innerHTML = `
          <div class="p3h-re-split-card-head">
            <div class="p3h-re-split-meta">
              <strong id="p3h-re-split-card-title">Split-Up — #${escapeHtml((item && item.slNo) || '')} (${escapeHtml(
          formatCompactSpecCode(item ? item.specCode : '')
        )})</strong>
            </div>
          </div>
          <div class="p3h-re-split-card-body">
            <div class="p3h-re-split-loading"><span>Loading To-Be-Executed sub-headings &amp; dimensions...</span></div>
          </div>
          <div class="p3h-re-split-card-footer">
            <span class="p3h-re-split-card-hint">Fetching split-up measurements...</span>
            <div class="p3h-re-split-card-btns">
              <button type="button" class="p3h-btn p3h-btn-sm p3h-re-split-cancel-btn" data-specid="${sidEsc}">Cancel</button>
            </div>
          </div>`;
        syncActionLockUi();
        return;
      }

      const loadErr = splitErrorsBySpecId.get(sid) || '';
      if (loadErr && !tbeDetailsBySpecId.has(sid)) {
        splitCardEl.innerHTML = `
          <div class="p3h-re-split-card-head">
            <div class="p3h-re-split-meta">
              <strong id="p3h-re-split-card-title">Split-Up — #${escapeHtml((item && item.slNo) || '')} (${escapeHtml(
          formatCompactSpecCode(item ? item.specCode : '')
        )})</strong>
            </div>
          </div>
          <div class="p3h-re-split-card-body">
            <div class="p3h-re-split-empty p3h-re-split-error">
              <span>${escapeHtml(loadErr)}</span>
              <button type="button" class="p3h-btn p3h-btn-sm p3h-re-refresh-split-btn" data-specid="${sidEsc}">Retry</button>
            </div>
          </div>
          <div class="p3h-re-split-card-footer">
            <span class="p3h-re-split-card-hint"></span>
            <div class="p3h-re-split-card-btns">
              <button type="button" class="p3h-btn p3h-btn-sm p3h-re-split-cancel-btn" data-specid="${sidEsc}">Cancel</button>
            </div>
          </div>`;
        syncActionLockUi();
        return;
      }

      const headMap = getOrInitDraftMap(sid);
      const drafts = Array.from(headMap.values());
      const specSummary = computeSpecSplitTotal(sid);
      const dprQty = model && model.dprQty !== null ? model.dprQty : null;
      const execQty = getInferredExecQty(item, model);
      const balToDpr =
        dprQty !== null && execQty !== null
          ? roundQty3(dprQty - execQty - specSummary.total)
          : null;

      const metricsParts = [];
      if (dprQty !== null) metricsParts.push(`<span>DPR: <strong>${escapeHtml(formatQty(dprQty))}</strong></span>`);
      if (execQty !== null) metricsParts.push(`<span>Exec: <strong>${escapeHtml(formatQty(execQty))}</strong></span>`);
      metricsParts.push(
        `<span>TBE Sum: <strong data-split-sum="${sidEsc}">${escapeHtml(
          formatQty(specSummary.total)
        )}</strong></span>`
      );
      if (balToDpr !== null) {
        metricsParts.push(
          `<span>Bal: <strong data-split-bal="${sidEsc}">${escapeHtml(
            formatQty(balToDpr)
          )}</strong></span>`
        );
      }

      const dirtyCount = drafts.filter((d) => d && (d.dirty || d.isNew)).length;
      const anyInvalid = drafts.some((d) => d && (d.dirty || d.isNew) && computeDraftHeadSummary(d).hasInvalid);
      const rowLocked = uiState.isRunning || savingRowIds.has(sid);

      const cardsHtml =
        drafts.length === 0
          ? `<div class="p3h-re-split-empty">
              <span>No To-Be-Executed measurement sub-headings recorded for this item.</span>
              <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-primary p3h-re-add-head-btn" data-specid="${sidEsc}">+ Add Sub-heading</button>
            </div>`
          : drafts
              .map((draft) => {
                const keyEsc = escapeHtml(draft.key);
                const summary = computeDraftHeadSummary(draft);
                const mgnText = draft.isNew ? 'NEW' : draft.mgn || 'HEAD';
                const rowsHtml = draft.rows
                  .map((r, rIdx) => {
                    const calc = summary.rowResults[rIdx] || { kind: 'blank', qty: null };
                    const isDed = calc.kind === 'valid' && calc.isDeduction;
                    const isInv = calc.kind === 'invalid';
                    const invField = isInv ? calc.field : '';
                    const qtyDisplay =
                      calc.kind === 'valid'
                        ? calc.qty.toFixed(3)
                        : calc.kind === 'invalid'
                        ? '!'
                        : '—';
                    const qtyTitle =
                      calc.kind === 'invalid'
                        ? calc.error
                        : calc.kind === 'valid' && calc.isFormulaN
                        ? `Formula evaluated: ${calc.evaluated.n} -> ${calc.qty.toFixed(3)}`
                        : '';
                    return `
                      <tr class="p3h-re-dim-row${isDed ? ' p3h-re-dim-deduction' : ''}" data-rowidx="${rIdx}">
                        <td class="p3h-re-dim-idx">${rIdx + 1}</td>
                        <td><input type="text" class="p3h-re-dim-input" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" data-field="itemDesc" value="${escapeHtml(
                      r.itemDesc
                    )}" placeholder="Description"></td>
                        <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num${
                          invField === 'itemN' ? ' p3h-re-dim-invalid' : ''
                        }" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" data-field="itemN" value="${escapeHtml(
                      r.itemN
                    )}" placeholder="No / expr"></td>
                        <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num${
                          invField === 'itemLength' ? ' p3h-re-dim-invalid' : ''
                        }" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" data-field="itemLength" value="${escapeHtml(
                      r.itemLength
                    )}" placeholder="—"></td>
                        <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num${
                          invField === 'itemBreadth' ? ' p3h-re-dim-invalid' : ''
                        }" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" data-field="itemBreadth" value="${escapeHtml(
                      r.itemBreadth
                    )}" placeholder="—"></td>
                        <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num${
                          invField === 'itemDepth' ? ' p3h-re-dim-invalid' : ''
                        }" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" data-field="itemDepth" value="${escapeHtml(
                      r.itemDepth
                    )}" placeholder="—"></td>
                        <td><input type="text" class="p3h-re-dim-input p3h-re-dim-input-num${
                          invField === 'itemCf' ? ' p3h-re-dim-invalid' : ''
                        }" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" data-field="itemCf" value="${escapeHtml(
                      r.itemCf
                    )}" placeholder="—"></td>
                        <td class="p3h-re-dim-qty${
                          isInv ? ' p3h-re-dim-qty-invalid' : ''
                        }" title="${escapeHtml(qtyTitle)}">${escapeHtml(qtyDisplay)}</td>
                        <td style="text-align:center;">
                          <div class="p3h-re-dim-actions">
                            <button type="button" class="p3h-re-dim-icon-btn p3h-re-dup-row-btn" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" title="Duplicate row">⧉</button>
                            <button type="button" class="p3h-re-dim-icon-btn p3h-re-del-row-btn" data-specid="${sidEsc}" data-headkey="${keyEsc}" data-rowidx="${rIdx}" title="Remove row">×</button>
                          </div>
                        </td>
                      </tr>`;
                  })
                  .join('');

                return `
                  <div class="p3h-re-head-card${draft.dirty ? ' p3h-re-head-dirty' : ''}" data-specid="${sidEsc}" data-headkey="${keyEsc}">
                    <div class="p3h-re-head-card-top">
                      <div class="p3h-re-head-title-group">
                        <span class="p3h-re-head-mgn${draft.isNew ? ' p3h-re-head-mgn-new' : ''}">${escapeHtml(
                  mgnText
                )}</span>
                        <input type="text" class="p3h-input p3h-re-head-desc-input" data-specid="${sidEsc}" data-headkey="${keyEsc}" value="${escapeHtml(
                  draft.headDesc
                )}" placeholder="Measurement sub-heading">
                      </div>
                      <div class="p3h-re-head-ctrl-group">
                        <span class="p3h-re-head-dirty-tag" style="${
                          draft.dirty ? '' : 'display:none;'
                        }">Unsaved</span>
                        <span class="p3h-re-head-subtotal-wrap">Subtotal: <strong class="p3h-re-head-subtotal">${escapeHtml(
                          summary.subtotal.toFixed(3)
                        )}</strong> ${escapeHtml(unit)}</span>
                        <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-muted-danger p3h-re-del-head-btn" data-specid="${sidEsc}" data-headkey="${keyEsc}"${
                  rowLocked ? ' disabled' : ''
                } title="Delete this sub-heading">Delete</button>
                      </div>
                    </div>
                    <table class="p3h-re-dim-table">
                      <thead>
                        <tr>
                          <th width="30" style="text-align:center;">#</th>
                          <th>Item Description</th>
                          <th width="86" style="text-align:right;">No</th>
                          <th width="68" style="text-align:right;">L</th>
                          <th width="68" style="text-align:right;">B</th>
                          <th width="68" style="text-align:right;">H</th>
                          <th width="62" style="text-align:right;">Cf</th>
                          <th width="78" style="text-align:right;">Qty</th>
                          <th width="54" style="text-align:center;">Act</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${rowsHtml}
                      </tbody>
                    </table>
                    <div class="p3h-re-head-card-foot">
                      <button type="button" class="p3h-btn p3h-btn-sm p3h-re-add-row-btn" data-specid="${sidEsc}" data-headkey="${keyEsc}">+ Add Row</button>
                      <span class="p3h-re-head-err">${
                        summary.firstError && draft.dirty ? escapeHtml(summary.firstError) : ''
                      }</span>
                    </div>
                  </div>`;
              })
              .join('');

      const hintText =
        dirtyCount > 0
          ? `${dirtyCount} unsaved sub-heading(s) — Save to commit & close, or Cancel to discard`
          : 'Click Save or Cancel to close';

      splitCardEl.innerHTML = `
        <div class="p3h-re-split-card-head">
          <div class="p3h-re-split-meta">
            <strong id="p3h-re-split-card-title">Split-Up — #${escapeHtml((item && item.slNo) || '')} (${escapeHtml(
        formatCompactSpecCode(item ? item.specCode : '')
      )})</strong>
            ${unit ? `<span class="p3h-re-split-unit">${escapeHtml(unit)}</span>` : ''}
            <div class="p3h-re-split-metrics">${metricsParts.join(' · ')}</div>
          </div>
          <div class="p3h-re-split-actions">
            <button type="button" class="p3h-btn p3h-btn-sm p3h-re-add-head-btn" data-specid="${sidEsc}">+ Sub-heading</button>
            <button type="button" class="p3h-btn p3h-btn-sm p3h-re-refresh-split-btn" data-specid="${sidEsc}" title="Reload from server">↻</button>
          </div>
        </div>
        <div class="p3h-re-split-card-body">
          ${cardsHtml}
        </div>
        <div class="p3h-re-split-card-footer">
          <span class="p3h-re-split-card-hint">${escapeHtml(hintText)}</span>
          <div class="p3h-re-split-card-btns">
            <button type="button" class="p3h-btn p3h-btn-sm p3h-re-split-cancel-btn" data-specid="${sidEsc}">Cancel</button>
            <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-primary p3h-re-split-save-btn" data-specid="${sidEsc}"${
        rowLocked || (dirtyCount > 0 && anyInvalid) ? ' disabled' : ''
      } title="Save changes and close (Ctrl+Enter)">${savingRowIds.has(sid) ? 'Saving...' : 'Save'}</button>
          </div>
        </div>`;

      syncActionLockUi();
    }

    function updateSplitLiveDom(sid, headKey) {
      if (!splitCardEl || activeSplitSpecId !== sid) return;
      const headMap = dirtyHeadsBySpecId.get(sid);
      const draft = headMap ? headMap.get(headKey) : null;
      if (!draft) return;

      const card = Array.from(splitCardEl.querySelectorAll('.p3h-re-head-card')).find(
        (el) => el.getAttribute('data-headkey') === headKey
      );
      const summary = computeDraftHeadSummary(draft);
      if (card) {
        card.classList.toggle('p3h-re-head-dirty', Boolean(draft.dirty));
        const dirtyTag = card.querySelector('.p3h-re-head-dirty-tag');
        if (dirtyTag) dirtyTag.style.display = draft.dirty ? '' : 'none';
        const subEl = card.querySelector('.p3h-re-head-subtotal');
        if (subEl) subEl.textContent = summary.subtotal.toFixed(3);
        const errEl = card.querySelector('.p3h-re-head-err');
        if (errEl) errEl.textContent = summary.firstError && draft.dirty ? summary.firstError : '';

        const dimRows = Array.from(card.querySelectorAll('tr.p3h-re-dim-row'));
        dimRows.forEach((rTr, idx) => {
          const calc = summary.rowResults[idx] || { kind: 'blank', qty: null };
          const isDed = calc.kind === 'valid' && calc.isDeduction;
          const isInv = calc.kind === 'invalid';
          const invField = isInv ? calc.field : '';
          rTr.classList.toggle('p3h-re-dim-deduction', isDed);
          const qtyCell = rTr.querySelector('.p3h-re-dim-qty');
          if (qtyCell) {
            qtyCell.textContent =
              calc.kind === 'valid' ? calc.qty.toFixed(3) : calc.kind === 'invalid' ? '!' : '—';
            qtyCell.classList.toggle('p3h-re-dim-qty-invalid', isInv);
            if (calc.kind === 'invalid') {
              qtyCell.setAttribute('title', calc.error || 'Invalid');
            } else if (calc.kind === 'valid' && calc.isFormulaN) {
              qtyCell.setAttribute('title', `Formula evaluated: ${calc.evaluated.n} -> ${calc.qty.toFixed(3)}`);
            } else {
              qtyCell.removeAttribute('title');
            }
          }
          rTr.querySelectorAll('.p3h-re-dim-input').forEach((inpEl) => {
            const fname = inpEl.getAttribute('data-field') || '';
            inpEl.classList.toggle('p3h-re-dim-invalid', fname === invField);
          });
        });
      }

      const specSummary = computeSpecSplitTotal(sid);
      const sumEl = splitCardEl.querySelector(`[data-split-sum="${sid}"]`);
      if (sumEl) sumEl.textContent = formatQty(specSummary.total);

      const item = itemBySpecId.get(sid);
      const model = helperModelBySpecId.get(sid) || null;
      const dprQty = model && model.dprQty !== null ? model.dprQty : null;
      const execQty = getInferredExecQty(item, model);
      const balEl = splitCardEl.querySelector(`[data-split-bal="${sid}"]`);
      if (balEl && dprQty !== null && execQty !== null) {
        balEl.textContent = formatQty(roundQty3(dprQty - execQty - specSummary.total));
      }

      const drafts = Array.from(headMap.values());
      const dirtyCount = drafts.filter((d) => d && (d.dirty || d.isNew)).length;
      const anyInvalid = drafts.some((d) => d && (d.dirty || d.isNew) && computeDraftHeadSummary(d).hasInvalid);
      const hintEl = splitCardEl.querySelector('.p3h-re-split-card-hint');
      if (hintEl) {
        hintEl.textContent =
          dirtyCount > 0
            ? `${dirtyCount} unsaved sub-heading(s) — Save to commit & close, or Cancel to discard`
            : 'Click Save or Cancel to close';
      }
      const saveCardBtn = splitCardEl.querySelector('.p3h-re-split-save-btn');
      if (saveCardBtn) {
        saveCardBtn.disabled = uiState.isRunning || savingRowIds.has(sid) || (dirtyCount > 0 && anyInvalid);
      }

      updateRowLivePreview(sid, specSummary.total);
    }

    function loadSplitDetails(sid, forceRefresh) {
      if (!sid) return Promise.resolve();
      if (loadingSplitSpecIds.has(sid)) return rowMutationChain;
      if (!forceRefresh && tbeDetailsBySpecId.has(sid)) {
        if (activeSplitSpecId === sid) renderSplitUpPanel(sid);
        return Promise.resolve();
      }
      if (forceRefresh) {
        tbeDetailsBySpecId.delete(sid);
        dirtyHeadsBySpecId.delete(sid);
      }
      splitErrorsBySpecId.delete(sid);
      loadingSplitSpecIds.add(sid);
      savingRowIds.add(sid);
      if (activeSplitSpecId === sid) renderSplitUpPanel(sid);
      syncActionLockUi();

      rowMutationChain = rowMutationChain
        .then(async () => {
          await pauseAndAwaitBackgroundSync();
          const res = await fetchItemTbeDetails(sid);
          if (res.ok) {
            const detailsObj = {
              kind: res.kind,
              tbeQty: res.tbeQty,
              measurementIds: res.measurementIds || [],
              headDetails: res.headDetails || [],
              hasDetailed: Boolean(res.hasDetailed),
            };
            tbeDetailsBySpecId.set(sid, detailsObj);
            cachedIdsBySpecId.set(sid, detailsObj.measurementIds);
            if (!committedTbeBySpecId.has(sid) && detailsObj.tbeQty !== null) {
              setRowTbeInputValue(sid, detailsObj.tbeQty, true);
            }
            syncDraftMapFromDetails(sid, detailsObj);
            syncRowSplitLockUi(sid);
          } else {
            if (res.sessionExpired) hasSessionExpired = true;
            splitErrorsBySpecId.set(sid, res.error || 'Failed to load split-ups');
          }
        })
        .catch((err) => {
          splitErrorsBySpecId.set(sid, (err && err.message) || 'Failed to load split-ups');
        })
        .finally(() => {
          loadingSplitSpecIds.delete(sid);
          savingRowIds.delete(sid);
          if (activeSplitSpecId === sid) {
            renderSplitUpPanel(sid);
          } else {
            syncActionLockUi();
          }
        });

      return rowMutationChain;
    }

    function openSplitCard(sid) {
      if (!sid || uiState.isRunning) return;
      if (activeSplitSpecId && activeSplitSpecId !== sid) {
        closeSplitCard({ revertDrafts: true });
      }
      activeSplitSpecId = sid;
      if (splitBackdropEl) splitBackdropEl.style.display = 'flex';
      if (tbeDetailsBySpecId.has(sid)) {
        renderSplitUpPanel(sid);
      } else {
        loadSplitDetails(sid, false);
      }
      if (splitCardEl) {
        const firstInput = splitCardEl.querySelector('.p3h-re-dim-input, .p3h-re-head-desc-input');
        if (firstInput && typeof firstInput.focus === 'function') firstInput.focus();
      }
    }

    function closeSplitCard(opts) {
      const cfg = opts || {};
      const closingSid = activeSplitSpecId;
      if (closingSid && cfg.revertDrafts) {
        dirtyHeadsBySpecId.delete(closingSid);
        if (tbeDetailsBySpecId.has(closingSid)) {
          syncDraftMapFromDetails(closingSid, tbeDetailsBySpecId.get(closingSid), '*');
        }
        restoreRowCommittedPreview(closingSid);
      }
      activeSplitSpecId = null;
      if (splitBackdropEl) splitBackdropEl.style.display = 'none';
      if (splitCardEl) splitCardEl.innerHTML = '';
      syncActionLockUi();
      if (closingSid && uiState.modalActive) {
        scheduleBackgroundHeadingPreSync(1100);
      }
    }

    function saveSplitCardChanges(sid) {
      const item = itemBySpecId.get(sid);
      if (!item || savingRowIds.has(sid) || uiState.isRunning) return Promise.resolve();
      const headMap = dirtyHeadsBySpecId.get(sid);
      const dirtyDrafts = headMap
        ? Array.from(headMap.values()).filter((d) => d && (d.dirty || d.isNew))
        : [];
      if (dirtyDrafts.length === 0) {
        closeSplitCard({ revertDrafts: false });
        return Promise.resolve();
      }

      for (let i = 0; i < dirtyDrafts.length; i++) {
        const summary = computeDraftHeadSummary(dirtyDrafts[i]);
        if (summary.hasInvalid) {
          renderSplitUpPanel(sid);
          return Promise.resolve();
        }
      }

      savingRowIds.add(sid);
      setRowStatus(sid, 'active', `<span class="p3h-re-pill-info">Saving split-up...</span>`, '');
      statusBadge.style.display = 'inline-block';
      statusBadge.className = 'p3h-re-status-badge';
      statusBadge.textContent = `Saving split-up for #${item.slNo || item.index + 1}...`;
      if (activeSplitSpecId === sid) renderSplitUpPanel(sid);
      else syncActionLockUi();

      let allOk = true;
      rowMutationChain = rowMutationChain
        .then(async () => {
          await pauseAndAwaitBackgroundSync();
          for (let i = 0; i < dirtyDrafts.length; i++) {
            const draft = dirtyDrafts[i];
            const details = tbeDetailsBySpecId.get(sid) || null;
            const existingIds =
              (details && Array.isArray(details.measurementIds) ? details.measurementIds : []) || [];
            let mode = 'edit';
            let itemheadorder = '1';
            if (draft.isNew) {
              if (existingIds.length === 0) {
                mode = 'add_first';
              } else {
                mode = 'add_between';
                itemheadorder = draft.itemHeadOrder || String(existingIds.length);
              }
            }
            const res = await saveItemTbeHead(
              {
                headspecid: sid,
                mode,
                measureheadid: draft.isNew ? '' : draft.id,
                itemheadorder,
                headDesc: draft.headDesc,
                rows: draft.rows,
              },
              { headId: ctx.curHeadId || extracted.headId || '' }
            );
            if (!res.ok) {
              allOk = false;
              if (res.sessionExpired) hasSessionExpired = true;
              setRowStatus(
                sid,
                'error',
                `<span class="p3h-re-pill-err">✘ Error</span>`,
                res.error || 'Save failed'
              );
              pbar.style.width = '100%';
              pbar.style.background = '#dc2626';
              statusBadge.className = 'p3h-re-status-badge p3h-re-status-err';
              statusBadge.textContent = res.sessionExpired
                ? 'Session expired — log in again'
                : res.error || 'Save failed';
              break;
            }

            const finalQty = roundQty3(res.tbeQty);
            const nextDetails = {
              kind:
                finalQty > QTY_EPS || (res.headDetails && res.headDetails.length > 0)
                  ? 'has_measurements'
                  : 'empty',
              tbeQty: finalQty,
              measurementIds: Array.isArray(res.measurementIds) ? res.measurementIds : [],
              headDetails: Array.isArray(res.headDetails) ? res.headDetails : [],
              hasDetailed: Boolean(res.hasDetailed),
            };
            tbeDetailsBySpecId.set(sid, nextDetails);
            cachedIdsBySpecId.set(sid, nextDetails.measurementIds);
            syncDraftMapFromDetails(sid, nextDetails, draft.key);
            updateLocalModelAfterTbeChange(item, finalQty);
            setRowTbeInputValue(sid, finalQty, false);
            syncRowSplitLockUi(sid);
            hasDirtyPortalChanges = true;
            if (res.headid) dirtyLastHeadId = res.headid;
            dirtyLastHeadSpecId = sid;
          }

          if (allOk) {
            const finalDetails = tbeDetailsBySpecId.get(sid);
            const finalQty = finalDetails ? roundQty3(finalDetails.tbeQty) : 0;
            setRowStatus(
              sid,
              'deleted',
              `<span class="p3h-re-pill-ok">✔ Saved</span>`,
              `TBE split-up saved (${formatQty(finalQty)})`
            );
            pbar.style.width = '100%';
            pbar.style.background = '#16a34a';
            statusBadge.className = 'p3h-re-status-badge p3h-re-status-ok';
            statusBadge.textContent = `Saved split-up #${item.slNo || item.index + 1}: TBE = ${formatEditableQty(
              finalQty
            )}`;
          }
        })
        .catch((err) => {
          allOk = false;
          const msg = err && err.message ? err.message : String(err || 'Save failed');
          setRowStatus(sid, 'error', `<span class="p3h-re-pill-err">✘ Error</span>`, msg);
          pbar.style.width = '100%';
          pbar.style.background = '#dc2626';
          statusBadge.className = 'p3h-re-status-badge p3h-re-status-err';
          statusBadge.textContent = msg;
        })
        .finally(() => {
          savingRowIds.delete(sid);
          if (allOk && activeSplitSpecId === sid) {
            closeSplitCard({ revertDrafts: false });
          } else if (activeSplitSpecId === sid) {
            renderSplitUpPanel(sid);
          }
          syncSelectionUi();
        });

      return rowMutationChain;
    }

    function deleteSplitHead(sid, headKey) {
      const item = itemBySpecId.get(sid);
      const headMap = dirtyHeadsBySpecId.get(sid);
      const draft = headMap ? headMap.get(headKey) : null;
      if (!item || !draft || savingRowIds.has(sid) || uiState.isRunning) return Promise.resolve();

      if (draft.isNew) {
        headMap.delete(headKey);
        if (activeSplitSpecId === sid) renderSplitUpPanel(sid);
        const specSummary = computeSpecSplitTotal(sid);
        if (headMap.size === 0) restoreRowCommittedPreview(sid);
        else updateRowLivePreview(sid, specSummary.total);
        return Promise.resolve();
      }

      const label = draft.headDesc || draft.mgn || draft.id;
      if (!confirm(`Delete measurement sub-heading "${label}" from item #${item.slNo || item.index + 1}?`)) {
        return Promise.resolve();
      }

      savingRowIds.add(sid);
      setRowStatus(sid, 'active', `<span class="p3h-re-pill-info">Deleting...</span>`, '');
      statusBadge.style.display = 'inline-block';
      statusBadge.className = 'p3h-re-status-badge';
      statusBadge.textContent = `Deleting sub-heading "${label}"...`;
      syncActionLockUi();

      rowMutationChain = rowMutationChain
        .then(async () => {
          await pauseAndAwaitBackgroundSync();
          const res = await deleteItemTbeHead(sid, draft.id, {
            headId: ctx.curHeadId || extracted.headId || '',
          });

          if (res.ok) {
            const finalQty = roundQty3(res.tbeQty);
            const nextDetails = {
              kind: res.kind,
              tbeQty: finalQty,
              measurementIds: Array.isArray(res.measurementIds) ? res.measurementIds : [],
              headDetails: Array.isArray(res.headDetails) ? res.headDetails : [],
              hasDetailed: Boolean(res.hasDetailed),
            };
            tbeDetailsBySpecId.set(sid, nextDetails);
            cachedIdsBySpecId.set(sid, nextDetails.measurementIds);
            syncDraftMapFromDetails(sid, nextDetails, headKey);
            updateLocalModelAfterTbeChange(item, finalQty);
            setRowTbeInputValue(sid, finalQty, false);
            syncRowSplitLockUi(sid);
            if (finalQty <= QTY_EPS) selectedSet.delete(sid);

            hasDirtyPortalChanges = true;
            if (res.headid) dirtyLastHeadId = res.headid;
            dirtyLastHeadSpecId = sid;
            setRowStatus(
              sid,
              finalQty <= QTY_EPS ? 'deleted' : 'checked',
              finalQty <= QTY_EPS
                ? `<span class="p3h-re-pill-ok">✔ Deleted</span>`
                : `<span class="p3h-re-pill-info">TBE: ${escapeHtml(formatQty(finalQty))}</span>`,
              res.message || 'Sub-heading deleted'
            );
            pbar.style.width = '100%';
            pbar.style.background = '#16a34a';
            statusBadge.className = 'p3h-re-status-badge p3h-re-status-ok';
            statusBadge.textContent = `Deleted "${label}" (TBE = ${formatEditableQty(finalQty)})`;
          } else {
            if (res.sessionExpired) hasSessionExpired = true;
            setRowStatus(
              sid,
              'error',
              `<span class="p3h-re-pill-err">✘ Error</span>`,
              res.error || 'Delete failed'
            );
            pbar.style.width = '100%';
            pbar.style.background = '#dc2626';
            statusBadge.className = 'p3h-re-status-badge p3h-re-status-err';
            statusBadge.textContent = res.sessionExpired
              ? 'Session expired — log in again'
              : res.error || 'Delete failed';
          }
        })
        .catch((err) => {
          const msg = err && err.message ? err.message : String(err || 'Delete failed');
          setRowStatus(sid, 'error', `<span class="p3h-re-pill-err">✘ Error</span>`, msg);
          pbar.style.width = '100%';
          pbar.style.background = '#dc2626';
          statusBadge.className = 'p3h-re-status-badge p3h-re-status-err';
          statusBadge.textContent = msg;
        })
        .finally(() => {
          savingRowIds.delete(sid);
          if (activeSplitSpecId === sid) renderSplitUpPanel(sid);
          syncSelectionUi();
        });

      return rowMutationChain;
    }

    function runRowTbeMutation(item, targetQty) {
      if (!item || !item.headspecid) return Promise.resolve();
      const sid = item.headspecid;
      const normalizedTarget = roundQty3(targetQty);
      savingRowIds.add(sid);
      setRowStatus(
        sid,
        'active',
        `<span class="p3h-re-pill-info">${normalizedTarget <= QTY_EPS ? 'Deleting...' : 'Saving...'}</span>`,
        ''
      );
      statusBadge.style.display = 'inline-block';
      statusBadge.className = 'p3h-re-status-badge';
      statusBadge.textContent =
        normalizedTarget <= QTY_EPS
          ? `Deleting TBE for #${item.slNo || item.index + 1}...`
          : `Saving TBE ${formatEditableQty(normalizedTarget)} for #${item.slNo || item.index + 1}...`;
      syncActionLockUi();

      rowMutationChain = rowMutationChain
        .then(async () => {
          await pauseAndAwaitBackgroundSync();
          const res = await upsertItemTbeQty(item, normalizedTarget, {
            headId: ctx.curHeadId || extracted.headId || '',
            preserveDetailedSplitUps: normalizedTarget > QTY_EPS,
          });

          if (res.ok) {
            const finalQty = roundQty3(res.tbeQty);
            cachedIdsBySpecId.set(sid, Array.isArray(res.measurementIds) ? res.measurementIds : []);
            if (res.status === 'deleted') {
              tbeDetailsBySpecId.set(sid, {
                kind: 'empty',
                tbeQty: 0,
                measurementIds: [],
                headDetails: [],
                hasDetailed: false,
              });
              dirtyHeadsBySpecId.delete(sid);
            } else if (Array.isArray(res.headDetails)) {
              const nextDetails = {
                kind: res.measurementIds && res.measurementIds.length > 0 ? 'has_measurements' : 'empty',
                tbeQty: finalQty,
                measurementIds: res.measurementIds || [],
                headDetails: res.headDetails,
                hasDetailed: Boolean(res.hasDetailed),
              };
              tbeDetailsBySpecId.set(sid, nextDetails);
              if (res.status !== 'unchanged') {
                syncDraftMapFromDetails(sid, nextDetails);
              }
            }
            updateLocalModelAfterTbeChange(item, finalQty);
            setRowTbeInputValue(sid, finalQty, false);
            syncRowSplitLockUi(sid);
            if (activeSplitSpecId === sid) renderSplitUpPanel(sid);

            if (finalQty <= QTY_EPS) {
              selectedSet.delete(sid);
            }

            if (res.status === 'deleted') {
              hasDirtyPortalChanges = true;
              if (res.headid) dirtyLastHeadId = res.headid;
              dirtyLastHeadSpecId = sid;
              setRowStatus(
                sid,
                'deleted',
                `<span class="p3h-re-pill-ok">✔ Deleted</span>`,
                res.message || 'To Be Executed quantity cleared'
              );
              pbar.style.width = '100%';
              pbar.style.background = '#16a34a';
              statusBadge.className = 'p3h-re-status-badge p3h-re-status-ok';
              statusBadge.textContent = `Deleted TBE for #${item.slNo || item.index + 1}`;
            } else if (res.status === 'unchanged') {
              setRowStatus(
                sid,
                finalQty <= QTY_EPS ? 'skipped' : 'checked',
                finalQty <= QTY_EPS
                  ? `<span class="p3h-re-pill-skip">⊘ TBE = 0</span>`
                  : `<span class="p3h-re-pill-info">TBE: ${escapeHtml(formatQty(finalQty))}</span>`,
                res.note || 'Unchanged'
              );
              statusBadge.className = 'p3h-re-status-badge p3h-re-status-ok';
              statusBadge.textContent = `#${item.slNo || item.index + 1} TBE unchanged (${formatEditableQty(
                finalQty
              )})`;
            } else {
              hasDirtyPortalChanges = true;
              if (res.headid) dirtyLastHeadId = res.headid;
              dirtyLastHeadSpecId = sid;
              setRowStatus(
                sid,
                'deleted',
                `<span class="p3h-re-pill-ok">✔ Saved</span>`,
                res.message || `TBE updated to ${formatQty(finalQty)}`
              );
              pbar.style.width = '100%';
              pbar.style.background = '#16a34a';
              statusBadge.className = 'p3h-re-status-badge p3h-re-status-ok';
              statusBadge.textContent = `Saved #${item.slNo || item.index + 1}: TBE = ${formatEditableQty(
                finalQty
              )}`;
            }
          } else if (res.blockedBySplitUp) {
            const detailsObj = {
              kind: 'has_measurements',
              tbeQty: res.tbeQty,
              measurementIds: res.measurementIds || [],
              headDetails: res.headDetails || (res.parsed && res.parsed.headDetails) || [],
              hasDetailed: true,
            };
            tbeDetailsBySpecId.set(sid, detailsObj);
            cachedIdsBySpecId.set(sid, detailsObj.measurementIds);
            syncDraftMapFromDetails(sid, detailsObj);
            if (res.tbeQty !== null) {
              setRowTbeInputValue(sid, res.tbeQty, false);
            }
            restoreRowCommittedPreview(sid);
            syncRowSplitLockUi(sid);
            openSplitCard(sid);
            setRowStatus(
              sid,
              'checked',
              `<span class="p3h-re-pill-info">Split-up</span>`,
              res.error || 'Detailed split-ups exist — edit in Split-Up Card'
            );
            statusBadge.className = 'p3h-re-status-badge p3h-re-status-warn';
            statusBadge.textContent = `#${item.slNo || item.index + 1} has detailed split-ups — opened Split-Up Card`;
          } else {
            if (res.sessionExpired) hasSessionExpired = true;
            const prevCommitted = committedTbeBySpecId.has(sid) ? committedTbeBySpecId.get(sid) : null;
            if (prevCommitted !== null) {
              setRowTbeInputValue(sid, prevCommitted, false);
            }
            setRowStatus(
              sid,
              'error',
              `<span class="p3h-re-pill-err">✘ Error</span>`,
              res.error || 'Save failed'
            );
            pbar.style.width = '100%';
            pbar.style.background = '#dc2626';
            statusBadge.className = 'p3h-re-status-badge p3h-re-status-err';
            statusBadge.textContent = res.sessionExpired
              ? 'Session expired — log in again'
              : res.error || 'Save failed';
          }
        })
        .catch((err) => {
          const msg = err && err.message ? err.message : String(err || 'Save failed');
          setRowStatus(sid, 'error', `<span class="p3h-re-pill-err">✘ Error</span>`, msg);
          pbar.style.width = '100%';
          pbar.style.background = '#dc2626';
          statusBadge.className = 'p3h-re-status-badge p3h-re-status-err';
          statusBadge.textContent = msg;
        })
        .finally(() => {
          savingRowIds.delete(sid);
          syncSelectionUi();
        });

      return rowMutationChain;
    }

    function commitRowTbeIfChanged(sid) {
      if (uiState.isRunning || savingRowIds.has(sid)) return;
      const item = itemBySpecId.get(sid);
      const tr = tbody.querySelector(`tr.p3h-re-row[data-specid="${sid}"]`);
      const inp = tr ? tr.querySelector('.p3h-re-tbe-input') : null;
      if (!item || !inp || inp.readOnly) return;

      const committed = committedTbeBySpecId.has(sid) ? committedTbeBySpecId.get(sid) : null;
      const parsed = parseEditableQtyInput(inp.value);

      if (parsed.kind === 'blank') {
        if (committed !== null) {
          inp.value = formatEditableQty(committed);
        }
        inp.classList.remove('p3h-re-input-invalid');
        restoreRowCommittedPreview(sid);
        return;
      }

      if (parsed.kind === 'invalid') {
        inp.classList.add('p3h-re-input-invalid');
        setRowStatus(sid, 'error', `<span class="p3h-re-pill-err">✘ Invalid qty</span>`, parsed.error);
        return;
      }

      inp.classList.remove('p3h-re-input-invalid');
      inp.value = formatEditableQty(parsed.value);

      if (committed !== null && Math.abs(parsed.value - committed) <= QTY_EPS) {
        restoreRowCommittedPreview(sid);
        return;
      }

      runRowTbeMutation(item, parsed.value);
    }

    if (currentBundle) {
      applyHelperBundleToModal(currentBundle, false);
    }

    searchInput.addEventListener('input', applyVisibilityFilter);
    if (viewFilterSelect) {
      viewFilterSelect.addEventListener('change', applyVisibilityFilter);
    }

    if (zeroCb) {
      zeroCb.addEventListener('change', () => {
        showZeroItems = zeroCb.checked;
        applyVisibilityFilter();
      });
    }

    allBtn.addEventListener('click', () => {
      if (uiState.isRunning || savingRowIds.size > 0) return;
      getVisibleItems().forEach((it) => selectedSet.add(it.headspecid));
      syncSelectionUi();
    });

    noneBtn.addEventListener('click', () => {
      if (uiState.isRunning || savingRowIds.size > 0) return;
      getVisibleItems().forEach((it) => selectedSet.delete(it.headspecid));
      syncSelectionUi();
    });

    invertBtn.addEventListener('click', () => {
      if (uiState.isRunning || savingRowIds.size > 0) return;
      getVisibleItems().forEach((it) => {
        if (selectedSet.has(it.headspecid)) selectedSet.delete(it.headspecid);
        else selectedSet.add(it.headspecid);
      });
      syncSelectionUi();
    });

    selDoubledBtn.addEventListener('click', () => {
      selectVisibleByPredicate((m) => m.isDoubledTbe);
    });

    selExecBtn.addEventListener('click', () => {
      selectVisibleByPredicate(
        (m) => m.isFullyExecutedInMbook && (m.reTbeQty === null || m.reTbeQty > QTY_EPS)
      );
    });

    selTbeBtn.addEventListener('click', () => {
      selectVisibleByPredicate((m) => m.hasTbe === true);
    });

    modalHelperBtn.addEventListener('click', () => {
      loadModalHelperData(Boolean(currentBundle));
    });

    headerCb.addEventListener('change', () => {
      if (uiState.isRunning || savingRowIds.size > 0) return;
      const check = headerCb.checked;
      getVisibleItems().forEach((it) => {
        if (check) selectedSet.add(it.headspecid);
        else selectedSet.delete(it.headspecid);
      });
      syncSelectionUi();
    });

    if (headingSelect) {
      headingSelect.addEventListener('change', () => {
        switchModalHeading(headingSelect.value);
      });
    }
    if (headPrevBtn) {
      headPrevBtn.addEventListener('click', () => {
        const idx = headingsList.findIndex((h) => String(h.headId) === String(currentHeadId));
        if (idx > 0) switchModalHeading(headingsList[idx - 1].headId);
      });
    }
    if (headNextBtn) {
      headNextBtn.addEventListener('click', () => {
        const idx = headingsList.findIndex((h) => String(h.headId) === String(currentHeadId));
        if (idx >= 0 && idx < headingsList.length - 1) switchModalHeading(headingsList[idx + 1].headId);
      });
    }

    tbody.addEventListener('mousedown', (e) => {
      const actionBtn =
        e.target && e.target.closest
          ? e.target.closest(
              '.p3h-re-row-del-btn, .p3h-re-row-bal-btn, .p3h-re-mb-pending-btn'
            )
          : null;
      if (actionBtn) {
        skipBlurSpecId = actionBtn.getAttribute('data-specid') || '';
        setTimeout(() => {
          skipBlurSpecId = '';
        }, 0);
      }
    });

    if (splitBackdropEl) {
      splitBackdropEl.addEventListener('click', (e) => {
        if (e.target === splitBackdropEl && !uiState.isRunning && (!activeSplitSpecId || !savingRowIds.has(activeSplitSpecId))) {
          closeSplitCard({ revertDrafts: true });
        }
      });
    }

    if (splitCardEl) {
      splitCardEl.addEventListener('input', (e) => {
        const headDescInp =
          e.target && e.target.closest ? e.target.closest('.p3h-re-head-desc-input') : null;
        if (headDescInp) {
          const sid = headDescInp.getAttribute('data-specid') || '';
          const headKey = headDescInp.getAttribute('data-headkey') || '';
          const headMap = dirtyHeadsBySpecId.get(sid);
          const draft = headMap ? headMap.get(headKey) : null;
          if (draft) {
            draft.headDesc = headDescInp.value;
            draft.dirty = true;
            updateSplitLiveDom(sid, headKey);
          }
          return;
        }

        const dimInp = e.target && e.target.closest ? e.target.closest('.p3h-re-dim-input') : null;
        if (dimInp) {
          const sid = dimInp.getAttribute('data-specid') || '';
          const headKey = dimInp.getAttribute('data-headkey') || '';
          const rIdx = parseInt(dimInp.getAttribute('data-rowidx'), 10);
          const field = dimInp.getAttribute('data-field') || '';
          const headMap = dirtyHeadsBySpecId.get(sid);
          const draft = headMap ? headMap.get(headKey) : null;
          if (draft && draft.rows[rIdx] && field) {
            draft.rows[rIdx][field] = dimInp.value;
            draft.dirty = true;
            updateSplitLiveDom(sid, headKey);
          }
        }
      });

      splitCardEl.addEventListener('keydown', (e) => {
        const sid = activeSplitSpecId || '';
        if (!sid) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (!savingRowIds.has(sid) && !uiState.isRunning) {
            closeSplitCard({ revertDrafts: true });
          }
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          saveSplitCardChanges(sid);
          return;
        }
        const dimInp = e.target && e.target.closest ? e.target.closest('.p3h-re-dim-input') : null;
        if (dimInp && e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const headKey = dimInp.getAttribute('data-headkey') || '';
          const rIdx = parseInt(dimInp.getAttribute('data-rowidx'), 10);
          const field = dimInp.getAttribute('data-field') || 'itemDesc';
          const headMap = dirtyHeadsBySpecId.get(sid);
          const draft = headMap ? headMap.get(headKey) : null;
          if (!draft) return;
          if (rIdx === draft.rows.length - 1) {
            draft.rows.push(createBlankDraftRow());
            draft.dirty = true;
            renderSplitUpPanel(sid);
            const nextCard = Array.from(splitCardEl.querySelectorAll('.p3h-re-head-card')).find(
              (el) => el.getAttribute('data-headkey') === headKey
            );
            const nextInp = nextCard
              ? nextCard.querySelector(
                  `tr.p3h-re-dim-row[data-rowidx="${rIdx + 1}"] .p3h-re-dim-input[data-field="itemDesc"]`
                )
              : null;
            if (nextInp) nextInp.focus();
          } else {
            const card = dimInp.closest('.p3h-re-head-card');
            const nextInp = card
              ? card.querySelector(
                  `tr.p3h-re-dim-row[data-rowidx="${rIdx + 1}"] .p3h-re-dim-input[data-field="${field}"]`
                )
              : null;
            if (nextInp) nextInp.focus();
          }
        }
      });

      splitCardEl.addEventListener('click', (e) => {
        if (uiState.isRunning) return;

        const cancelSplitBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-split-cancel-btn') : null;
        if (cancelSplitBtn) {
          e.stopPropagation();
          const sid = cancelSplitBtn.getAttribute('data-specid') || activeSplitSpecId || '';
          if (!sid || !savingRowIds.has(sid)) closeSplitCard({ revertDrafts: true });
          return;
        }

        const saveSplitBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-split-save-btn') : null;
        if (saveSplitBtn) {
          e.stopPropagation();
          const sid = saveSplitBtn.getAttribute('data-specid') || activeSplitSpecId || '';
          if (sid) saveSplitCardChanges(sid);
          return;
        }

        const refreshSplitBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-refresh-split-btn') : null;
        if (refreshSplitBtn) {
          e.stopPropagation();
          const sid = refreshSplitBtn.getAttribute('data-specid') || '';
          if (sid && !savingRowIds.has(sid)) loadSplitDetails(sid, true);
          return;
        }

        const addHeadBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-add-head-btn') : null;
        if (addHeadBtn) {
          e.stopPropagation();
          const sid = addHeadBtn.getAttribute('data-specid') || '';
          if (!sid || savingRowIds.has(sid)) return;
          const headMap = getOrInitDraftMap(sid);
          const newKey = 'new-' + String(newHeadSeq++);
          const existingCount = Array.from(headMap.values()).filter((d) => !d.isNew).length;
          headMap.set(newKey, {
            key: newKey,
            isNew: true,
            id: '',
            mgn: '',
            itemHeadOrder: String(Math.max(1, existingCount)),
            headDesc: existingCount === 0 ? '1' : `Part ${existingCount + 1}`,
            rows: [createBlankDraftRow()],
            dirty: true,
          });
          renderSplitUpPanel(sid);
          const newCard = Array.from(splitCardEl.querySelectorAll('.p3h-re-head-card')).find(
            (el) => el.getAttribute('data-headkey') === newKey
          );
          const descInp = newCard ? newCard.querySelector('.p3h-re-head-desc-input') : null;
          if (descInp) {
            descInp.focus();
            if (typeof descInp.select === 'function') descInp.select();
          }
          return;
        }

        const addRowBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-add-row-btn') : null;
        if (addRowBtn) {
          e.stopPropagation();
          const sid = addRowBtn.getAttribute('data-specid') || '';
          const headKey = addRowBtn.getAttribute('data-headkey') || '';
          if (!sid || !headKey || savingRowIds.has(sid)) return;
          const headMap = getOrInitDraftMap(sid);
          const draft = headMap.get(headKey);
          if (!draft) return;
          draft.rows.push(createBlankDraftRow());
          draft.dirty = true;
          renderSplitUpPanel(sid);
          const card = Array.from(splitCardEl.querySelectorAll('.p3h-re-head-card')).find(
            (el) => el.getAttribute('data-headkey') === headKey
          );
          const newDesc = card
            ? card.querySelector(
                `tr.p3h-re-dim-row[data-rowidx="${draft.rows.length - 1}"] .p3h-re-dim-input[data-field="itemDesc"]`
              )
            : null;
          if (newDesc) newDesc.focus();
          return;
        }

        const dupRowBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-dup-row-btn') : null;
        if (dupRowBtn) {
          e.stopPropagation();
          const sid = dupRowBtn.getAttribute('data-specid') || '';
          const headKey = dupRowBtn.getAttribute('data-headkey') || '';
          const rIdx = parseInt(dupRowBtn.getAttribute('data-rowidx'), 10);
          if (!sid || !headKey || !Number.isFinite(rIdx) || savingRowIds.has(sid)) return;
          const headMap = getOrInitDraftMap(sid);
          const draft = headMap.get(headKey);
          if (!draft || !draft.rows[rIdx]) return;
          draft.rows.splice(rIdx + 1, 0, { ...draft.rows[rIdx] });
          draft.dirty = true;
          renderSplitUpPanel(sid);
          updateRowLivePreview(sid, computeSpecSplitTotal(sid).total);
          return;
        }

        const delDimRowBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-del-row-btn') : null;
        if (delDimRowBtn) {
          e.stopPropagation();
          const sid = delDimRowBtn.getAttribute('data-specid') || '';
          const headKey = delDimRowBtn.getAttribute('data-headkey') || '';
          const rIdx = parseInt(delDimRowBtn.getAttribute('data-rowidx'), 10);
          if (!sid || !headKey || !Number.isFinite(rIdx) || savingRowIds.has(sid)) return;
          const headMap = getOrInitDraftMap(sid);
          const draft = headMap.get(headKey);
          if (!draft || !draft.rows[rIdx]) return;
          if (draft.rows.length === 1) {
            draft.rows[0] = createBlankDraftRow();
          } else {
            draft.rows.splice(rIdx, 1);
          }
          draft.dirty = true;
          renderSplitUpPanel(sid);
          updateRowLivePreview(sid, computeSpecSplitTotal(sid).total);
          return;
        }

        const delHeadBtn =
          e.target && e.target.closest ? e.target.closest('.p3h-re-del-head-btn') : null;
        if (delHeadBtn) {
          e.stopPropagation();
          const sid = delHeadBtn.getAttribute('data-specid') || '';
          const headKey = delHeadBtn.getAttribute('data-headkey') || '';
          if (sid && headKey) deleteSplitHead(sid, headKey);
        }
      });
    }

    tbody.addEventListener('input', (e) => {
      const inp = e.target && e.target.closest ? e.target.closest('.p3h-re-tbe-input') : null;
      if (!inp || inp.readOnly) return;
      const sid = inp.getAttribute('data-specid') || '';
      if (!sid) return;
      const parsed = parseEditableQtyInput(inp.value);
      if (parsed.kind === 'valid') {
        inp.classList.remove('p3h-re-input-invalid');
        updateRowLivePreview(sid, parsed.value);
      } else if (parsed.kind === 'blank') {
        inp.classList.remove('p3h-re-input-invalid');
        restoreRowCommittedPreview(sid);
      } else {
        inp.classList.add('p3h-re-input-invalid');
      }
    });

    tbody.addEventListener('focusout', (e) => {
      if (uiState.isRunning) return;
      const flatInp =
        e.target && e.target.closest ? e.target.closest('.p3h-re-tbe-input') : null;
      if (!flatInp || flatInp.readOnly) return;
      const tr = flatInp.closest('tr.p3h-re-row');
      if (!tr) return;
      const sid = tr.getAttribute('data-specid') || '';
      if (!sid) return;
      setTimeout(() => {
        if (!uiState.modalActive || uiState.isRunning) return;
        if (skipBlurSpecId === sid) return;
        const active = document.activeElement;
        if (active && tr.contains(active)) return;
        commitRowTbeIfChanged(sid);
      }, 0);
    });

    tbody.addEventListener('dblclick', (e) => {
      if (uiState.isRunning) return;
      const inp = e.target && e.target.closest ? e.target.closest('.p3h-re-tbe-input') : null;
      if (!inp) return;
      const sid = inp.getAttribute('data-specid') || '';
      if (sid && !savingRowIds.has(sid)) {
        e.stopPropagation();
        openSplitCard(sid);
      }
    });

    tbody.addEventListener('keydown', (e) => {
      const inp = e.target && e.target.closest ? e.target.closest('.p3h-re-tbe-input') : null;
      if (!inp) return;
      const sid = inp.getAttribute('data-specid') || '';
      if (e.altKey && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (sid && !savingRowIds.has(sid)) openSplitCard(sid);
        return;
      }
      if (inp.readOnly) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openSplitCard(sid);
        }
        return;
      }
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        commitRowTbeIfChanged(sid);
        const visibleInputs = rowNodes
          .filter((r) => r.style.display !== 'none')
          .map((r) => r.querySelector('.p3h-re-tbe-input'))
          .filter((el) => el && !el.disabled && !el.readOnly);
        const curIdx = visibleInputs.indexOf(inp);
        const nextIdx = e.key === 'ArrowUp' ? curIdx - 1 : curIdx + 1;
        if (curIdx >= 0 && nextIdx >= 0 && nextIdx < visibleInputs.length) {
          const nextInp = visibleInputs[nextIdx];
          nextInp.focus();
          if (typeof nextInp.select === 'function') nextInp.select();
        } else {
          inp.blur();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const committed = committedTbeBySpecId.has(sid) ? committedTbeBySpecId.get(sid) : null;
        inp.value = formatEditableQty(committed);
        inp.classList.remove('p3h-re-input-invalid');
        restoreRowCommittedPreview(sid);
        inp.blur();
      }
    });

    tbody.addEventListener('click', (e) => {
      if (uiState.isRunning) return;

      const mbPendBtn =
        e.target && e.target.closest ? e.target.closest('.p3h-re-mb-pending-btn') : null;
      if (mbPendBtn) {
        e.stopPropagation();
        const sid = mbPendBtn.getAttribute('data-specid') || '';
        if (sid && !savingRowIds.has(sid)) openMbookPendingModal(sid);
        return;
      }

      const balRowBtn =
        e.target && e.target.closest ? e.target.closest('.p3h-re-row-bal-btn') : null;
      if (balRowBtn) {
        e.stopPropagation();
        const sid = balRowBtn.getAttribute('data-specid') || '';
        if (!sid || savingRowIds.has(sid)) return;
        const details = tbeDetailsBySpecId.get(sid) || null;
        if (details && details.hasDetailed) return;
        const item = itemBySpecId.get(sid);
        const model = helperModelBySpecId.get(sid);
        if (!item || !model || model.dprBalanceQty === null) return;
        const committed = committedTbeBySpecId.has(sid) ? committedTbeBySpecId.get(sid) : null;
        if (committed !== null && Math.abs(model.dprBalanceQty - committed) <= QTY_EPS) {
          setRowTbeInputValue(sid, committed, false);
          restoreRowCommittedPreview(sid);
          return;
        }
        runRowTbeMutation(item, model.dprBalanceQty);
        return;
      }

      const delRowBtn =
        e.target && e.target.closest ? e.target.closest('.p3h-re-row-del-btn') : null;
      if (delRowBtn) {
        e.stopPropagation();
        const sid = delRowBtn.getAttribute('data-specid') || '';
        if (!sid || savingRowIds.has(sid)) return;
        const item = itemBySpecId.get(sid);
        if (!item) return;
        const details = tbeDetailsBySpecId.get(sid) || null;
        if (details && details.hasDetailed) {
          const ok = confirm(
            `Clear all To-Be-Executed measurement sub-headings and dimensions for item #${
              item.slNo || item.index + 1
            }?`
          );
          if (!ok) return;
        }
        runRowTbeMutation(item, 0);
        return;
      }

      const flatInp =
        e.target && e.target.closest ? e.target.closest('.p3h-re-tbe-input') : null;
      if (flatInp) {
        if (flatInp.readOnly) {
          e.stopPropagation();
          const sid = flatInp.getAttribute('data-specid') || '';
          if (sid && !savingRowIds.has(sid)) openSplitCard(sid);
        }
        return;
      }

      if (e.target && e.target.closest && e.target.closest('.p3h-re-tbe-edit-wrap')) {
        return;
      }

      const tr = e.target && e.target.closest ? e.target.closest('tr.p3h-re-row') : null;
      if (!tr || tr.style.display === 'none') return;
      const sid = tr.getAttribute('data-specid');
      if (savingRowIds.has(sid)) return;
      const idx = parseInt(tr.getAttribute('data-idx'), 10);
      const cb = tr.querySelector('.p3h-re-cb');
      const isCb = e.target === cb;
      const targetState = isCb ? Boolean(cb && cb.checked) : !selectedSet.has(sid);

      if (e.shiftKey && lastClickedIndex !== null) {
        const visibleByIdx = rowNodes
          .filter((r) => r.style.display !== 'none')
          .map((r) => parseInt(r.getAttribute('data-idx'), 10));
        const lo = Math.min(lastClickedIndex, idx);
        const hi = Math.max(lastClickedIndex, idx);
        visibleByIdx.forEach((vIdx) => {
          if (vIdx >= lo && vIdx <= hi && items[vIdx]) {
            if (targetState) selectedSet.add(items[vIdx].headspecid);
            else selectedSet.delete(items[vIdx].headspecid);
          }
        });
      } else {
        if (targetState) selectedSet.add(sid);
        else selectedSet.delete(sid);
      }

      lastClickedIndex = idx;
      syncSelectionUi();
    });

    stopBtn.addEventListener('click', () => {
      if (!uiState.isRunning) return;
      uiState.cancelRequested = true;
      stopBtn.disabled = true;
      stopBtn.textContent = 'Stopping...';
      statusBadge.textContent = 'Stopping after current request...';
      if (syncStepEl) syncStepEl.textContent = 'Stopping after current request...';
    });

    scanBtn.addEventListener('click', async () => {
      if (uiState.isRunning || savingRowIds.size > 0) return;
      const targets = getVisibleItems();
      if (targets.length === 0) return;

      await pauseAndAwaitBackgroundSync();
      const t0 = Date.now();
      setRunningUi(true, 'Checking TBE...', {
        indeterminate: false,
        step: `Preparing ${targets.length} item(s)...`,
      });

      const scanRes = await scanItemsTbe(targets, {
        isCancelled: () => uiState.cancelRequested,
        onProgress: (i, total, item) => {
          focusRow(item.headspecid);
          const pct = Math.round((i / Math.max(1, total)) * 100);
          const msg = `Checking ${i + 1}/${total} (#${item.slNo || item.index + 1})...`;
          statusBadge.textContent = msg;
          updateSyncOverlay({ percent: pct, step: msg, indeterminate: false });
        },
        onItemResult: (item, parsed) => {
          if (parsed.kind === 'has_measurements') {
            cachedIdsBySpecId.set(item.headspecid, parsed.measurementIds);
            const detailsObj = {
              kind: 'has_measurements',
              tbeQty: parsed.tbeQty,
              measurementIds: parsed.measurementIds || [],
              headDetails: parsed.headDetails || [],
              hasDetailed: hasDetailedSplitUp(parsed),
            };
            tbeDetailsBySpecId.set(item.headspecid, detailsObj);
            const curDraftMap = dirtyHeadsBySpecId.get(item.headspecid);
            const hasDirtyDrafts =
              curDraftMap && Array.from(curDraftMap.values()).some((d) => d && d.dirty);
            if (!hasDirtyDrafts) {
              syncDraftMapFromDetails(item.headspecid, detailsObj);
            }
            syncRowSplitLockUi(item.headspecid);
            if (activeSplitSpecId === item.headspecid && !hasDirtyDrafts) {
              renderSplitUpPanel(item.headspecid);
            }
            if (parsed.tbeQty !== null) {
              setRowTbeInputValue(item.headspecid, parsed.tbeQty, true);
            }
            const qtySuffix =
              parsed.tbeQty !== null ? ` · ${escapeHtml(formatQty(parsed.tbeQty))}` : '';
            setRowStatus(
              item.headspecid,
              'checked',
              `<span class="p3h-re-pill-info">${parsed.count} head${
                parsed.count === 1 ? '' : 's'
              }${qtySuffix}</span>`
            );
          } else if (parsed.kind === 'empty') {
            cachedIdsBySpecId.set(item.headspecid, []);
            const emptyObj = {
              kind: 'empty',
              tbeQty: 0,
              measurementIds: [],
              headDetails: [],
              hasDetailed: false,
            };
            tbeDetailsBySpecId.set(item.headspecid, emptyObj);
            const curDraftMap = dirtyHeadsBySpecId.get(item.headspecid);
            const hasDirtyDrafts =
              curDraftMap && Array.from(curDraftMap.values()).some((d) => d && d.dirty);
            if (!hasDirtyDrafts) {
              syncDraftMapFromDetails(item.headspecid, emptyObj);
            }
            syncRowSplitLockUi(item.headspecid);
            if (activeSplitSpecId === item.headspecid && !hasDirtyDrafts) {
              renderSplitUpPanel(item.headspecid);
            }
            selectedSet.delete(item.headspecid);
            setRowTbeInputValue(item.headspecid, 0, true);
            setRowStatus(
              item.headspecid,
              'skipped',
              `<span class="p3h-re-pill-skip">⊘ No TBE</span>`,
              parsed.note || 'No To-Be-Executed measurements'
            );
          } else {
            setRowStatus(
              item.headspecid,
              'error',
              `<span class="p3h-re-pill-err">✘ Error</span>`,
              parsed.error || 'Check failed'
            );
          }
        },
      });

      rowNodes.forEach((r) => r.classList.remove('p3h-re-row-active'));
      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      pbar.style.width = '100%';
      setRunningUi(false);

      if (scanRes.sessionExpired) {
        hasSessionExpired = true;
        pbar.style.background = '#dc2626';
        statusBadge.classList.add('p3h-re-status-err');
        statusBadge.textContent = 'Session expired — log in again';
      } else if (scanRes.stopped) {
        pbar.style.background = '#d97706';
        statusBadge.classList.add('p3h-re-status-warn');
        statusBadge.textContent = `Stopped (${scanRes.withTbe} with TBE · ${scanRes.empty} empty)`;
      } else {
        pbar.style.background = scanRes.errors > 0 ? '#d97706' : '#16a34a';
        statusBadge.classList.add(scanRes.errors > 0 ? 'p3h-re-status-warn' : 'p3h-re-status-ok');
        statusBadge.textContent = `Checked ${scanRes.scanned}: ${scanRes.withTbe} TBE · ${scanRes.empty} empty (${elapsedSec}s)`;
      }
      scheduleBackgroundHeadingPreSync(1100);
    });

    async function runDeleteBatch(batchItems, useCache) {
      await pauseAndAwaitBackgroundSync();
      const t0 = Date.now();
      setRunningUi(true, 'Clearing TBE...', {
        indeterminate: false,
        step: `Clearing ${batchItems.length} item(s)...`,
      });
      lastFailedItems = [];

      const delSummary = await deleteItemsTbe(batchItems, {
        cachedIdsBySpecId: useCache ? cachedIdsBySpecId : null,
        isCancelled: () => uiState.cancelRequested,
        onProgress: (i, total, item, isRetry) => {
          focusRow(item.headspecid);
          const pct = Math.round((i / Math.max(1, total)) * 100);
          const msg = isRetry
            ? `Retrying ${i + 1}/${total}...`
            : `Clearing ${i + 1}/${total} (#${item.slNo || item.index + 1})...`;
          statusBadge.textContent = msg;
          updateSyncOverlay({ percent: pct, step: msg, indeterminate: false });
        },
        onRetryStart: (attempt, maxRetries, count) => {
          const msg = `Retry ${attempt}/${maxRetries} (${count} item${count === 1 ? '' : 's'})...`;
          statusBadge.textContent = msg;
          if (syncStepEl) syncStepEl.textContent = msg;
        },
        onItemResult: (item, res) => {
          if (res.status === 'deleted') {
            cachedIdsBySpecId.set(item.headspecid, []);
            tbeDetailsBySpecId.set(item.headspecid, {
              kind: 'empty',
              tbeQty: 0,
              measurementIds: [],
              headDetails: [],
              hasDetailed: false,
            });
            dirtyHeadsBySpecId.delete(item.headspecid);
            selectedSet.delete(item.headspecid);
            hasDirtyPortalChanges = true;
            if (res.headid) dirtyLastHeadId = res.headid;
            dirtyLastHeadSpecId = item.headspecid;
            updateLocalModelAfterTbeChange(item, 0);
            setRowTbeInputValue(item.headspecid, 0, false);
            syncRowSplitLockUi(item.headspecid);
            if (activeSplitSpecId === item.headspecid) renderSplitUpPanel(item.headspecid);
            const cntTxt = res.deletedCount > 0 ? ` (${res.deletedCount})` : '';
            setRowStatus(
              item.headspecid,
              'deleted',
              `<span class="p3h-re-pill-ok">✔ Deleted${cntTxt}</span>`,
              res.note || res.message || ''
            );
          } else if (res.status === 'skipped') {
            cachedIdsBySpecId.set(item.headspecid, []);
            tbeDetailsBySpecId.set(item.headspecid, {
              kind: 'empty',
              tbeQty: 0,
              measurementIds: [],
              headDetails: [],
              hasDetailed: false,
            });
            dirtyHeadsBySpecId.delete(item.headspecid);
            selectedSet.delete(item.headspecid);
            updateLocalModelAfterTbeChange(item, 0);
            setRowTbeInputValue(item.headspecid, 0, false);
            syncRowSplitLockUi(item.headspecid);
            if (activeSplitSpecId === item.headspecid) renderSplitUpPanel(item.headspecid);
            setRowStatus(
              item.headspecid,
              'skipped',
              `<span class="p3h-re-pill-skip">⊘ No TBE</span>`,
              res.note || ''
            );
          } else {
            setRowStatus(
              item.headspecid,
              'error',
              `<span class="p3h-re-pill-err">✘ Failed</span>`,
              res.error || 'Delete failed'
            );
          }
        },
      });

      rowNodes.forEach((r) => r.classList.remove('p3h-re-row-active'));

      if (delSummary.sessionExpired) {
        hasSessionExpired = true;
      }
      if (delSummary.deleted > 0) {
        hasDirtyPortalChanges = true;
        if (delSummary.lastHeadId) dirtyLastHeadId = delSummary.lastHeadId;
        if (delSummary.lastHeadSpecId) dirtyLastHeadSpecId = delSummary.lastHeadSpecId;
      }

      lastFailedItems = batchItems.filter((it) => {
        const res = delSummary.resultsBySpecId.get(it.headspecid);
        return res && res.status === 'error';
      });

      const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
      pbar.style.width = '100%';
      setRunningUi(false);
      cancelBtn.textContent = 'Close';

      if (lastFailedItems.length > 0 && !delSummary.sessionExpired) {
        retryBtn.style.display = 'inline-flex';
        retryBtn.textContent = `Retry Failed (${lastFailedItems.length})`;
      } else {
        retryBtn.style.display = 'none';
      }

      if (delSummary.sessionExpired) {
        pbar.style.background = '#dc2626';
        statusBadge.classList.add('p3h-re-status-err');
        statusBadge.textContent = 'Session expired — log in again';
      } else if (delSummary.stopped) {
        pbar.style.background = '#d97706';
        statusBadge.classList.add('p3h-re-status-warn');
        statusBadge.textContent = `Stopped: ${delSummary.deleted} cleared · ${delSummary.skipped} no TBE · ${delSummary.errors} errors`;
      } else if (delSummary.errors > 0) {
        pbar.style.background = '#dc2626';
        statusBadge.classList.add('p3h-re-status-err');
        statusBadge.textContent = `Done (${elapsedSec}s): ${delSummary.deleted} cleared · ${delSummary.skipped} no TBE · ${delSummary.errors} errors`;
      } else {
        pbar.style.background = '#16a34a';
        statusBadge.classList.add('p3h-re-status-ok');
        statusBadge.textContent = `Done (${elapsedSec}s): ${delSummary.deleted} cleared · ${delSummary.skipped} no TBE`;
      }
      scheduleBackgroundHeadingPreSync(1100);
    }

    deleteBtn.addEventListener('click', () => {
      if (uiState.isRunning || savingRowIds.size > 0 || selectedSet.size === 0) return;
      const toProcess = items.filter((it) => selectedSet.has(it.headspecid));
      const hName = extracted.headingName || 'current heading';
      const ok = confirm(
        `Clear all "To Be Executed" measurements for ${toProcess.length} selected item(s) under "${hName}"?\n\nExecuted (e-MBook) measurements will NOT be affected.`
      );
      if (!ok) return;
      runDeleteBatch(toProcess, true);
    });

    retryBtn.addEventListener('click', () => {
      if (uiState.isRunning || savingRowIds.size > 0 || lastFailedItems.length === 0) return;
      runDeleteBatch(lastFailedItems.slice(), false);
    });

    cancelBtn.addEventListener('click', () => closeReBatchModal(false));
    closeXBtn.addEventListener('click', () => closeReBatchModal(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && !uiState.isRunning && savingRowIds.size === 0) closeReBatchModal(false);
    });

    applyVisibilityFilter();
    refreshHeadingSelectLabels('');

    if (!currentBundle && !ctx.hasMeasurementFormOpen && items.length > 0) {
      loadModalHelperData(false);
    } else if (!ctx.hasMeasurementFormOpen) {
      scheduleBackgroundHeadingPreSync(1100);
    }
  }

  async function loadReHelperFromToolbar(helperBtn, forceRefreshOverride) {
    if (uiState.isRunning || uiState.helperLoading) return;
    const ctxRes =
      extractor && typeof extractor.syncBridgeCall === 'function'
        ? extractor.syncBridgeCall('re:getContext', {})
        : { bridged: false, ok: false };
    const ctx = (ctxRes && ctxRes.ok && ctxRes.result) || {};
    const { bundle: existingBundle } = getActiveCachedHelperBundle(document, ctx);
    const force =
      forceRefreshOverride !== undefined ? Boolean(forceRefreshOverride) : Boolean(existingBundle);

    uiState.helperLoading = true;
    uiState.lastBtnSig = '';
    if (helperBtn) {
      helperBtn.disabled = true;
      helperBtn.textContent = 'Loading...';
    }

    let res;
    try {
      res = await fetchReHeadingHelperData({
        doc: document,
        bridgeCtx: ctx,
        forceRefresh: force,
        onStatus: (msg) => {
          if (helperBtn) helperBtn.textContent = msg;
        },
      });
    } finally {
      uiState.helperLoading = false;
      uiState.lastBtnSig = '';
      syncReTriggerButton();
    }

    if (res && res.ok && res.bundle) {
      uiState.inlineHelpersHidden = false;
      renderInlineReHelpers(document, res.bundle);
      uiState.lastBtnSig = '';
      syncReTriggerButton();
    } else if (res && res.error) {
      const btnAfter = document.getElementById('p3h-re-helper-btn');
      if (btnAfter) {
        btnAfter.title = res.error;
        btnAfter.textContent = res.sessionExpired ? 'Session Expired' : 'Retry DPR & MBook';
      }
      if (res.formOpen || res.sessionExpired) {
        alert(res.error);
      }
    }
  }

  function syncReTriggerButton() {
    if (!hasDocument) return;
    if (!isReEditorPresent(document)) {
      const existing = document.getElementById('p3h-re-batch-btn');
      if (existing) existing.remove();
      const existingHelper = document.getElementById('p3h-re-helper-btn');
      if (existingHelper) existingHelper.remove();
      if (uiState.modalActive && !uiState.isRunning) closeReBatchModal(true);
      uiState.lastBtnSig = '';
      return;
    }

    const tabRight = document.querySelector('#pt-slide-right ul#tabs li.pt-tab-right');
    const breadcrumb = document.getElementById('pt-breadcrumb');
    const mountTarget = tabRight || breadcrumb;
    if (!mountTarget) return;

    const ctxRes =
      extractor && typeof extractor.syncBridgeCall === 'function'
        ? extractor.syncBridgeCall('re:getContext', {})
        : { bridged: false, ok: false };
    const bridgeCtx = (ctxRes && ctxRes.ok && ctxRes.result) || {};
    const extracted = extractReSpecItems(document);
    const totalCount = extracted.items.length;
    const activeCount = extracted.items.filter((i) => i.amount > 0 || i.qty > 0).length;
    const cached = getActiveCachedHelperBundle(document, bridgeCtx);
    const hasBundle = Boolean(cached.bundle);
    const mountKey = tabRight ? 'tab' : 'bc';
    const sig = `${mountKey}|${activeCount}|${totalCount}|${extracted.headingName}|${
      hasBundle ? cached.bundle.fetchedAt : 0
    }|${uiState.helperLoading ? 1 : 0}|${uiState.inlineHelpersHidden ? 1 : 0}`;

    let btn = document.getElementById('p3h-re-batch-btn');
    let helperBtn = document.getElementById('p3h-re-helper-btn');

    if (hasBundle && totalCount > 0) {
      if (uiState.inlineHelpersHidden) {
        clearInlineReHelpers(document);
      } else {
        renderInlineReHelpers(document, cached.bundle);
      }
    }

    if (
      btn &&
      btn.parentElement === mountTarget &&
      helperBtn &&
      helperBtn.parentElement === mountTarget &&
      sig === uiState.lastBtnSig
    ) {
      return;
    }

    if (!helperBtn) {
      helperBtn = document.createElement('button');
      helperBtn.type = 'button';
      helperBtn.id = 'p3h-re-helper-btn';
      helperBtn.className = 'p3h-re-trigger-btn p3h-re-helper-btn';
      helperBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (uiState.isRunning || uiState.helperLoading) return;
        const curCtxRes =
          extractor && typeof extractor.syncBridgeCall === 'function'
            ? extractor.syncBridgeCall('re:getContext', {})
            : { bridged: false, ok: false };
        const curCtx = (curCtxRes && curCtxRes.ok && curCtxRes.result) || {};
        const { bundle: curBundle } = getActiveCachedHelperBundle(document, curCtx);
        if (!curBundle || e.shiftKey) {
          uiState.inlineHelpersHidden = false;
          loadReHelperFromToolbar(helperBtn, Boolean(curBundle));
          return;
        }
        uiState.inlineHelpersHidden = !uiState.inlineHelpersHidden;
        if (uiState.inlineHelpersHidden) {
          clearInlineReHelpers(document);
        }
        uiState.lastBtnSig = '';
        syncReTriggerButton();
      });
    }

    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'p3h-re-batch-btn';
      btn.className = 'p3h-re-trigger-btn';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openReBatchModal();
      });
    }

    if (helperBtn.parentElement !== mountTarget) {
      if (btn.parentElement === mountTarget) {
        mountTarget.insertBefore(helperBtn, btn);
      } else {
        mountTarget.appendChild(helperBtn);
      }
    }
    if (btn.parentElement !== mountTarget) {
      mountTarget.appendChild(btn);
    }

    helperBtn.classList.toggle('p3h-re-helper-loaded', hasBundle && !uiState.inlineHelpersHidden);
    helperBtn.classList.toggle('p3h-re-helper-hidden', hasBundle && uiState.inlineHelpersHidden);
    helperBtn.disabled = totalCount === 0 || uiState.helperLoading;
    if (!uiState.helperLoading) {
      helperBtn.textContent = !hasBundle
        ? 'Load DPR & MBook'
        : uiState.inlineHelpersHidden
        ? 'Show DPR & MBook'
        : 'Hide DPR & MBook';
    }
    helperBtn.title =
      totalCount === 0
        ? 'No specification items in active RE heading'
        : !hasBundle
        ? 'Load DPR (Original Sanctioned) & e-MBook quantities as inline helpers for this heading'
        : uiState.inlineHelpersHidden
        ? 'Helper chips hidden for original official page view — click to show DPR & e-MBook chips (Shift+click to refresh data)'
        : 'Hide inline DPR & e-MBook helper chips to view original official page (Shift+click to refresh data)';

    btn.textContent = totalCount > 0 ? `RE Helper (${totalCount})` : 'RE Helper';
    btn.disabled = totalCount === 0;
    btn.title =
      totalCount > 0
        ? `Open RE Helper to inspect DPR/MBook and edit or delete "To Be Executed" quantities (${activeCount} active / ${totalCount} items)`
        : 'No specification items in active RE heading';
    uiState.lastBtnSig = sig;
  }

  if (hasDocument) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && uiState.mbookModalActive) {
        if (!uiState.isRunning && uiState.activeSaveCount === 0 && typeof uiState.closeMbookModalHook === 'function') {
          uiState.closeMbookModalHook(false);
        }
        return;
      }
      if (e.key === 'Escape' && uiState.modalActive && !uiState.isRunning && uiState.activeSaveCount === 0) {
        if (typeof uiState.closeSplitCardHook === 'function' && uiState.closeSplitCardHook()) {
          return;
        }
        closeReBatchModal(false);
      }
    });

    if (typeof MutationObserver !== 'undefined' && document.body) {
      let timer = null;
      const observer = new MutationObserver((mutations) => {
        const onlyInternal = mutations.every((m) => {
          const t = m.target;
          return Boolean(t && t.closest && t.closest(RE_INTERNAL_SELECTOR));
        });
        if (onlyInternal) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(syncReTriggerButton, 180);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      syncReTriggerButton();
    }
  }

  const reBatchApi = Object.freeze({
    parseHeadSpecIdFromOnclick,
    parseHeadIdFromOnclick,
    parseAmountNumber,
    parseQtyNumber,
    parseSignedNumberOrNull,
    roundQty,
    formatQty,
    roundQty3,
    formatEditableQty,
    parseEditableQtyInput,
    parseUnitRateNumber,
    extractQtyUnit,
    formatCompactSpecCode,
    computeQtyDeviation,
    isSafePortalEndpoint,
    evalMeasurementExpr,
    formatDimensionForSubmit,
    computeMeasurementRowQty,
    hasDetailedSplitUp,
    buildMeasurementHeadFormParams,
    isReEditorPresent,
    extractReHeadingsList,
    extractReSpecItems,
    resolveReWorkContext,
    parseToBeExecutedHtml,
    parseDeleteReResponse,
    parseSaveReTbeResponse,
    buildSingleRowTbeFormParams,
    parseReDeviationStatementHtml,
    sumDeviationTotals,
    formatReImpactSummary,
    extractRePageTotalsFromDoc,
    parseApprovedDprHeadingTotalsHtml,
    parseEmbookSpecTotalsHtml,
    parseMbookPendingAeHtml,
    parseMbookEntryDetailsHtml,
    parseMbookEditFormHtml,
    validateAndComputeMbookRow,
    buildMbookUpdateParams,
    parseMbookMutationResponse,
    parseApprovedDprSpecsHtml,
    buildReHelperRowModel,
    formatModalMbookCellHtml,
    formatModalTbeCellHtml,
    fetchReHeadingHelperData,
    loadMbookPendingEntries,
    saveMbookPendingEntry,
    deleteMbookPendingRows,
    restoreReSession,
    renderInlineHelperHtml,
    clearInlineReHelpers,
    renderInlineReHelpers,
    scanItemsTbe,
    deleteItemsTbe,
    upsertItemTbeQty,
    fetchItemTbeDetails,
    saveItemTbeHead,
    deleteItemTbeHead,
  });

  P3H.reBatch = reBatchApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = reBatchApi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
