# Deduplicator

Version-controlled source for the **Tech Angel Deduplicator** Google Apps Script — a
tool that recursively scans a Google Drive folder, finds duplicate files by content
hash, and moves them to Trash. The script is bound to the **"DuplicateFinder"** Google
Sheet.

## Status — v5.0

v5.0 is a rewrite of the storage and scanning layer. It is **pushed to the live project
and byte-verified against it, but not yet exercised against a real Drive folder.** Run it
on a small test folder before pointing it at anything that matters.

What changed from v4.1:

| Area | v4.1 | v5.0 |
|------|------|------|
| Checkpoint store | whole file list in one `ScriptProperties` value (**9 KB cap → broke past ~40 files**) | append-only sheets in the bound spreadsheet |
| Hashing | downloaded every file < 20 MB and MD5'd the bytes; `LARGE_<size>` above that | Drive's own `md5Checksum` — **nothing is downloaded**, no size limit |
| Tree walk | recursion, re-descended from the root on every resume | breadth-first queue sheet + cursor, O(1) resume, page-token-accurate |
| Live status | two `setProperty` round-trips **per file** | one throttled `CacheService` write per ~2 s |
| Result delivery | whole duplicate array through `google.script.run` into `innerHTML` | written to the **Duplicates** sheet; dialog gets a summary |
| Deleting | one call with every ID; no resume | `trashDuplicates`, per-row Status column, resumes across the 6-min limit |
| Concurrency | none | `LockService` around scan and trash |

Migration note: the first run after upgrading should start with **🚀 Angel → Reset Scan
Progress** to clear v4's leftover `TEMP_FILE_LIST` / `SCANNED_FOLDERS` properties.

**v5.0.1** — first live run. The scan itself worked (real md5 hashes, correct sizes and
paths), but clearing a checkpoint sheet threw *"Sorry, it is not possible to delete all
non-frozen rows."* Sheets refuses `deleteRows(2, lastRow - 1)` whenever `maxRows` equals
the last data row — reachable both by hand-deleting rows and, possibly, by the grid
growing to exactly fit an append. Fixed by clearing with `clearContent` instead of
`deleteRows` (`clearData`), which is immune to either, and by growing the grid explicitly
in `appendRows` with 100 rows of headroom.

**v5.1** — clickable links for review. The **Duplicates** sheet now has a **Duplicate Link**
and an **Original Link** column, each holding the file's `https://drive.google.com/file/d/<id>/view`
URL as a live hyperlink, so a pair can be opened and compared straight from the row before
anything is trashed. The links are written as *rich text*, not `=HYPERLINK()` formulas —
`appendRows` forces its range to plain-text format (the guard that stores a file named
`=total.xlsx` as text), which would turn a formula into literal text; rich text is immune
to that and `getValues()` still returns the plain URL. `getSheet` now also repairs a header
row that does not match the current layout, so a `Duplicates` sheet written by v5.0 is
re-headed (and its now-misaligned rows dropped) on the next scan instead of silently
mislabelling columns.

**v5.2** — partial results and resilience. A scan of a large tree ran for many executions
and then died with a dialog reading *"Failed: undefined"*, leaving ~1600 already-identified
duplicates unusable because the trash button only appeared after a **completed** scan. Three
things changed:

- **A scan no longer has to finish to be useful.** *Pause & Compare* (dialog) or
  **🚀 Angel → Compare Files Scanned So Far** (menu, works even with the dialog closed) stops
  the walk at the next folder boundary, compares everything recorded so far and fills the
  Duplicates sheet. Those rows can be trashed immediately; *Resume Scan* continues at the
  cursor. Re-comparing later **carries over the Status** of rows already handled, so trashing
  work is never lost or repeated. The pause flag travels through `CacheService`, not
  `ScriptProperties` — the property store is read into an execution once, so a running scan
  would not reliably see a flag set by the execution serving the button click.
- **Failures retry instead of dead-ending.** The dialog re-invokes after a failed call (6
  attempts, 6 s apart) because the server-side checkpoint survives; server errors come back
  as `{error, resumable}` instead of throwing at the client, `describeError` fixes the
  `undefined` message, and transient Drive/Sheets errors (rate limits, 5xx, *"failed while
  accessing document"*) are retried in place with backoff. A folder that cannot be listed at
  all (no permission, deleted mid-scan) is skipped instead of ending the walk.
- **Trashing got faster and restartable.** Status is written in batches of 50 instead of one
  `setValue` per row — the single-cell write was the bottleneck that made ~1600 rows need
  several executions — and the dialog offers the trash button whenever the sheet holds
  unhandled rows, however the scan that produced them ended. The soft deadline moved to
  4.5 min for more headroom under the 6-min kill.

**v5.3** — per-row swap, and the ID column out of the way. The Duplicates sheet now reads
`Duplicate Name · Duplicate Link · Duplicate Path · Original Name · Original Link ·
Original Path · Size · Duplicate ID · Hash · Status · Swap ⇄` — the two sides side by side,
with the raw ID moved back among the machine-facing columns.

**Swap ⇄** is a checkbox per row that behaves like a button: tick it and the Duplicate and
Original sides of that row trade places, so the copy shown as the duplicate is the one that
survives and the file that was the original gets trashed instead. The box clears itself
immediately (via the `onEdit` simple trigger), a toast confirms what happened, and rows
already marked `Trashed` refuse to swap — the file is in the bin, so the row would describe
something that no longer exists. **🚀 Angel → Keep Duplicate Instead (selected rows)** does the
same for a whole selection.

Two details worth knowing:

- The new duplicate ID is parsed back out of the **Original Link**, which is the reason that
  column holds a full URL rather than link text — the two sides stay swappable without a
  second hidden ID column.
- A re-compare **remembers swaps**. `readPairChoices` records which of the two files each
  pair currently calls the duplicate; when `runDeduplication` rebuilds the list and its own
  scan-order default disagrees, the reviewer's choice wins instead of being silently flipped
  back. Whatever is swapped, each content-identical group keeps at least one copy: *n* copies
  produce *n−1* rows, so at most *n−1* distinct files can ever be trashed.

Status carry-over also became layout-independent (`readByHeaders` locates `Duplicate ID` and
`Status` by header name), so upgrading past a column change no longer loses the record of
what was already trashed.

> **Don't hand-edit the checkpoint sheets.** `QUEUE_CURSOR` is a positional index into
> `_scan_queue`; deleting rows above it silently shifts the scan onto the wrong folders,
> so a resumed scan can under-report duplicates. Use **🚀 Angel → Reset Scan Progress**.

## How to use

1. Open the bound Google Sheet
   ([DuplicateFinder](https://docs.google.com/spreadsheets/d/1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0/edit)).
2. In the menu bar, click **🚀 Angel → Start Deduplicator**. A dialog opens.
3. Paste a **Google Drive folder URL** (e.g. `https://drive.google.com/drive/folders/<id>`)
   and click **Analyze Folder**.
4. Watch the live status (parent folder / current folder / active file). If the scan hits
   the Apps Script 6-minute limit it **pauses and auto-resumes** until the whole tree is
   covered — no action needed.
5. When the scan finishes, the full duplicate list is written to the **Duplicates** sheet.
   Review it there — **delete any row you want left alone**, and tick **Swap ⇄** on a row to
   keep *that* copy and trash the original instead — then click **Move Duplicates to Trash**
   in the dialog and confirm.
6. **Don't want to wait for the whole tree?** Click **Pause & Compare What Is Scanned So Far**
   at any time. The walk stops at the next folder, the files seen so far are compared, and the
   duplicates among them can be trashed right away. **Resume Scan** continues where it stopped;
   comparing again later keeps the rows you already trashed marked as handled.
7. If the dialog was closed or its connection died, just reopen it — it reads the current state
   back and offers **Resume Scan** plus the trash button for any unhandled rows. The same
   compare is available without the dialog via **🚀 Angel → Compare Files Scanned So Far**.
8. To discard a paused or stale scan and start clean: **🚀 Angel → Reset Scan Progress**.

> The tool only ever trashes the **duplicate** copy (the first file seen for each
> content hash is kept as the original). Trashed files stay recoverable from Drive Trash.

## How it works (complete flow)

| Stage | Function(s) | What happens |
|-------|-------------|--------------|
| Menu | `onOpen`, `showUi` | Adds the **🚀 Angel** menu and opens `Progress.html` as a modeless dialog. |
| Scan | `processFolder`, `scanUntilDeadline` | Breadth-first walk driven by the `_scan_queue` sheet and a cursor in properties. Each folder is listed with `Drive.Files.list` (Advanced Drive Service); rows are appended to `_scan_files` in batches of 200. |
| Hash | (none — Drive supplies it) | Uses Drive's own `md5Checksum` field. **No file is ever downloaded**, so there is no size limit and no `LARGE_<size>` fallback. |
| Resume | `processFolder` (timeout branch) | On the 4.5-min soft limit the buffers are flushed, the queue cursor + page token are saved, and `{timeout:true}` is returned; the dialog re-invokes to continue. Resume is O(1) — no re-walking the tree. |
| Pause | `requestPause`, `scanUntilDeadline` | A cache flag polled ~every 2 s by the walk. It flushes and returns `'PAUSED'` at a folder boundary, so partial results can be compared and trashed mid-scan. |
| Detect | `runDeduplication` | Groups `_scan_files` by `md5 + size`; the first is the original, later matches go to the **Duplicates** sheet. Runnable at any time via `compareScannedSoFar`; carries over the Status of rows already handled. |
| Report | `getLiveStatus`, `getState`, `Progress.html` | Live status is throttled into `CacheService` (~1 write / 2 s) and polled by the dialog; `getState` lets a reopened dialog resume and re-offer the trash button. |
| Delete | `trashDuplicates` | Trashes every un-handled row of the Duplicates sheet, writing `Trashed` / `Error: …` into the Status column in batches of 50. Resumes across the 6-min limit like the scan. |
| Swap | `onEdit`, `swapKeeper`, `swapSelectedRows` | The **Swap ⇄** checkbox flips one row's Duplicate and Original sides and clears itself; the new duplicate ID is parsed out of the Original Link. Nothing in Drive moves — only which ID `trashDuplicates` will read. |
| Recover | `withRetry`, `describeError`, `isSkippableFolderError` | Transient Drive/Sheets errors are retried with backoff, unreadable folders are skipped, and every failure reaches the dialog as a message it can retry from. |

## State storage

All bulk state lives in sheets of the bound spreadsheet; `ScriptProperties` holds only
small cursors (`PHASE`, `ROOT_ID`, `QUEUE_CURSOR`, `PAGE_TOKEN`). `CacheService` carries the
two cross-execution signals — the live status (`STATUS`) and the pause request
(`PAUSE_REQUEST`).

| Sheet | Columns | Role |
|-------|---------|------|
| `_scan_files` | File ID, Name, Size, Path, Hash | append-only record of every file seen |
| `_scan_queue` | Folder ID, Path | the folder frontier + a cursor into it |
| `Duplicates` | Duplicate Name/Link/Path, Original Name/Link/Path, Size, Duplicate ID, Hash, Status, Swap ⇄ | the reviewable result |

> **Why not `ScriptProperties`?** A single property value is capped at **9 KB** — about
> 40 file records. v4 checkpointed the whole file list into one property, so every scan
> larger than ~40 files threw `Argument too large: value` at the 5.5-min mark, lost all
> its work, and surfaced as a generic alert instead of resuming. Sheets also allow
> *incremental appends*, so checkpoint cost stays flat instead of rewriting the entire
> list every few minutes.

## Known limits

- **Google-native files** (Docs/Sheets/Slides) have no `md5Checksum` and are recorded but
  **never reported as duplicates** — comparing them would mean exporting each to PDF and
  hashing that, which is slow and unsafe. The dialog reports how many were skipped.
- **Zero-byte files** are likewise excluded (every empty file matches every other one).
- **Shortcuts** are ignored; a file reachable through several parents is counted once.
- Paths are relative to the scanned root, not to My Drive.

## Repository layout

| Path | Purpose |
|------|---------|
| `src/appsscript.json` | Apps Script manifest (timezone Europe/Berlin, V8 runtime, Advanced Drive Service v3) |
| `src/Code.js` | Server-side Apps Script logic |
| `src/Progress.html` | Client-side dialog UI |
| `.clasp.json` | clasp config — `scriptId` + `rootDir: src` |
| `.claspignore` | Restricts pushes to the three source files |

## Production workflow (clasp + git)

The Apps Script project is the source of truth for *running*; this git repo is the source
of truth for *history*. Keep them in sync with clasp — run clasp commands from **inside
this `Deduplicator/` directory**.

**Accounts**
- clasp is authenticated as **createk.corporation@gmail.com** (has edit access to the script).
- Script ID: `1U_Ej4u1kFRmR3ywpdnCHmbjImRxuNzZmIu5DRHMw6SpKpHFKzrH-k2lb`

**Pull remote changes into git** (after editing in the Apps Script IDE):
```bash
clasp pull            # updates src/ from the live project
git add -A && git commit -m "Pull: <what changed>" && git push
```

**Push local changes to the live project** (after editing files here):
```bash
clasp push            # updates the live Apps Script project from src/
git add -A && git commit -m "Push: <what changed>" && git push
```

> **After the first push of v5.0**: the manifest now enables the **Advanced Drive Service
> (v3)**. Open the script (`clasp open-script`) and run `showUi` once — Apps Script will
> prompt for re-authorization because of the new service. If the editor reports that the
> Drive API is not enabled for the project, enable it under **Services → Drive API**
> (or in the associated Cloud project) before the first scan.

**Handy commands**
```bash
clasp status                 # list files clasp will push
clasp open-script            # open the Apps Script IDE
clasp show-authorized-user   # confirm which Google account clasp uses
```

> ⚠️ Never commit `.clasprc.json` — it holds OAuth tokens. It lives in your home
> directory (`~/.clasprc.json`) and is also git-ignored here as a safeguard.

## Container binding

This is a **container-bound** script, bound to the Google Sheet **"DuplicateFinder"**:

- Spreadsheet ID: `1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0`
- Sheet URL: <https://docs.google.com/spreadsheets/d/1DZuoYcTXyTV35llQlO3qmTK6m4NDH3h6-P6R7Jru9D0/edit>
- Owner: kai.bolik@createk.biz

Because it is bound, the `onOpen` **🚀 Angel** menu appears automatically in that
spreadsheet, and `SpreadsheetApp.getUi()` works. To open the code from the sheet:
**Extensions → Apps Script**. `clasp pull` / `clasp push` sync this repo with that same
bound project (scriptId `1U_Ej4u1kFRmR3ywpdnCHmbjImRxuNzZmIu5DRHMw6SpKpHFKzrH-k2lb`).
