import * as SQLite from 'expo-sqlite';

// SQLiteデータベースの遅延オープン（ブリッジ初期化前のフリーズ防止）
let dbInstance = null;
function getDb() {
  if (!dbInstance) {
    dbInstance = SQLite.openDatabaseSync('FR5Database.db');
  }
  return dbInstance;
}

// データベースの初期化（テーブル作成）
export function initDatabase() {
  try {
    // surveysテーブル作成
    getDb().execSync(`
      CREATE TABLE IF NOT EXISTS surveys (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        category TEXT NOT NULL,
        species TEXT NOT NULL,
        detail TEXT,
        interview TEXT,
        photo TEXT,
        lat REAL NOT NULL,
        lng REAL NOT NULL
      );
    `);

    // tracksテーブル作成
    getDb().execSync(`
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        username TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        lat REAL NOT NULL,
        lng REAL NOT NULL
      );
    `);

    console.log('SQLite データベースの初期化が成功しました');
  } catch (error) {
    console.error('SQLite データベースの初期化失敗:', error);
  }
}

// ==========================================
// SURVEYS (調査データ) の操作
// ==========================================

// 新規調査データの追加
export function addSurvey(survey) {
  return new Promise((resolve, reject) => {
    try {
      getDb().runSync(
        `INSERT INTO surveys (id, username, date, time, category, species, detail, interview, photo, lat, lng) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          survey.id,
          survey.username,
          survey.date,
          survey.time,
          survey.category,
          survey.species,
          survey.detail || '',
          survey.interview || '聞き取りなし',
          survey.photo || '',
          survey.lat,
          survey.lng
        ]
      );
      resolve(true);
    } catch (error) {
      console.error('Survey追加失敗:', error);
      reject(error);
    }
  });
}

// すべての調査データを取得
export function getAllSurveys() {
  try {
    return getDb().getAllSync('SELECT * FROM surveys ORDER BY date DESC, time DESC');
  } catch (error) {
    console.error('Survey取得失敗:', error);
    return [];
  }
}

// 調査データの修正更新
export function updateSurvey(survey) {
  return new Promise((resolve, reject) => {
    try {
      getDb().runSync(
        `UPDATE surveys 
         SET category = ?, species = ?, detail = ?, interview = ?, photo = ?, lat = ?, lng = ? 
         WHERE id = ?`,
        [
          survey.category,
          survey.species,
          survey.detail || '',
          survey.interview || '聞き取りなし',
          survey.photo || '',
          survey.lat,
          survey.lng,
          survey.id
        ]
      );
      resolve(true);
    } catch (error) {
      console.error('Survey更新失敗:', error);
      reject(error);
    }
  });
}

// 特定の調査データの削除
export function deleteSurvey(id) {
  return new Promise((resolve, reject) => {
    try {
      getDb().runSync('DELETE FROM surveys WHERE id = ?', [id]);
      resolve(true);
    } catch (error) {
      console.error('Survey削除失敗:', error);
      reject(error);
    }
  });
}

// 調査データテーブルの全クリア
export function clearSurveys() {
  try {
    getDb().runSync('DELETE FROM surveys');
    return true;
  } catch (error) {
    console.error('Surveysクリア失敗:', error);
    return false;
  }
}

// ==========================================
// TRACKS (軌跡データ) の操作
// ==========================================

// 新規軌跡点の追加
export function addTrackPoint(track) {
  try {
    getDb().runSync(
      `INSERT INTO tracks (sessionId, username, timestamp, lat, lng) VALUES (?, ?, ?, ?, ?)`,
      [
        track.sessionId,
        track.username,
        track.timestamp,
        track.lat,
        track.lng
      ]
    );
    return true;
  } catch (error) {
    console.error('TrackPoint追加失敗:', error);
    return false;
  }
}

// 現在のセッションの軌跡データを取得
export function getTracksBySession(sessionId) {
  try {
    return getDb().getAllSync('SELECT * FROM tracks WHERE sessionId = ? ORDER BY timestamp ASC', [sessionId]);
  } catch (error) {
    console.error('Session別Track取得失敗:', error);
    return [];
  }
}

// すべての軌跡データを取得
export function getAllTracks() {
  try {
    return getDb().getAllSync('SELECT * FROM tracks ORDER BY timestamp ASC');
  } catch (error) {
    console.error('すべてのTrack取得失敗:', error);
    return [];
  }
}

// 軌跡データテーブルの全クリア
export function clearTracks() {
  try {
    getDb().runSync('DELETE FROM tracks');
    return true;
  } catch (error) {
    console.error('Tracksクリア失敗:', error);
    return false;
  }
}
