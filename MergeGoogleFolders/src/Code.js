/**
 * Spreadsheet-Bound Drive Folder Merge (V8 Runtime)
 * ================================================================
 * Recursively merges a SOURCE Drive folder tree into a DESTINATION
 * folder tree, matching by file/folder NAME. On name collisions the
 * newest file wins (older copy is trashed). Runs from a custom menu
 * on the bound Google Sheet, with a safe DRY RUN mode by default.
 *
 * CONTAINER SHEET SETUP
 * ---------------------
 * This script is bound to a Google Sheet. Run "Initialize Sheet" once
 * to auto-create the three tabs it needs, then fill in the Settings tab:
 *   • Settings tab (created for you):
 *       B1  SOURCE_FOLDER_URL_OR_ID  -> paste source folder URL or ID
 *       B2  DEST_FOLDER_URL_OR_ID    -> paste destination folder URL or ID
 *       B3  DRY_RUN                  -> TRUE (preview only) / FALSE (make changes)
 *       B4  DRY_RUN_SECONDS          -> time budget per dry-run pass (1-270)
 *   • Queue tab   -> internal work list of folder pairs still to process (do not edit)
 *   • Logs  tab   -> every action taken/previewed, timestamped
 *
 * MAIN FUNCTIONS (called from the "Drive Merge" menu — reload the sheet if absent)
 * -------------------------------------------------------------------------------
 *   1. initializeSheet()  Run ONCE. Creates the Settings / Queue / Logs tabs.
 *   2. startFreshMerge()  Clears the queue, seeds the source->dest roots, and starts
 *                         processing. Use this to begin a brand-new merge.
 *   3. continueMerge()    Resumes an interrupted merge from whatever is left in the
 *                         Queue tab (used after a dry-run timeout, or to pick up a
 *                         run that was paused).
 *
 * (onOpen builds the menu automatically; processMergeQueue is the internal worker
 *  invoked by the two entry points above and by the auto-resume trigger — never
 *  call it directly.)
 *
 * DRY RUN vs LIVE
 * ---------------
 *   • DRY_RUN = TRUE  : nothing is moved/trashed; actions are logged as "[DRY RUN] …".
 *                       On timeout it stops; click "Continue Merge" to run the next pass.
 *   • DRY_RUN = FALSE : files/folders are actually moved and older duplicates removed.
 *                       Long runs auto-resume every ~1 min via a time-based trigger
 *                       until the queue is empty.
 *
 * OWNERSHIP & DUPLICATE REMOVAL
 * ----------------------------
 * In Google Drive, only a file's OWNER can move it to Trash. This script runs as the
 * script owner, who may not own every file in a shared folder. So an older duplicate is:
 *   • TRASHED    if the script owner owns it (recoverable from Drive Trash), or
 *   • QUARANTINED (moved to a "MERGE_DUPLICATES_TO_REVIEW" folder in the script owner's
 *                  My Drive) if someone else owns it — because a non-owner cannot trash
 *                  it. Its real owner can then delete it. Every action is logged with the
 *                  outcome (TRASHED / QUARANTINED / MOVED / FAILED) AFTER it runs, so the
 *                  Logs tab reflects what actually happened, not just what was intended.
 */

const CONFIG = {
  SETTINGS_SHEET: 'Settings',
  QUEUE_SHEET: 'Queue',
  LOGS_SHEET: 'Logs',
  LIVE_RUN_TIME_MS: 4.5 * 60 * 1000   // 270,000 ms (4.5 mins)
};

/**
 * Creates a custom menu in the Google Sheet.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Drive Merge')
    .addItem('1. Initialize Sheet (Run Once)', 'initializeSheet')
    .addSeparator()
    .addItem('2. Start Fresh Merge (Clears Queue)', 'startFreshMerge')
    .addItem('3. Continue Merge', 'continueMerge')
    .addToUi();
}

/**
 * Extracts a Google Drive Folder ID from a raw ID or full URL.
 */
function extractFolderId(inputString) {
  if (!inputString) return null;
  const match = inputString.match(/([a-zA-Z0-9_-]{25,})/);
  if (!match || !match[1]) {
    throw new Error(`Could not extract a valid Drive ID from: ${inputString}`);
  }
  return match[1];
}

/**
 * Dual-channel logger.
 */
function pushLog(logBuffer, isDryRun, actionType, filename, details) {
  const ts = new Date();
  const actionPrefix = isDryRun && actionType !== 'ERROR' && actionType !== 'SYSTEM' && actionType !== 'INIT' 
                       ? `[DRY RUN] ${actionType}` 
                       : actionType;
  
  console.log(`${actionPrefix} | ${filename} | ${details}`);
  logBuffer.push([ts, actionPrefix, filename, details]);
}

/**
 * Run this ONCE to prepare the spreadsheet UI.
 */
function initializeSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  let settings = ss.getSheetByName(CONFIG.SETTINGS_SHEET) || ss.insertSheet(CONFIG.SETTINGS_SHEET);
  settings.clear();
  settings.getRange('A1:B4').setValues([
    ['SOURCE_FOLDER_URL_OR_ID', 'PASTE_SOURCE_HERE'],
    ['DEST_FOLDER_URL_OR_ID', 'PASTE_DEST_HERE'],
    ['DRY_RUN', true],
    ['DRY_RUN_SECONDS', 30]
  ]);
  settings.getRange('A1:A4').setFontWeight('bold');
  settings.setColumnWidth(1, 220);
  settings.setColumnWidth(2, 350);

  let queue = ss.getSheetByName(CONFIG.QUEUE_SHEET) || ss.insertSheet(CONFIG.QUEUE_SHEET);
  if (queue.getLastRow() === 0) queue.appendRow(['Source ID', 'Destination ID']);
  
  let logs = ss.getSheetByName(CONFIG.LOGS_SHEET) || ss.insertSheet(CONFIG.LOGS_SHEET);
  if (logs.getLastRow() === 0) logs.appendRow(['Timestamp', 'Action', 'Filename', 'Details']);
  
  SpreadsheetApp.getUi().alert('Initialization Complete. Use the "Drive Merge" menu at the top to proceed.');
}

/**
 * Entry point 1: Clears state, seeds roots, starts fresh.
 */
function startFreshMerge() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settings = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  
  const rawSource = settings.getRange('B1').getValue();
  const rawDest = settings.getRange('B2').getValue();
  
  let sourceId, destId;
  
  try {
    sourceId = extractFolderId(rawSource.toString());
    destId = extractFolderId(rawDest.toString());
  } catch (error) {
    ui.alert(`Input Error: ${error.message}`);
    return;
  }
  
  if (!sourceId || !destId || rawSource.includes('PASTE_')) {
    ui.alert("Error: Please provide valid Folder IDs or URLs in the Settings tab.");
    return;
  }
  
  const queueSheet = ss.getSheetByName(CONFIG.QUEUE_SHEET);
  const logsSheet = ss.getSheetByName(CONFIG.LOGS_SHEET);
  
  // Clear existing queue and logs (optional logs clear, leaving it for audit trails)
  if (queueSheet.getLastRow() > 1) {
    queueSheet.getRange(2, 1, queueSheet.getLastRow() - 1, 2).clearContent();
  }
  
  queueSheet.appendRow([sourceId, destId]);
  
  const initBuffer = [];
  pushLog(initBuffer, false, 'INIT', 'Merge Started (Fresh)', `Source: ${sourceId} -> Dest: ${destId}`);
  logsSheet.getRange(logsSheet.getLastRow() + 1, 1, 1, 4).setValues(initBuffer);
  
  cleanupTriggers();
  processMergeQueue();
}

/**
 * Entry point 2: Resumes from existing queue state.
 */
function continueMerge() {
  const queueSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.QUEUE_SHEET);
  if (queueSheet.getLastRow() <= 1) {
    SpreadsheetApp.getUi().alert("Queue is empty. There is nothing to continue.");
    return;
  }
  processMergeQueue();
}

/**
 * Main processor. Traverses queue and logs actions.
 */
function processMergeQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; 
  
  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const settings = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  const queueSheet = ss.getSheetByName(CONFIG.QUEUE_SHEET);
  
  const isDryRun = settings.getRange('B3').getValue() === true;
  
  let timeLimit = CONFIG.LIVE_RUN_TIME_MS;
  if (isDryRun) {
    const rawSeconds = parseInt(settings.getRange('B4').getValue(), 10);
    const safeSeconds = isNaN(rawSeconds) ? 30 : rawSeconds;
    const clampedSeconds = Math.min(Math.max(safeSeconds, 1), 270);
    timeLimit = clampedSeconds * 1000;
  }
  
  const lastRow = queueSheet.getLastRow();
  if (lastRow <= 1) {
    lock.releaseLock();
    return; 
  }
  
  let queueData = queueSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  let remainingQueue = [];
  let logBuffer = [];
  let executionPreempted = false;
  
  while (queueData.length > 0) {
    if (Date.now() - startTime > timeLimit) {
      executionPreempted = true;
      remainingQueue = queueData.concat(remainingQueue); 
      break;
    }
    
    const [srcId, destId] = queueData.shift();
    try {
      const newSubfolders = processFolderPair(srcId, destId, logBuffer, isDryRun);
      remainingQueue = remainingQueue.concat(newSubfolders);
    } catch (e) {
      pushLog(logBuffer, isDryRun, 'ERROR', 'Exception', `Pair: ${srcId}->${destId}. Msg: ${e.message}`);
    }
  }
  
  if (logBuffer.length > 0) {
    const logsSheet = ss.getSheetByName(CONFIG.LOGS_SHEET);
    logsSheet.getRange(logsSheet.getLastRow() + 1, 1, logBuffer.length, 4).setValues(logBuffer);
  }
  
  queueSheet.getRange(2, 1, queueSheet.getMaxRows(), 2).clearContent();
  if (remainingQueue.length > 0) {
    queueSheet.getRange(2, 1, remainingQueue.length, 2).setValues(remainingQueue);
    
    if (executionPreempted) {
      pushLog([], isDryRun, 'SYSTEM', 'Preempted', isDryRun ? `Dry Run timeout (${timeLimit/1000}s). Use 'Continue Merge' to resume.` : 'Chaining trigger...');
      if (!isDryRun) chainExecution();
    }
  } else {
    const logsSheet = ss.getSheetByName(CONFIG.LOGS_SHEET);
    pushLog([], isDryRun, 'SYSTEM', 'Merge Complete', 'Queue is empty.');
    logsSheet.appendRow([new Date(), 'SYSTEM', 'Merge Complete', 'Queue is empty.']);
    cleanupTriggers();
  }
  
  lock.releaseLock();
}

const QUARANTINE_FOLDER_NAME = 'MERGE_DUPLICATES_TO_REVIEW';
const QUARANTINE_PROP_KEY = 'QUARANTINE_FOLDER_ID';

// Per-execution cache of the quarantine folder (globals reset between executions;
// the folder ID is persisted in Script Properties so chained triggers reuse it).
let _quarantineFolder = null;

/**
 * Lazily gets/creates the "duplicates to review" folder in the script owner's My Drive.
 * Only ever called during a live run (never in dry run).
 */
function ensureQuarantineFolder() {
  if (_quarantineFolder) return _quarantineFolder;

  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(QUARANTINE_PROP_KEY);
  if (savedId) {
    try {
      _quarantineFolder = DriveApp.getFolderById(savedId);
      return _quarantineFolder;
    } catch (e) {
      // Saved folder was deleted/inaccessible — fall through and recreate.
    }
  }

  _quarantineFolder = DriveApp.getRootFolder().createFolder(QUARANTINE_FOLDER_NAME);
  props.setProperty(QUARANTINE_PROP_KEY, _quarantineFolder.getId());
  return _quarantineFolder;
}

/**
 * Best-effort owner email for a file (null if it can't be determined).
 */
function ownerEmailOf(file) {
  try {
    const owner = file.getOwner();
    return owner ? owner.getEmail() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Removes an older duplicate file: trashes it if the script owner owns it (only the
 * owner can trash), otherwise moves it to the quarantine folder. Logs the real outcome.
 */
function removeDuplicate(file, effectiveEmail, isDryRun, logBuffer, name, reason) {
  const owner = ownerEmailOf(file);
  const ownedByUs = !!effectiveEmail && !!owner && owner === effectiveEmail;

  if (isDryRun) {
    pushLog(logBuffer, true, ownedByUs ? 'TRASH' : 'QUARANTINE', name,
      ownedByUs
        ? `${reason} Would trash (owned by script owner).`
        : `${reason} Would quarantine (owner: ${owner || 'unknown'}) — non-owner cannot trash.`);
    return;
  }

  try {
    if (ownedByUs) {
      file.setTrashed(true);
      pushLog(logBuffer, false, 'TRASHED', name, `${reason} Trashed (owned by script owner).`);
    } else {
      const q = ensureQuarantineFolder();
      file.moveTo(q);
      pushLog(logBuffer, false, 'QUARANTINED', name,
        `${reason} Not owned (owner: ${owner || 'unknown'}) — moved to "${QUARANTINE_FOLDER_NAME}".`);
    }
  } catch (e) {
    pushLog(logBuffer, false, 'FAILED', name, `${reason} Could not remove: ${e.message}`);
  }
}

/**
 * Moves a file/folder into destFolder. Logs the real outcome; returns true on success.
 */
function moveInto(item, destFolder, isDryRun, logBuffer, name, actionLabel, note) {
  if (isDryRun) {
    pushLog(logBuffer, true, actionLabel, name, note);
    return true;
  }
  try {
    item.moveTo(destFolder);
    pushLog(logBuffer, false, actionLabel, name, `${note} (done)`);
    return true;
  } catch (e) {
    pushLog(logBuffer, false, 'FAILED', name, `${note} Move failed: ${e.message}`);
    return false;
  }
}

/**
 * Snapshots a Drive iterator into an array. Necessary because moving/trashing items out
 * of a folder WHILE iterating that folder's live iterator can skip entries.
 */
function collect(iterator) {
  const items = [];
  while (iterator.hasNext()) items.push(iterator.next());
  return items;
}

/**
 * Compares files and queues subfolders. Each file/folder operation is isolated so one
 * failure logs a FAILED line and processing continues instead of aborting the folder.
 */
function processFolderPair(srcId, destId, logBuffer, isDryRun) {
  const effectiveEmail = Session.getEffectiveUser().getEmail();
  const srcFolder = DriveApp.getFolderById(srcId);
  const destFolder = DriveApp.getFolderById(destId);
  const queuedSubfolders = [];

  // Map dest files by name, keeping the newest when the dest already has duplicates.
  const destFileMap = {};
  collect(destFolder.getFiles()).forEach(df => {
    const name = df.getName();
    const lastUpdated = df.getLastUpdated().getTime();
    if (!destFileMap[name] || lastUpdated > destFileMap[name].lastUpdated) {
      destFileMap[name] = { file: df, lastUpdated: lastUpdated };
    }
  });

  // Snapshot source files BEFORE we start moving them out of srcFolder.
  collect(srcFolder.getFiles()).forEach(sf => {
    const name = sf.getName();
    const srcUpdated = sf.getLastUpdated().getTime();
    const match = destFileMap[name];

    if (match) {
      if (srcUpdated > match.lastUpdated) {
        const moved = moveInto(sf, destFolder, isDryRun, logBuffer, name, 'REPLACE', 'Source is newer — moving into Dest.');
        if (moved) {
          removeDuplicate(match.file, effectiveEmail, isDryRun, logBuffer, name, 'Older Dest copy.');
        }
      } else {
        removeDuplicate(sf, effectiveEmail, isDryRun, logBuffer, name, 'Dest is newer/equal — Source is the duplicate.');
      }
    } else {
      moveInto(sf, destFolder, isDryRun, logBuffer, name, 'MOVE FILE', 'New to Dest — moving Source file into Dest.');
    }
  });

  // Map dest subfolders by name.
  const destFolderMap = {};
  collect(destFolder.getFolders()).forEach(dfold => {
    destFolderMap[dfold.getName()] = dfold.getId();
  });

  // Snapshot source subfolders BEFORE we start moving them out of srcFolder.
  collect(srcFolder.getFolders()).forEach(sfold => {
    const name = sfold.getName();
    if (destFolderMap[name]) {
      // Both sides have this folder — recurse into the pair.
      queuedSubfolders.push([sfold.getId(), destFolderMap[name]]);
    } else {
      moveInto(sfold, destFolder, isDryRun, logBuffer, name, 'MOVE FOLDER', 'New to Dest — moving entire folder into Dest.');
    }
  });

  return queuedSubfolders;
}

function chainExecution() {
  cleanupTriggers();
  ScriptApp.newTrigger('processMergeQueue').timeBased().after(60 * 1000).create();
}

function cleanupTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'processMergeQueue') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}