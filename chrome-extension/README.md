# PRICE 3.0 Helper (Chrome Extension v2.5.0)

A local Chrome Extension overlay for `https://price3.kerala.gov.in/price3_pwd/*` running with MV3 origin isolation (extension IndexedDB in `background.js`, UI/fetch logic in `ISOLATED` content scripts, and a zero-global `MAIN`-world `page-bridge.js` for portal DataTables/CSRF access).

## Key Features (v2.5.0)
- **RE Helper (DPR/MBook Diagnostics & TBE Editor)**:
  - Adds an **RE Helper** modal and **Load DPR & MBook** inline chips directly on the Revised Estimate Preparation toolbar for DPR/e-MBook/RE quantity inspection, inline **To Be Executed (TBE)** editing applied on row blur (or `Enter`), per-row `✕` delete, read-only **Check TBE** pre-scan, Shift+Click range selection, sequential CSRF-safe add/edit/delete (`call_to_be_executed.pro`, `save_re_to_be_executed.pro`, `revised_estimation_edit_measurement.pro`, `save_re_to_be_executed_edit.pro`, `delete_re_to_be_executed.pro`) with retries, and an end-of-session RE table refresh without affecting Executed (e-MBook) measurements.
- **Deactivated DPR & Mixed-Work Filtering**:
  - Accurately detects deactivated estimate/component nodes across ancestors and descendants and excludes deactivated DPR stubs (`stageName = "DPR"`) from ongoing work tracking while keeping them viewable inside a collapsible drawer section.
- **Non-Composite Multi-Activity Finalization & Auto-Reconciliation**:
  - Works with multiple independent activities stay **Active** (`Partial Final (X/Y)`) until every trackable non-archived execution activity is finalized and submitted — even if an active sibling hasn't reached `e-Bills` yet.
  - On startup, automatically reconciles local IndexedDB stores to fix mis-classified active/archived records.
- **Activity-wise & File-wise Project Register & Reports**:
  - Toggle between **Activity-wise** (default, flat numbered activity rows) and **File-wise** (with expandable activity sub-rows).
  - Smart **Composite Work** handling: lists active composite components when no Composite Final Bill exists, and consolidates to the Composite Final row once generated to avoid duplication.
  - **Per-Report Exclusion Checkboxes** & CSP-safe print/PDF report rendering.
- **Manual Archiving & Restore**:
  - Archive cancelled, abandoned, or superseded works or individual activities (with reason & timestamp), view them in **Manually Archived**, and restore anytime.
- **Financial Status & Draft Bill Exclusion**:
  - Excludes `Draft` bills from billed totals and finalization status.
  - **Financial Status** shows billed amount and `%` relative to component **TS Amount adjusted for negotiated rate / tender variation**.
- **Agreement Period Due Date Fill Bar & Open M-Book ≥ 75% Filter**:
  - Displays a solid-color `0–150%` fill bar behind Due Date badges for active unfinalized components with non-closed M-Books (Green `≤50%`, Yellow `≤75%`, Orange `≤100%`, Red `>100%`).
- **Timestamped Milestone Progress Chronology**:
  - Logs status and physical progress updates with timestamps in an interactive chronology timeline in both the Details Drawer and Project Register.

## Installation
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right corner).
3. Click **Load unpacked** (or click the **Reload** icon if upgrading) and select:
   `d:\Development\Projects\OD verification\chrome-extension`
