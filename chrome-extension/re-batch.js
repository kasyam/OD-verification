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
    '#p3h-toolbar, #p3h-drawer, #p3h-drawer-backdrop, #p3h-register-modal, .p3h-cell-meta, #pt-file_table_list, .dataTables_wrapper, #p3h-re-modal-overlay, #p3h-re-batch-btn, .p3h-re-trigger-btn';

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

  /**
   * Parses the server response from `POST call_to_be_executed.pro`.
   * Classifies into `has_measurements`, `empty`, `session_expired`, or `error`.
   */
  function parseToBeExecutedHtml(html, expectedHeadSpecId) {
    const raw = String(html == null ? '' : html).trim();
    if (!raw) {
      return { kind: 'error', measurementIds: [], count: 0, error: 'Empty response' };
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
            note: (obj && obj.message) || 'No To-Be-Executed measurements',
          };
        }
        return {
          kind: 'error',
          measurementIds: [],
          count: 0,
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
        error: 'Portal returned an error page',
      };
    }

    if (typeof DOMParser === 'undefined') {
      return { kind: 'error', measurementIds: [], count: 0, error: 'DOMParser unavailable' };
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
    }

    if (measurementIds.length > 0) {
      return {
        kind: 'has_measurements',
        measurementIds,
        count: measurementIds.length,
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
        note: 'No To-Be-Executed measurements',
      };
    }

    return {
      kind: 'error',
      measurementIds: [],
      count: 0,
      error: 'Unrecognized To-Be-Executed response',
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

  // -------------------------------------------------------------------------
  // Browser UI Integration & Lifecycle
  // -------------------------------------------------------------------------

  const uiState = {
    lastBtnSig: '',
    modalActive: false,
    isRunning: false,
    cancelRequested: false,
  };

  function closeReBatchModal() {
    if (uiState.isRunning) return;
    const overlay = typeof document !== 'undefined' && document.getElementById('p3h-re-modal-overlay');
    if (overlay) overlay.remove();
    uiState.modalActive = false;
    uiState.cancelRequested = false;
  }

  function openReBatchModal() {
    if (!hasDocument || document.getElementById('p3h-re-modal-overlay')) return;

    const ctxRes =
      extractor && typeof extractor.syncBridgeCall === 'function'
        ? extractor.syncBridgeCall('re:getContext', {})
        : { bridged: false, ok: false };
    const ctx = (ctxRes && ctxRes.ok && ctxRes.result) || {};
    const extracted = extractReSpecItems(document);
    const items = extracted.items;

    const activeItems = items.filter((i) => i.amount > 0 || i.qty > 0);
    const zeroItemsCount = items.length - activeItems.length;
    let showZeroItems = activeItems.length === 0 && items.length > 0;
    const selectedSet = new Set(
      (showZeroItems ? items : activeItems).map((it) => it.headspecid)
    );
    const cachedIdsBySpecId = new Map();
    const rowStatuses = new Map();
    let lastFailedItems = [];
    let lastClickedIndex = null;

    const overlay = document.createElement('div');
    overlay.id = 'p3h-re-modal-overlay';
    overlay.className = 'p3h-re-modal-overlay';

    const headingLabel = extracted.headingName ? escapeHtml(extracted.headingName) : 'Current Heading';
    const warnHtml = ctx.hasMeasurementFormOpen
      ? `<div class="p3h-re-warn-banner">Measurement entry screen is currently open. Close or save it before deleting items.</div>`
      : '';

    overlay.innerHTML = `
      <div class="p3h-re-modal" role="dialog" aria-modal="true" aria-labelledby="p3h-re-modal-title">
        <div class="p3h-re-progress-track"><div class="p3h-re-progress-fill" id="p3h-re-pbar"></div></div>
        <div class="p3h-re-header">
          <div class="p3h-re-title-wrap">
            <h3 id="p3h-re-modal-title">Clear "To Be Executed" Measurements</h3>
            <span class="p3h-re-heading-pill" title="Active Estimate Heading">${headingLabel}</span>
            <span class="p3h-re-status-badge" id="p3h-re-status" style="display:none;"></span>
          </div>
          <button type="button" class="p3h-re-close-x" id="p3h-re-close-x" title="Close">×</button>
        </div>
        ${warnHtml}
        <div class="p3h-re-tip">
          <span>Only <strong>To Be Executed</strong> measurements are deleted; <strong>Executed (e-MBook)</strong> measurements remain untouched. Hold <kbd class="p3h-re-kbd">Shift</kbd> + click to select a range.</span>
        </div>
        <div class="p3h-re-toolbar" id="p3h-re-toolbar">
          <input type="text" class="p3h-input p3h-re-search" id="p3h-re-search" placeholder="Filter by #, spec code, or description...">
          <div class="p3h-re-tool-btns">
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-all-btn">All</button>
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-none-btn">None</button>
            <button type="button" class="p3h-btn p3h-btn-sm" id="p3h-re-invert-btn">Invert</button>
            ${
              zeroItemsCount > 0
                ? `<label class="p3h-re-zero-toggle"><input type="checkbox" id="p3h-re-zero-cb" ${
                    showZeroItems ? 'checked' : ''
                  }> Show ₹0 items (${zeroItemsCount})</label>`
                : ''
            }
            <button type="button" class="p3h-btn p3h-btn-sm p3h-btn-primary" id="p3h-re-scan-btn" title="Read-only pre-check to count TBE measurement heads and uncheck Executed-only items">Check TBE</button>
          </div>
        </div>
        <div class="p3h-re-content" id="p3h-re-content">
          <table class="p3h-re-table">
            <thead>
              <tr>
                <th width="36" style="text-align:center;"><input type="checkbox" id="p3h-re-header-cb"></th>
                <th width="46">#</th>
                <th width="145">Spec</th>
                <th>Description</th>
                <th width="130" style="text-align:right;">Qty / Amount</th>
                <th width="120" style="text-align:center;">Status</th>
              </tr>
            </thead>
            <tbody id="p3h-re-tbody">
              ${
                items.length === 0
                  ? `<tr><td colspan="6" style="text-align:center;padding:28px;color:#64748b;">No items found in the active heading.</td></tr>`
                  : items
                      .map(
                        (it) => `
                  <tr class="p3h-re-row" data-specid="${escapeHtml(it.headspecid)}" data-idx="${it.index}">
                    <td style="text-align:center;"><input type="checkbox" class="p3h-re-cb" data-specid="${escapeHtml(
                      it.headspecid
                    )}" ${selectedSet.has(it.headspecid) ? 'checked' : ''}></td>
                    <td class="p3h-re-sl">${escapeHtml(it.slNo || String(it.index + 1))}</td>
                    <td class="p3h-re-spec">
                      <span>${escapeHtml(it.specCode || '-')}</span>
                      ${it.isBgFix ? '<span class="p3h-re-bgfix-tag">BG-FIX</span>' : ''}
                    </td>
                    <td class="p3h-re-desc">${escapeHtml(it.desc)}</td>
                    <td class="p3h-re-amt">
                      <div>${escapeHtml(it.qtyText || '0')}</div>
                      <div class="p3h-re-amt-sub">₹${escapeHtml(formatInr(it.amount))}</div>
                    </td>
                    <td class="p3h-re-status-cell" data-status-cell="${escapeHtml(it.headspecid)}">
                      <span class="p3h-re-pill-muted">Pending</span>
                    </td>
                  </tr>`
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
        <div class="p3h-re-footer">
          <div class="p3h-re-summary" id="p3h-re-summary"></div>
          <div class="p3h-re-footer-actions">
            <button type="button" class="p3h-btn p3h-btn-warn" id="p3h-re-stop-btn" style="display:none;">Stop</button>
            <button type="button" class="p3h-btn p3h-btn-primary" id="p3h-re-retry-btn" style="display:none;">Retry Failed (0)</button>
            <button type="button" class="p3h-btn" id="p3h-re-cancel-btn">Cancel</button>
            <button type="button" class="p3h-btn p3h-btn-danger-solid" id="p3h-re-delete-btn">Delete Selected TBE</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    uiState.modalActive = true;
    uiState.isRunning = false;
    uiState.cancelRequested = false;

    const modalEl = overlay.querySelector('.p3h-re-modal');
    const pbar = overlay.querySelector('#p3h-re-pbar');
    const statusBadge = overlay.querySelector('#p3h-re-status');
    const closeXBtn = overlay.querySelector('#p3h-re-close-x');
    const searchInput = overlay.querySelector('#p3h-re-search');
    const allBtn = overlay.querySelector('#p3h-re-all-btn');
    const noneBtn = overlay.querySelector('#p3h-re-none-btn');
    const invertBtn = overlay.querySelector('#p3h-re-invert-btn');
    const zeroCb = overlay.querySelector('#p3h-re-zero-cb');
    const scanBtn = overlay.querySelector('#p3h-re-scan-btn');
    const headerCb = overlay.querySelector('#p3h-re-header-cb');
    const tbody = overlay.querySelector('#p3h-re-tbody');
    const summaryEl = overlay.querySelector('#p3h-re-summary');
    const stopBtn = overlay.querySelector('#p3h-re-stop-btn');
    const retryBtn = overlay.querySelector('#p3h-re-retry-btn');
    const cancelBtn = overlay.querySelector('#p3h-re-cancel-btn');
    const deleteBtn = overlay.querySelector('#p3h-re-delete-btn');
    const rowNodes = Array.from(tbody.querySelectorAll('tr.p3h-re-row'));

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

    function getVisibleItems() {
      const term = (searchInput.value || '').trim().toLowerCase();
      return items.filter((it) => {
        if (!showZeroItems && it.amount <= 0 && it.qty <= 0) return false;
        return itemMatchesSearch(it, term);
      });
    }

    function applyVisibilityFilter() {
      const visibleIds = new Set(getVisibleItems().map((it) => it.headspecid));
      rowNodes.forEach((tr) => {
        const sid = tr.getAttribute('data-specid');
        tr.style.display = visibleIds.has(sid) ? '' : 'none';
      });
      syncSelectionUi();
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
      items.forEach((it) => {
        if (selectedSet.has(it.headspecid)) {
          totalSelectedAmt += Number(it.amount) || 0;
        }
      });

      summaryEl.textContent = `${selectedSet.size} of ${items.length} selected · ₹${formatInr(
        totalSelectedAmt
      )}`;
      deleteBtn.disabled = uiState.isRunning || selectedSet.size === 0;
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

      const cell = tr.querySelector('.p3h-re-status-cell');
      if (cell) {
        cell.innerHTML = htmlText;
        if (titleText) cell.setAttribute('title', titleText);
        else cell.removeAttribute('title');
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

    function setRunningUi(running, modeLabel) {
      uiState.isRunning = running;
      uiState.cancelRequested = false;
      modalEl.classList.toggle('p3h-re-processing', running);
      searchInput.disabled = running;
      allBtn.disabled = running;
      noneBtn.disabled = running;
      invertBtn.disabled = running;
      scanBtn.disabled = running;
      headerCb.disabled = running;
      if (zeroCb) zeroCb.disabled = running;
      rowNodes.forEach((tr) => {
        const cb = tr.querySelector('.p3h-re-cb');
        if (cb) cb.disabled = running;
      });
      closeXBtn.disabled = running;

      if (running) {
        statusBadge.style.display = 'inline-block';
        statusBadge.className = 'p3h-re-status-badge';
        statusBadge.textContent = modeLabel || 'Working...';
        pbar.style.background = '#2563eb';
        pbar.style.width = '0%';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop';
        retryBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        deleteBtn.style.display = 'none';
      } else {
        stopBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-flex';
        deleteBtn.style.display = 'inline-flex';
        syncSelectionUi();
      }
    }

    searchInput.addEventListener('input', applyVisibilityFilter);

    if (zeroCb) {
      zeroCb.addEventListener('change', () => {
        showZeroItems = zeroCb.checked;
        applyVisibilityFilter();
      });
    }

    allBtn.addEventListener('click', () => {
      if (uiState.isRunning) return;
      getVisibleItems().forEach((it) => selectedSet.add(it.headspecid));
      syncSelectionUi();
    });

    noneBtn.addEventListener('click', () => {
      if (uiState.isRunning) return;
      getVisibleItems().forEach((it) => selectedSet.delete(it.headspecid));
      syncSelectionUi();
    });

    invertBtn.addEventListener('click', () => {
      if (uiState.isRunning) return;
      getVisibleItems().forEach((it) => {
        if (selectedSet.has(it.headspecid)) selectedSet.delete(it.headspecid);
        else selectedSet.add(it.headspecid);
      });
      syncSelectionUi();
    });

    headerCb.addEventListener('change', () => {
      if (uiState.isRunning) return;
      const check = headerCb.checked;
      getVisibleItems().forEach((it) => {
        if (check) selectedSet.add(it.headspecid);
        else selectedSet.delete(it.headspecid);
      });
      syncSelectionUi();
    });

    tbody.addEventListener('click', (e) => {
      if (uiState.isRunning) return;
      const tr = e.target && e.target.closest ? e.target.closest('tr.p3h-re-row') : null;
      if (!tr || tr.style.display === 'none') return;
      const sid = tr.getAttribute('data-specid');
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
    });

    scanBtn.addEventListener('click', async () => {
      if (uiState.isRunning) return;
      const targets = getVisibleItems();
      if (targets.length === 0) return;

      const t0 = Date.now();
      setRunningUi(true, 'Checking TBE...');

      const scanRes = await scanItemsTbe(targets, {
        isCancelled: () => uiState.cancelRequested,
        onProgress: (i, total, item) => {
          focusRow(item.headspecid);
          pbar.style.width = `${Math.round((i / Math.max(1, total)) * 100)}%`;
          statusBadge.textContent = `Checking ${i + 1}/${total}...`;
        },
        onItemResult: (item, parsed) => {
          if (parsed.kind === 'has_measurements') {
            cachedIdsBySpecId.set(item.headspecid, parsed.measurementIds);
            selectedSet.add(item.headspecid);
            setRowStatus(
              item.headspecid,
              'checked',
              `<span class="p3h-re-pill-info">${parsed.count} head${
                parsed.count === 1 ? '' : 's'
              }</span>`
            );
          } else if (parsed.kind === 'empty') {
            cachedIdsBySpecId.set(item.headspecid, []);
            selectedSet.delete(item.headspecid);
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
    });

    async function runDeleteBatch(batchItems, useCache) {
      const t0 = Date.now();
      setRunningUi(true, 'Deleting TBE...');
      lastFailedItems = [];

      const delSummary = await deleteItemsTbe(batchItems, {
        cachedIdsBySpecId: useCache ? cachedIdsBySpecId : null,
        isCancelled: () => uiState.cancelRequested,
        onProgress: (i, total, item, isRetry) => {
          focusRow(item.headspecid);
          pbar.style.width = `${Math.round((i / Math.max(1, total)) * 100)}%`;
          statusBadge.textContent = isRetry
            ? `Retrying ${i + 1}/${total}...`
            : `Deleting ${i + 1}/${total}...`;
        },
        onRetryStart: (attempt, maxRetries, count) => {
          statusBadge.textContent = `Retry ${attempt}/${maxRetries} (${count} item${
            count === 1 ? '' : 's'
          })...`;
        },
        onItemResult: (item, res) => {
          if (res.status === 'deleted') {
            cachedIdsBySpecId.set(item.headspecid, []);
            selectedSet.delete(item.headspecid);
            const cntTxt = res.deletedCount > 0 ? ` (${res.deletedCount})` : '';
            setRowStatus(
              item.headspecid,
              'deleted',
              `<span class="p3h-re-pill-ok">✔ Deleted${cntTxt}</span>`,
              res.note || res.message || ''
            );
          } else if (res.status === 'skipped') {
            cachedIdsBySpecId.set(item.headspecid, []);
            selectedSet.delete(item.headspecid);
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

      if (delSummary.deleted > 0 && !delSummary.sessionExpired) {
        if (extractor && typeof extractor.syncBridgeCall === 'function') {
          extractor.syncBridgeCall('re:refreshAfterDelete', {
            headId: delSummary.lastHeadId || ctx.curHeadId || extracted.headId,
            lastHeadSpecId: delSummary.lastHeadSpecId,
          });
        }
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
        statusBadge.textContent = `Stopped: ${delSummary.deleted} deleted · ${delSummary.skipped} no TBE · ${delSummary.errors} errors`;
      } else if (delSummary.errors > 0) {
        pbar.style.background = '#dc2626';
        statusBadge.classList.add('p3h-re-status-err');
        statusBadge.textContent = `Done (${elapsedSec}s): ${delSummary.deleted} deleted · ${delSummary.skipped} no TBE · ${delSummary.errors} errors`;
      } else {
        pbar.style.background = '#16a34a';
        statusBadge.classList.add('p3h-re-status-ok');
        statusBadge.textContent = `Done (${elapsedSec}s): ${delSummary.deleted} deleted · ${delSummary.skipped} no TBE`;
      }
    }

    deleteBtn.addEventListener('click', () => {
      if (uiState.isRunning || selectedSet.size === 0) return;
      const toProcess = items.filter((it) => selectedSet.has(it.headspecid));
      const hName = extracted.headingName || 'current heading';
      const ok = confirm(
        `Delete all "To Be Executed" measurements for ${toProcess.length} selected item(s) under "${hName}"?\n\nExecuted (e-MBook) measurements will NOT be affected.`
      );
      if (!ok) return;
      runDeleteBatch(toProcess, true);
    });

    retryBtn.addEventListener('click', () => {
      if (uiState.isRunning || lastFailedItems.length === 0) return;
      runDeleteBatch(lastFailedItems.slice(), false);
    });

    cancelBtn.addEventListener('click', closeReBatchModal);
    closeXBtn.addEventListener('click', closeReBatchModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && !uiState.isRunning) closeReBatchModal();
    });

    applyVisibilityFilter();
  }

  function syncReTriggerButton() {
    if (!hasDocument) return;
    if (!isReEditorPresent(document)) {
      const existing = document.getElementById('p3h-re-batch-btn');
      if (existing) existing.remove();
      if (uiState.modalActive && !uiState.isRunning) closeReBatchModal();
      uiState.lastBtnSig = '';
      return;
    }

    const tabRight = document.querySelector('#pt-slide-right ul#tabs li.pt-tab-right');
    const breadcrumb = document.getElementById('pt-breadcrumb');
    const mountTarget = tabRight || breadcrumb;
    if (!mountTarget) return;

    const extracted = extractReSpecItems(document);
    const totalCount = extracted.items.length;
    const activeCount = extracted.items.filter((i) => i.amount > 0 || i.qty > 0).length;
    const mountKey = tabRight ? 'tab' : 'bc';
    const sig = `${mountKey}|${activeCount}|${totalCount}|${extracted.headingName}`;

    let btn = document.getElementById('p3h-re-batch-btn');
    if (btn && btn.parentElement === mountTarget && sig === uiState.lastBtnSig) {
      return;
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

    if (btn.parentElement !== mountTarget) {
      mountTarget.appendChild(btn);
    }

    btn.textContent = totalCount > 0 ? `Clear TBE (${activeCount})` : 'Clear TBE';
    btn.disabled = totalCount === 0;
    btn.title =
      totalCount > 0
        ? `Batch inspect & clear "To Be Executed" measurements (${activeCount} active / ${totalCount} items)`
        : 'No specification items in active RE heading';
    uiState.lastBtnSig = sig;
  }

  if (hasDocument) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && uiState.modalActive && !uiState.isRunning) {
        closeReBatchModal();
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
    isReEditorPresent,
    extractReSpecItems,
    parseToBeExecutedHtml,
    parseDeleteReResponse,
    scanItemsTbe,
    deleteItemsTbe,
  });

  P3H.reBatch = reBatchApi;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = reBatchApi;
  }
})(typeof window !== 'undefined' ? window : globalThis);
