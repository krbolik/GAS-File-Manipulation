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

**v5.0.1** — first live run. The scan itself worked (498 files, real md5 hashes, correct
paths), but clearing a checkpoint sheet threw *"Sorry, it is not possible to delete all
non-frozen rows."* Appending had grown each sheet's grid to exactly fit its data, so
`maxRows == getLastRow()` and `deleteRows(2, lastRow - 1)` was asking Sheets to delete
every non-frozen row. Fixed by clearing with `clearContent` instead of `deleteRows`
(`clearData`), and by growing the grid explicitly in `appendRows` with 100 rows of
headroom.

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
   Review it there — **delete any row you want to keep** — then click **Move Duplicates
   to Trash** in the dialog and confirm.
6. To discard a paused or stale scan and start clean: **🚀 Angel → Reset Scan Progress**.

> The tool only ever trashes the **duplicate** copy (the first file seen for each
> content hash is kept as the original). Trashed files stay recoverable from Drive Trash.

## How it works (complete flow)

| Stage | Function(s) | What happens |
|-------|-------------|--------------|
| Menu | `onOpen`, `showUi` | Adds the **🚀 Angel** menu and opens `Progress.html` as a modeless dialog. |
| Scan | `processFolder`, `scanUntilDeadline` | Breadth-first walk driven by the `_scan_queue` sheet and a cursor in properties. Each folder is listed with `Drive.Files.list` (Advanced Drive Service); rows are appended to `_scan_files` in batches of 200. |
| Hash | (none — Drive supplies it) | Uses Drive's own `md5Checksum` field. **No file is ever downloaded**, so there is no size limit and no `LARGE_<size>` fallback. |
| Resume | `processFolder` (timeout branch) | On the 5-min soft limit the buffers are flushed, the queue cursor + page token are saved, and `{timeout:true}` is returned; the dialog re-invokes to continue. Resume is O(1) — no re-walking the tree. |
| Detect | `runDeduplication` | Groups `_scan_files` by `md5 + size`; the first is the original, later matches go to the **Duplicates** sheet. |
| Report | `getLiveStatus`, `Progress.html` | Live status is throttled into `CacheService` (~1 write / 2 s) and polled by the dialog, which shows a summary and links to the sheet. |
| Delete | `trashDuplicates` | Trashes every un-handled row of the Duplicates sheet, writing `Trashed` / `Error: …` into the Status column. Resumes across the 6-min limit like the scan. |

## State storage

All bulk state lives in sheets of the bound spreadsheet; `ScriptProperties` holds only
small cursors (`PHASE`, `ROOT_ID`, `QUEUE_CURSOR`, `PAGE_TOKEN`).

| Sheet | Columns | Role |
|-------|---------|------|
| `_scan_files` | File ID, Name, Size, Path, Hash | append-only record of every file seen |
| `_scan_queue` | Folder ID, Path | the folder frontier + a cursor into it |
| `Duplicates` | Duplicate Name/Path/ID, Original Name/Path, Size, Hash, Status | the reviewable result |

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
