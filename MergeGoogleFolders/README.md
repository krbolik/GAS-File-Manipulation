# MergeGoogleFolders

Version-controlled source for a **container-bound Google Apps Script** that recursively
**merges one Google Drive folder tree into another**. Files and folders are matched by
**name**; on a name collision the **newest file wins** and the older copy is trashed. The
tool runs from a custom menu on the bound Google Sheet and defaults to a safe **dry run**
so you can preview every action before anything is moved or trashed.

> ⚠️ Deduplication here is by **filename + last-updated time only** (not by content hash).
> Same-named files are treated as the same file, and the older one is removed. In a live
> run the source folder is emptied as its contents are moved into the destination.
>
> **Ownership matters:** in Google Drive only a file's **owner** can move it to Trash. The
> script runs as the script owner, who may not own every file in a shared folder. So an
> older duplicate is either **trashed** (if the script owner owns it — recoverable from
> Drive Trash) or **quarantined** — moved to a `MERGE_DUPLICATES_TO_REVIEW` folder in the
> script owner's My Drive — if someone else owns it, so its real owner can delete it. The
> **Logs** tab records the actual outcome (`TRASHED` / `QUARANTINED` / `MOVED` / `FAILED`)
> after each action runs, not just the intended one.

## Container Google Sheet setup

The script is bound to a Google Sheet. Before the first run:

1. Open the bound Sheet, then run **Drive Merge → 1. Initialize Sheet (Run Once)**. This
   auto-creates the three tabs the script needs.
2. On the **Settings** tab, fill in:

   | Cell | Key | What to enter |
   |------|-----|----------------|
   | `B1` | `SOURCE_FOLDER_URL_OR_ID` | Source folder URL or ID (contents get merged out of here) |
   | `B2` | `DEST_FOLDER_URL_OR_ID`   | Destination folder URL or ID (everything ends up here) |
   | `B3` | `DRY_RUN`                 | `TRUE` = preview only · `FALSE` = actually move/trash |
   | `B4` | `DRY_RUN_SECONDS`         | Time budget per dry-run pass, 1–270 (default 30) |

3. Leave the **Queue** tab alone — it's the internal work list of folder pairs still to
   process. The **Logs** tab records every action (timestamped), prefixed `[DRY RUN]`
   while previewing.

> If the **Drive Merge** menu isn't visible, reload the Sheet (the menu is built by
> `onOpen`).

## How to use

1. **Preview first (recommended):** set `B3` (`DRY_RUN`) to `TRUE`, then
   **Drive Merge → 2. Start Fresh Merge**. Review the **Logs** tab. If a dry run hits its
   time budget it stops — click **3. Continue Merge** to run the next pass until the Logs
   show `Merge Complete`.
2. **Go live:** set `B3` to `FALSE`, then **2. Start Fresh Merge** again. Long runs
   auto-resume about once a minute (via a time-based trigger) until the queue is empty.
3. **Resume anytime:** **3. Continue Merge** picks up from whatever is left in the Queue
   tab.

## Main functions

These are the only functions you call — all from the **Drive Merge** menu:

| Menu item | Function | What it does |
|-----------|----------|--------------|
| 1. Initialize Sheet (Run Once) | `initializeSheet` | Creates the **Settings**, **Queue**, and **Logs** tabs and their headers. Run once. |
| 2. Start Fresh Merge (Clears Queue) | `startFreshMerge` | Validates the Settings folder IDs, clears the queue, seeds the source→dest roots, and starts processing. Begins a brand-new merge. |
| 3. Continue Merge | `continueMerge` | Resumes from whatever folder pairs remain in the Queue tab (after a dry-run timeout or a paused live run). |

Not called directly: `onOpen` builds the menu automatically; `processMergeQueue` is the
internal worker driven by the two entry points above and by the auto-resume trigger.

## How it works

| Stage | Function(s) | What happens |
|-------|-------------|--------------|
| Menu | `onOpen` | Adds the **Drive Merge** menu when the Sheet opens. |
| Setup | `initializeSheet` | Builds the Settings / Queue / Logs tabs. |
| Start | `startFreshMerge`, `extractFolderId` | Parses folder URLs/IDs, resets the queue, seeds the root pair. |
| Process | `processMergeQueue` | Works folder pairs off the Queue under a `LockService` lock within a time budget (4.5 min live; `DRY_RUN_SECONDS` in dry run). |
| Merge | `processFolderPair` | Per name match: **REPLACE** (source newer → move in, remove old dest), **remove duplicate** (dest newer/equal → remove source), **MOVE FILE** / **MOVE FOLDER** (new to dest), and queues sub-folder pairs for recursion. Each op is isolated (`FAILED` logged on error) and older duplicates are trashed or quarantined by ownership (see `removeDuplicate`). |
| Resume | `chainExecution`, `cleanupTriggers` | On a live-run timeout, saves the remaining queue and schedules a follow-up trigger ~1 min later; cleans up triggers when done. |
| Log | `pushLog` | Writes each action to the console and the Logs tab, prefixed `[DRY RUN]` in preview mode. |

## Repository layout

| Path | Purpose |
|------|---------|
| `src/appsscript.json` | Apps Script manifest (timezone Europe/Berlin, V8 runtime) |
| `src/Code.js` | All script logic (menu, merge engine, queue/timeout handling, logging) |
| `.clasp.json` | clasp config binding this folder to the Apps Script project |
| `.claspignore` | Restricts `clasp push` to `appsscript.json` + `Code.js` |

## Working with clasp

From **inside this `MergeGoogleFolders/` directory**:

```bash
clasp pull   # download the latest from Apps Script
clasp push   # upload local changes
```

Each script in this workspace has its own `.clasp.json`, so run clasp commands from the
relevant subdirectory (`Deduplicator/` or `MergeGoogleFolders/`).
