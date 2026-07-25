/**
 * Tech Angel Deduplicator v5.0 (Sheet-backed, resumable)
 *
 * HOW TO USE:
 *   1. In the bound Google Sheet, open the "🚀 Angel" menu → "Start Deduplicator".
 *   2. Paste a Google Drive folder URL into the dialog and click "Analyze Folder".
 *   3. Wait for the scan (it auto-resumes if it hits the 6-min limit).
 *   4. Review the "Duplicates" sheet, then click "Move Duplicates to Trash".
 *   To clear a paused/partial scan: "🚀 Angel" menu → "Reset Scan Progress".
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

const MAX_RUNTIME = 5 * 60 * 1000;   // soft deadline; hard kill is at 6 min
const FLUSH_EVERY = 200;             // rows buffered before a batched sheet write
const STATUS_EVERY = 2000;           // ms between live-status writes
const PAGE_SIZE = 1000;              // Drive list page size

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const PATH_SEP = ' → ';

const P_PHASE = 'PHASE';
const P_ROOT = 'ROOT_ID';
const P_CURSOR = 'QUEUE_CURSOR';
const P_PAGE = 'PAGE_TOKEN';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🚀 Angel')
      .addItem('Start Deduplicator', 'showUi')
      .addItem('Reset Scan Progress', 'resetToken')
      .addToUi();
}

function showUi() {
  const html = HtmlService.createHtmlOutputFromFile('Progress')
      .setWidth(600).setHeight(500);
  SpreadsheetApp.getUi().showModelessDialog(html, 'Deduplication Engine');
}

function resetToken() {
  [FILES_SHEET, QUEUE_SHEET, DUPES_SHEET].forEach(name => {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (sh) clearData(sh);
  });
  PropertiesService.getScriptProperties().deleteAllProperties();
  CacheService.getScriptCache().remove('STATUS');
  SpreadsheetApp.getUi().alert('Scan progress, checkpoint sheets and cache cleared.');
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

  const current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (headers.every((h, i) => current[i] === h)) return;

  clearData(sh);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
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
  sh.getRange(start, 1, rows.length, rows[0].length)
    .setNumberFormat('@')
    .setValues(rows);
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
  CacheService.getScriptCache().put('STATUS', JSON.stringify(statusState), 600);
}

function getLiveStatus() {
  const raw = CacheService.getScriptCache().get('STATUS');
  return raw ? JSON.parse(raw) : {};
}

/* ------------------------------------------------------------------- scan -- */

/**
 * One execution's worth of work. Returns {timeout:true} when the client should
 * call it again to continue, or the final summary when everything is done.
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

    if (phase === 'SCAN') {
      const finished = scanUntilDeadline(deadline);
      if (!finished) return { timeout: true, count: statusState.files || 0, phase: 'Scanning' };
      props.setProperty(P_PHASE, 'DEDUPE');
    }

    if (Date.now() > deadline) return { timeout: true, count: statusState.files || 0, phase: 'Comparing' };

    const summary = runDeduplication();
    props.deleteProperty(P_PHASE);
    return summary;

  } catch (e) {
    setStatus({ currentFile: 'Error: ' + e.message }, true);
    return { error: e.message };
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

  const root = Drive.Files.get(rootId, { fields: 'id,name', supportsAllDrives: true });
  appendRows(queueSh, [[root.id, root.name]]);
  props.setProperties({ [P_ROOT]: rootId, [P_CURSOR]: '0', [P_PHASE]: 'SCAN' });
  props.deleteProperty(P_PAGE);
  statusState = {};
  setStatus({ currentParent: 'Root', currentFolder: root.name, currentFile: 'Starting…', files: 0 }, true);
}

/**
 * Breadth-first walk driven by the _scan_queue sheet plus a cursor in properties.
 * Resuming is O(1) — it picks up at the cursor instead of re-descending the tree.
 * Returns true when the queue is exhausted, false when the deadline was hit.
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

  while (cursor < queue.length) {
    if (Date.now() > deadline) { flush(); return false; }

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
      res = Drive.Files.list(params);
    } catch (e) {
      if (pageToken) { pageToken = null; continue; }          // stale token → restart folder
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
  return true;
}

/* ------------------------------------------------------------------ dedup -- */

/**
 * Groups the scanned files by md5 + size and writes every later match to the
 * Duplicates sheet. Files without a hash (Google-native) and zero-byte files are
 * never reported — neither can be compared safely by content.
 *
 * Both the duplicate (the copy that would be trashed) and the original it matched
 * get a clickable Drive link, so a row can be checked without hunting for the file.
 */
function runDeduplication() {
  const filesSh = getSheet(FILES_SHEET, FILES_HEADERS);
  const dupesSh = getSheet(DUPES_SHEET, DUPES_HEADERS);
  clearData(dupesSh);
  dupesSh.setColumnWidth(D_COL_DUPE_LINK, LINK_COL_WIDTH);
  dupesSh.setColumnWidth(D_COL_ORIG_LINK, LINK_COL_WIDTH);

  const rows = readColumns(filesSh, 5);
  const seen = {};
  const dupeRows = [];
  let skipped = 0;

  rows.forEach(r => {
    const id = r[0], name = r[1], size = r[2], path = r[3], hash = r[4];
    if (!hash || !size) { skipped++; return; }
    const key = hash + '_' + size;
    if (seen[key]) {
      const orig = seen[key];
      dupeRows.push([name, fileUrl(id), path, id,
                     orig.name, fileUrl(orig.id), orig.path,
                     size, hash, '']);
    } else {
      seen[key] = { id: id, name: name, path: path };
    }
  });

  const start = appendRows(dupesSh, dupeRows);
  linkifyColumn(dupesSh, start, D_COL_DUPE_LINK, dupeRows.map(r => r[D_COL_DUPE_LINK - 1]));
  linkifyColumn(dupesSh, start, D_COL_ORIG_LINK, dupeRows.map(r => r[D_COL_ORIG_LINK - 1]));
  setStatus({ currentFile: 'Done — ' + dupeRows.length + ' duplicates', files: rows.length }, true);

  return {
    done: true,
    dupeCount: dupeRows.length,
    totalFiles: rows.length,
    skipped: skipped,
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl() + '#gid=' + dupesSh.getSheetId()
  };
}

/* ------------------------------------------------------------------ trash -- */

/**
 * Trashes duplicates listed in the Duplicates sheet, resuming across executions.
 * The client calls this repeatedly while `remaining` > 0.
 */
function trashDuplicates() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return { error: 'Another operation is running.' };
  try {
    const deadline = Date.now() + MAX_RUNTIME;
    const sh = getSheet(DUPES_SHEET, DUPES_HEADERS);
    const rows = readColumns(sh, DUPES_HEADERS.length);
    let trashed = 0, errors = 0, remaining = 0;

    for (let i = 0; i < rows.length; i++) {
      if (rows[i][D_COL_STATUS - 1]) continue;                 // already handled
      if (Date.now() > deadline) { remaining = rows.length - i; break; }
      let status;
      try {
        DriveApp.getFileById(rows[i][D_COL_DUPE_ID - 1]).setTrashed(true);
        status = 'Trashed';
        trashed++;
      } catch (e) {
        status = 'Error: ' + e.message;
        errors++;
      }
      sh.getRange(i + 2, D_COL_STATUS).setValue(status);
      setStatus({ currentFile: 'Trashing: ' + rows[i][0] });
    }

    setStatus({ currentFile: 'Trashed ' + trashed + ' file(s)' }, true);
    return { trashed: trashed, errors: errors, remaining: remaining };
  } catch (e) {
    return { error: e.message };
  } finally {
    lock.releaseLock();
  }
}
