/**
 * Tech Angel Deduplicator v5.2 (Sheet-backed, resumable, interruptible)
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
 * REVIEWING: every row of the Duplicates sheet carries a clickable Drive link for
 * the duplicate that would be trashed and for the original it matched, so a pair
 * can be opened and compared straight from the sheet before trashing anything.
 */

const FILES_SHEET = '_scan_files';
const QUEUE_SHEET = '_scan_queue';
const DUPES_SHEET = 'Duplicates';

const FILES_HEADERS = ['File ID', 'Name', 'Size', 'Path', 'Hash'];
const QUEUE_HEADERS = ['Folder ID', 'Path'];
const DUPES_HEADERS = ['Duplicate Name', 'Duplicate Link', 'Duplicate Path', 'Duplicate ID',
                       'Original Name', 'Original Link', 'Original Path',
                       'Size', 'Hash', 'Status'];

// 1-based column positions in DUPES_HEADERS, so the layout can change in one place.
const D_COL_DUPE_LINK = 2;
const D_COL_DUPE_ID = 4;
const D_COL_ORIG_LINK = 6;
const D_COL_STATUS = 10;
const LINK_COL_WIDTH = 320;
const LINK_CHUNK = 500;              // rich-text rows per write, keeps payloads small

const MAX_RUNTIME = 4.5 * 60 * 1000; // soft deadline; hard kill is at 6 min
const FLUSH_EVERY = 200;             // rows buffered before a batched sheet write
const STATUS_EVERY = 2000;           // ms between live-status writes
const PAGE_SIZE = 1000;              // Drive list page size
const TRASH_FLUSH = 50;              // Status cells written per batch while trashing
const RETRY_TRIES = 4;               // attempts per Drive/Sheets call before giving up

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const PATH_SEP = ' → ';

const P_PHASE = 'PHASE';
const P_ROOT = 'ROOT_ID';
const P_CURSOR = 'QUEUE_CURSOR';
const P_PAGE = 'PAGE_TOKEN';

const K_STATUS = 'STATUS';           // cache keys — cross-execution, unlike properties
const K_PAUSE = 'PAUSE_REQUEST';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🚀 Angel')
      .addItem('Start Deduplicator', 'showUi')
      .addItem('Compare Files Scanned So Far', 'compareScannedSoFarMenu')
      .addItem('Reset Scan Progress', 'resetToken')
      .addToUi();
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
  if (!lock.tryLock(2000)) {
    return { error: 'A scan is already running. Wait for it to finish, or use 🚀 Angel → Reset Scan Progress.' };
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
    }
    clearPause();                       // a stale request must not stop this run at once

    if (phase === 'SCAN') {
      const outcome = scanUntilDeadline(deadline);
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

    const summary = runDeduplication();
    props.deleteProperty(P_PHASE);
    return summary;

  } catch (e) {
    const msg = describeError(e);
    let resumable = false;
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
  const props = PropertiesService.getScriptProperties();
  const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
  const queueSh = getSheet(QUEUE_SHEET, QUEUE_HEADERS);
  const dupesSh = getSheet(DUPES_SHEET, DUPES_HEADERS);
  [filesSh, queueSh, dupesSh].forEach(clearData);

  const root = withRetry(() =>
      Drive.Files.get(rootId, { fields: 'id,name', supportsAllDrives: true }));
  appendRows(queueSh, [[root.id, root.name]]);
  props.setProperties({ [P_ROOT]: rootId, [P_CURSOR]: '0', [P_PHASE]: 'SCAN' });
  props.deleteProperty(P_PAGE);
  clearPause();
  statusState = {};
  setStatus({ currentParent: 'Root', currentFolder: root.name, currentFile: 'Starting…', files: 0 }, true);
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
  const seenFiles = new Set(readColumns(filesSh, 1).map(r => r[0]));

  let cursor = Number(props.getProperty(P_CURSOR) || 0);
  let pageToken = props.getProperty(P_PAGE) || null;
  let fileBuf = [];
  let queueBuf = [];
  let fileCount = seenFiles.size;

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
      fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum)',
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
      if (seenFiles.has(f.id)) return;
      seenFiles.add(f.id);
      fileCount++;
      setStatus({ currentFile: f.name, files: fileCount });
      fileBuf.push([f.id, f.name, Number(f.size || 0), folderPath, f.md5Checksum || '']);
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
function runDeduplication() {
  const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
  const dupesSh = getSheet(DUPES_SHEET, DUPES_HEADERS);
  const prevStatus = readStatusByFileId(dupesSh);
  clearData(dupesSh);
  dupesSh.setColumnWidth(D_COL_DUPE_LINK, LINK_COL_WIDTH);
  dupesSh.setColumnWidth(D_COL_ORIG_LINK, LINK_COL_WIDTH);

  const rows = readColumns(filesSh, 5);
  const seen = {};
  const dupeRows = [];
  let skipped = 0, carried = 0;

  rows.forEach(r => {
    const id = r[0], name = r[1], size = r[2], path = r[3], hash = r[4];
    if (!hash || !size) { skipped++; return; }
    const key = hash + '_' + size;
    if (seen[key]) {
      const orig = seen[key];
      const status = prevStatus[id] || '';
      if (status) carried++;
      dupeRows.push([name, fileUrl(id), path, id,
                     orig.name, fileUrl(orig.id), orig.path,
                     size, hash, status]);
    } else {
      seen[key] = { id: id, name: name, path: path };
    }
  });

  const start = appendRows(dupesSh, dupeRows);
  linkifyColumn(dupesSh, start, D_COL_DUPE_LINK, dupeRows.map(r => r[D_COL_DUPE_LINK - 1]));
  linkifyColumn(dupesSh, start, D_COL_ORIG_LINK, dupeRows.map(r => r[D_COL_ORIG_LINK - 1]));
  setStatus({ currentFile: 'Compared — ' + dupeRows.length + ' duplicates', files: rows.length }, true);

  return {
    done: true,
    dupeCount: dupeRows.length,
    pending: dupeRows.length - carried,
    alreadyHandled: carried,
    totalFiles: rows.length,
    skipped: skipped,
    sheetUrl: dupesSheetUrl(dupesSh)
  };
}

/** Duplicate-file-ID → Status, read from the Duplicates sheet before it is rewritten. */
function readStatusByFileId(dupesSh) {
  const n = dupesSh.getLastRow() - 1;
  const map = {};
  if (n < 1) return map;
  const ids = dupesSh.getRange(2, D_COL_DUPE_ID, n, 1).getValues();
  const stats = dupesSh.getRange(2, D_COL_STATUS, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] && stats[i][0]) map[ids[i][0]] = stats[i][0];
  }
  return map;
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
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    requestPause();
    if (!lock.tryLock(90 * 1000)) {
      return { error: 'The running scan did not pause in time. Wait a moment and try again.' };
    }
  }
  try {
    const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
    if (filesSh.getLastRow() < 2) {
      return { error: 'Nothing has been scanned yet — run "Analyze Folder" first.' };
    }
    const summary = runDeduplication();
    summary.partial = !!PropertiesService.getScriptProperties().getProperty(P_PHASE);
    return summary;
  } catch (e) {
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
  if (!lock.tryLock(2000)) return { error: 'Another operation is running.' };

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
    rows = readColumns(sh, DUPES_HEADERS.length);

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
    return { trashed: trashed, errors: errors, remaining: remaining };
  } catch (e) {
    // Record what did get trashed before surfacing the failure, and let the client retry.
    try { flushStatus(); } catch (ignored) {}
    return { error: describeError(e), trashed: trashed, errors: errors, resumable: true };
  } finally {
    lock.releaseLock();
  }
}
