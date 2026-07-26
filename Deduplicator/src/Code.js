/**
 * Tech Angel Deduplicator v5.4 (Sheet-backed, resumable, interruptible)
 *
 * HOW TO USE:
 *   1. In the bound Google Sheet, open the "🚀 Angel" menu → "Start Deduplicator".
 *   2. Paste a Google Drive folder URL into the dialog and click "Analyze Folder".
 *   3. Wait for the scan (it auto-resumes if it hits the 6-min limit).
 *   4. Review the "Duplicates" sheet, then click "Move Duplicates to Trash".
 *   To clear a paused/partial scan: "🚀 Angel" menu → "Reset Scan Progress".
 *
 * PARTIAL RESULTS: a scan does not have to finish to be useful. "Pause & Compare"
 * stops the walk at the next folder boundary, compares everything recorded so far
 * and fills the Duplicates sheet, so those duplicates can be trashed immediately;
 * "Resume Scan" picks the walk back up at the cursor. Re-comparing later keeps the
 * Status of rows already handled, so no trashing work is ever repeated or lost.
 *
 * STORAGE: all bulk state lives in hidden sheets of this spreadsheet, never in
 * ScriptProperties (a single property value is capped at 9 KB — roughly 40 files —
 * which is what broke resume in v4). Properties hold only small cursors.
 *
 * HASHING: file hashes come from Drive's own md5Checksum via the Advanced Drive
 * Service, so no file is ever downloaded. Google-native files (Docs/Sheets/Slides)
 * have no md5Checksum and are recorded but excluded from duplicate detection.
 *
 * WHICH COPY SURVIVES: of a set of byte-identical files, the one with the most recent
 * date is the original and is kept; every older copy is listed as a duplicate and gets
 * trashed. The date is Drive's modifiedTime (createdTime when a file has none) — see
 * DATE_FIELD. Undated files never beat a dated one, and exact ties fall back to scan
 * order, so the choice is stable every time the list is rebuilt.
 *
 * REVIEWING: every row of the Duplicates sheet carries a clickable Drive link for
 * the duplicate that would be trashed and for the original it matched, so a pair
 * can be opened and compared straight from the sheet before trashing anything.
 * Ticking the row's "Swap ⇄" box flips the two sides — the copy shown as the
 * duplicate is kept and the original is trashed instead — and the box clears itself,
 * so it acts like a per-row button. A later re-compare remembers the flip.
 */

const FILES_SHEET = '_scan_files';
const QUEUE_SHEET = '_scan_queue';
const DUPES_SHEET = 'Duplicates';

const FILES_HEADERS = ['File ID', 'Name', 'Size', 'Path', 'Hash', 'Date'];
const QUEUE_HEADERS = ['Folder ID', 'Path'];
// The duplicate and its original read side by side, each with the date that decided
// which of them is which; the raw ID sits behind them with the machine-facing columns.
const DUPES_HEADERS = ['Duplicate Name', 'Duplicate Link', 'Duplicate Path', 'Duplicate Date',
                       'Original Name', 'Original Link', 'Original Path', 'Original Date',
                       'Size', 'Duplicate ID', 'Hash', 'Status', 'Swap ⇄'];

// 1-based column positions in DUPES_HEADERS, so the layout can change in one place.
const D_COL_DUPE_NAME = 1;
const D_COL_DUPE_LINK = 2;
const D_COL_DUPE_PATH = 3;
const D_COL_DUPE_DATE = 4;
const D_COL_ORIG_NAME = 5;
const D_COL_ORIG_LINK = 6;
const D_COL_ORIG_PATH = 7;
const D_COL_ORIG_DATE = 8;
const D_COL_SIZE = 9;
const D_COL_DUPE_ID = 10;
const D_COL_HASH = 11;
const D_COL_STATUS = 12;
const D_COL_SWAP = 13;
const D_COL_DATA_WIDTH = 12;         // columns written per row; the swap box is set apart

/**
 * Which Drive timestamp decides the keeper. modifiedTime is the date Drive itself
 * shows as "Last modified"; createdTime stands in when a file has no modifiedTime.
 * Switching this constant needs a fresh scan, since the chosen date is what the scan
 * records per file.
 */
const DATE_FIELD = 'modifiedTime';

const DATE_NOTE = 'The newest copy of a set of identical files is kept as the Original; ' +
                  'every older copy is listed as a Duplicate and gets trashed. The date ' +
                  'is Drive\'s "Last modified" (or the creation date when a file has ' +
                  'none). Tick "Swap ⇄" to overrule the choice on a row.';

const SWAP_NOTE = 'Tick this box to keep the file in this row instead: the Duplicate and ' +
                  'Original sides swap, so the file listed as "Original" becomes the one ' +
                  'that gets trashed. Tick again to swap back. Rows already trashed cannot ' +
                  'be swapped.';

const LINK_COL_WIDTH = 320;
const LINK_CHUNK = 500;              // rich-text rows per write, keeps payloads small

const MAX_RUNTIME = 4.5 * 60 * 1000; // soft deadline; hard kill is at 6 min
const FLUSH_EVERY = 200;             // rows buffered before a batched sheet write
const STATUS_EVERY = 2000;           // ms between live-status writes
const PAGE_SIZE = 1000;              // Drive list page size
const TRASH_FLUSH = 50;              // Status cells written per batch while trashing
const RETRY_TRIES = 4;               // attempts per Drive/Sheets call before giving up
const LOCK_WAIT = 20 * 1000;         // how long to wait for a busy predecessor to finish

/* --------------------------------------------------------------------- log -- */

const LOG_PREFIX = 'Dedup';
const LOG_ROWS_SHOWN = 25;           // row numbers listed before the list is truncated

/**
 * Every trace goes through here, so a run can be read back in the Apps Script IDE under
 * Executions (Extensions → Apps Script → Executions, signed in as the account that ran
 * it — executions run as the acting user, so another account's view looks empty).
 *
 * Deliberately aggregate: the scan touches tens of thousands of files, and one line per
 * file would both flood the log and slow the walk. Logging must never be the thing that
 * breaks a run, hence the swallowed error.
 */
function logIt(where, detail) {
  try {
    let text = '';
    if (detail !== undefined && detail !== null) {
      text = ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    console.log(LOG_PREFIX + ' ' + where + text);
  } catch (ignored) {}
}

/** Row numbers as "2, 3, 4 …(+120 more)" — readable without dumping thousands of them. */
function rowList(rows) {
  const shown = rows.slice(0, LOG_ROWS_SHOWN).join(', ');
  return rows.length > LOG_ROWS_SHOWN
    ? shown + ' …(+' + (rows.length - LOG_ROWS_SHOWN) + ' more)'
    : shown;
}

/**
 * Reply for "someone else holds the script lock". This is ordinary contention between
 * consecutive chunks of the same job, not a failure: an execution can hold the lock for
 * at most the 6-minute limit, so it always clears. It is flagged resumable+busy so the
 * dialog waits and calls again rather than ending a job that is halfway done.
 */
function busyReply(what) {
  return {
    error: what + ' is still running. Waiting for it to finish…',
    resumable: true,
    busy: true
  };
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const PATH_SEP = ' → ';

const P_PHASE = 'PHASE';
const P_ROOT = 'ROOT_ID';
const P_CURSOR = 'QUEUE_CURSOR';
const P_PAGE = 'PAGE_TOKEN';
const P_LINKS_FROM = 'LINKS_FROM';   // first Duplicates row still needing its links

const READ_PAGE_ROWS = 50000;        // rows per getValues when streaming a big sheet

const K_STATUS = 'STATUS';           // cache keys — cross-execution, unlike properties
const K_PAUSE = 'PAUSE_REQUEST';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🚀 Angel')
      .addItem('Start Deduplicator', 'showUi')
      .addItem('Compare Files Scanned So Far', 'compareScannedSoFarMenu')
      .addItem('Keep Duplicate Instead (selected rows)', 'swapSelectedRows')
      .addItem('Reset Scan Progress', 'resetToken')
      .addToUi();
}

/* --------------------------------------------------------------------- swap -- */

/**
 * The per-row switch in the "Swap ⇄" column. Ticking the box swaps the Duplicate and
 * Original sides of that row, so the copy shown as the duplicate is the one that
 * survives and the file that was the original gets trashed instead. The box clears
 * itself again, which makes it behave like a button rather than a stored setting.
 *
 * This is a simple trigger, so it may only touch the spreadsheet — that is all a swap
 * needs. Nothing in Drive moves; the row just changes which ID trashDuplicates reads.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== DUPES_SHEET) return;
    if (e.range.getColumn() !== D_COL_SWAP || e.range.getNumColumns() !== 1) return;

    const first = e.range.getRow();
    const ticks = e.range.getValues();
    let swapped = 0, blocked = 0, bad = 0;
    const done = [];

    for (let i = 0; i < ticks.length; i++) {
      const row = first + i;
      if (row < 2 || ticks[i][0] !== true) continue;
      const outcome = swapKeeper(sh, row);
      if (outcome === 'OK') { swapped++; done.push(row); }
      else if (outcome === 'TRASHED') blocked++;
      else bad++;
    }
    logIt('swap checkbox', { rows: rowList(done), swapped: swapped, alreadyTrashed: blocked, unusable: bad });

    // Clear the boxes we just acted on — a programmatic write does not re-trigger onEdit.
    e.range.setValues(ticks.map(() => [false]));

    if (swapped || blocked || bad) {
      SpreadsheetApp.getActiveSpreadsheet().toast(
        (swapped ? swapped + ' row(s) swapped — the file now shown as "Original" will be trashed. ' : '') +
        (blocked ? blocked + ' row(s) left alone (already trashed). ' : '') +
        (bad ? bad + ' row(s) could not be read. ' : ''),
        'Swap ⇄', 6);
    }
  } catch (err) {
    // A simple trigger has nowhere to report to; a toast is the most it can do.
    try { SpreadsheetApp.getActiveSpreadsheet().toast(describeError(err), 'Swap failed', 8); } catch (ignored) {}
  }
}

/**
 * Menu twin of the checkbox, for the whole current selection. Useful for flipping many
 * rows at once, and as a fallback if the simple trigger is ever unavailable.
 *
 * Rows hidden by a filter are never touched. Selecting a filtered result looks like a
 * contiguous block but its row range spans everything the filter hid, so acting on the
 * span would swap rows the reviewer cannot even see — the opposite of what selecting
 * them means.
 */
function swapSelectedRows() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  logIt('swapSelectedRows start', { sheet: sh.getName() });
  if (sh.getName() !== DUPES_SHEET) {
    logIt('swapSelectedRows aborted', 'active sheet is not ' + DUPES_SHEET);
    return ui.alert('Select the rows to swap in the "' + DUPES_SHEET + '" sheet first.');
  }
  const sel = selectedDataRows(sh);
  let swapped = 0, blocked = 0, bad = 0;
  const done = [];
  sel.rows.forEach(row => {
    const outcome = swapKeeper(sh, row);
    if (outcome === 'OK') { swapped++; done.push(row); }
    else if (outcome === 'TRASHED') blocked++;
    else bad++;
  });

  const summary = { swapped: swapped, hiddenSkipped: sel.hidden, alreadyTrashed: blocked, unusable: bad };
  logIt('swapSelectedRows done', summary);
  if (done.length) logIt('swapSelectedRows rows swapped', rowList(done));

  const msg = swapped + ' row(s) swapped: the file listed as "Original" is now the one that ' +
              'will be trashed.' +
              (sel.hidden ? '\n' + sel.hidden + ' hidden row(s) skipped (filtered or hidden by hand).' : '') +
              (blocked ? '\n' + blocked + ' row(s) skipped — already trashed.' : '') +
              (bad ? '\n' + bad + ' row(s) skipped — no usable links in the row.' : '');
  // Toast as well as the alert: a modal is easy to miss, and this is the only confirmation
  // that the menu item ran at all.
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Swap ⇄', 8); } catch (ignored) {}
  ui.alert(msg);
}

/**
 * The data rows a reviewer actually selected: every range of the selection (Ctrl-clicking
 * several blocks makes getActiveRange return only one of them, which used to mean the
 * others were silently ignored), de-duplicated where ranges overlap, clamped to real data
 * so selecting whole columns does not walk a thousand blanks, and with hidden rows
 * reported separately rather than acted on.
 */
function selectedDataRows(sh) {
  const lastData = sh.getLastRow();
  const ranges = sh.getActiveRangeList ? sh.getActiveRangeList().getRanges() : [sh.getActiveRange()];
  const seen = {};
  const rows = [];
  let hidden = 0;

  ranges.forEach(r => {
    const from = Math.max(2, r.getRow());
    const to = Math.min(r.getRow() + r.getNumRows() - 1, lastData);
    for (let row = from; row <= to; row++) {
      if (seen[row]) continue;
      seen[row] = true;
      if (isRowHidden(sh, row)) hidden++;
      else rows.push(row);
    }
  });

  rows.sort((a, b) => a - b);
  logIt('selection resolved', {
    ranges: ranges.map(r => r.getRow() + ':' + (r.getRow() + r.getNumRows() - 1)),
    lastDataRow: lastData,
    willAct: rows.length,
    hiddenSkipped: hidden,
    rows: rowList(rows)
  });
  return { rows: rows, hidden: hidden };
}

function isRowHidden(sh, row) {
  try {
    return sh.isRowHiddenByFilter(row) || sh.isRowHiddenByUser(row);
  } catch (e) {
    return false;      // both calls are long-standing API; the guard is belt and braces
  }
}

/**
 * Swaps the Duplicate and Original sides of one row and repoints Duplicate ID at the
 * new duplicate. The ID comes out of the Original Link, which is why that column holds
 * a full Drive URL: the two sides stay swappable without a second hidden ID column.
 *
 * Returns 'OK', 'TRASHED' (the duplicate is already in the bin, so swapping would
 * describe something that no longer exists) or 'SKIP'.
 */
function swapKeeper(sh, row) {
  const v = sh.getRange(row, 1, 1, D_COL_DATA_WIDTH).getValues()[0];
  const dupe = [v[D_COL_DUPE_NAME - 1], v[D_COL_DUPE_LINK - 1],
                v[D_COL_DUPE_PATH - 1], v[D_COL_DUPE_DATE - 1]];
  const orig = [v[D_COL_ORIG_NAME - 1], v[D_COL_ORIG_LINK - 1],
                v[D_COL_ORIG_PATH - 1], v[D_COL_ORIG_DATE - 1]];
  const dupUrl = dupe[1], origUrl = orig[1];
  const status = v[D_COL_STATUS - 1];

  if (String(status).indexOf('Trashed') === 0) {
    logIt('swap skipped', { row: row, reason: 'already trashed' });
    return 'TRASHED';
  }
  const newDupeId = parseFileIdFromUrl(origUrl);
  if (!newDupeId || !dupUrl) {
    logIt('swap skipped', {
      row: row,
      reason: !dupUrl && !origUrl ? 'row has no links (blank row?)'
            : !newDupeId ? 'no file id in the Original Link'
            : 'no Duplicate Link'
    });
    return 'SKIP';
  }

  // Columns 1..8 are the duplicate's name/link/path/date then the original's.
  sh.getRange(row, D_COL_DUPE_NAME, 1, D_COL_ORIG_DATE).setNumberFormat('@')
    .setValues([orig.concat(dupe)]);
  sh.getRange(row, D_COL_DUPE_ID).setNumberFormat('@').setValue(newDupeId);
  linkCell(sh, row, D_COL_DUPE_LINK, origUrl);
  linkCell(sh, row, D_COL_ORIG_LINK, dupUrl);
  // A failed attempt on the old file says nothing about the new one, so let it be retried.
  if (status) sh.getRange(row, D_COL_STATUS).clearContent();
  return 'OK';
}

/**
 * Menu twin of the dialog's "Pause & Compare". Reachable even when the dialog has
 * been closed or its connection died mid-scan, which is the state a long scan tends
 * to be found in.
 */
function compareScannedSoFarMenu() {
  const res = compareScannedSoFar();
  const ui = SpreadsheetApp.getUi();
  if (res.error) return ui.alert(res.error);
  ui.alert(res.dupeCount + ' duplicate(s) found among ' + res.totalFiles +
           ' file(s) scanned so far' + (res.partial ? ' (scan incomplete — resume it from the dialog).' : '.') +
           '\n\nThey are listed in the "' + DUPES_SHEET + '" sheet. Open 🚀 Angel → Start Deduplicator ' +
           'to trash them.');
}

function showUi() {
  const html = HtmlService.createHtmlOutputFromFile('Progress')
      .setWidth(600).setHeight(560);
  SpreadsheetApp.getUi().showModelessDialog(html, 'Deduplication Engine');
}

function resetToken() {
  logIt('resetToken', 'clearing checkpoint sheets, properties and cache');
  [FILES_SHEET, QUEUE_SHEET, DUPES_SHEET].forEach(name => {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (sh) clearData(sh);
  });
  PropertiesService.getScriptProperties().deleteAllProperties();
  CacheService.getScriptCache().removeAll([K_STATUS, K_PAUSE]);
  SpreadsheetApp.getUi().alert('Scan progress, checkpoint sheets and cache cleared.');
}

/* --------------------------------------------------------------- resilience -- */

/**
 * Retries a Drive/Sheets call through transient failures. A scan of a few thousand
 * files makes thousands of API calls, so a single rate-limit or backend hiccup is
 * near-certain over a long run — without this it would end the whole execution and
 * (before the pause/compare flow) throw away everything since the last checkpoint.
 * Permanent errors (no permission, file not found) are rethrown on the first try.
 */
function withRetry(fn) {
  let wait = 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= RETRY_TRIES || !isTransient(e)) throw e;
      Utilities.sleep(wait);
      wait *= 2;
    }
  }
}

function isTransient(e) {
  const m = describeError(e).toLowerCase();
  return ['rate limit', 'ratelimit', 'user rate', 'quota', 'too many',
          'internal error', 'backend error', 'try again', 'timed out', 'timeout',
          'unavailable', 'failed while accessing', 'temporarily', 'empty response',
          '429', '500', '502', '503', '504'].some(s => m.indexOf(s) !== -1);
}

/**
 * Every error path funnels through here. `e.message` is undefined for some Apps
 * Script failures (the reason a killed run surfaced in the dialog as the useless
 * "Failed: undefined"), so fall back to the string form and finally to a label.
 */
function describeError(e) {
  if (!e) return 'Unknown error';
  return String(e.message || e.toString() || e) || 'Unknown error';
}

/* -------------------------------------------------------------------- pause -- */

/**
 * Asks a running scan to stop at the next folder boundary. The scan polls this flag,
 * flushes its buffers and returns {paused:true}; nothing is killed mid-write, so the
 * checkpoint stays consistent and the walk resumes at the cursor.
 *
 * The flag lives in CacheService, not ScriptProperties: the property store is read
 * into the execution once, so a running scan would not reliably see a flag set by the
 * separate execution that serves the button click. Cache reads always cross that
 * boundary — it is the same channel the live status already travels on. Eviction is
 * harmless, the flag only has to survive a few seconds.
 */
function requestPause() {
  CacheService.getScriptCache().put(K_PAUSE, '1', 600);
  return { ok: true };
}

function pauseRequested() {
  return !!CacheService.getScriptCache().get(K_PAUSE);
}

function clearPause() {
  CacheService.getScriptCache().remove(K_PAUSE);
}

/* ---------------------------------------------------------------- storage -- */

function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sh;
  }
  writeHeaders(sh, headers);
  return sh;
}

/**
 * Rewrites the header row when it does not match `headers` — the state a sheet left
 * behind by an older version is in. Without this, a Duplicates sheet created before
 * the link columns existed would keep its 8 old headers while rows are written 10
 * columns wide, silently mislabelling every column. Its rows are dropped too, since
 * they no longer line up with the new layout.
 *
 * Only the first `headers.length` columns are compared, so columns a reviewer added
 * to the right of the layout never trigger a migration (and never cost them a
 * half-finished trash run).
 */
function writeHeaders(sh, headers) {
  const missing = headers.length - sh.getMaxColumns();
  if (missing > 0) sh.insertColumnsAfter(sh.getMaxColumns(), missing);
  if (headersMatch(sh, headers)) return;

  clearData(sh);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function headersMatch(sh, headers) {
  if (sh.getMaxColumns() < headers.length) return false;
  const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  return headers.every((h, i) => current[i] === h);
}

/**
 * Appends rows in one batched write and returns the row the block starts at (0 when
 * nothing was written). The range is forced to plain text first so a file literally
 * named "=total.xlsx" is stored as text instead of a formula. The grid is grown
 * explicitly rather than relying on implicit expansion, which leaves maxRows exactly
 * equal to the last data row.
 */
function appendRows(sh, rows) {
  if (!rows.length) return 0;
  const start = sh.getLastRow() + 1;
  const short = (start + rows.length - 1) - sh.getMaxRows();
  if (short > 0) sh.insertRowsAfter(sh.getMaxRows(), short + 100);
  withRetry(() => sh.getRange(start, 1, rows.length, rows[0].length)
                    .setNumberFormat('@')
                    .setValues(rows));
  return start;
}

/* ------------------------------------------------------------------- links -- */

function fileUrl(id) {
  return 'https://drive.google.com/file/d/' + id + '/view';
}

/**
 * Inverse of fileUrl, and tolerant of the other shapes a pasted Drive URL takes.
 * The id is taken as "everything up to the next separator" rather than by matching a
 * length or character class, so nothing here depends on how Drive happens to mint ids.
 */
function parseFileIdFromUrl(url) {
  const s = String(url || '');
  let m = s.match(/\/d\/([^/?#]+)/);               // .../file/d/<id>/view
  if (!m) m = s.match(/[?&]id=([^&#]+)/);          // ...open?id=<id>
  return m ? m[1] : '';
}

/** One cell's worth of linkifyColumn, for the swap. */
function linkCell(sh, row, col, url) {
  sh.getRange(row, col).setNumberFormat('@').setRichTextValue(
      SpreadsheetApp.newRichTextValue().setText(url).setLinkUrl(url).build());
}

/**
 * Turns a column of already-written URL text into clickable links.
 *
 * Rich text is used rather than a `=HYPERLINK()` formula because appendRows forces
 * the range to plain-text format (the "=total.xlsx" guard), which would store any
 * formula as literal text. Rich-text links are also unaffected by that format, and
 * getValues() still returns the plain URL string — so reading the sheet back, e.g.
 * in trashDuplicates, behaves exactly as before.
 */
function linkifyColumn(sh, startRow, col, urls) {
  if (!startRow || !urls.length) return;
  for (let i = 0; i < urls.length; i += LINK_CHUNK) {
    const values = urls.slice(i, i + LINK_CHUNK).map(u => [
      SpreadsheetApp.newRichTextValue().setText(u).setLinkUrl(u).build()
    ]);
    sh.getRange(startRow + i, col, values.length, 1).setRichTextValues(values);
  }
}

/**
 * Empties a sheet below its header. Uses clearContent rather than deleteRows:
 * deleteRows throws "Sorry, it is not possible to delete all non-frozen rows"
 * whenever maxRows equals the last data row, which is exactly the state an
 * append-only sheet ends up in.
 */
function clearData(sh) {
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, sh.getMaxColumns()).clearContent();
}

function readColumns(sh, numCols) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, numCols).getValues();
}

/**
 * Streams a sheet's data rows to a callback in pages. _scan_files reaches hundreds of
 * thousands of rows on a large tree; pulling that into one array is a million-plus cells
 * held at once, so it is read in slices instead.
 */
function forEachDataRow(sh, numCols, fn) {
  const n = sh.getLastRow() - 1;
  for (let offset = 0; offset < n; offset += READ_PAGE_ROWS) {
    const height = Math.min(READ_PAGE_ROWS, n - offset);
    const rows = sh.getRange(2 + offset, 1, height, numCols).getValues();
    for (let i = 0; i < rows.length; i++) fn(rows[i], offset + i);
  }
  return n;
}

/* ----------------------------------------------------------------- status -- */

let statusState = {};
let statusLastWrite = 0;

function setStatus(patch, force) {
  Object.assign(statusState, patch);
  const now = Date.now();
  if (!force && now - statusLastWrite < STATUS_EVERY) return;
  statusLastWrite = now;
  CacheService.getScriptCache().put(K_STATUS, JSON.stringify(statusState), 600);
}

function getLiveStatus() {
  const raw = CacheService.getScriptCache().get(K_STATUS);
  return raw ? JSON.parse(raw) : {};
}

/* ------------------------------------------------------------------- scan -- */

/**
 * One execution's worth of work. Returns {timeout:true} when the client should call
 * it again to continue, {paused:true} when someone asked the walk to stop so partial
 * results can be reviewed, or the final summary when everything is done.
 *
 * Nothing here throws at the client: every failure comes back as {error, resumable},
 * because a scan that has already recorded thousands of files must never be lost to
 * one bad API call.
 */
function processFolder(inputUrl) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT)) {
    logIt('processFolder busy', 'could not get the lock in ' + (LOCK_WAIT / 1000) + 's');
    return busyReply('Another scan or trash run');
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const deadline = Date.now() + MAX_RUNTIME;

    let phase = props.getProperty(P_PHASE);
    if (!phase) {
      const rootId = parseFolderId(inputUrl);
      if (!rootId) {
        return { error: 'Please provide a valid Google Drive folder URL (e.g. https://drive.google.com/drive/folders/<id>).' };
      }
      startFreshScan(rootId);
      phase = 'SCAN';
    } else if (phase === 'SCAN') {
      restartWalkIfRecordsLost();
    }
    clearPause();                       // a stale request must not stop this run at once

    logIt('processFolder start', { phase: phase, cursor: props.getProperty(P_CURSOR) });

    if (phase === 'SCAN') {
      const outcome = scanUntilDeadline(deadline);
      logIt('scan chunk ended', {
        outcome: outcome,
        files: statusState.files || 0,
        folders: statusState.folders || ''
      });
      if (outcome !== 'DONE') {
        return {
          timeout: outcome === 'TIMEOUT',
          paused: outcome === 'PAUSED',
          count: statusState.files || 0,
          phase: 'Scanning'
        };
      }
      props.setProperty(P_PHASE, 'DEDUPE');
    }

    if (Date.now() > deadline) return { timeout: true, count: statusState.files || 0, phase: 'Comparing' };

    const summary = runDeduplication(deadline);
    props.deleteProperty(P_PHASE);
    return summary;

  } catch (e) {
    const msg = describeError(e);
    let resumable = false;
    logIt('processFolder failed', msg);
    // Both of these touch services that may themselves be the thing that failed.
    try { setStatus({ currentFile: 'Error: ' + msg }, true); } catch (ignored) {}
    try { resumable = !!PropertiesService.getScriptProperties().getProperty(P_PHASE); } catch (ignored) {}
    return { error: msg, resumable: resumable };   // checkpoint survives — just call again
  } finally {
    lock.releaseLock();
  }
}

function parseFolderId(inputUrl) {
  if (!inputUrl || inputUrl.indexOf('/folders/') === -1) return null;
  const id = inputUrl.split('/folders/')[1].split(/[/?#]/)[0];
  return id || null;
}

function startFreshScan(rootId) {
  const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
  const dupesSh = getSheet(DUPES_SHEET, DUPES_HEADERS);
  [filesSh, dupesSh].forEach(clearData);
  const root = seedQueue(rootId);
  PropertiesService.getScriptProperties().setProperty(P_PHASE, 'SCAN');
  statusState = {};
  setStatus({ currentParent: 'Root', currentFolder: root.name, currentFile: 'Starting…', files: 0 }, true);
}

/** Puts the walk back at the root: one queue entry, cursor 0, no page token. */
function seedQueue(rootId) {
  const props = PropertiesService.getScriptProperties();
  const queueSh = getSheet(QUEUE_SHEET, QUEUE_HEADERS);
  clearData(queueSh);
  const root = withRetry(() =>
      Drive.Files.get(rootId, { fields: 'id,name', supportsAllDrives: true }));
  appendRows(queueSh, [[root.id, root.name]]);
  props.setProperties({ [P_ROOT]: rootId, [P_CURSOR]: '0' });
  props.deleteProperty(P_PAGE);
  clearPause();
  return root;
}

/**
 * Guards the one inconsistency the checkpoint cannot describe: a cursor deep in the
 * queue while _scan_files is empty. An upgrade that changes the file record layout
 * (adding the Date column, say) re-heads that sheet and drops its rows, and resuming
 * from the old cursor would then skip every folder already walked — silently
 * under-reporting duplicates. Rewalking the tree is the cheap half of a scan.
 */
function restartWalkIfRecordsLost() {
  const props = PropertiesService.getScriptProperties();
  const cursor = Number(props.getProperty(P_CURSOR) || 0);
  const rootId = props.getProperty(P_ROOT);
  if (!cursor || !rootId) return false;
  if (getSheet(FILES_SHEET, FILES_HEADERS).getLastRow() > 1) return false;

  logIt('restarting walk', 'cursor was at ' + cursor + ' but _scan_files is empty');
  seedQueue(rootId);
  setStatus({ currentFile: 'Scan records were reset by an upgrade — restarting the walk…' }, true);
  return true;
}

/**
 * Breadth-first walk driven by the _scan_queue sheet plus a cursor in properties.
 * Resuming is O(1) — it picks up at the cursor instead of re-descending the tree.
 *
 * Returns 'DONE' when the queue is exhausted, 'TIMEOUT' when the soft deadline was
 * hit, or 'PAUSED' when a pause was requested. All three flush first, so the
 * checkpoint always describes exactly what has been recorded.
 */
function scanUntilDeadline(deadline) {
  const props = PropertiesService.getScriptProperties();
  const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
  const queueSh = getSheet(QUEUE_SHEET, QUEUE_HEADERS);

  const queue = readColumns(queueSh, 2);                       // [[folderId, path], …]
  const seenFolders = new Set(queue.map(r => r[0]));

  /*
   * Every recorded file id used to be read back here to keep _scan_files free of repeats.
   * That read grows with every file scanned — at a hundred thousand files it would eat a
   * large slice of each chunk and keep getting worse, which is what stops a big tree from
   * finishing. Repeats are collapsed by id in runDeduplication instead, which already
   * reads the whole list exactly once; a per-execution set still covers the only case
   * that happens often, a folder re-listed after a stale page token.
   */
  const recordedHere = new Set();

  let cursor = Number(props.getProperty(P_CURSOR) || 0);
  let pageToken = props.getProperty(P_PAGE) || null;
  let fileBuf = [];
  let queueBuf = [];
  let fileCount = Math.max(0, filesSh.getLastRow() - 1);       // records, not distinct ids

  const flush = () => {
    appendRows(filesSh, fileBuf);
    appendRows(queueSh, queueBuf);
    fileBuf = [];
    queueBuf = [];
    props.setProperty(P_CURSOR, String(cursor));
    if (pageToken) props.setProperty(P_PAGE, pageToken);
    else props.deleteProperty(P_PAGE);
  };

  // The pause flag is a cache read, so it is polled on the same ~2 s rhythm as the
  // live status rather than once per folder — a wide tree has thousands of folders.
  let pauseChecked = 0;
  const askedToPause = () => {
    const now = Date.now();
    if (now - pauseChecked < STATUS_EVERY) return false;
    pauseChecked = now;
    return pauseRequested();
  };

  while (cursor < queue.length) {
    if (Date.now() > deadline) { flush(); return 'TIMEOUT'; }
    if (askedToPause()) {
      flush();
      setStatus({ currentFile: 'Paused after ' + fileCount + ' files', files: fileCount }, true);
      return 'PAUSED';
    }

    const folderId = queue[cursor][0];
    const folderPath = queue[cursor][1];
    const parts = folderPath.split(PATH_SEP);
    setStatus({
      currentParent: parts.length > 1 ? parts[parts.length - 2] : 'Root',
      currentFolder: parts[parts.length - 1],
      folders: (cursor + 1) + '/' + queue.length
    });

    const params = {
      q: "'" + folderId + "' in parents and trashed = false",
      fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime)',
      pageSize: PAGE_SIZE,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    };
    if (pageToken) params.pageToken = pageToken;   // never send an explicit null

    let res;
    try {
      res = withRetry(() => Drive.Files.list(params));
    } catch (e) {
      if (pageToken) { pageToken = null; continue; }          // stale token → restart folder
      if (isSkippableFolderError(e)) {                        // no access / vanished mid-scan
        setStatus({ currentFile: 'Skipped unreadable folder: ' + folderPath }, true);
        cursor++;                                             // one bad folder ≠ a dead scan
        flush();                                              // buffers + new cursor together
        continue;
      }
      throw e;
    }

    (res.files || []).forEach(f => {
      if (f.mimeType === SHORTCUT_MIME) return;               // shortcuts point elsewhere
      if (f.mimeType === FOLDER_MIME) {
        if (seenFolders.has(f.id)) return;
        seenFolders.add(f.id);
        const childPath = folderPath + PATH_SEP + f.name;
        queue.push([f.id, childPath]);
        queueBuf.push([f.id, childPath]);
        return;
      }
      if (recordedHere.has(f.id)) return;
      recordedHere.add(f.id);
      fileCount++;
      setStatus({ currentFile: f.name, files: fileCount });
      // The date is stored as Drive's RFC 3339 string: it sorts correctly as plain
      // text, which is what the sheet holds, so no parsing is needed to compare.
      fileBuf.push([f.id, f.name, Number(f.size || 0), folderPath, f.md5Checksum || '',
                    f[DATE_FIELD] || f.createdTime || '']);
    });

    pageToken = res.nextPageToken || null;
    if (!pageToken) cursor++;
    if (fileBuf.length >= FLUSH_EVERY || queueBuf.length >= FLUSH_EVERY) flush();
  }

  flush();
  setStatus({ currentFile: 'Scan complete — comparing…', files: fileCount }, true);
  return 'DONE';
}

/**
 * True for folders this account simply cannot list — no permission, deleted or
 * moved to trash after it was queued. Skipping them costs one folder; throwing
 * would cost the rest of the walk.
 */
function isSkippableFolderError(e) {
  const m = describeError(e).toLowerCase();
  return ['not found', 'file not found', 'notfound', 'permission', 'forbidden',
          'access denied', 'insufficient', '403', '404'].some(s => m.indexOf(s) !== -1);
}

/* ------------------------------------------------------------------ dedup -- */

/**
 * Groups the scanned files by md5 + size and writes every later match to the
 * Duplicates sheet. Files without a hash (Google-native) and zero-byte files are
 * never reported — neither can be compared safely by content.
 *
 * Both the duplicate (the copy that would be trashed) and the original it matched
 * get a clickable Drive link, so a row can be checked without hunting for the file.
 *
 * Safe to run at any point during a scan: it only reads _scan_files and rewrites the
 * Duplicates sheet, never touching the queue or cursor. The Status of rows already
 * handled is carried across the rewrite, so trashing work done on a partial result is
 * neither lost nor repeated when the finished scan is compared again.
 */
function runDeduplication(deadline) {
  deadline = deadline || (Date.now() + MAX_RUNTIME);
  const props = PropertiesService.getScriptProperties();
  const prevStatus = readStatusByFileId();          // before getSheet may re-head the sheet
  const pairChoice = readPairChoices();             // and before the rows are rewritten
  const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
  const dupesSh = getSheet(DUPES_SHEET, DUPES_HEADERS);
  clearData(dupesSh);
  // clearContent leaves the checkbox validation behind; a shorter list than last time
  // would otherwise trail empty boxes that look like rows waiting to be acted on.
  if (dupesSh.getMaxRows() > 1) {
    dupesSh.getRange(2, D_COL_SWAP, dupesSh.getMaxRows() - 1, 1).clearDataValidations();
  }
  dupesSh.setColumnWidth(D_COL_DUPE_LINK, LINK_COL_WIDTH);
  dupesSh.setColumnWidth(D_COL_ORIG_LINK, LINK_COL_WIDTH);
  dupesSh.setColumnWidth(D_COL_DUPE_DATE, 130);
  dupesSh.setColumnWidth(D_COL_ORIG_DATE, 130);
  dupesSh.setColumnWidth(D_COL_SWAP, 80);
  dupesSh.getRange(1, D_COL_SWAP).setNote(SWAP_NOTE);
  dupesSh.getRange(1, D_COL_ORIG_DATE).setNote(DATE_NOTE);

  const groups = {};
  const dupeRows = [];
  const seenIds = new Set();
  let skipped = 0, carried = 0, kept = 0, undated = 0, repeats = 0;

  // The scan no longer filters repeats itself, so they are collapsed here. This must not
  // be missed: the same file recorded twice would otherwise look like two copies of
  // itself and be offered up for trashing against itself.
  const fileRecords = forEachDataRow(filesSh, FILES_HEADERS.length, (r, seq) => {
    const id = r[0], hash = r[4], size = r[2];
    if (!id || seenIds.has(id)) { repeats++; return; }
    seenIds.add(id);
    if (!hash || !size) { skipped++; return; }
    if (!r[5]) undated++;
    const key = hash + '_' + size;
    (groups[key] = groups[key] || []).push({
      id: id, name: r[1], size: size, path: r[3], hash: hash, date: r[5] || '', seq: seq
    });
  });
  const distinctFiles = seenIds.size;

  Object.keys(groups).forEach(key => {
    const members = groups[key];
    if (members.length < 2) return;
    const keeper = pickKeeper(members);

    members.forEach(m => {
      if (m === keeper) return;
      let dupe = m, orig = keeper;
      // The date rule decides by default. If the sheet already said otherwise for this
      // exact pair, a reviewer swapped it by hand — keep their decision instead of
      // quietly re-flipping the row on every re-compare.
      if (pairChoice[pairKey(dupe.id, orig.id)] === orig.id) {
        const t = dupe; dupe = orig; orig = t;
        kept++;
      }
      const status = prevStatus[dupe.id] || '';
      if (status) carried++;
      dupeRows.push([dupe.name, fileUrl(dupe.id), dupe.path, showDate(dupe.date),
                     orig.name, fileUrl(orig.id), orig.path, showDate(orig.date),
                     dupe.size, dupe.id, dupe.hash, status]);
    });
  });

  // Values first: they are what trashing reads, so the list is usable the moment this
  // returns. Making the URLs clickable and adding the swap boxes is decoration, and it is
  // the part that can run long on a big list — so it runs under the deadline and picks up
  // where it left off if it does not finish.
  const start = appendRows(dupesSh, dupeRows);
  if (start) props.setProperty(P_LINKS_FROM, String(start));
  const decorated = decorateRows(dupesSh, deadline);

  setStatus({ currentFile: 'Compared — ' + dupeRows.length + ' duplicates', files: distinctFiles }, true);
  logIt('compare done', {
    fileRecords: fileRecords,
    distinctFiles: distinctFiles,
    repeatRecords: repeats,
    duplicates: dupeRows.length,
    pending: dupeRows.length - carried,
    alreadyHandled: carried,
    swapsKept: kept,
    noHashOrEmpty: skipped,
    undated: undated,
    linksPending: !decorated
  });

  return {
    done: true,
    dupeCount: dupeRows.length,
    pending: dupeRows.length - carried,
    alreadyHandled: carried,
    swapsKept: kept,
    totalFiles: distinctFiles,
    repeats: repeats,
    skipped: skipped,
    undated: undated,
    linksPending: !decorated,
    sheetUrl: dupesSheetUrl(dupesSh)
  };
}

/**
 * Turns the URL text already sitting in the two link columns into clickable links and
 * gives each row its swap checkbox, working forward from the row recorded in
 * P_LINKS_FROM and saving progress as it goes.
 *
 * Returns true when the whole list is decorated, false when the deadline cut it short —
 * in which case the property still points at the first undecorated row, so the next call
 * continues from there. Nothing about trashing or swapping depends on this having run:
 * the URLs are plain text until it does, and both are read as text either way.
 */
function decorateRows(dupesSh, deadline) {
  const props = PropertiesService.getScriptProperties();
  let row = Number(props.getProperty(P_LINKS_FROM) || 0);
  const last = lastDuplicateRow(dupesSh);
  if (!row || row > last) {
    props.deleteProperty(P_LINKS_FROM);
    return true;
  }

  while (row <= last) {
    if (Date.now() > deadline) {
      logIt('decoration paused', { nextRow: row, lastRow: last });
      return false;
    }
    const height = Math.min(LINK_CHUNK, last - row + 1);
    const dupeUrls = dupesSh.getRange(row, D_COL_DUPE_LINK, height, 1).getValues().map(r => r[0]);
    const origUrls = dupesSh.getRange(row, D_COL_ORIG_LINK, height, 1).getValues().map(r => r[0]);
    // Runs, because a rich text value needs actual text: a blank cell in the middle of the
    // block (a row deleted by hand, say) must be stepped over, not linked.
    linkRuns(row, dupeUrls).forEach(r => linkifyColumn(dupesSh, r.row, D_COL_DUPE_LINK, r.urls));
    linkRuns(row, origUrls).forEach(r => linkifyColumn(dupesSh, r.row, D_COL_ORIG_LINK, r.urls));
    dupesSh.getRange(row, D_COL_SWAP, height, 1).insertCheckboxes();
    row += height;
    props.setProperty(P_LINKS_FROM, String(row));
  }

  props.deleteProperty(P_LINKS_FROM);
  logIt('decoration complete', { throughRow: last });
  return true;
}

/**
 * Last row that actually holds a duplicate. Not getLastRow(): a helper column someone
 * filled down past the data would stretch that beyond the rows this decorates.
 */
function lastDuplicateRow(dupesSh) {
  const n = dupesSh.getLastRow() - 1;
  if (n < 1) return 1;
  const ids = dupesSh.getRange(2, D_COL_DUPE_ID, n, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0]) return i + 2;
  return 1;
}

/** Contiguous stretches of non-empty urls, as [{row, urls}] starting at startRow. */
function linkRuns(startRow, urls) {
  const runs = [];
  let current = null;
  urls.forEach((u, i) => {
    if (!u) { current = null; return; }
    if (!current) { current = { row: startRow + i, urls: [] }; runs.push(current); }
    current.urls.push(u);
  });
  return runs;
}

/**
 * Finishes a decoration pass the compare could not complete in its own execution. The
 * dialog calls this until `pending` is false; nothing is blocked while it runs.
 */
function finishPendingLinks() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT)) return busyReply('Another scan or trash run');
  try {
    const dupesSh = getSheet(DUPES_SHEET, DUPES_HEADERS);
    const done = decorateRows(dupesSh, Date.now() + MAX_RUNTIME);
    return { done: done, pending: !done };
  } catch (e) {
    logIt('finishPendingLinks failed', describeError(e));
    return { error: describeError(e), resumable: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * The copy a group keeps: the newest one. Dates are Drive's RFC 3339 strings, which
 * compare correctly as text (fixed-width, UTC, most-significant first).
 *
 * A file with no date loses to any dated file rather than winning by accident, and an
 * exact tie falls back to scan order so the choice is stable across re-compares.
 */
function pickKeeper(members) {
  return members.reduce((best, m) => {
    if (!m.date) return best;
    if (!best.date) return m;
    if (m.date > best.date) return m;
    if (m.date < best.date) return best;
    return m.seq < best.seq ? m : best;
  }, members[0]);
}

/** Drive's RFC 3339 timestamp as something readable in the sheet's own timezone. */
function showDate(rfc3339) {
  if (!rfc3339) return '';
  try {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(new Date(rfc3339), tz, 'yyyy-MM-dd HH:mm');
  } catch (e) {
    return String(rfc3339);
  }
}

/**
 * Duplicate-file-ID → Status from the Duplicates sheet as it stands now, located by
 * header name rather than by column number: this runs before a possible layout
 * migration, so the sheet may still be in an older column order. Losing the map would
 * mean re-trashing files that are already in the bin, so it is worth the header lookup.
 */
function readStatusByFileId() {
  const map = {};
  const cells = readByHeaders(['Duplicate ID', 'Status']);
  cells.forEach(c => { if (c[0] && c[1]) map[c[0]] = c[1]; });
  return map;
}

/**
 * For every duplicate/original pair currently on the sheet: which of the two the sheet
 * calls the duplicate. runDeduplication compares that against its own default to tell a
 * reviewer's swap apart from an untouched row.
 */
function readPairChoices() {
  const out = {};
  readByHeaders(['Duplicate ID', 'Original Link']).forEach(c => {
    const dupeId = c[0], origId = parseFileIdFromUrl(c[1]);
    if (dupeId && origId) out[pairKey(dupeId, origId)] = dupeId;
  });
  return out;
}

/** Unordered key for a duplicate/original pair, so it survives being flipped. */
function pairKey(a, b) {
  return a < b ? a + '|' + b : b + '|' + a;
}

/**
 * Reads named columns out of the Duplicates sheet whatever order they sit in, returning
 * one array per row in the order the names were asked for. Missing headers yield [].
 */
function readByHeaders(names) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DUPES_SHEET);
  if (!sh) return [];
  const n = sh.getLastRow() - 1;
  const width = sh.getLastColumn();
  if (n < 1 || width < 1) return [];

  const header = sh.getRange(1, 1, 1, width).getValues()[0];
  const idx = names.map(name => header.indexOf(name));
  if (idx.some(i => i < 0)) return [];

  const rows = sh.getRange(2, 1, n, width).getValues();
  return rows.map(r => idx.map(i => r[i]));
}

function dupesSheetUrl(dupesSh) {
  return SpreadsheetApp.getActiveSpreadsheet().getUrl() + '#gid=' + dupesSh.getSheetId();
}

/**
 * Compares whatever has been scanned so far without waiting for the walk to finish.
 * A scan of a large tree can take many executions; this makes its findings usable
 * (and trashable) at any point along the way.
 *
 * If a scan is mid-execution it holds the script lock, so this first asks it to
 * pause and then waits for the lock to come free — the walk stops at a folder
 * boundary, having flushed its checkpoint, and the dialog can resume it afterwards.
 */
function compareScannedSoFar() {
  logIt('compareScannedSoFar start');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    logIt('compareScannedSoFar', 'a scan holds the lock — asking it to pause');
    requestPause();
    if (!lock.tryLock(90 * 1000)) return busyReply('The scan');
  }
  try {
    const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
    if (filesSh.getLastRow() < 2) {
      return { error: 'Nothing has been scanned yet — run "Analyze Folder" first.' };
    }
    const summary = runDeduplication(Date.now() + MAX_RUNTIME);
    summary.partial = !!PropertiesService.getScriptProperties().getProperty(P_PHASE);
    return summary;
  } catch (e) {
    logIt('compareScannedSoFar failed', describeError(e));
    return { error: describeError(e) };
  } finally {
    lock.releaseLock();
  }
}

/**
 * What the dialog needs to pick up wherever things were left — after a reload, a
 * dead connection, or a browser that was closed mid-scan.
 */
function getState() {
  try {
    const props = PropertiesService.getScriptProperties();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rootId = props.getProperty(P_ROOT) || '';
    const filesSh = ss.getSheetByName(FILES_SHEET);
    const dupesSh = ss.getSheetByName(DUPES_SHEET);

    // A sheet still on an older layout is reported as empty rather than trusted: its
    // column 4 holds something other than the duplicate's file ID, and offering to
    // trash by it would act on the wrong thing.
    let total = 0, pending = 0;
    if (dupesSh && headersMatch(dupesSh, DUPES_HEADERS)) {
      const n = dupesSh.getLastRow() - 1;
      if (n > 0) {
        total = n;
        pending = dupesSh.getRange(2, D_COL_STATUS, n, 1).getValues()
                         .filter(r => !r[0]).length;
      }
    }
    return {
      phase: props.getProperty(P_PHASE) || '',
      linksPending: !!props.getProperty(P_LINKS_FROM),
      rootUrl: rootId ? 'https://drive.google.com/drive/folders/' + rootId : '',
      scannedFiles: filesSh ? Math.max(0, filesSh.getLastRow() - 1) : 0,
      dupeTotal: total,
      dupePending: pending,
      sheetUrl: dupesSh ? dupesSheetUrl(dupesSh) : ss.getUrl()
    };
  } catch (e) {
    return { error: describeError(e) };
  }
}

/* ------------------------------------------------------------------ trash -- */

/**
 * Trashes duplicates listed in the Duplicates sheet, resuming across executions.
 * The client calls this repeatedly while `remaining` > 0. Rows are independent, so
 * this works just as well on a partial result list as on a finished scan.
 *
 * Status cells are written in batches of TRASH_FLUSH rather than one setValue per
 * row: a single-cell write is the slowest thing in the loop, and at ~1600 rows it
 * was the reason a trash run needed several executions to get through the list.
 * A batch is flushed before every exit, so a killed run never loses more than the
 * files trashed since the last flush (they simply get retried, which is harmless —
 * trashing an already-trashed file succeeds).
 */
function trashDuplicates() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT)) {
    logIt('trash busy', 'could not get the lock in ' + (LOCK_WAIT / 1000) + 's');
    return busyReply('Another scan or trash run');
  }

  const sh = getSheet(DUPES_SHEET, DUPES_HEADERS);
  let rows = [];
  let trashed = 0, errors = 0, remaining = 0;
  let buf = [], bufStart = 0;

  const flushStatus = () => {
    if (!buf.length) return;
    const block = buf.map(s => [s]);
    const at = bufStart;
    buf = [];
    withRetry(() => sh.getRange(at, D_COL_STATUS, block.length, 1)
                      .setNumberFormat('@')
                      .setValues(block));
  };
  const countPending = from => {
    let n = 0;
    for (let j = from; j < rows.length; j++) if (!rows[j][D_COL_STATUS - 1]) n++;
    return n;
  };

  try {
    const deadline = Date.now() + MAX_RUNTIME;
    rows = readColumns(sh, D_COL_DATA_WIDTH);      // the swap checkbox is not needed here

    for (let i = 0; i < rows.length; i++) {
      const done = rows[i][D_COL_STATUS - 1];
      if (done) {
        if (buf.length) buf.push(done);      // keep the pending block contiguous
        continue;
      }
      if (Date.now() > deadline) { remaining = countPending(i); break; }

      const id = rows[i][D_COL_DUPE_ID - 1];
      let status;
      if (!id) {
        status = 'Error: no file ID in this row';
        errors++;
      } else {
        try {
          withRetry(() => DriveApp.getFileById(id).setTrashed(true));
          status = 'Trashed';
          trashed++;
        } catch (e) {
          status = 'Error: ' + describeError(e);
          errors++;
        }
      }
      if (!buf.length) bufStart = i + 2;
      buf.push(status);
      if (buf.length >= TRASH_FLUSH) flushStatus();
      setStatus({ currentFile: 'Trashing: ' + rows[i][0] });
    }

    flushStatus();
    setStatus({ currentFile: 'Trashed ' + trashed + ' file(s)' +
                             (remaining ? ' — ' + remaining + ' to go' : '') }, true);
    logIt('trash chunk done', { rowsOnSheet: rows.length, trashed: trashed, errors: errors, remaining: remaining });
    return { trashed: trashed, errors: errors, remaining: remaining };
  } catch (e) {
    // Record what did get trashed before surfacing the failure, and let the client retry.
    try { flushStatus(); } catch (ignored) {}
    logIt('trash chunk failed', { error: describeError(e), trashed: trashed, errors: errors });
    return { error: describeError(e), trashed: trashed, errors: errors, resumable: true };
  } finally {
    lock.releaseLock();
  }
}
