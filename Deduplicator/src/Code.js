/**
 * Tech Angel Deduplicator v4.1 (Resumable + Parent + Full Path)
 *
 * HOW TO USE:
 *   1. In the bound Google Sheet, open the "🚀 Angel" menu → "Start Deduplicator".
 *   2. Paste a Google Drive folder URL into the dialog and click "Analyze Folder".
 *   3. Wait for the recursive scan (it auto-resumes if it hits the 6-min limit).
 *   4. Review the duplicates listed, then click "Move Duplicates to Trash".
 *   To clear a paused/partial scan: "🚀 Angel" menu → "Reset Scan Progress".
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🚀 Angel')
      .addItem('Start Deduplicator', 'showUi')
      .addItem('Reset Scan Progress', 'resetToken')
      .addToUi();
}

function resetToken() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  SpreadsheetApp.getUi().alert("Scan progress and cache cleared.");
}

function showUi() {
  const html = HtmlService.createHtmlOutputFromFile('Progress')
      .setWidth(600).setHeight(500);
  SpreadsheetApp.getUi().showModelessDialog(html, 'Deduplication Engine');
}

function getLiveStatus() {
  return PropertiesService.getScriptProperties().getProperties();
}

function processFolder(inputUrl) {
  const props = PropertiesService.getScriptProperties();
  let folderId;
  try {
    if (inputUrl.includes('folders/')) {
      folderId = inputUrl.split('/folders/')[1].split(/[/?]/)[0];
    } else {
      throw new Error("Please provide a valid Google Drive URL (e.g., https://drive.google.com/...)");
    }
  } catch (e) {
    return { error: e.message };
  }

  const startTime = Date.now();
  const MAX_RUNTIME = 5.5 * 60 * 1000;
  props.deleteProperty('SCAN_TIMED_OUT');

  let allFiles = JSON.parse(props.getProperty('TEMP_FILE_LIST') || "[]");
  let fileIdSet = new Set(allFiles.map(f => f.id));
  let scannedFolders = new Set(JSON.parse(props.getProperty('SCANNED_FOLDERS') || "[]"));

  try {
    const rootFolder = DriveApp.getFolderById(folderId);
    scanRecursive(rootFolder, null, allFiles, fileIdSet, scannedFolders, startTime, MAX_RUNTIME);

    const isTimedOut = props.getProperty('SCAN_TIMED_OUT') === 'true';

    if (isTimedOut) {
      props.setProperty('TEMP_FILE_LIST', JSON.stringify(allFiles));
      props.setProperty('SCANNED_FOLDERS', JSON.stringify(Array.from(scannedFolders)));
      return { timeout: true, count: allFiles.length };
    }

    props.deleteProperty('TEMP_FILE_LIST');
    props.deleteProperty('SCANNED_FOLDERS');
    return runDeduplication(allFiles);

  } catch (e) {
    return { error: e.message };
  }
}

function getFullPath(folder) {
  let path = [];
  let current = folder;
  while (current) {
    path.unshift(current.getName());
    const parents = current.getParents();
    current = parents.hasNext() ? parents.next() : null;
  }
  return path.join(' → ');
}

function scanRecursive(folder, parentFolder, allFiles, fileIdSet, scannedFolders, startTime, MAX_RUNTIME) {
  const props = PropertiesService.getScriptProperties();
  const folderId = folder.getId();

  if (scannedFolders.has(folderId)) {
    props.setProperty('currentFolder', folder.getName() + ' (skipped)');
    return;
  }

  if (Date.now() - startTime > MAX_RUNTIME) {
    props.setProperty('SCAN_TIMED_OUT', 'true');
    return;
  }

  const parentName = parentFolder ? parentFolder.getName() : "Root";
  props.setProperty('currentParent', parentName);
  props.setProperty('currentFolder', folder.getName());

  const files = folder.getFiles();
  while (files.hasNext()) {
    if (Date.now() - startTime > MAX_RUNTIME) {
      props.setProperty('SCAN_TIMED_OUT', 'true');
      return;
    }
    const f = files.next();
    const fId = f.getId();
    props.setProperty('currentFile', f.getName());
    if (fileIdSet.has(fId)) continue;

    let hash = (f.getSize() < 20 * 1024 * 1024)
      ? Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, f.getBlob().getBytes())
          .map(chr => (chr < 0 ? chr + 256 : chr).toString(16).padStart(2, '0')).join('')
      : "LARGE_" + f.getSize();

    allFiles.push({
      id: fId,
      name: f.getName(),
      size: f.getSize(),
      fullPath: getFullPath(folder),
      hash: hash
    });
    fileIdSet.add(fId);
  }

  const subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    if (Date.now() - startTime > MAX_RUNTIME) {
      props.setProperty('SCAN_TIMED_OUT', 'true');
      return;
    }
    const sub = subFolders.next();
    scanRecursive(sub, folder, allFiles, fileIdSet, scannedFolders, startTime, MAX_RUNTIME);
    if (props.getProperty('SCAN_TIMED_OUT') === 'true') return;
    scannedFolders.add(sub.getId());
  }

  scannedFolders.add(folderId);
}

function runDeduplication(filesData) {
  let seen = {};
  let duplicates = [];
  filesData.forEach(file => {
    let key = file.hash + "_" + file.size;
    if (seen[key]) {
      duplicates.push({ duplicate: file, original: seen[key] });
    } else {
      seen[key] = file;
    }
  });
  return { dupes: duplicates };
}

function deleteSelectedFiles(ids) {
  ids.forEach(id => DriveApp.getFileById(id).setTrashed(true));
  return "Success";
}