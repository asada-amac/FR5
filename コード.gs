// ==========================================
// 1. CONFIGURATION
// ==========================================
var SPREADSHEET_ID = "1kSUf7P5D97oQ4JOhAHTyCPAsDE3gcKLRfnKfxsho8OI";
var DRIVE_FOLDER_ID = "1vuPqSRlshqLwVQqhoTVT44jm6DA0TvrJ";

// シート名定義
var SURVEY_SHEET_NAME = "現地調査結果";
var SURVEY_SHEET_GID = 1613389351; // フォールバック用
var TRACK_SHEET_NAME = "トラックデータ";

// ==========================================
// 2. MAIN POST ENDPOINT (CORS対応)
// ==========================================
function doPost(e) {
  // CORSプリフライトや通常レスポンスのヘッダーはGoogle Apps Script側で自動処理されますが、
  // エラー回避のためレスポンスを適切なMIMEタイプ（JSON）で返却します。
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
      insertedTracks: result.insertedTracks
    });

  } catch (error) {
    return createJsonResponse({
      status: "error",
      message: error.toString()
    });
  }
}

// OPTIONSメソッド（プリフライト）用ダミー（GAS Webアプリでは直接呼び出されないことが多いが、念のため記述）
function doOptions(e) {
  var output = ContentService.createTextOutput();
  return output;
}

// JSONレスポンスの作成
function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 3. CORE LOGIC
// ==========================================
function processUpload(payload) {
  var surveys = payload.surveys || [];
  var tracks = payload.tracks || [];

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var driveFolder = DriveApp.getFolderById(DRIVE_FOLDER_ID);

  // 1. 調査データの処理
  var surveySheet = getOrCreateSurveySheet(ss);
  var insertedSurveysCount = 0;

  for (var i = 0; i < surveys.length; i++) {
    var survey = surveys[i];
    var photoFileName = "";

    // 写真の処理 (Base64データがある場合)
    if (survey.photo && survey.photo.indexOf("base64,") !== -1) {
      photoFileName = savePhotoToDrive(driveFolder, survey);
    }

    // スプレッドシートへの追加行の作成
    // 項目順: ID, 調査者, 調査日, 調査時間, 地点分類, 種名, 情報詳細, 聞き取り対象, 写真, 緯度, 経度
    var rowData = [
      survey.id,
      survey.username,
      survey.date,
      survey.time,
      survey.category,
      survey.species,
      survey.detail,
      survey.interview,
      photoFileName, // ドライブに保存されたファイル名
      survey.lat,
      survey.lng
    ];

    surveySheet.appendRow(rowData);
    insertedSurveysCount++;
  }

  // 2. トラックデータの処理
  var trackSheet = getOrCreateTrackSheet(ss);
  var insertedTracksCount = 0;

  if (tracks.length > 0) {
    // 大量データの高速書き込みのため、二次元配列に展開して一挙に書き込む
    var trackRows = [];
    for (var j = 0; j < tracks.length; j++) {
      var track = tracks[j];
      
      // タイムスタンプを人が読みやすい日時形式に変換
      var formattedDate = "";
      if (track.timestamp) {
        var d = new Date(track.timestamp);
        formattedDate = Utilities.formatDate(d, "JST", "yyyy-MM-dd HH:mm:ss");
      }

      // 項目順: 調査ID, タイムスタンプ, 緯度, 経度
      trackRows.push([
        track.sessionId || "",
        formattedDate || track.timestamp,
        track.lat,
        track.lng
      ]);
    }

    if (trackRows.length > 0) {
      // 最終行の次の行から書き込む
      var lastRow = trackSheet.getLastRow();
      var startRow = lastRow + 1;
      var range = trackSheet.getRange(startRow, 1, trackRows.length, 4);
      range.setValues(trackRows);
      insertedTracksCount = trackRows.length;
    }
  }

  return {
    insertedSurveys: insertedSurveysCount,
    insertedTracks: insertedTracksCount
  };
}

// ==========================================
// 4. GOOGLE DRIVE HELPER
// ==========================================
function savePhotoToDrive(folder, survey) {
  try {
    // Base64からプレフィックス（"data:image/jpeg;base64," 等）を除去
    var base64Parts = survey.photo.split("base64,");
    var base64Data = base64Parts[1];
    
    // デコードしてBlobを作成
    var decoded = Utilities.base64Decode(base64Data);
    
    // ファイル名の決定: 調査者名_調査ID_日時.jpg
    // 日時文字列の整形 (例: 2026-05-24_190000)
    var cleanTime = survey.time.replace(/:/g, "");
    var fileName = survey.username + "_" + survey.id + "_" + survey.date + "_" + cleanTime + ".jpg";
    
    var blob = Utilities.newBlob(decoded, "image/jpeg", fileName);
    
    // ドライブフォルダーにファイルを保存
    var file = folder.createFile(blob);
    
    // スプレッドシートに保存するためにファイル名を返す
    return file.getName();
  } catch (err) {
    Logger.log("写真保存失敗: " + err.toString());
    return "Error_FailedToSavePhoto";
  }
}

// ==========================================
// 5. SHEET HELPERS
// ==========================================

// 調査データシート「現地調査結果」の取得、または作成
function getOrCreateSurveySheet(ss) {
  // 1. シート名で取得を試みる
  var sheet = ss.getSheetByName(SURVEY_SHEET_NAME);
  if (sheet) return sheet;

  // 2. GIDで取得を試みる (フォールバック)
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === SURVEY_SHEET_GID) {
      // ユーザー要望に沿ってシート名を「現地調査結果」にリネームして返す
      sheets[i].setName(SURVEY_SHEET_NAME);
      return sheets[i];
    }
  }

  // 3. どちらも見つからなければ新規作成
  sheet = ss.insertSheet(SURVEY_SHEET_NAME);
  
  // ヘッダーの書き込み
  var headers = ["ID", "調査者", "調査日", "調査時間", "地点分類", "種名", "情報詳細", "聞き取り対象", "写真", "緯度", "経度"];
  sheet.appendRow(headers);
  
  // ヘッダーのフォント変更や装飾
  sheet.getRange("A1:K1").setFontWeight("bold").setBackground("#e2e8f0");
  
  return sheet;
}

// トラックデータシートの取得、または作成
function getOrCreateTrackSheet(ss) {
  var sheet = ss.getSheetByName(TRACK_SHEET_NAME);
  if (sheet) return sheet;

  sheet = ss.insertSheet(TRACK_SHEET_NAME);
  
  // ヘッダーの書き込み
  var headers = ["調査ID", "タイムスタンプ", "緯度", "経度"];
  sheet.appendRow(headers);
  
  sheet.getRange("A1:D1").setFontWeight("bold").setBackground("#e2e8f0");
  
  return sheet;
}
