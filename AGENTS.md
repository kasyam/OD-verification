# PRICE 3.0 Helper (Chrome Extension) Rules

- **Test Command**: Run `node chrome-extension/tests/verify_v2.mjs` after any JS edit; add regression tests for bug fixes.
- **MV3 World Isolation**: Keep `page-bridge.js` (`MAIN` world) zero-global, communicating only via `p3h:bridge:req`/`p3h:bridge:res` and `p3h:dt:draw` `CustomEvent`s with JSON-stringified payloads.
- **DataTables Instance Identity**: Never compare `jq(table).DataTable()` wrapper references (`dt`); compare `table` and `dt.settings()[0]` in `page-bridge.js` (`dt:ensure`).
- **MutationObserver Scope**: Keep `#pt-file_table_list`, `.dataTables_wrapper`, and `.p3h-*` containers excluded in `overlay.js`'s `MutationObserver`; handle table redraws via `p3h:dt:draw`.
- **Pagination Focus & Scroll**: Blur focused elements inside `.dataTables_paginate` on `page.dt`/`draw.dt` (sync + `setTimeout(0)`), suppress `.dataTables_paginate` `:focus` outline/`box-shadow` in `overlay.css`, and scroll via `anchorEl.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' })` with ancestor/window fallbacks.
