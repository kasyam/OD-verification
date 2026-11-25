/**
 * PRICE 3.0 Helper — Minimal MAIN-World Page Bridge
 *
 * Exposes zero globals on window and responds only to allowlisted synchronous
 * CustomEvent requests from the extension's ISOLATED content scripts:
 *   - Reading/updating PRICE 3.0 CSRF token (window.GTOKEN / input[name="price_token"])
 *   - Accessing page jQuery DataTables rows, search-applied rows, filtering, and page length
 */
(function () {
  'use strict';

  const BRIDGE_SYM = Symbol.for('p3h.pageBridge.v1');
  if (typeof document === 'undefined' || document[BRIDGE_SYM]) return;
  try {
    Object.defineProperty(document, BRIDGE_SYM, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (e) {
    return;
  }

  const rowMetaMap = new WeakMap();
  let currentTable = null;
  let currentDt = null;
  let currentSettings = null;
  let dtFilterRegistered = false;
  let pendingPageChange = false;
  const filterState = {
    active: false,
    visibleSet: null,
  };

  function cleanSingleLine(str) {
    return String(str == null ? '' : str)
      .replace(/\s+/g, ' ')
      .trim();
  }

  const BLOCK_TAGS = new Set([
    'BR',
    'P',
    'DIV',
    'LI',
    'TR',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
  ]);

  function extractSubjectText(td) {
    if (!td) return '';
    const parts = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.classList && node.classList.contains('p3h-cell-meta')) return;
      const tag = node.tagName ? node.tagName.toUpperCase() : '';
      if (tag === 'BR') {
        parts.push('\n');
        return;
      }
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock && parts.length > 0 && parts[parts.length - 1] !== '\n') {
        parts.push('\n');
      }
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }
      if (isBlock && parts.length > 0 && parts[parts.length - 1] !== '\n') {
        parts.push('\n');
      }
    };
    walk(td);
    return parts
      .join('')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractRowMetaFromTr(tr) {
    if (!tr || !tr.querySelectorAll) return null;
    if (rowMetaMap.has(tr)) {
      return rowMetaMap.get(tr);
    }

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

    const meta = {
      rowNo: cleanSingleLine(tds[0].textContent),
      fileId,
      fileNumber: cleanSingleLine(tds[1].textContent),
      subject: extractSubjectText(tds[2]),
      createdBy: cleanSingleLine(tds[3].textContent),
      createdOn: cleanSingleLine(tds[4].textContent),
    };
    rowMetaMap.set(tr, meta);
    return meta;
  }

  function resolveTableAndDt(selector) {
    const sel = typeof selector === 'string' && selector ? selector : '#pt-file_table_list';
    const table = document.querySelector(sel);
    if (!table) return { table: null, jq: null, dt: null };
    const jq = window.jQuery;
    if (jq && jq.fn && jq.fn.dataTable && jq.fn.dataTable.isDataTable(table)) {
      return { table, jq, dt: jq(table).DataTable() };
    }
    return { table, jq, dt: null };
  }

  function respond(id, ok, result, error) {
    document.dispatchEvent(
      new CustomEvent('p3h:bridge:res', {
        detail: JSON.stringify({
          id,
          ok: Boolean(ok),
          result: ok ? result : null,
          error: ok ? null : String(error || 'Bridge error'),
        }),
      })
    );
  }

  function handleAction(action, payload) {
    switch (action) {
      case 'getToken': {
        if (typeof window.GTOKEN === 'string' && window.GTOKEN.trim()) {
          return window.GTOKEN.trim();
        }
        const gtokenEl = document.getElementById('gtoken');
        if (gtokenEl && typeof gtokenEl.value === 'string' && gtokenEl.value.trim()) {
          return gtokenEl.value.trim();
        }
        const inp = document.querySelector('input[name="price_token"]');
        return inp && typeof inp.value === 'string' ? inp.value.trim() : '';
      }

      case 'setToken': {
        const tok = payload && typeof payload.token === 'string' ? payload.token.trim() : '';
        if (!tok) return false;
        window.GTOKEN = tok;
        const gtokenEl = document.getElementById('gtoken');
        if (gtokenEl && 'value' in gtokenEl) {
          gtokenEl.value = tok;
        }
        document.querySelectorAll('input[name="price_token"]').forEach((inp) => {
          inp.value = tok;
        });
        return true;
      }

      case 'dt:ensure': {
        const { table, jq, dt } = resolveTableAndDt(payload && payload.selector);
        if (!dt) return { hasDt: false, newlyBound: false };

        const settings = dt && dt.settings && typeof dt.settings === 'function' ? dt.settings()[0] || dt : dt;
        const newlyBound = currentTable !== table || currentSettings !== settings;
        currentTable = table;
        currentSettings = settings;
        currentDt = dt;

        if (!dtFilterRegistered) {
          jq.fn.dataTable.ext.search.push(function (settings, _data, dataIndex) {
            if (!currentTable || settings.nTable !== currentTable) return true;
            if (!filterState.active || !filterState.visibleSet) return true;
            const rowNode =
              (settings.aoData && settings.aoData[dataIndex] && settings.aoData[dataIndex].nTr) ||
              (currentDt && typeof currentDt.row === 'function'
                ? currentDt.row(dataIndex).node()
                : null);
            const meta = extractRowMetaFromTr(rowNode);
            if (!meta) return true;
            return filterState.visibleSet.has(meta.fileId);
          });
          dtFilterRegistered = true;
        }

        jq(table)
          .off('page.dt.p3h draw.dt.p3h')
          .on('page.dt.p3h', function () {
            pendingPageChange = true;
          })
          .on('draw.dt.p3h', function () {
            const pageChanged = pendingPageChange;
            pendingPageChange = false;
            if (pageChanged) {
              try {
                if (
                  document.activeElement &&
                  document.activeElement.closest &&
                  document.activeElement.closest('.dataTables_paginate')
                ) {
                  document.activeElement.blur();
                }
              } catch (_e) {}
              if (typeof setTimeout === 'function') {
                setTimeout(() => {
                  try {
                    if (
                      document.activeElement &&
                      document.activeElement.closest &&
                      document.activeElement.closest('.dataTables_paginate')
                    ) {
                      document.activeElement.blur();
                    }
                  } catch (_e) {}
                }, 0);
              }
            }
            document.dispatchEvent(
              new CustomEvent('p3h:dt:draw', {
                detail: JSON.stringify({ pageChanged }),
              })
            );
          });

        return { hasDt: true, newlyBound };
      }

      case 'dt:getAllRows': {
        const { dt } = resolveTableAndDt(payload && payload.selector);
        if (!dt) return { hasDt: false, rows: [] };
        const rows = [];
        dt.rows()
          .nodes()
          .each((tr) => {
            const meta = extractRowMetaFromTr(tr);
            if (meta) rows.push(meta);
          });
        return { hasDt: true, rows };
      }

      case 'dt:getSearchAppliedFileIds': {
        const { dt } = resolveTableAndDt(payload && payload.selector);
        if (!dt) return { hasDt: false, fileIds: [] };
        const fileIds = [];
        dt.rows({ search: 'applied' })
          .nodes()
          .each((tr) => {
            const meta = extractRowMetaFromTr(tr);
            if (meta) fileIds.push(meta.fileId);
          });
        return { hasDt: true, fileIds };
      }

      case 'dt:setVisibleFileIds': {
        const active = Boolean(payload && payload.active);
        filterState.active = active;
        filterState.visibleSet = active
          ? new Set((Array.isArray(payload.fileIds) ? payload.fileIds : []).map(String))
          : null;
        const { dt } = resolveTableAndDt(payload && payload.selector);
        if (dt && (!payload || payload.draw !== false)) {
          dt.draw(Boolean(payload && payload.resetPaging));
        }
        return { hasDt: Boolean(dt), active };
      }

      case 'dt:setPageLen': {
        const len = payload && parseInt(payload.len, 10);
        const { dt } = resolveTableAndDt(payload && payload.selector);
        if (!dt || !Number.isFinite(len)) return { hasDt: Boolean(dt) };
        dt.page.len(len).draw();
        return { hasDt: true };
      }

      case 'dt:clear': {
        filterState.active = false;
        filterState.visibleSet = null;
        pendingPageChange = false;
        currentTable = null;
        currentSettings = null;
        currentDt = null;
        return true;
      }

      case 're:getContext': {
        const hasMeasurementFormOpen =
          typeof window.checkMeasurementTabExists === 'function'
            ? String(window.checkMeasurementTabExists()) === '1'
            : false;
        const curHeadId =
          window.CURHEADID !== undefined && window.CURHEADID !== null
            ? String(window.CURHEADID).trim()
            : '';
        const gestId =
          window.GESTID !== undefined && window.GESTID !== null
            ? String(window.GESTID).trim()
            : '';
        const estEditEl = document.getElementById('estEditId');
        const estEditId =
          estEditEl && estEditEl.value !== undefined && estEditEl.value !== null
            ? String(estEditEl.value).trim()
            : estEditEl && typeof estEditEl.getAttribute === 'function'
            ? String(estEditEl.getAttribute('value') || '').trim()
            : '';
        const headOrderEl = curHeadId ? document.getElementById('headorderNo' + curHeadId) : null;
        const headOrderNo =
          headOrderEl && headOrderEl.value !== undefined && headOrderEl.value !== null
            ? String(headOrderEl.value).trim()
            : headOrderEl && typeof headOrderEl.getAttribute === 'function'
            ? String(headOrderEl.getAttribute('value') || '').trim()
            : '';
        return {
          curHeadId,
          selTab:
            window.SELTAB !== undefined && window.SELTAB !== null
              ? String(window.SELTAB).trim()
              : '',
          selItem:
            window.SELITEM !== undefined && window.SELITEM !== null
              ? String(window.SELITEM).trim()
              : '',
          gestId,
          estEditId,
          headOrderNo,
          hasMeasurementFormOpen,
          canRefreshHeading: typeof window.re_change_heading === 'function',
          canRefreshLeftList: typeof window.call_left_spec_list === 'function',
        };
      }

      case 're:refreshAfterDelete': {
        const rawHeadId =
          payload && payload.headId !== undefined && payload.headId !== null
            ? String(payload.headId).trim()
            : window.CURHEADID !== undefined && window.CURHEADID !== null
            ? String(window.CURHEADID).trim()
            : '';
        const lastHeadSpecId =
          payload && payload.lastHeadSpecId !== undefined && payload.lastHeadSpecId !== null
            ? String(payload.lastHeadSpecId).trim()
            : '';
        const formOpen =
          typeof window.checkMeasurementTabExists === 'function' &&
          String(window.checkMeasurementTabExists()) === '1';

        if (
          rawHeadId &&
          !formOpen &&
          typeof window.re_change_heading === 'function' &&
          document.getElementById('headorderNo' + rawHeadId)
        ) {
          window.re_change_heading(rawHeadId);
          return { refreshed: true, method: 're_change_heading', headId: rawHeadId };
        }
        if (rawHeadId && typeof window.call_left_spec_list === 'function') {
          window.call_left_spec_list(rawHeadId, lastHeadSpecId);
          if (
            !formOpen &&
            String(window.SELTAB || '').trim() === 'AM' &&
            window.SELITEM !== undefined &&
            window.SELITEM !== null &&
            String(window.SELITEM).trim() !== '' &&
            typeof window.re_to_be_executed === 'function'
          ) {
            window.re_to_be_executed(String(window.SELITEM).trim());
          }
          return { refreshed: true, method: 'call_left_spec_list', headId: rawHeadId };
        }
        if (rawHeadId && typeof window.revised_estimation_grand_total === 'function') {
          window.revised_estimation_grand_total(rawHeadId);
          return { refreshed: true, method: 'revised_estimation_grand_total', headId: rawHeadId };
        }
        return { refreshed: false, method: 'none', headId: rawHeadId };
      }

      default:
        throw new Error(`Unsupported bridge action: ${String(action || '')}`);
    }
  }

  document.addEventListener('p3h:bridge:req', (ev) => {
    let req = null;
    try {
      req = typeof ev.detail === 'string' ? JSON.parse(ev.detail) : ev.detail;
    } catch (e) {
      return;
    }
    if (!req || typeof req.id !== 'string') return;
    try {
      const result = handleAction(req.action, req.payload || null);
      respond(req.id, true, result);
    } catch (err) {
      respond(req.id, false, null, err && err.message ? err.message : String(err));
    }
  });
})();
