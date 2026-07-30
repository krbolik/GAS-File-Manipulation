/*
 * Deduplicator test harness.
 *
 *   node test/simulate.js          → runs every assertion, exits non-zero on failure
 *
 * Runs the real src/Code.js inside a vm context against a fake Sheets/Drive/Script API:
 * an in-memory sheet model with ranges, rich text, checkboxes, notes, filters and
 * selections, a fake trigger registry, and a Drive stub that can report files as
 * trashed or unreadable. Nothing here touches a real spreadsheet or a real Drive.
 *
 * It exists to pin the promises rather than the mechanics — that a repeated file record
 * is never reported as a duplicate of itself, that swapping every row of a family
 * over-keeps instead of destroying, that no scan tick ever calls setTrashed, that a row
 * deleted from the sheet is never trashed, and that a duplicate whose original is already
 * in the trash is skipped. Change those behaviours and this fails loudly.
 *
 * NOT part of the deployed Apps Script project: .claspignore keeps pushes to src/.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'Code.js');

class Sheet {
  // maxRows is modelled for real, not derived from the data: the whole point of compaction
  // is that Sheets charges the grid rather than the populated cells, so a fake that reported
  // "as many rows as there is data" could not tell a cleared sheet from a compacted one.
  constructor(name) { this.name = name; this.cells = []; this.notes = {}; this.checkboxRows = new Set(); this.links = {}; this.maxCols = 26; this.maxRows = 1000; this.filterHidden = new Set(); this.selection = []; }
  getName() { return this.name; }
  isRowHiddenByFilter(row) { return this.filterHidden.has(row); }
  isRowHiddenByUser() { return false; }
  select(...spans) { this.selection = spans.map(([row, n]) => this.getRange(row, 1, n, 1)); }
  getActiveRange() { return this.selection[this.selection.length - 1]; }
  getActiveRangeList() { return { getRanges: () => this.selection }; }
  getSheetId() { return 1; }
  setFrozenRows() { return this; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(after, n) { this.maxCols += n; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; }
  deleteRows(row, n) { this.cells.splice(row - 1, n); this.maxRows -= n; }
  setColumnWidth() { return this; }
  getLastRow() {
    let last = 0;
    this.cells.forEach((row, i) => { if (row && row.some(v => v !== '' && v !== undefined && v !== null)) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let w = 0;
    this.cells.forEach(row => { if (row) row.forEach((v, j) => { if (v !== '' && v !== undefined && v !== null) w = Math.max(w, j + 1); }); });
    return w;
  }
  appendRow(vals) { this.cells[this.getLastRow()] = vals.slice(); }
  cell(r, c, v) {
    if (!this.cells[r - 1]) this.cells[r - 1] = [];
    if (v !== undefined) this.cells[r - 1][c - 1] = v;
    const got = this.cells[r - 1][c - 1];
    return got === undefined ? '' : got;
  }
  getRange(row, col, nRows = 1, nCols = 1) {
    const sh = this;
    return {
      getRow: () => row, getNumRows: () => nRows, getColumn: () => col, getNumColumns: () => nCols,
      getSheet: () => sh,
      getValues() { const out = []; for (let i = 0; i < nRows; i++) { const r = []; for (let j = 0; j < nCols; j++) r.push(sh.cell(row + i, col + j)); out.push(r); } return out; },
      getValue() { return sh.cell(row, col); },
      setValues(vals) { vals.forEach((r, i) => r.forEach((v, j) => sh.cell(row + i, col + j, v))); return this; },
      setValue(v) { sh.cell(row, col, v); return this; },
      setNumberFormat() { return this; }, setFontWeight() { return this; },
      setNote(n) { sh.notes[row + ',' + col] = n; return this; },
      clearContent() { for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) sh.cell(row + i, col + j, ''); return this; },
      clearDataValidations() { for (let i = 0; i < nRows; i++) sh.checkboxRows.delete(row + i); return this; },
      insertCheckboxes() { for (let i = 0; i < nRows; i++) { sh.checkboxRows.add(row + i); if (sh.cell(row + i, col) === '') sh.cell(row + i, col, false); } return this; },
      setRichTextValues(vals) { vals.forEach((r, i) => { sh.links[(row + i) + ',' + col] = r[0].url; sh.cell(row + i, col, r[0].text); }); return this; },
      setRichTextValue(v) { sh.links[row + ',' + col] = v.url; sh.cell(row, col, v.text); return this; }
    };
  }
}

class Spreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new Sheet(n)); }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/FAKE/edit'; }
  getSpreadsheetTimeZone() { return 'Europe/Berlin'; }
  toast(msg) { this.toasts = (this.toasts || []).concat(msg); }
}

const ss = new Spreadsheet();
const props = {};
const cache = {};
const alerts = [];

const logs = [];
const tzUsed = [];
let uiAnswer = 'YES';              // what ui.alert(...YES_NO) returns; set per test
const sandbox = {
  // Capture what the script logs, so the trace lines can be asserted like any other output.
  console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
  Utilities: {
    sleep: () => {},
    // Enough of formatDate for the one pattern the script uses (UTC stands in for tz).
    formatDate: (d, tz, pat) => {
      tzUsed.push(tz);
      // Duck-typed: the script's Date comes from the vm realm, so instanceof would fail.
      if (!d || typeof d.getUTCFullYear !== 'function' || isNaN(d.getTime())) throw new Error('bad date');
      const p = n => String(n).padStart(2, '0');
      return pat.replace('yyyy', d.getUTCFullYear()).replace('MM', p(d.getUTCMonth() + 1))
                .replace('dd', p(d.getUTCDate())).replace('HH', p(d.getUTCHours()))
                .replace('mm', p(d.getUTCMinutes()));
    }
  },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ss,
    getActiveSheet: () => ss.getSheetByName('Duplicates'),
    getUi: () => ({
      createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }),
      // Records prompts and returns whatever the test has scripted as the button press.
      alert: (...args) => { alerts.push(args.join(' | ')); return uiAnswer; },
      ButtonSet: { YES_NO: 'YES_NO', OK: 'OK' },
      Button: { YES: 'YES', NO: 'NO', OK: 'OK' }
    }),
    newRichTextValue: () => { const o = {}; return { setText(t) { o.text = t; return this; }, setLinkUrl(u) { o.url = u; return this; }, build: () => o }; }
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = v; },
    setProperties: o => Object.assign(props, o),
    deleteProperty: k => { delete props[k]; },
    deleteAllProperties: () => Object.keys(props).forEach(k => delete props[k])
  }) },
  CacheService: { getScriptCache: () => ({
    get: k => (k in cache ? cache[k] : null),
    put: (k, v) => { cache[k] = v; },
    remove: k => { delete cache[k]; },
    removeAll: ks => ks.forEach(k => delete cache[k])
  }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  DriveApp: { getFileById: id => ({ setTrashed: () => { trashed.push(id); } }) },
  // Files.get doubles as the keeper-alive check; `trashedIds` marks files already binned.
  Drive: { Files: {
    get: (id, opts) => {
      if (opts && String(opts.fields || '').indexOf('trashed') >= 0) {
        if (missingIds.has(id)) throw new Error('File not found: ' + id);
        return { id: id, trashed: trashedIds.has(id) };
      }
      return { id: id, name: 'Root' };
    },
    list: () => ({ files: [] })
  } },
  HtmlService: { createHtmlOutputFromFile: () => ({ setWidth() { return this; }, setHeight() { return this; } }) },
  Session: { getScriptTimeZone: () => 'Europe/Berlin' },
  ScriptApp: {
    getProjectTriggers: () => triggers,
    deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: fn => ({
      timeBased: () => ({
        everyMinutes: m => ({
          create: () => { triggers.push({ getHandlerFunction: () => fn, minutes: m }); }
        })
      })
    })
  }
};
const triggers = [];
const trashedIds = new Set();      // files Drive reports as already in the trash
const missingIds = new Set();      // files Drive cannot read at all
sandbox.triggers = triggers;
const trashed = [];
sandbox.trashed = trashed;

vm.createContext(sandbox);
new vm.Script(fs.readFileSync(SRC, 'utf8') + '\n;this.__api = {runDeduplication, swapKeeper, swapSelectedRows, selectedDataRows, onEdit, getState, trashDuplicates, finishPendingLinks, setBackgroundScan, backgroundScanTick, backgroundInfo, bgBudget, requestPause, setBackgroundTrash, backgroundTrashTick, pendingTrashCount, trashOneRow, looksLikeFileId, BG_TRASH_FN, compareScannedSoFarMenu, BG_DAILY_BUDGET_MS, BG_TRIGGER_FN, DUPES_HEADERS, D_COL_SWAP, D_COL_STATUS, D_COL_DUPE_ID, resetToken, startFreshScan, purgeSheet, compactData};').runInContext(sandbox);
const api = sandbox.__api;

/* ---- fixture: A,B,C identical (B newest); D,E identical (D newest, scanned first);
       F unique; G google-native; H,I identical but I has no date               ---- */
const files = ss.insertSheet('_scan_files');
files.appendRow(['File ID', 'Name', 'Size', 'Path', 'Hash', 'Date']);
[['idA', 'a.pdf', 100, 'Root', 'h1', '2021-01-01T10:00:00.000Z'],
 ['idB', 'b.pdf', 100, 'Root → x', 'h1', '2024-06-30T09:00:00.000Z'],   // newest of h1
 ['idC', 'c.pdf', 100, 'Root → y', 'h1', '2023-05-05T08:00:00.000Z'],
 ['idD', 'd.pdf', 200, 'Root', 'h2', '2025-02-02T12:00:00.000Z'],       // newest of h2
 ['idE', 'e.pdf', 200, 'Root → z', 'h2', '2020-02-02T12:00:00.000Z'],
 ['idF', 'f.pdf', 300, 'Root', 'h3', '2022-01-01T00:00:00.000Z'],
 ['idG', 'g.doc', 0, 'Root', '', '2022-01-01T00:00:00.000Z'],
 ['idH', 'h.pdf', 400, 'Root', 'h4', '2019-09-09T09:09:00.000Z'],       // dated beats
 ['idI', 'i.pdf', 400, 'Root → q', 'h4', '']].forEach(r => files.appendRow(r));      // undated

let res = api.runDeduplication();
const dupes = ss.getSheetByName('Duplicates');
const header = dupes.getRange(1, 1, 1, api.DUPES_HEADERS.length).getValues()[0];
console.log('HEADERS:', header.join(' | '));
console.log('summary:', JSON.stringify(res));

const parseIdFrom = url => (String(url).match(/\/d\/([^/?#]+)/) || [, ''])[1];
const W = api.DUPES_HEADERS.length;
const dump = () => dupes.getRange(2, 1, 4, W).getValues()
  .filter(r => r[0] !== '')
  .map(r => r.map(v => (v === '' ? '·' : v)).join('  '));
console.log('\nROWS after first compare:');
dump().forEach(r => console.log('  ' + r));

// h1: keeper B (newest) -> rows for A and C. h2: keeper D -> row for E.
// h4: keeper H (dated beats undated) -> row for I. F unique, G has no hash.
const col = n => api.DUPES_HEADERS.indexOf(n) + 1;
const dupeIds = [2, 3, 4, 5].map(r => dupes.cell(r, col('Duplicate ID')));
const origOf = id => { const r = [2, 3, 4, 5].find(r => dupes.cell(r, col('Duplicate ID')) === id); return r ? dupes.cell(r, col('Original Link')) : ''; };
const ok = [];
ok.push(['4 dupe rows', res.dupeCount === 4]);
ok.push(['newest (idB) is not a duplicate', !dupeIds.includes('idB')]);
ok.push(['older copies idA and idC are', dupeIds.includes('idA') && dupeIds.includes('idC')]);
ok.push(['both point at the newest', origOf('idA').includes('idB') && origOf('idC').includes('idB')]);
ok.push(['newest kept even when scanned first (idD)', !dupeIds.includes('idD') && dupeIds.includes('idE')]);
ok.push(['undated loses to dated (idI trashed, idH kept)', dupeIds.includes('idI') && !dupeIds.includes('idH')]);
ok.push(['undated counted', res.undated === 1]);
ok.push(['dates shown for both sides', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dupes.cell(2, col('Duplicate Date'))) &&
                                        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dupes.cell(2, col('Original Date')))]);
ok.push(['checkbox per row', [2, 3, 4, 5].every(r => dupes.checkboxRows.has(r))]);
ok.push(['size / hash columns', dupes.cell(2, col('Size')) === 100 && dupes.cell(2, col('Hash')) === 'h1']);
ok.push(['links clickable', dupes.links['2,' + col('Duplicate Link')] === dupes.cell(2, col('Duplicate Link'))]);

/* ---- swap row 2: overrule the date rule and keep the OLDER copy (idA) ---- */
dupes.cell(2, api.D_COL_SWAP, true);
api.onEdit({ range: dupes.getRange(2, api.D_COL_SWAP) });
console.log('\nROWS after swapping row 2 (keep the older a.pdf):');
dump().forEach(r => console.log('  ' + r));
ok.push(['swap put the newer idB on the duplicate side', dupes.cell(2, col('Duplicate ID')) === 'idB']);
ok.push(['swap traded names', dupes.cell(2, col('Duplicate Name')) === 'b.pdf' &&
                              dupes.cell(2, col('Original Name')) === 'a.pdf']);
ok.push(['swap traded dates too', dupes.cell(2, col('Duplicate Date')).startsWith('2024') &&
                                  dupes.cell(2, col('Original Date')).startsWith('2021')]);
ok.push(['swap re-linked', dupes.links['2,' + col('Duplicate Link')].includes('idB') &&
                           dupes.links['2,' + col('Original Link')].includes('idA')]);
ok.push(['checkbox cleared', dupes.cell(2, api.D_COL_SWAP) === false]);
ok.push(['toast shown', (ss.toasts || []).length === 1]);

/* ---- trash, then re-compare: swap remembered, Trashed carried over ---- */
const t = api.trashDuplicates();
console.log('\ntrash:', JSON.stringify(t), 'ids:', trashed.join(','));
ok.push(['trashed the swapped-in id', trashed.includes('idB')]);
ok.push(['trashed 4', t.trashed === 4]);
ok.push(['every group keeps a copy', ['idA', 'idD', 'idH'].every(id => !trashed.includes(id))]);

res = api.runDeduplication();
console.log('\nROWS after re-compare:');
dump().forEach(r => console.log('  ' + r));
console.log('summary:', JSON.stringify(res));
ok.push(['swap survived re-compare', dupes.cell(2, col('Duplicate ID')) === 'idB']);
ok.push(['status carried', dupes.cell(2, col('Status')) === 'Trashed']);
ok.push(['swapsKept reported', res.swapsKept === 1]);
ok.push(['nothing pending', res.pending === 0]);

/* ---- swap refuses on a trashed row ---- */
ok.push(['trashed row cannot swap', api.swapKeeper(dupes, 2) === 'TRASHED']);

/* ---- state for the dialog ---- */
const st = api.getState();
console.log('\ngetState:', JSON.stringify(st));
ok.push(['state sees 4 rows', st.dupeTotal === 4]);
ok.push(['state sees 0 pending', st.dupePending === 0]);

/* ---- migration: a v5.2-layout sheet (ID in D, Status in J) must keep its Status ---- */
delete ss.sheets['Duplicates'];
const old = ss.insertSheet('Duplicates');
old.appendRow(['Duplicate Name', 'Duplicate Link', 'Duplicate Path', 'Duplicate ID',
               'Original Name', 'Original Link', 'Original Path', 'Size', 'Hash', 'Status']);
old.appendRow(['b.pdf', 'https://drive.google.com/file/d/idB/view', 'Root → x', 'idB',
               'a.pdf', 'https://drive.google.com/file/d/idA/view', 'Root', 100, 'h1', 'Trashed']);
old.appendRow(['e.pdf', 'https://drive.google.com/file/d/idE/view', 'Root → z', 'idE',
               'd.pdf', 'https://drive.google.com/file/d/idD/view', 'Root', 200, 'h2', 'Error: no permission']);
res = api.runDeduplication();
const migrated = ss.getSheetByName('Duplicates');
console.log('\nROWS after upgrading a v5.2 sheet:');
migrated.getRange(2, 1, 4, W).getValues().forEach(r => console.log('  ' + r.map(v => (v === '' ? '·' : v)).join('  ')));
const statusOf = id => {
  const r = [2, 3, 4, 5].find(r => migrated.cell(r, col('Duplicate ID')) === id);
  return r ? migrated.cell(r, col('Status')) : '(absent)';
};
ok.push(['migrated to new headers', migrated.getRange(1, 1, 1, W).getValues()[0][col('Duplicate Date') - 1] === 'Duplicate Date']);
// The old sheet called idB a duplicate of idA — a swap under the date rule, so it stands.
ok.push(['old sheet swap honoured', migrated.cell(2, col('Duplicate ID')) === 'idB' && res.swapsKept === 1]);
ok.push(['Trashed carried across layouts', statusOf('idB') === 'Trashed']);
ok.push(['Error status carried too', String(statusOf('idE')).indexOf('Error') === 0]);
ok.push(['pending counts only unhandled', res.pending === 2]);

/* ---- menu swap must ignore rows a filter hides, and honour every selected range ---- */
delete ss.sheets['Duplicates'];
res = api.runDeduplication();                    // fresh list: rows 2..5
const fs2 = ss.getSheetByName('Duplicates');
const idsOf = () => [2, 3, 4, 5].map(r => fs2.cell(r, col('Duplicate ID')));
const before = idsOf();

fs2.filterHidden.add(3);                         // row 3 filtered out of view
fs2.select([2, 4]);                              // drag-select rows 2..5 as one range
alerts.length = 0;
api.swapSelectedRows();
const after = idsOf();
console.log('\nmenu swap over a filtered selection (row 3 hidden):');
console.log('  before:', before.join(','), '\n  after: ', after.join(','));
console.log('  alert:', alerts[0].replace(/\n/g, ' | '));
ok.push(['visible rows swapped', after[0] !== before[0] && after[2] !== before[2] && after[3] !== before[3]]);
ok.push(['filtered row untouched', after[1] === before[1]]);
ok.push(['alert reports the skip', /1 hidden row\(s\) skipped/.test(alerts[0])]);
ok.push(['3 swapped, not 4', /^3 row\(s\) swapped/.test(alerts[0])]);

fs2.filterHidden.clear();
fs2.select([2, 1], [5, 1]);                      // two separate blocks, Ctrl-click style
alerts.length = 0;
api.swapSelectedRows();
const after2 = idsOf();
ok.push(['both selected ranges acted on', after2[0] === before[0] && after2[3] === before[3]]);
ok.push(['unselected rows left alone', after2[1] === before[1] && after2[2] === after[2]]);
ok.push(['no phantom hidden skips', !/hidden/.test(alerts[0])]);

/* ---- overlapping ranges must not double-swap (a swap is its own inverse) ---- */
fs2.select([2, 2], [3, 2]);                      // rows 2-3 and 3-4 overlap on row 3
const beforeOverlap = idsOf();
api.swapSelectedRows();
const afterOverlap = idsOf();
ok.push(['overlap swapped once, not twice', afterOverlap[1] !== beforeOverlap[1]]);

/* ---- the trace lines a run leaves behind ---- */
logs.length = 0;
fs2.filterHidden.add(3);
fs2.select([2, 4]);
api.swapSelectedRows();
fs2.filterHidden.clear();
const logged = logs.join('\n');
console.log('\nlog lines from one filtered menu swap:');
logs.forEach(l => console.log('  ' + l));
ok.push(['logs the entry point', /swapSelectedRows start.*Duplicates/.test(logged)]);
ok.push(['logs the resolved selection', /selection resolved.*"ranges":\["2:5"\].*"willAct":3.*"hiddenSkipped":1/.test(logged)]);
ok.push(['logs which rows were swapped', /swapSelectedRows rows swapped 2, 4, 5/.test(logged)]);
ok.push(['logs the outcome counts', /swapSelectedRows done.*"swapped":3/.test(logged)]);
ok.push(['toast confirms as well as the alert', (ss.toasts || []).some(t => /row\(s\) swapped/.test(t))]);

logs.length = 0;
api.trashDuplicates();
ok.push(['trash chunk logged', /trash chunk done.*"trashed"/.test(logs.join('\n'))]);

logs.length = 0;
api.runDeduplication();
ok.push(['compare logged', /compare done.*"duplicates"/.test(logs.join('\n'))]);

/* ---- the scan no longer filters repeats, so the compare must collapse them ---- */
delete ss.sheets['Duplicates'];
// idA recorded twice (a folder re-listed after a stale page token) and idJ twice via two
// parents. Neither may be reported as a duplicate of itself.
files.appendRow(['idA', 'a.pdf', 100, 'Root', 'h1', '2021-01-01T10:00:00.000Z']);
files.appendRow(['idJ', 'j.pdf', 500, 'Root', 'h5', '2022-01-01T00:00:00.000Z']);
files.appendRow(['idJ', 'j.pdf', 500, 'Root → shared', 'h5', '2022-01-01T00:00:00.000Z']);
res = api.runDeduplication();
const rep = ss.getSheetByName('Duplicates');
const repIds = [];
for (let r = 2; r <= 8; r++) { const v = rep.cell(r, col('Duplicate ID')); if (v) repIds.push(v); }
console.log('\nwith repeat records in _scan_files:');
console.log('  duplicate ids listed:', repIds.join(','));
console.log('  summary:', JSON.stringify(res));
ok.push(['repeat records collapsed', res.repeats === 2]);   // the second idA and the second idJ
ok.push(['distinct file count reported', res.totalFiles === 10]);
ok.push(['a repeated id is never its own duplicate', repIds.filter(id => id === 'idJ').length === 0]);
ok.push(['still 4 real duplicates', res.dupeCount === 4]);

/* ---- a compare that runs out of time defers decoration and resumes ---- */
delete ss.sheets['Duplicates'];
res = api.runDeduplication(Date.now() - 1);            // deadline already passed
const late = ss.getSheetByName('Duplicates');
console.log('\ncompare with an expired deadline:', JSON.stringify({ linksPending: res.linksPending, dupes: res.dupeCount }));
ok.push(['rows written despite the deadline', res.dupeCount === 4 && late.cell(2, col('Duplicate ID')) !== '']);
ok.push(['decoration deferred', res.linksPending === true]);
ok.push(['no links yet', !late.links['2,' + col('Duplicate Link')]]);
ok.push(['no checkboxes yet', !late.checkboxRows.has(2)]);
ok.push(['state reports it', api.getState().linksPending === true]);
ok.push(['urls are plain text meanwhile', /drive\.google\.com/.test(late.cell(2, col('Duplicate Link')))]);

const fin = api.finishPendingLinks();
ok.push(['finishPendingLinks completes', fin.done === true && !fin.pending]);
ok.push(['links applied on resume', late.links['2,' + col('Duplicate Link')] === late.cell(2, col('Duplicate Link'))]);
ok.push(['checkboxes applied on resume', late.checkboxRows.has(2) && late.checkboxRows.has(5)]);
ok.push(['state clears', api.getState().linksPending === false]);

/* ---- multi-copy group semantics: A,B,C share h1 with B newest ---- */
delete ss.sheets['Duplicates'];
trashed.length = 0;
res = api.runDeduplication();
const g = ss.getSheetByName('Duplicates');
const rowOf = id => [2, 3, 4, 5].find(r => g.cell(r, col('Duplicate ID')) === id);
const h1Rows = [2, 3, 4, 5].filter(r => g.cell(r, col('Hash')) === 'h1');
console.log('\n3-copy group A,B,C (B newest):');
h1Rows.forEach(r => console.log('  row ' + r + ': dupe=' + g.cell(r, col('Duplicate ID')) +
  ' orig=' + parseIdFrom(g.cell(r, col('Original Link')))));
ok.push(['n copies produce n-1 rows', h1Rows.length === 2]);
ok.push(['Copies shows the family size on every row of it',
  h1Rows.every(r => g.cell(r, col('Copies')) === 3)]);
ok.push(['Copies is 2 for a plain pair', g.cell(rowOf('idE'), col('Copies')) === 2]);
ok.push(['Copies and Size are numbers, not text',
  typeof g.cell(2, col('Copies')) === 'number' && typeof g.cell(2, col('Size')) === 'number']);
ok.push(['both rows point at the same keeper',
  h1Rows.every(r => parseIdFrom(g.cell(r, col('Original Link'))) === 'idB')]);
ok.push(['group rows are adjacent', h1Rows[1] === h1Rows[0] + 1]);
ok.push(['group identity is the hash column', g.cell(2, col('Hash')) === g.cell(3, col('Hash'))]);

// One swap designates a different survivor: keep A instead of B.
api.swapKeeper(g, rowOf('idA'));
api.trashDuplicates();
console.log('  after swapping only A-row, trashed:', trashed.join(','));
ok.push(['one swap → keeper changes, one survivor', trashed.includes('idB') && trashed.includes('idC') && !trashed.includes('idA')]);

// Swapping EVERY row of a group over-keeps: the trash set collapses to one id.
delete ss.sheets['Duplicates'];
trashed.length = 0;
api.runDeduplication();
const g2 = ss.getSheetByName('Duplicates');
const rowOf2 = id => [2, 3, 4, 5].find(r => g2.cell(r, col('Duplicate ID')) === id);
api.swapKeeper(g2, rowOf2('idA'));
api.swapKeeper(g2, rowOf2('idC'));
api.trashDuplicates();
const h1Trashed = ['idA', 'idB', 'idC'].filter(id => trashed.includes(id));
console.log('  after swapping BOTH rows, trashed from the group:', h1Trashed.join(',') || '(none)');
ok.push(['swapping every row over-keeps rather than destroys', h1Trashed.length === 1 && h1Trashed[0] === 'idB']);
ok.push(['two copies therefore survive', !trashed.includes('idA') && !trashed.includes('idC')]);

/* ---- background runner: trigger lifecycle, daily budget, deference to the reviewer ---- */
console.log('\nbackground runner:');
triggers.length = 0;
Object.keys(props).forEach(k => delete props[k]);

ok.push(['refuses to start with nothing to do', !!api.setBackgroundScan(true).error]);
ok.push(['no trigger installed then', triggers.length === 0]);

props['PHASE'] = 'SCAN';                                  // a scan is in progress
let bg = api.setBackgroundScan(true);
ok.push(['starts and reports running', bg.running === true && triggers.length === 1]);
ok.push(['trigger points at the tick handler', triggers[0].getHandlerFunction() === api.BG_TRIGGER_FN]);
ok.push(['cadence is 5 min', triggers[0].minutes === 5]);
ok.push(['budget reported in minutes', bg.budgetMin === 300 && bg.leftMin === 300]);

api.setBackgroundScan(true);                              // starting twice must not stack
ok.push(['starting twice does not duplicate the trigger', triggers.length === 1]);

// A tick with decoration outstanding and the scan still mid-flight: it must do the
// decoration, spend budget, and leave the trigger installed because work remains.
props['LINKS_FROM'] = '2';
props['BG_USED_MS'] = String(60 * 1000);        // pretend a minute is already spent today
const trashedBefore = trashed.length;
logs.length = 0;
api.backgroundScanTick();
console.log('  working tick:', logs.join(' | '));
// A fake tick returns in well under a millisecond, so assert the accounting path rather
// than a wall-clock increase: the spend is recorded against today and never lost.
ok.push(['tick records runtime against today\'s budget',
  Number(props['BG_USED_MS']) >= 60 * 1000 && !!props['BG_DAY']]);
ok.push(['budget left is reported accordingly', api.backgroundInfo().leftMin === 299]);
ok.push(['tick did the decoration', /background tick decorated/.test(logs.join('\n'))]);
ok.push(['trigger stays while the scan is unfinished', triggers.length === 1]);
ok.push(['a background tick never trashes', trashed.length === trashedBefore]);

// Budget exhausted: the tick must do nothing but stay installed for tomorrow.
props['BG_USED_MS'] = String(api.BG_DAILY_BUDGET_MS);
logs.length = 0;
api.backgroundScanTick();
console.log('  budget-exhausted tick:', logs.join(' | ') || '(silent)');
ok.push(['skips when the daily budget is gone', /background tick skipped/.test(logs.join('\n'))]);
ok.push(['does not scan on a skipped tick', !/background tick \{/.test(logs.join('\n'))]);
ok.push(['trigger survives budget exhaustion', triggers.length === 1]);

// Date rollover resets the budget.
props['BG_DAY'] = '2000-01-01';
ok.push(['budget resets on a new day', api.bgBudget().usedMs === 0]);

// A pause requested from the sheet switches background mode off rather than racing it.
api.requestPause();
api.backgroundScanTick();
ok.push(['a pause request stops background mode', triggers.length === 0]);

// Nothing left to do → the trigger removes itself.
delete cache['PAUSE_REQUEST'];
props['PHASE'] = 'SCAN';
api.setBackgroundScan(true);
delete props['PHASE'];
delete props['LINKS_FROM'];
logs.length = 0;
api.backgroundScanTick();
console.log('  finished tick:', logs.join(' | '));
ok.push(['removes itself when the work is done', triggers.length === 0]);
ok.push(['logs completion', /background scan complete/.test(logs.join('\n'))]);
ok.push(['stop is idempotent', api.setBackgroundScan(false).running === false]);

/* ---- what trashing is allowed to touch ---- */
console.log('\ntrash guards:');
ok.push(['a plausible id passes', api.looksLikeFileId('1AbC-dEf_2')]);
ok.push(['a filename is not an id', !api.looksLikeFileId('invoice.pdf')]);
ok.push(['text with spaces is not an id', !api.looksLikeFileId('Original Name')]);
ok.push(['empty is not an id', !api.looksLikeFileId('')]);

const goodRow = () => { const r = []; r[col('Duplicate ID') - 1] = 'idX';
  r[col('Hash') - 1] = 'h9'; r[col('Original Link') - 1] = 'https://drive.google.com/file/d/idKeep/view'; return r; };
trashed.length = 0;
ok.push(['a well-formed row is trashed', api.trashOneRow(goodRow(), {}) === 'Trashed' && trashed.includes('idX')]);

const noHash = goodRow(); noHash[col('Hash') - 1] = '';
ok.push(['a row with no hash is refused', /^Error/.test(api.trashOneRow(noHash, {}))]);
const badId = goodRow(); badId[col('Duplicate ID') - 1] = 'not an id';
ok.push(['a row with a bad id is refused', /^Error/.test(api.trashOneRow(badId, {}))]);
const noOrig = goodRow(); noOrig[col('Original Link') - 1] = '';
ok.push(['a row with no original is refused', /^Error/.test(api.trashOneRow(noOrig, {}))]);

// The important one: never leave a family with every copy in the trash.
trashedIds.add('idKeep');
trashed.length = 0;
const verdict = api.trashOneRow(goodRow(), {});
console.log('  original already trashed →', verdict);
ok.push(['duplicate is skipped when its original is already trashed', /^Skipped/.test(verdict)]);
ok.push(['and nothing was trashed', trashed.length === 0]);
trashedIds.delete('idKeep');

missingIds.add('idKeep');
ok.push(['an unverifiable original also blocks trashing', /^Skipped/.test(api.trashOneRow(goodRow(), {}))]);
missingIds.delete('idKeep');

/* ---- background trash: opt-in, exclusivity, self-removal, and what it reads ---- */
console.log('\nbackground trash runner:');
triggers.length = 0;
Object.keys(props).forEach(k => delete props[k]);
delete ss.sheets['Duplicates'];
api.runDeduplication();                                   // 4 pending rows, current layout
const bt = ss.getSheetByName('Duplicates');

ok.push(['refuses without confirmation', !!api.setBackgroundTrash(true).error]);
ok.push(['nothing installed then', triggers.length === 0]);

props['PHASE'] = 'SCAN';
api.setBackgroundScan(true);
ok.push(['refuses while background scanning runs', !!api.setBackgroundTrash(true, true).error]);
api.setBackgroundScan(false);
delete props['PHASE'];

let r = api.setBackgroundTrash(true, true);
ok.push(['starts with confirmation', r.trashRunning === true && triggers.length === 1]);
ok.push(['handler is the trash tick', triggers[0].getHandlerFunction() === api.BG_TRASH_FN]);
ok.push(['scanning is refused while it runs', !!api.setBackgroundScan(true).error]);

// A deleted row must never be trashed: drop row 3 and confirm that id is untouched.
const droppedId = bt.cell(3, col('Duplicate ID'));
bt.getRange(3, 1, 1, api.DUPES_HEADERS.length).clearContent();
trashed.length = 0;
api.backgroundTrashTick();
console.log('  trashed by the tick:', trashed.join(',') || '(none)');
ok.push(['tick trashed the listed rows', trashed.length > 0]);
ok.push(['a row cleared from the sheet is never trashed', !trashed.includes(droppedId)]);
ok.push(['removes itself once nothing is pending', triggers.length === 0]);
ok.push(['budget was charged', api.bgBudget().usedMs >= 0 && !!props['BG_DAY']]);

// Budget exhaustion blocks trashing too, and keeps the trigger for tomorrow.
Object.keys(props).forEach(k => delete props[k]);
delete ss.sheets['Duplicates'];
api.runDeduplication();
api.setBackgroundTrash(true, true);
props['BG_USED_MS'] = String(api.BG_DAILY_BUDGET_MS);
trashed.length = 0;
logs.length = 0;
api.backgroundTrashTick();
ok.push(['no trashing when the budget is spent', trashed.length === 0]);
ok.push(['logged as skipped', /background trash skipped/.test(logs.join('\n'))]);
ok.push(['trigger kept for the next day', triggers.length === 1]);

// A pause request stops it, as with scanning.
props['BG_USED_MS'] = '0';
api.requestPause();
api.backgroundTrashTick();
ok.push(['a pause request stops background trashing', triggers.length === 0]);
delete cache['PAUSE_REQUEST'];

/* ---- the ledger day follows Pacific, not the script timezone ---- */
ok.push(['budget day is a date string', /^\d{4}-\d{2}-\d{2}$/.test(api.bgBudget().day)]);
ok.push(['ledger uses the quota timezone', tzUsed.indexOf('America/Los_Angeles') >= 0]);

/* ---- rebuilding a finished list asks first, because it resurrects deleted rows ---- */
console.log('\nrebuild guard:');
Object.keys(props).forEach(k => delete props[k]);
delete ss.sheets['Duplicates'];
api.runDeduplication();                                  // a finished list, phase empty
const rebuilt = ss.getSheetByName('Duplicates');
const beforeRows = rebuilt.getLastRow();
rebuilt.getRange(3, 1, 1, api.DUPES_HEADERS.length).clearContent();   // reviewer deletes a row
const afterDelete = rebuilt.cell(3, col('Duplicate ID'));

alerts.length = 0;
uiAnswer = 'NO';
api.compareScannedSoFarMenu();
console.log('  prompt shown:', /Rebuild the duplicate list/.test(alerts.join(' ')));
ok.push(['a finished list prompts before rebuilding', /Rebuild the duplicate list/.test(alerts.join(' '))]);
ok.push(['warns that deleted rows come back', /will come back/.test(alerts.join(' '))]);
ok.push(['answering No changes nothing', rebuilt.cell(3, col('Duplicate ID')) === afterDelete]);

uiAnswer = 'YES';
alerts.length = 0;
api.compareScannedSoFarMenu();
ok.push(['answering Yes rebuilds', rebuilt.getLastRow() === beforeRows &&
                                   rebuilt.cell(3, col('Duplicate ID')) !== '']);

// A scan still in progress must not be nagged: comparing a partial scan is the feature.
props['PHASE'] = 'SCAN';
alerts.length = 0;
uiAnswer = 'NO';
api.compareScannedSoFarMenu();
ok.push(['a partial scan compares without a prompt', !/Rebuild the duplicate list/.test(alerts.join(' '))]);
delete props['PHASE'];
uiAnswer = 'YES';

/* ---- Reset: asks first, stops background jobs, and gives the cells back ---- */
console.log('\nreset:');
triggers.length = 0;
Object.keys(props).forEach(k => delete props[k]);
delete ss.sheets['Duplicates'];
api.runDeduplication();
const rDupes = ss.getSheetByName('Duplicates');
const rFiles = ss.getSheetByName('_scan_files');
const gridBefore = rFiles.getMaxRows();

props['PHASE'] = 'SCAN';
api.setBackgroundScan(true);                     // a background job is running meanwhile
alerts.length = 0;
uiAnswer = 'NO';
api.resetToken();
console.log('  prompt:', (alerts[0] || '').replace(/\n/g, ' | ').slice(0, 150));
ok.push(['reset asks before throwing the list away', /Throw away the scan/.test(alerts.join(' '))]);
ok.push(['reset says where the backup belongs',
  /Duplicate backup/.test(alerts.join(' ')) && /Copy to/.test(alerts.join(' '))]);
ok.push(['answering No keeps the rows', rDupes.getLastRow() > 1]);
ok.push(['answering No keeps the background job', triggers.length === 1]);

uiAnswer = 'YES';
alerts.length = 0;
logs.length = 0;
api.resetToken();
console.log('  after reset:', logs.join(' | '));
ok.push(['reset empties the sheets', rDupes.getLastRow() <= 1 && rFiles.getLastRow() <= 1]);
ok.push(['reset shrinks the grid rather than only blanking it',
  gridBefore > 2 && rDupes.getMaxRows() <= 2 && rFiles.getMaxRows() <= 2]);
ok.push(['reset stops any background job', triggers.length === 0]);
ok.push(['reset clears every cursor', !props['PHASE'] && !props['QUEUE_CURSOR'] && !props['BG_USED_MS']]);

/* ---- a fresh scan must not inherit the previous job's records ---- */
api.startFreshScan('rootX', Date.now() + 60 * 1000);
ok.push(['a fresh scan starts from an empty file record', rFiles.getLastRow() <= 1]);
ok.push(['and seeds the queue with just the root', ss.getSheetByName('_scan_queue').getLastRow() === 2]);

/* ---- compaction is bounded by the deadline, and never at the data's expense ---- */
const probe = ss.insertSheet('_compact_probe');
probe.appendRow(['h']);
probe.cell(500, 1, 'x');
ok.push(['a compaction out of time reports it did not finish', api.compactData(probe, Date.now() - 1) === false]);
ok.push(['rows survive a compaction that could not run', probe.getMaxRows() > 2]);
ok.push(['but purge still clears the data first',
  api.purgeSheet(probe, Date.now() - 1) === false && probe.getLastRow() <= 1]);
ok.push(['and an unbounded compaction finishes the job',
  api.compactData(probe) === true && probe.getMaxRows() <= 2]);

console.log('\n--- checks ---');
let bad = 0;
ok.forEach(([name, pass]) => { if (!pass) bad++; console.log((pass ? 'PASS  ' : 'FAIL  ') + name); });
console.log(bad ? '\n' + bad + ' FAILURES' : '\nall checks pass');
process.exit(bad ? 1 : 0);
