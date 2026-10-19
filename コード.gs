// ==========================================
// 1. CONFIGURATION
// ==========================================
var PARENT_FOLDER_ID = "17hKxRiGZIzaOgmOYybt5xJxuHJVYY3H_"; // プロジェクト親フォルダ
var SPREADSHEET_ID   = "1kSUf7P5D97oQ4JOhAHTyCPAsDE3gcKLRfnKfxsho8OI";
var DRIVE_FOLDER_ID  = "1vuPqSRlshqLwVQqhoTVT44jm6DA0TvrJ"; // 写真保存用フォルダ
var SHP_FOLDER_ID    = "1H-3icPudMe_X_yFo8FuccXsjzcXjch6R"; // トラックGeoJSON保存用フォルダ
var BACKUP_FOLDER_ID = "1I1bn_UtMfHlUkMIqdXaR98MnWuupTWzv"; // バックアップ保存用フォルダ

// シート名定義
var SURVEY_SHEET_NAME = "現地調査結果";
var SURVEY_SHEET_GID  = 1613389351; // フォールバック用
var TRACK_SHEET_NAME  = "トラックファイル名";

// ==========================================
// 2. ENDPOINTS (POST / GET / OPTIONS)
// ==========================================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return createJsonResponse({
        status: "error",
        message: "No data received"
      });
    }

    var payload = JSON.parse(e.postData.contents);
    var result = processUpload(payload);

    return createJsonResponse({
      status: "success",
      insertedSurveys: result.insertedSurveys,
      updatedSurveys: result.updatedSurveys || 0,
      insertedTracks: result.insertedTracks
    });

  } catch (error) {
    return createJsonResponse({
      status: "error",
      message: error.toString()
    });
  }
}

/**
 * QGISパイプライン等からのデータ取得用エンドポイント
 * ?action=tracks : トラックGeoJSON一覧と中身を返す
 * ?action=photos : 写真フォルダ内のファイル名とDrive URL一覧を返す
 */
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : "status";

    if (action === "tracks") {
      var shpFolder = DriveApp.getFolderById(SHP_FOLDER_ID);
      var files = shpFolder.getFiles();
      var tracks = [];
      while (files.hasNext()) {
        var f = files.next();
        var name = f.getName();
        if (name.toLowerCase().indexOf(".geojson") !== -1 || name.toLowerCase().indexOf(".json") !== -1) {
          try {
            var content = f.getBlob().getDataAsString("UTF-8");
            tracks.push({
              name: name,
              id: f.getId(),
              url: "https://drive.google.com/file/d/" + f.getId() + "/view",
              updated: f.getLastUpdated().toISOString(),
              geojson: JSON.parse(content)
            });
          } catch (parseErr) {
            Logger.log("GeoJSON parse error (" + name + "): " + parseErr);
          }
        }
      }
      return createJsonResponse({ status: "success", tracks: tracks });
    }

    if (action === "photos") {
      var photoFolder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
      var pFiles = photoFolder.getFiles();
      var photos = [];
      while (pFiles.hasNext()) {
        var pf = pFiles.next();
        photos.push({
          name: pf.getName(),
          id: pf.getId(),
          url: "https://drive.google.com/file/d/" + pf.getId() + "/view"
        });
      }
      return createJsonResponse({ status: "success", photos: photos });
    }

    return createJsonResponse({
      status: "success",
      message: "FR5 GAS Backend is running",
      spreadsheetId: SPREADSHEET_ID,
      parentFolderId: PARENT_FOLDER_ID
    });
  } catch (error) {
    return createJsonResponse({
      status: "error",
      message: error.toString()
    });
  }
}

function doOptions(e) {
  return ContentService.createTextOutput();
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 3. CORE LOGIC (弱電界リトライ時の重複防止・バックアップ対応)
// ==========================================
function processUpload(payload) {
  var surveys = payload.surveys || [];
  var trackZip = payload.trackZip || "";
  var trackZipName = payload.trackZipName || "";

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var driveFolder = DriveApp.getFolderById(DRIVE_FOLDER_ID);

  // 1. 調査データの処理（IDによる重複チェック付き）
  var surveySheet = getOrCreateSurveySheet(ss);
  var existingIdMap = getExistingSurveyIdRowMap(surveySheet);
  var insertedSurveysCount = 0;
  var updatedSurveysCount = 0;

  for (var i = 0; i < surveys.length; i++) {
    var survey = surveys[i];
    if (!survey || !survey.id) continue;

    var photoUrlOrName = "";

    // 写真の処理 (Base64データがある場合)
    if (survey.photo && survey.photo.indexOf("base64,") !== -1) {
      photoUrlOrName = savePhotoToDrive(driveFolder, survey);
    } else if (survey.photoUrl) {
      photoUrlOrName = survey.photoUrl;
    }

    // スプレッドシートの列順:
    // A:ID, B:調査者, C:調査日, D:調査時間, E:地点分類, F:種名, G:情報詳細, H:聞き取り対象, I:写真(Drive URL), J:緯度, K:経度
    var rowData = [
      survey.id,
      survey.username || "",
      survey.date || "",
      survey.time || "",
      survey.category || "",
      survey.species || "",
      survey.detail || "",
      survey.interview || "",
      photoUrlOrName,
      survey.lat,
      survey.lng
    ];

    var existingRow = existingIdMap[String(survey.id)];
    if (existingRow) {
      // 既に同じIDが存在する場合は上書き更新（弱電界での再送時に重複行を作らない）
      if (!photoUrlOrName) {
        var prevPhoto = surveySheet.getRange(existingRow, 9).getValue();
        rowData[8] = prevPhoto;
      }
      surveySheet.getRange(existingRow, 1, 1, rowData.length).setValues([rowData]);
      updatedSurveysCount++;
    } else {
      surveySheet.appendRow(rowData);
      existingIdMap[String(survey.id)] = surveySheet.getLastRow();
      insertedSurveysCount++;
    }
  }

  // 2. トラックデータのGoogleドライブ保存 (GeoJSON形式で直接保存)
  var isTrackSaved = 0;
  if (trackZip && trackZipName) {
    try {
      var shpFolder = DriveApp.getFolderById(SHP_FOLDER_ID);
      var decoded = Utilities.base64Decode(trackZip);

      var mimeType = "application/zip";
      if (trackZipName.toLowerCase().indexOf(".geojson") !== -1) {
        mimeType = "application/json";
      }

      // 同一ファイル名が既に存在する場合は既存ファイルを更新または再利用
      var existingFiles = shpFolder.getFilesByName(trackZipName);
      var trackFile;
      if (existingFiles.hasNext()) {
        trackFile = existingFiles.next();
        trackFile.setContent(Utilities.newBlob(decoded).getDataAsString("UTF-8"));
      } else {
        var blob = Utilities.newBlob(decoded, mimeType, trackZipName);
        trackFile = shpFolder.createFile(blob);
      }

      try {
        trackFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {
        Logger.log("トラック共有設定スキップ: " + shareErr.toString());
      }

      var trackUrl = "https://drive.google.com/file/d/" + trackFile.getId() + "/view";
      isTrackSaved = 1;

      // スプレッドシートの「トラックファイル名」シートに ファイル名, DriveURL, 日時 を記録
      try {
        var trackNameSheet = getOrCreateTrackNameSheet(ss);
        var lastRow = trackNameSheet.getLastRow();
        trackNameSheet.appendRow([
          trackZipName,
          trackUrl,
          Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd HH:mm:ss")
        ]);
      } catch (sheetErr) {
        Logger.log("トラックファイル名シートへの書き込みに失敗: " + sheetErr.toString());
      }

    } catch (err) {
      Logger.log("トラックデータの保存に失敗: " + err.toString());
      throw new Error("トラックデータの保存失敗: " + err.toString());
    }
  }

  // 3. バックアップフォルダへの自動JSONバックアップ保存（写真Base64を除いた軽量メタデータ）
  try {
    saveBackupToDrive(surveys, trackZipName);
  } catch (backupErr) {
    Logger.log("バックアップ保存スキップ: " + backupErr.toString());
  }

  return {
    insertedSurveys: insertedSurveysCount,
    updatedSurveys: updatedSurveysCount,
    insertedTracks: isTrackSaved
  };
}

// ==========================================
// 4. GOOGLE DRIVE HELPERS
// ==========================================
function savePhotoToDrive(folder, survey) {
  try {
    var base64Parts = survey.photo.split("base64,");
    var base64Data = base64Parts[1];
    var decoded = Utilities.base64Decode(base64Data);

    // ファイル名: 調査日_調査者_地点分類_種名_調査ID.jpg
    var cleanTime = (survey.time || "").replace(/:/g, "");
    var safeUser = (survey.username || "user").replace(/[\\/:*?"<>|]/g, "_");
    var safeCat  = (survey.category || "地点").replace(/[\\/:*?"<>|]/g, "_");
    var fileName = (survey.date || "date") + "_" + safeUser + "_" + safeCat + "_" + survey.id + "_" + cleanTime + ".jpg";

    // 同一IDの写真が既にある場合は重複作成を防ぐ
    var existing = folder.getFilesByName(fileName);
    var file;
    if (existing.hasNext()) {
      file = existing.next();
    } else {
      var blob = Utilities.newBlob(decoded, "image/jpeg", fileName);
      file = folder.createFile(blob);
    }

    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (shareErr) {
      Logger.log("写真共有設定スキップ: " + shareErr.toString());
    }

    // スプレッドシート上でのプレビューとQGIS自動取得の両方で使えるDrive閲覧URLを返す
    return "https://drive.google.com/file/d/" + file.getId() + "/view";
  } catch (err) {
    Logger.log("写真保存失敗: " + err.toString());
    return "Error_FailedToSavePhoto";
  }
}

function saveBackupToDrive(surveys, trackZipName) {
  if ((!surveys || surveys.length === 0) && !trackZipName) return;
  var backupFolder = DriveApp.getFolderById(BACKUP_FOLDER_ID);
  var lightSurveys = [];
  for (var i = 0; i < surveys.length; i++) {
    var s = surveys[i];
    lightSurveys.push({
      id: s.id,
      username: s.username,
      date: s.date,
      time: s.time,
      category: s.category,
      species: s.species,
      detail: s.detail,
      interview: s.interview,
      hasPhoto: Boolean(s.photo),
      lat: s.lat,
      lng: s.lng
    });
  }
  var stamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmmss");
  var userLabel = (lightSurveys[0] && lightSurveys[0].username) ? lightSurveys[0].username : "track";
  var backupName = "backup_" + stamp + "_" + userLabel + ".json";
  var content = JSON.stringify({
    timestamp: new Date().toISOString(),
    surveys: lightSurveys,
    trackFileName: trackZipName || ""
  }, null, 2);
  backupFolder.createFile(backupName, content, MimeType.PLAIN_TEXT);
}

// ==========================================
// 5. SHEET HELPERS
// ==========================================
function getExistingSurveyIdRowMap(sheet) {
  var map = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;
  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var id = values[i][0];
    if (id !== null && id !== "") {
      map[String(id)] = i + 2;
    }
  }
  return map;
}

function getOrCreateSurveySheet(ss) {
  var sheet = ss.getSheetByName(SURVEY_SHEET_NAME);
  if (sheet) return sheet;

  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SURVEY_SHEET_GID) {
      sheets[i].setName(SURVEY_SHEET_NAME);
      return sheets[i];
    }
  }

  sheet = ss.insertSheet(SURVEY_SHEET_NAME);
  var headers = ["ID", "調査者", "調査日", "調査時間", "地点分類", "種名", "情報詳細", "聞き取り対象", "写真", "緯度", "経度"];
  sheet.appendRow(headers);
  sheet.getRange("A1:K1").setFontWeight("bold").setBackground("#e2e8f0");
  return sheet;
}

function getOrCreateTrackNameSheet(ss) {
  var sheet = ss.getSheetByName(TRACK_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(TRACK_SHEET_NAME);
  var headers = ["トラックファイル名", "Driveリンク", "保存日時"];
  sheet.appendRow(headers);
  sheet.getRange("A1:C1").setFontWeight("bold").setBackground("#e2e8f0");
  return sheet;
}

