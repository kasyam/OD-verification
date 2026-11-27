# RE Helper Modal UX & Workflow Upgrades — Checkpoint

## Plan Status
- Step 1: Author failing regression tests (`RED`) in `chrome-extension/tests/verify_v2.mjs` — IN PROGRESS (`2535401d-c51b-484f-a742-a24e9276cce9`).
- Step 2: `page-bridge.js` (`304-415`): add async `re:switchHeading` handler (`window.re_change_heading` + settle wait), zero globals.
- Step 3: `re-batch.js`:
  - `3A`: `extractReHeadingsList(doc)` (`~426`), `fetchReHeadingHelperData` `options.restoreCtx` & `options.shouldAbort` (`2619-2853`), export `formatModalTbeCellHtml` & `extractReHeadingsList` (`7967-8025`).
  - `3B`: Remove `.p3h-re-split-toggle`, `.p3h-re-split-caret`, `.p3h-re-split-count` from `formatModalTbeCellHtml` (`4446-4473`) and `tr.p3h-re-split-row` (`4665-4667`). Add `#p3h-re-split-backdrop` + `#p3h-re-split-card`, `openSplitCard`, `closeSplitCard({ revertDrafts })`, `saveSplitCardChanges`. Open only on detailed `readOnly` click/`Enter` (or double-click/`Alt+Enter`, or `blockedBySplitUp`); Save/Cancel hides card.
  - `3C`: Footer `#p3h-re-delete-btn` (`p3h-btn p3h-btn-sm p3h-btn-muted-danger`, "Clear Selected TBE") before `#p3h-re-cancel-btn` ("Close").
  - `3D`: Header `#p3h-re-head-prev`, `#p3h-re-heading-select`, `#p3h-re-head-next`, `#p3h-re-bg-sync-pill`; `switchModalHeading`; serialized idle `scheduleBackgroundHeadingPreSync` + `pauseAndAwaitBackgroundSync` (`restoreCtx: ctx` so active server heading never drifts).
  - `3E`: `.p3h-re-content-wrap` + `#p3h-re-sync-overlay` (`.p3h-re-sync-card`, `#p3h-re-sync-title`, `#p3h-re-sync-step`, `#p3h-re-sync-bar-fill`) wired into `setRunningUi`, `loadModalHelperData`, `scanBtn`, `runDeleteBatch`, `switchModalHeading`.
- Step 4: `overlay.css`: compact split card modal, `.p3h-btn-muted-danger`, heading switcher, prominent sync overlay + `.p3h-re-pbar-indeterminate`, clean dead `.p3h-re-split-row`/`.p3h-re-split-toggle`.
- Step 5: Verify `node chrome-extension/tests/verify_v2.mjs` (`GREEN`) + browser UI preview + `walkthrough.md`.
