// ==========================================
// 1. FIREBASE & APP INITIALIZATION
// ==========================================
const GAS_URL = "https://script.google.com/macros/s/AKfycbx_OirHKvZF_zeee6ZqgwiKR4yRqRj_jnHH5KbwJcRWe6i3iPppxGFlm5lYQccSG_rW/exec";

// Firebaseの設定と初期化 (Compat v10)
const firebaseConfig = {
  apiKey: "AIzaSyCd9CKodyXBOQLylgZR26FuyNp6mDKuza0",
  authDomain: "fieldresearch5.firebaseapp.com",
  projectId: "fieldresearch5",
  storageBucket: "fieldresearch5.firebasestorage.app",
  messagingSenderId: "68930595789",
  appId: "1:68930595789:web:deba33f203d1ec66e47284"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const dbFirestore = firebase.firestore();

// Dexie.js (IndexedDBラッパー) の初期化
const db = new Dexie("FieldSurveyDatabase");
db.version(1).stores({
  surveys: "id, username, date, time, category, species, detail, interview, photo, lat, lng",
  tracks: "++id, sessionId, username, timestamp, lat, lng"
});

// アプリのグローバルステート
let map = null;
let currentPositionMarker = null;
let currentPositionAccuracyCircle = null;
let trackPolyline = null;
let surveyMarkersGroup = null; // 調査データピン用のレイヤーグループ
let latestCoords = { lat: null, lng: null, accuracy: null };

let trackingIntervalId = null;
let watchPositionId = null;
let currentSessionId = null;
let editCompressedPhotoBase64 = ""; // 編集中の写真Base64キャッシュ
let lastRealtimeUploadTime = 0; // 他調査員用現在地アップロードのスロットリング用タイムスタンプ

// バックグラウンド動作維持用のグローバル変数 (Screen Wake Lock & Audio Background Loop)
let wakeLock = null;
const silentAudio = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAAA");
silentAudio.loop = true;

// 画面がフォアグラウンドに戻った際に Wake Lock を自動的に再取得
document.addEventListener('visibilitychange', async () => {
  if (trackingIntervalId && wakeLock === null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

// Firebaseリアルタイム共有・GPSステータス用のグローバル変数
let realtimeLocationIntervalId = null; // 10分ごとのFirestore更新タイマーID
let otherUsersMarkers = {};            // 他の調査員のマーカー管理 (username -> L.marker)
let otherUsersPolylines = {};          // 他の調査員の軌跡管理 (username -> L.polyline)
let showOtherUsers = true;             // 他ユーザーの表示切替フラグ
let hasInitialCenteringDone = false;   // 初回位置測位でのマップ中央寄せ完了フラグ

// ==========================================
// 2. LIFECYCLE & EVENT LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", async () => {
  initUI();
  initDBStats();
  
  // ログイン確認
  const username = checkLogin();
  if (username) {
    initApp(username);
  }
});

// UI初期化（タブ切り替えなど）
function initUI() {
  const tabs = document.querySelectorAll(".bottom-nav .nav-item-btn");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      // タブのactive状態の切り替え
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      // コンテンツの切り替え
      const targetTabId = tab.getAttribute("data-tab");
      const tabContents = document.querySelectorAll(".app-tab-content");
      tabContents.forEach(content => content.classList.remove("active"));
      
      const targetContent = document.getElementById(targetTabId);
      if (targetContent) {
        targetContent.classList.add("active");
      }

      // マップタブに切り替わった場合、Leafletマップの再描画（サイズ崩れ防止）
      if (targetTabId === "tab-map" && map) {
        setTimeout(() => map.invalidateSize(), 100);
      }
    });
  });

  // ログインフォーム送信
  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const nameInput = document.getElementById("username-input").value.trim();
    if (nameInput) {
      sessionStorage.setItem("surveyor_name", nameInput);
      document.getElementById("login-overlay").style.display = "none";
      initApp(nameInput);
    }
  });

  // ログアウトボタン (自身のリアルタイム位置を確実に消去してからログアウトするよう拡張)
  document.getElementById("btn-change-user").addEventListener("click", async () => {
    if (confirm("ログアウトしますか？（保存済みの調査データは削除されません）")) {
      const username = sessionStorage.getItem("surveyor_name");
      if (username) {
        try {
          await dbFirestore.collection("active_users").doc(username).delete();
          console.log("Firestoreから自身のリアルタイム位置を削除しました");
        } catch (e) {
          console.error("ログアウト時のFirestore削除失敗:", e);
        }
      }
      sessionStorage.removeItem("surveyor_name");
      location.reload();
    }
  });

  // 強制クリアボタン
  document.getElementById("btn-clear-db").addEventListener("click", async () => {
    if (confirm("警告: 端末内のすべての未送信データを強制消去します。よろしいですか？")) {
      await db.surveys.clear();
      await db.tracks.clear();
      alert("端末内データをクリアしました。");
      location.reload();
    }
  });

  // 現在地移動ボタン
  document.getElementById("btn-recenter").addEventListener("click", () => {
    recenterMap();
  });

  // 調査開始・停止ボタン
  // 調査開始・停止のトグルボタン (単一ボタン化)
  const toggleTrackingBtn = document.getElementById("btn-toggle-tracking");
  if (toggleTrackingBtn) {
    toggleTrackingBtn.addEventListener("click", () => {
      if (!trackingIntervalId) {
        startTracking();
      } else {
        stopTracking();
      }
    });
  }

  // 写真選択・撮影のトリガー
  const photoTrigger = document.getElementById("photo-trigger");
  const cameraInput = document.getElementById("camera-input");
  
  photoTrigger.addEventListener("click", () => cameraInput.click());
  cameraInput.addEventListener("change", handlePhotoUpload);

  // 新規調査フォームの更新ボタン (安全にチェック)
  const refreshFormCoordsBtn = document.getElementById("btn-refresh-form-coords");
  if (refreshFormCoordsBtn) {
    refreshFormCoordsBtn.addEventListener("click", () => {
      updateFormCoordinates();
    });
  }

  // 調査フォーム送信
  document.getElementById("survey-form").addEventListener("submit", handleSurveySubmit);

  // GAS一括送信ボタン
  document.getElementById("btn-submit-gas").addEventListener("click", submitAllDataToGAS);

  // ページを閉じる・遷移する際、非同期で自身のリアルタイム位置を削除する後始末
  window.addEventListener("beforeunload", () => {
    const username = sessionStorage.getItem("surveyor_name");
    if (username) {
      dbFirestore.collection("active_users").doc(username).delete();
    }
  });

  // 地点分類のチップ選択イベント (イベント委譲)
  const categoryGroup = document.getElementById("category-button-group");
  if (categoryGroup) {
    categoryGroup.addEventListener("click", (e) => {
      const button = e.target.closest(".btn-chip");
      if (!button) return;
      
      // 全ボタンから選択状態を除去
      categoryGroup.querySelectorAll(".btn-chip").forEach(btn => btn.classList.remove("selected"));
      // クリックされたボタンを選択状態にする
      button.classList.add("selected");
      // 隠しフィールドの値を更新
      document.getElementById("spot-category").value = button.getAttribute("data-value");
    });
  }

  // 種名のチップ選択イベント (イベント委譲)
  const speciesGroup = document.getElementById("species-button-group");
  if (speciesGroup) {
    // 初期選択スタイル設定
    const defaultBtn = speciesGroup.querySelector('[data-value="イノシシ"]');
    if (defaultBtn) {
      defaultBtn.classList.add("selected");
    }

    speciesGroup.addEventListener("click", (e) => {
      const button = e.target.closest(".btn-chip");
      if (!button) return;
      
      // 全ボタンから選択状態を除去
      speciesGroup.querySelectorAll(".btn-chip").forEach(btn => btn.classList.remove("selected"));
      // クリックされたボタンを選択状態にする
      button.classList.add("selected");
      // 隠しフィールドの値を更新
      document.getElementById("species-name").value = button.getAttribute("data-value");
    });
  }

  // --- 追加された調査データ管理・編集用のイベントリスナー ---

  // 「調査データ件数」のクリックリスナー (一覧表示)
  const showSurveysBtn = document.getElementById("btn-show-surveys");
  if (showSurveysBtn) {
    showSurveysBtn.addEventListener("click", () => {
      showSurveyListModal();
    });
  }

  // 編集モーダル：地点分類チップの選択イベント (イベント委譲)
  const editCategoryGroup = document.getElementById("edit-category-button-group");
  if (editCategoryGroup) {
    editCategoryGroup.addEventListener("click", (e) => {
      const button = e.target.closest(".btn-chip");
      if (!button) return;
      editCategoryGroup.querySelectorAll(".btn-chip").forEach(btn => btn.classList.remove("selected"));
      button.classList.add("selected");
      document.getElementById("edit-spot-category").value = button.getAttribute("data-value");
    });
  }

  // 編集モーダル：種名チップの選択イベント (イベント委譲)
  const editSpeciesGroup = document.getElementById("edit-species-button-group");
  if (editSpeciesGroup) {
    editSpeciesGroup.addEventListener("click", (e) => {
      const button = e.target.closest(".btn-chip");
      if (!button) return;
      editSpeciesGroup.querySelectorAll(".btn-chip").forEach(btn => btn.classList.remove("selected"));
      button.classList.add("selected");
      document.getElementById("edit-species-name").value = button.getAttribute("data-value");
    });
  }

  // 編集モーダル：写真選択・撮影のトリガー
  const editPhotoTrigger = document.getElementById("edit-photo-trigger");
  const editCameraInput = document.getElementById("edit-camera-input");
  if (editPhotoTrigger && editCameraInput) {
    editPhotoTrigger.addEventListener("click", () => editCameraInput.click());
    editCameraInput.addEventListener("change", handleEditPhotoUpload);
  }

  // 編集モーダル：写真を削除ボタン
  const editDeletePhotoBtn = document.getElementById("btn-edit-delete-photo");
  if (editDeletePhotoBtn) {
    editDeletePhotoBtn.addEventListener("click", () => {
      if (confirm("写真を削除してもよろしいですか？")) {
        editCompressedPhotoBase64 = "";
        document.getElementById("edit-camera-icon").style.display = "block";
        document.getElementById("edit-photo-status").innerText = "カメラを起動して写真を変更";
        document.getElementById("edit-photo-status").className = "text-secondary small";
        document.getElementById("edit-photo-preview-img").style.display = "none";
        document.getElementById("edit-photo-preview-img").src = "#";
        document.getElementById("edit-photo-delete-container").style.display = "none";
      }
    });
  }

  // 編集モーダル：保存ボタン
  const editSaveSurveyBtn = document.getElementById("btn-edit-save-survey");
  if (editSaveSurveyBtn) {
    editSaveSurveyBtn.addEventListener("click", () => {
      saveEditedSurvey();
    });
  }

  // 編集モーダル：削除ボタン
  const editDeleteSurveyBtn = document.getElementById("btn-edit-delete-survey");
  if (editDeleteSurveyBtn) {
    editDeleteSurveyBtn.addEventListener("click", () => {
      deleteEditedSurvey();
    });
  }
}

// 端末内データ件数の同期
async function initDBStats() {
  const surveyCount = await db.surveys.count();
  const trackCount = await db.tracks.count();

  // バッジやディスプレイの更新
  document.getElementById("badge-survey-count").innerText = surveyCount;
  document.getElementById("survey-count-display").innerText = surveyCount;
  document.getElementById("track-count-display").innerText = trackCount;
  document.getElementById("btn-submit-badge").innerText = `${surveyCount} 件`;
}

// ログイン確認
function checkLogin() {
  const username = sessionStorage.getItem("surveyor_name");
  if (username) {
    document.getElementById("login-overlay").style.display = "none";
    return username;
  } else {
    document.getElementById("login-overlay").style.display = "flex";
    return null;
  }
}

// ログイン後のアプリ初期化
function initApp(username) {
  // セッションIDの復元 (リロード時のセッション継続対応)
  const savedSessionId = sessionStorage.getItem("current_session_id");
  if (savedSessionId) {
    currentSessionId = savedSessionId;
    console.log("セッションIDを復元しました:", currentSessionId);
  }

  const badgeUsername = document.getElementById("badge-username");
  if (badgeUsername) {
    badgeUsername.innerText = username;
  }
  document.getElementById("config-username").innerText = username;

  // 地図の初期化
  initMap();

  // Geolocationの監視を開始
  startGpsMonitoring();

  // Firebase 匿名認証を実行してリアルタイムリッスンを開始
  auth.signInAnonymously()
    .then((userCredential) => {
      console.log("Firebase 匿名ログイン成功: ", userCredential.user.uid);
      listenToOtherUsers();
      
      // ログイン成功時に最新の位置がすでに取得できていれば、即座にFirestoreに現在地を登録する (同期の高速化、force = true)
      if (latestCoords.lat && latestCoords.lng) {
        updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng, true);
      }
    })
    .catch((error) => {
      console.error("Firebase 匿名ログイン失敗: ", error);
      alert("リアルタイム同期サーバーとの接続に失敗しました。オフライン機能は引き続き動作します。");
    });
}

// 調査員名から一意のカラーコードを生成する (美しいHSLカラーベース)
function getUserColor(username) {
  if (!username) return "#a855f7"; // フォールバック
  
  // 文字列からハッシュ値を計算 (DJB2アルゴリズム)
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // 色相 (0〜360) を決定
  const hue = Math.abs(hash) % 360;
  
  // 彩度 (75〜90%)、明度 (45〜55%) で見やすい高コントラストな色にする
  const saturation = 80 + (Math.abs(hash >> 8) % 15);
  const lightness = 45 + (Math.abs(hash >> 16) % 10);
  
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// 緯度経度オブジェクト (プレーンまたはGeoPoint) から緯度と経度を安全に抽出する超堅牢な関数
function parseCoordinate(obj) {
  if (!obj) return null;
  
  let lat = null;
  let lng = null;

  // 1. latitude / longitude プロパティをチェック
  if (typeof obj.latitude === "number") lat = obj.latitude;
  else if (typeof obj.lat === "number") lat = obj.lat;
  else if (obj.lat && typeof obj.lat.latitude === "number") lat = obj.lat.latitude; // 入れ子

  // 2. longitude / lng プロパティをチェック
  if (typeof obj.longitude === "number") lng = obj.longitude;
  else if (typeof obj.lng === "number") lng = obj.lng;
  else if (obj.lng && typeof obj.lng.longitude === "number") lng = obj.lng.longitude; // 入れ子

  if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
    return [lat, lng];
  }
  return null;
}

// Screen Wake Lock API の要求 (自動消灯防止)
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('Wake Lock 有効化成功');
      const bgStatusEl = document.getElementById("config-background-status");
      if (bgStatusEl) {
        bgStatusEl.innerText = "稼働中 (画面維持)";
        bgStatusEl.className = "text-success fw-bold ms-1";
      }
    }
  } catch (err) {
    console.warn(`Wake Lock 要求失敗: ${err.name}, ${err.message}`);
    const bgStatusEl = document.getElementById("config-background-status");
    if (bgStatusEl) {
      bgStatusEl.innerText = "制限中 (画面消灯可)";
      bgStatusEl.className = "text-warning fw-bold ms-1";
    }
  }
}

// Screen Wake Lock API の解除 (スリープ制限の解除)
function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release();
    wakeLock = null;
    console.log('Wake Lock 解除');
    const bgStatusEl = document.getElementById("config-background-status");
    if (bgStatusEl) {
      bgStatusEl.innerText = "停止中";
      bgStatusEl.className = "text-secondary fw-bold ms-1";
    }
  }
}

// ==========================================
// 3. MAP & GPS FUNCTIONS
// ==========================================
// ==========================================
// CUSTOM OFFLINE CACHE TILE LAYER & CONTROL
// ==========================================
L.TileLayer.OfflineCache = L.TileLayer.extend({
  createTile: function(coords, done) {
    const tile = document.createElement('img');
    const url = this.getTileUrl(coords);
    const cacheName = 'gsi-tile-cache';
    
    L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
    L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
    
    if (window.caches) {
      window.caches.open(cacheName).then(cache => {
        cache.match(url).then(response => {
          if (response) {
            response.blob().then(blob => {
              const objectURL = URL.createObjectURL(blob);
              tile.addEventListener('load', () => URL.revokeObjectURL(objectURL), { once: true });
              tile.addEventListener('error', () => URL.revokeObjectURL(objectURL), { once: true });
              tile.src = objectURL;
            }).catch(err => {
              console.warn("Blob conversion error, falling back to network:", err);
              tile.src = url;
            });
          } else {
            if (navigator.onLine === false) {
              tile.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
              setTimeout(() => done(null, tile), 0);
              return;
            }
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            
            fetch(url, { signal: controller.signal })
              .then(res => {
                clearTimeout(timeoutId);
                if (res.ok) {
                  const resClone = res.clone();
                  cache.put(url, resClone);
                  return res.blob();
                }
                throw new Error("Tile fetch failed");
              })
              .then(blob => {
                const objectURL = URL.createObjectURL(blob);
                tile.addEventListener('load', () => URL.revokeObjectURL(objectURL), { once: true });
                tile.addEventListener('error', () => URL.revokeObjectURL(objectURL), { once: true });
                tile.src = objectURL;
              })
              .catch(err => {
                clearTimeout(timeoutId);
                if (err.name === 'AbortError') {
                  console.warn("Tile fetch aborted (timeout):", url);
                }
                tile.src = url;
              });
          }
        });
      }).catch(err => {
        console.error("Cache open error:", err);
        tile.src = url;
      });
    } else {
      tile.src = url;
    }
    
    return tile;
  }
});

L.tileLayer.offlineCache = function(url, options) {
  return new L.TileLayer.OfflineCache(url, options);
};

L.Control.MapCache = L.Control.extend({
  options: {
    position: 'topleft'
  },
  
  onAdd: function(map) {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const button = L.DomUtil.create('a', '', container);
    button.href = '#';
    button.title = '現在の表示エリアの地図を事前保存';
    button.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i>';
    button.style.fontSize = '1.3rem';
    button.style.display = 'flex';
    button.style.alignItems = 'center';
    button.style.justifyContent = 'center';
    button.style.cursor = 'pointer';
    
    L.DomEvent.disableClickPropagation(container);
    
    const mapParent = map.getContainer();
    const card = L.DomUtil.create('div', 'glass-panel p-3', mapParent);
    card.style.position = 'absolute';
    card.style.top = '15px';
    card.style.left = '70px';
    card.style.zIndex = '1000';
    card.style.width = '280px';
    card.style.display = 'none';
    card.style.boxShadow = '0 10px 30px rgba(15, 23, 42, 0.2)';
    card.style.border = '2px solid var(--glass-border)';
    card.style.background = '#ffffff';
    card.style.borderRadius = '12px';
    
    card.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="m-0 fw-bold text-primary"><i class="fa-solid fa-cloud-arrow-down me-1"></i>オフライン地図保存</h6>
        <button type="button" class="btn-close btn-close-sm" style="font-size: 0.8rem; border: none; background: transparent;"></button>
      </div>
      <p class="text-secondary small mb-3" style="font-size: 0.82rem; line-height: 1.35; color: #64748b !important;">
        現在表示されている範囲の地図を保存（キャッシュ）します。調査エリアを画面内に収め、拡大してから実行してください。
      </p>
      <div class="mb-2 small text-dark">
        <strong>保存ズームレベル:</strong> <span id="cache-zoom-range">15 〜 18</span><br>
        <strong>予想タイル数:</strong> <span class="fw-bold" id="cache-tile-count">計算中...</span>
      </div>
      <div id="cache-progress-container" style="display: none;" class="mb-3">
        <div class="progress" style="height: 12px; border-radius: 6px; overflow: hidden; background: #e2e8f0;">
          <div id="cache-progress-bar" class="progress-bar progress-bar-striped progress-bar-animated bg-success" style="width: 0%; height: 100%;"></div>
        </div>
        <div class="text-center small mt-1 text-secondary" id="cache-progress-text" style="font-size: 0.78rem;">0 / 0 タイル (0%)</div>
      </div>
      <button class="btn btn-sm btn-gradient-primary w-100 py-2" id="btn-start-cache-download" style="font-size: 0.9rem; font-weight: 700;">ダウンロード開始</button>
    `;
    
    const closeBtn = card.querySelector('.btn-close');
    const startBtn = card.querySelector('#btn-start-cache-download');
    const tileCountSpan = card.querySelector('#cache-tile-count');
    const zoomRangeSpan = card.querySelector('#cache-zoom-range');
    const progressContainer = card.querySelector('#cache-progress-container');
    const progressBar = card.querySelector('#cache-progress-bar');
    const progressText = card.querySelector('#cache-progress-text');
    
    let isDownloading = false;
    let abortController = null;
    
    L.DomEvent.on(button, 'click', function(e) {
      L.DomEvent.preventDefault(e);
      if (card.style.display === 'none') {
        card.style.display = 'block';
        updateTileEstimate();
      } else {
        closeCard();
      }
    });
    
    L.DomEvent.on(closeBtn, 'click', closeCard);
    
    function closeCard() {
      if (isDownloading) {
        if (confirm("ダウンロードを中止しますか？")) {
          if (abortController) abortController.abort();
          resetUI();
          card.style.display = 'none';
        }
      } else {
        card.style.display = 'none';
      }
    }
    
    function resetUI() {
      isDownloading = false;
      progressContainer.style.display = 'none';
      progressBar.style.width = '0%';
      progressText.innerText = '0 / 0 タイル (0%)';
      startBtn.disabled = false;
      startBtn.innerText = 'ダウンロード開始';
      startBtn.className = 'btn btn-sm btn-gradient-primary w-100 py-2';
    }
    
    function lng2tile(lon, zoom) {
      return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
    }
    function lat2tile(lat, zoom) {
      return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
    }
    
    function getTilesList() {
      const bounds = map.getBounds();
      const currentZoom = Math.max(12, Math.round(map.getZoom()));
      const minZoom = currentZoom;
      const maxZoom = Math.min(18, currentZoom + 3);
      
      zoomRangeSpan.innerText = `${minZoom} 〜 ${maxZoom}`;
      
      const tiles = [];
      for (let z = minZoom; z <= maxZoom; z++) {
        const north = bounds.getNorth();
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const east = bounds.getEast();
        
        const xMin = lng2tile(west, z);
        const xMax = lng2tile(east, z);
        const yMin = lat2tile(north, z);
        const yMax = lat2tile(south, z);
        
        for (let x = xMin; x <= xMax; x++) {
          for (let y = yMin; y <= yMax; y++) {
            tiles.push({ x: x, y: y, z: z });
          }
        }
      }
      return tiles;
    }
    
    function updateTileEstimate() {
      if (isDownloading) return;
      const tiles = getTilesList();
      tileCountSpan.innerText = `${tiles.length} タイル`;
      if (tiles.length > 1000) {
        tileCountSpan.className = 'fw-bold text-danger';
        tileCountSpan.innerText += ' (多すぎます)';
        startBtn.disabled = true;
        startBtn.innerText = '地図を拡大してください';
      } else {
        tileCountSpan.className = 'fw-bold text-success';
        startBtn.disabled = false;
        startBtn.innerText = 'ダウンロード開始';
      }
    }
    
    map.on('moveend', updateTileEstimate);
    
    L.DomEvent.on(startBtn, 'click', async function() {
      if (isDownloading) return;
      
      const tiles = getTilesList();
      if (tiles.length === 0) return;
      
      isDownloading = true;
      startBtn.disabled = true;
      startBtn.innerText = 'ダウンロード中...';
      startBtn.className = 'btn btn-sm btn-secondary w-100 py-2';
      progressContainer.style.display = 'block';
      
      abortController = new AbortController();
      const signal = abortController.signal;
      
      const cacheName = 'gsi-tile-cache';
      let loadedCount = 0;
      const totalCount = tiles.length;
      const pool = [];
      const limit = 5;
      
      try {
        const cache = await window.caches.open(cacheName);
        
        for (let i = 0; i < tiles.length; i++) {
          if (signal.aborted) break;
          
          const tile = tiles[i];
          const url = `https://cyberjapandata.gsi.go.jp/xyz/std/${tile.z}/${tile.x}/${tile.y}.png`;
          
          const promise = (async () => {
            const matched = await cache.match(url);
            if (!matched) {
              try {
                const response = await fetch(url, { signal });
                if (response.ok) {
                  await cache.put(url, response);
                }
              } catch (e) {
                console.warn("Failed to pre-download tile:", url, e);
              }
            }
            
            loadedCount++;
            const pct = Math.round((loadedCount / totalCount) * 100);
            progressBar.style.width = `${pct}%`;
            progressText.innerText = `${loadedCount} / ${totalCount} タイル (${pct}%)`;
          })();
          
          pool.push(promise);
          
          if (pool.length >= limit) {
            await Promise.race(pool);
            for (let j = pool.length - 1; j >= 0; j--) {
              // Remove resolved promises from tracking list
            }
            pool.splice(0, pool.length - limit + 1);
          }
        }
        
        await Promise.all(pool);
        
        if (!signal.aborted) {
          progressBar.style.width = '100%';
          progressText.innerText = `完了! ${totalCount} タイル保存完了`;
          startBtn.className = 'btn btn-sm btn-success w-100 py-2';
          startBtn.innerText = '保存完了';
          setTimeout(() => {
            resetUI();
            card.style.display = 'none';
          }, 2000);
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          console.log("Pre-download aborted by user.");
        } else {
          console.error("Cache download error:", err);
          alert("地図の事前保存中にエラーが発生しました。");
          resetUI();
        }
      }
    });
    
    return container;
  }
});

L.control.mapCache = function(options) {
  return new L.Control.MapCache(options);
};

function initMap() {
  if (map) return;

  // デフォルト位置 (日本中心) でマップ作成 (Canvas描画を有効化して高速化)
  map = L.map("map", {
    zoomControl: false,
    maxZoom: 19,
    preferCanvas: true
  }).setView([35.681236, 139.767125], 13);

  // L.control.zoomを右上等に配置
  L.control.zoom({ position: 'topleft' }).addTo(map);

  // 国土地理院 標準地図タイル (キャッシュ対応のカスタムレイヤーを使用)
  L.tileLayer.offlineCache("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    minZoom: 2,
    maxZoom: 18
  }).addTo(map);

  // 事前ダウンロード用のカスタムコントロールを追加
  L.control.mapCache({ position: 'topleft' }).addTo(map);

  const username = sessionStorage.getItem("surveyor_name") || "匿名調査員";
  const myColor = getUserColor(username);

  // 軌跡描画用のレイヤーを作成
  trackPolyline = L.polyline([], {
    color: myColor, // 自分の色を自動適用
    weight: 4,
    opacity: 0.85,
    dashArray: "1, 1", // 細かい点線/破線で美しい軌跡を演出
    lineJoin: "round"
  }).addTo(map);

  // 調査ピン用のレイヤーグループを作成
  surveyMarkersGroup = L.layerGroup().addTo(map);

  // 保存済みの軌跡があれば初期表示する
  loadExistingTracksOnMap();

  // 保存済みの調査データがあれば初期表示する
  loadExistingSurveysOnMap();
}

// 保存済みのすべての調査データをマップ上に復元
async function loadExistingSurveysOnMap() {
  if (!map || !surveyMarkersGroup) return;

  // 一旦全ピンをクリア
  surveyMarkersGroup.clearLayers();

  const surveys = await db.surveys.toArray();
  surveys.forEach(survey => {
    const pinColor = getMarkerColorByCategory(survey.category);
    const marker = L.circleMarker([survey.lat, survey.lng], {
      radius: 8,
      fillColor: pinColor,
      color: "#ffffff",
      weight: 1.5,
      fillOpacity: 0.9
    });

    marker.bindPopup(`<strong>[${survey.category}] ${survey.species}</strong><br><span class="small text-secondary">${survey.time} 保存完了</span>`);
    surveyMarkersGroup.addLayer(marker);
  });
}

// 既存の全軌跡を読み込んでマップに描画
async function loadExistingTracksOnMap() {
  const allTracks = await db.tracks.orderBy("timestamp").toArray();
  if (allTracks.length > 0) {
    const latlngs = allTracks.map(t => [t.lat, t.lng]);
    trackPolyline.setLatLngs(latlngs);
  }
}

// 常時GPS監視 (精度と現在地の表示用)
// 常時GPS監視 (精度と現在地の表示用)
function startGpsMonitoring() {
  // 起動時の初期化状態（測位中）を設定
  updateGpsStatus("positioning");

  if (!navigator.geolocation) {
    updateGpsStatus("error", "GPS非対応");
    return;
  }

  const gpsOptions = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
  };

  // watchPosition でリアルタイム監視
  navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy = position.coords.accuracy;

      latestCoords = { lat, lng, accuracy };
      
      updateGpsStatus("active", `誤差: ±${Math.round(accuracy)}m`);
      updateFormCoordinates();

      // マップの現在地マーク更新
      updateMapMarker(lat, lng, accuracy);

      // 初回位置取得時の自動センタリング (現時点を中心に示す)
      if (!hasInitialCenteringDone && map) {
        map.setView([lat, lng], 17);
        hasInitialCenteringDone = true;
      }
    },
    (error) => {
      console.warn("GPSエラー:", error.message);
      updateGpsStatus("positioning"); // 測位できない時は「測位中...」に戻す
    },
    gpsOptions
  );
}

// GPSステータスUIの更新 (三状態制御)
function updateGpsStatus(state, message) {
  const dot = document.getElementById("gps-status-dot");
  const text = document.getElementById("gps-status-text");
  if (!dot || !text) return;

  if (state === "active") {
    dot.className = "status-dot active";
    text.innerText = message;
    text.className = "text-light small fw-bold";
  } else if (state === "positioning") {
    dot.className = "status-dot positioning";
    text.innerText = "測位中...";
    text.className = "text-warning small fw-bold";
  } else {
    dot.className = "status-dot";
    text.innerText = message || "測位失敗";
    text.className = "text-danger small fw-bold";
  }
}

// 地図上の現在地マークを更新
function updateMapMarker(lat, lng, accuracy) {
  if (!map) return;

  const username = sessionStorage.getItem("surveyor_name") || "匿名調査員";
  const myColor = getUserColor(username);

  const myIcon = L.divIcon({
    className: 'custom-gps-icon',
    html: `<div style="
      width: 14px; 
      height: 14px; 
      background: ${myColor}; 
      border: 2px solid #ffffff; 
      border-radius: 50%;
      box-shadow: 0 0 10px ${myColor};"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });

  if (currentPositionMarker) {
    currentPositionMarker.setLatLng([lat, lng]);
  } else {
    currentPositionMarker = L.marker([lat, lng], { icon: myIcon }).addTo(map);
  }

  // 精度円の描画
  if (currentPositionAccuracyCircle) {
    currentPositionAccuracyCircle.setLatLng([lat, lng]);
    currentPositionAccuracyCircle.setRadius(accuracy);
  } else {
    currentPositionAccuracyCircle = L.circle([lat, lng], {
      radius: accuracy,
      color: myColor,
      fillColor: myColor,
      fillOpacity: 0.1,
      weight: 1
    }).addTo(map);
  }

  // ログイン済みであれば、トラッキング中かどうかにかかわらず、現在地をリアルタイムにFirestoreへ共有！
  // (これによって、トラック開始ボタンを押す前でもお互いの現在地ピンがマップ上に瞬時に表示されます)
  // 電池消耗を防ぐため、前回のリアルタイム送信から少なくとも10分(600,000ms)以上経過している場合のみ実行
  if (username && username !== "匿名調査員") {
    const now = Date.now();
    if (now - lastRealtimeUploadTime >= 600000) {
      updateRealtimeLocation(username, lat, lng);
    }
  }
}

// マップの再センタリング
function recenterMap() {
  if (latestCoords.lat && latestCoords.lng) {
    map.setView([latestCoords.lat, latestCoords.lng], 17);
  } else {
    alert("GPS位置の取得を待っています...");
  }
}

// 新規調査フォーム内の位置座標表示を更新
function updateFormCoordinates() {
  const formCoordsSpan = document.getElementById("form-coords");
  if (!formCoordsSpan) return; // 安全対策
  if (latestCoords.lat && latestCoords.lng) {
    formCoordsSpan.innerText = `${latestCoords.lat.toFixed(6)}, ${latestCoords.lng.toFixed(6)} (±${Math.round(latestCoords.accuracy)}m)`;
    formCoordsSpan.className = "ms-1 fw-bold text-light";
  } else {
    formCoordsSpan.innerText = "GPS位置を測位中...";
    formCoordsSpan.className = "ms-1 text-warning";
  }
}

// ==========================================
// 4. GPS TRACKING LOGIC (1分ごと)
// ==========================================
function startTracking() {
  if (trackingIntervalId) return;

  // GPSが取れていない場合は警告
  if (!latestCoords.lat || !latestCoords.lng) {
    alert("GPS測位が完了していないため、調査を開始できません。電波の良い場所でお待ちください。");
    return;
  }

  // 追跡用セッションIDの新規生成 (UUIDv4)
  currentSessionId = crypto.randomUUID();
  sessionStorage.setItem("current_session_id", currentSessionId);

  // UI状態の更新 (単一トグルボタン化 - ヘッダー用)
  const toggleBtn = document.getElementById("btn-toggle-tracking");
  if (toggleBtn) {
    toggleBtn.className = "btn btn-sm btn-gradient-success fw-bold py-2 px-3 d-flex align-items-center gap-1";
    const icon = document.getElementById("tracking-icon");
    if (icon) icon.className = "fa-solid fa-circle-stop";
    const textStr = document.getElementById("tracking-btn-text");
    if (textStr) textStr.innerText = "トラック中";
  }

  // 1. バックグラウンド動作維持用の無音オーディオ再生を開始 (メディア再生によるOSサスペンド防止)
  silentAudio.play()
    .then(() => {
      console.log("無音オーディオバックグラウンドループ開始成功");
      const bgStatusEl = document.getElementById("config-background-status");
      if (bgStatusEl) {
        bgStatusEl.innerText = "稼働中 (バックグラウンド維持)";
        bgStatusEl.className = "text-success fw-bold ms-1";
      }
    })
    .catch(err => {
      console.warn("無音オーディオ再生失敗:", err);
    });

  // 2. 画面の消灯防止 (Wake Lock) を要求
  requestWakeLock();

  // 開始時の現在点を直ちに記録
  recordCurrentTrackPoint();

  // Firebase リアルタイム位置情報の即時更新 (開始時は force = true で即時登録) & 10分ごとの定期更新タイマー開始 (電池節約)
  const username = sessionStorage.getItem("surveyor_name") || "匿名調査員";
  updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng, true);
  realtimeLocationIntervalId = setInterval(() => {
    const currentUsername = sessionStorage.getItem("surveyor_name") || "匿名調査員";
    if (latestCoords.lat && latestCoords.lng) {
      updateRealtimeLocation(currentUsername, latestCoords.lat, latestCoords.lng, true); // 定期送信なので force = true
    }
  }, 10 * 60 * 1000); // 10分間隔に変更

  // 1分ごとに定期記録するインターバルをセット (60000 ms)
  trackingIntervalId = setInterval(() => {
    recordCurrentTrackPoint();
  }, 60000);

  // バックグラウンドでの欠損対策として watchPosition のコールバックも別で軌跡記録に補完的に組み込む
  watchPositionId = navigator.geolocation.watchPosition(
    (pos) => {
      // watchPositionは高頻度で呼ばれるため、前回の記録時間から一定時間（例：50秒）経過している場合のみ記録
      checkAndRecordAsync(pos);
    },
    null,
    { enableHighAccuracy: true }
  );

  alert("調査（軌跡ログ）を開始しました。アプリを起動したまま移動してください。");
}

let lastRecordedTime = 0;

// Geolocationによる非同期イベントからの適宜記録 (バックグラウンド補強)
async function checkAndRecordAsync(position) {
  const now = Date.now();
  // 50秒以上経過していたら記録
  if (now - lastRecordedTime >= 50000) {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const username = sessionStorage.getItem("surveyor_name") || "匿名調査員";

    await db.tracks.add({
      sessionId: currentSessionId,
      username: username,
      timestamp: now,
      lat: lat,
      lng: lng
    });

    lastRecordedTime = now;
    updateTrackUiAndMap();

    // 1分ごとのバックグラウンド位置補完時にも即時アップロード
    updateRealtimeLocation(username, lat, lng);
  }
}

// 1分ごとの定期記録実行コア
async function recordCurrentTrackPoint() {
  // GPSの最新値がある場合のみ記録
  if (latestCoords.lat && latestCoords.lng) {
    const now = Date.now();
    const username = sessionStorage.getItem("surveyor_name") || "匿名調査員";

    await db.tracks.add({
      sessionId: currentSessionId,
      username: username,
      timestamp: now,
      lat: latestCoords.lat,
      lng: latestCoords.lng
    });

    lastRecordedTime = now;
    updateTrackUiAndMap();

    // 1分ごとの定期記録時にFirestoreに即時アップロード
    updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng);
  }
}

// トラックUIとマップ描画のリアルタイム同期
async function updateTrackUiAndMap() {
  const allTracks = await db.tracks.orderBy("timestamp").toArray();
  const trackCountEl = document.getElementById("track-count");
  if (trackCountEl) {
    trackCountEl.innerText = `${allTracks.length} 点記録`;
  }
  document.getElementById("track-count-display").innerText = allTracks.length;

  // マップのラインを引く
  const latlngs = allTracks.map(t => [t.lat, t.lng]);
  trackPolyline.setLatLngs(latlngs);
}

// トラッキングの一時停止
async function stopTracking() {
  // 1. バックグラウンド用無音オーディオ再生を停止
  silentAudio.pause();
  silentAudio.currentTime = 0;
  
  // 2. 画面スリープ制限 (Wake Lock) を解除
  releaseWakeLock();

  if (trackingIntervalId) {
    clearInterval(trackingIntervalId);
    trackingIntervalId = null;
  }
  if (watchPositionId) {
    navigator.geolocation.clearWatch(watchPositionId);
    watchPositionId = null;
  }
  if (realtimeLocationIntervalId) {
    clearInterval(realtimeLocationIntervalId);
    realtimeLocationIntervalId = null;
  }

  // 調査一時停止時に自身のリアルタイム位置情報をFirestoreから確実に削除
  await removeRealtimeLocation();

  // UI状態の更新 (単一トグルボタン化 - ヘッダー用)
  const toggleBtn = document.getElementById("btn-toggle-tracking");
  if (toggleBtn) {
    toggleBtn.className = "btn btn-sm btn-gradient-primary fw-bold py-2 px-3 d-flex align-items-center gap-1";
    const icon = document.getElementById("tracking-icon");
    if (icon) icon.className = "fa-solid fa-play";
    const textStr = document.getElementById("tracking-btn-text");
    if (textStr) textStr.innerText = "トラック開始";
  }

  alert("トラッキングを一時停止しました。");
}

// ==========================================
// 5. PHOTO HANDLING & IMAGE COMPRESSION (200KB)
// ==========================================
let compressedPhotoBase64 = "";

function handlePhotoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const photoStatus = document.getElementById("photo-status");
  const cameraIcon = document.getElementById("camera-icon");
  const previewImg = document.getElementById("photo-preview-img");

  photoStatus.innerText = "写真を圧縮中...";
  photoStatus.className = "text-warning small";

  // 画像リサイズ＆圧縮
  compressImage(file, 1024, 200)
    .then(base64 => {
      compressedPhotoBase64 = base64;
      
      // UIプレビューの更新
      cameraIcon.style.display = "none";
      photoStatus.innerText = "撮影完了（200KB以下に圧縮済み）";
      photoStatus.className = "text-success small fw-bold";
      
      previewImg.src = base64;
      previewImg.style.display = "block";
    })
    .catch(err => {
      console.error("画像圧縮エラー:", err);
      photoStatus.innerText = "エラー: 圧縮に失敗しました";
      photoStatus.className = "text-danger small";
      alert("画像の読み込みまたは圧縮に失敗しました。");
    });
}

// Canvasを使ったスマート圧縮ロジック
function compressImage(file, maxWidth = 1024, maxFileSizeKB = 200) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    
    reader.onload = function(event) {
      const img = new Image();
      img.src = event.target.result;
      
      img.onload = function() {
        let width = img.width;
        let height = img.height;
        
        // アスペクト比を保ったまま縮小
        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxWidth) {
            width = Math.round((width * maxWidth) / height);
            height = maxWidth;
          }
        }
        
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        
        // 品質を徐々に落としながら200KB以下に収める
        let quality = 0.9;
        let base64 = canvas.toDataURL("image/jpeg", quality);
        let sizeKB = (base64.length * 0.75) / 1024; // Base64文字数から概算バイトを算出
        
        console.log(`初期圧縮サイズ: ${Math.round(sizeKB)}KB`);

        // ループ上限を設定して無限ループを防ぎつつ200KB以下を目指す
        while (sizeKB > maxFileSizeKB && quality > 0.15) {
          quality -= 0.1;
          base64 = canvas.toDataURL("image/jpeg", quality);
          sizeKB = (base64.length * 0.75) / 1024;
          console.log(`再圧縮画質 ${quality.toFixed(1)} -> サイズ: ${Math.round(sizeKB)}KB`);
        }
        
        resolve(base64);
      };
      
      img.onerror = reject;
    };
    
    reader.onerror = reject;
  });
}

// ==========================================
// 6. SURVEY FORM SUBMIT
// ==========================================
async function handleSurveySubmit(e) {
  e.preventDefault();

  if (!latestCoords.lat || !latestCoords.lng) {
    alert("現在地のGPS座標が特定できていません。測位が安定するまで少しお待ちください。");
    return;
  }

  // フォームデータ収集
  const surveyorName = sessionStorage.getItem("surveyor_name") || "匿名調査員";
  const category = document.getElementById("spot-category").value;
  const speciesName = document.getElementById("species-name").value.trim();
  const infoDetail = document.getElementById("info-detail").value.trim();
  const interviewTarget = document.getElementById("interview-target").value.trim() || "聞き取りなし";
  
  // 日時の自動生成
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const surveyDate = `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD (ローカル日時基準)
  const surveyTime = now.toTimeString().split(" ")[0]; // HH:MM:SS
  const surveyId = crypto.randomUUID();

  // IndexedDBへのデータ保存
  const surveyItem = {
    id: surveyId,
    username: surveyorName,
    date: surveyDate,
    time: surveyTime,
    category: category,
    species: speciesName,
    detail: infoDetail,
    interview: interviewTarget,
    photo: compressedPhotoBase64, // Base64 (無い場合は空文字列)
    lat: latestCoords.lat,
    lng: latestCoords.lng
  };

  try {
    await db.surveys.add(surveyItem);
    
    // フォームと写真選択のリセット
    document.getElementById("survey-form").reset();
    resetPhotoSelector();
    resetFormCustomFields();
    
    // UI同期
    await initDBStats();
    
    // マップ上のピンを再描画
    await loadExistingSurveysOnMap();

    alert(`調査データを端末内に保存しました。 (現在 ${await db.surveys.count()} 件保存済み)`);

  } catch (err) {
    console.error("IndexedDB 保存失敗:", err);
    alert("端末データベースへの保存に失敗しました。");
  }
}

// 写真エリアのリセット
function resetPhotoSelector() {
  compressedPhotoBase64 = "";
  document.getElementById("camera-icon").style.display = "block";
  document.getElementById("photo-status").innerText = "カメラを起動して撮影";
  document.getElementById("photo-status").className = "text-secondary small";
  document.getElementById("photo-preview-img").style.display = "none";
  document.getElementById("photo-preview-img").src = "#";
  document.getElementById("camera-input").value = "";
}

// チップ型選択フォームのリセット
function resetFormCustomFields() {
  // 地点分類のリセット
  const spotCategoryInput = document.getElementById("spot-category");
  if (spotCategoryInput) {
    spotCategoryInput.value = "";
  }
  const catGroup = document.getElementById("category-button-group");
  if (catGroup) {
    catGroup.querySelectorAll(".btn-chip").forEach(btn => btn.classList.remove("selected"));
  }
  
  // 種名のリセット (デフォルトはイノシシ)
  const speciesNameInput = document.getElementById("species-name");
  if (speciesNameInput) {
    speciesNameInput.value = "イノシシ";
  }
  const specGroup = document.getElementById("species-button-group");
  if (specGroup) {
    specGroup.querySelectorAll(".btn-chip").forEach(btn => {
      if (btn.getAttribute("data-value") === "イノシシ") {
        btn.classList.add("selected");
      } else {
        btn.classList.remove("selected");
      }
    });
  }
}

// 分類別のピンカラー選定
function getMarkerColorByCategory(cat) {
  switch (cat) {
    case "聞き取り": return "#ef4444"; // 赤
    case "目撃": return "#ec4899"; // ピンク
    case "被害": return "#dc2626"; // 濃い赤
    
    case "掘り起こし": return "#d97706"; // アンバー
    case "足跡": return "#f59e0b"; // オレンジ
    case "獣道": return "#84cc16"; // 黄緑
    case "食痕": return "#10b981"; // エメラルド
    case "泥こすり": return "#059669"; // 濃い緑
    case "ヌタ場": return "#0d9488"; // ティール
    case "寝屋": return "#06b6d4"; // シアン
    case "爪痕": return "#ea580c"; // 濃いオレンジ
    
    case "箱わな": return "#2563eb"; // 青
    case "くくりわな": return "#3b82f6"; // ライトブルー
    case "囲いわな": return "#4f46e5"; // インディゴ
    case "小型わな": return "#6366f1"; // ライトインディゴ
    
    case "電気柵": return "#475569"; // スレート
    case "ワイヤーメッシュ": return "#64748b"; // グレー
    case "金網柵": return "#94a3b8"; // ライトグレー
    case "その他柵": return "#cbd5e1"; // シルバー
    
    case "カメラ": return "#16a34a"; // 緑
    default: return "#a855f7"; // その他は紫
  }
}

// ==========================================
// 7. GAS POST DATA SENDING
// ==========================================
// BlobをBase64文字列に変換するヘルパー (ヘッダー部分を除去)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = () => {
      const base64data = reader.result.split(",")[1];
      resolve(base64data);
    };
    reader.onerror = reject;
  });
}

async function postToGASWebWithRetry(payload, loadingTextEl, baseLabel, maxRetries = 2, timeoutMs = 30000) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (attempt > 0 && loadingTextEl) {
        loadingTextEl.innerText = `${baseLabel} (再試行 ${attempt}/${maxRetries})...`;
        await new Promise(res => setTimeout(res, 1500 * attempt));
      }
      const response = await fetch(GAS_URL, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);
      const result = await response.json();
      if (result.status !== "success") {
        throw new Error(result.message || "サーバー側で書き込みエラーが発生しました。");
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      lastError = err.name === "AbortError"
        ? new Error("通信がタイムアウトしました（電波が弱い可能性があります）")
        : err;
    }
  }
  throw lastError;
}

async function submitAllDataToGAS() {
  const surveyCount = await db.surveys.count();
  const trackCount = await db.tracks.count();

  if (surveyCount === 0 && trackCount === 0) {
    alert("送信するデータ（調査データ・トラックデータ）がありません。");
    return;
  }

  if (GAS_URL === "YOUR_GAS_WEB_APP_URL") {
    alert("GASのWebアプリURLが設定されていません。app.jsの冒頭にある 'GAS_URL' を書き換えてください。");
    return;
  }

  if (!confirm(`端末内に保存されている調査データ ${surveyCount} 件と軌跡データ ${trackCount} 点をGoogleクラウドへ順次送信しますか？\n（1件送信に成功するごとに端末から削除され、途中で電波が切れても残りのデータは保持されます）`)) {
    return;
  }

  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");
  loadingOverlay.style.display = "flex";

  const surveys = await db.surveys.toArray();
  const tracks = await db.tracks.orderBy("timestamp").toArray();

  let surveySuccessCount = 0;
  let trackZipName = "";

  try {
    // 1. 調査データを1件ずつ順次送信し、成功ごとにIndexedDBから削除
    for (let i = 0; i < surveys.length; i++) {
      const label = `調査データを送信中... (${i + 1} / ${surveys.length} 件)`;
      loadingText.innerText = label;

      const payload = {
        surveys: [surveys[i]],
        trackZip: "",
        trackZipName: ""
      };

      await postToGASWebWithRetry(payload, loadingText, label);
      await db.surveys.delete(surveys[i].id);
      surveySuccessCount++;
      await initDBStats();
    }

    // 2. トラックデータの送信
    if (tracks.length > 0) {
      loadingText.innerText = "軌跡データをGeoJSON形式に変換中...";

      const coordinates = tracks.map(t => [t.lng, t.lat]);
      const geojson = {
        type: "FeatureCollection",
        features: []
      };

      const startTime = new Date(tracks[0].timestamp);
      const yyyy = startTime.getFullYear();
      const mm = String(startTime.getMonth() + 1).padStart(2, '0');
      const dd = String(startTime.getDate()).padStart(2, '0');
      const hh = String(startTime.getHours()).padStart(2, '0');
      const min = String(startTime.getMinutes()).padStart(2, '0');

      const yyyymmdd = `${yyyy}${mm}${dd}`;
      const hhmm = `${hh}${min}`;
      const username = tracks[0].username || "匿名調査員";
      const cleanUsername = username.replace(/[\\/:*?"<>|]/g, "_");
      trackZipName = `${yyyymmdd}_${hhmm}_${cleanUsername}_line.geojson`;

      if (coordinates.length === 1) {
        geojson.features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: coordinates[0] },
          properties: {
            id: tracks[0].sessionId || "single_point",
            surveyor: username,
            time: startTime.toISOString()
          }
        });
      } else {
        geojson.features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: coordinates },
          properties: {
            id: tracks[0].sessionId || "track_line",
            surveyor: username,
            start: startTime.toISOString(),
            end: new Date(tracks[tracks.length - 1].timestamp).toISOString()
          }
        });
      }

      const geojsonBlob = new Blob([JSON.stringify(geojson)], { type: "application/json" });
      const trackZipBase64 = await blobToBase64(geojsonBlob);

      const trackLabel = "軌跡データをGoogleドライブへ送信中...";
      loadingText.innerText = trackLabel;

      await postToGASWebWithRetry({
        surveys: [],
        trackZip: trackZipBase64,
        trackZipName: trackZipName
      }, loadingText, trackLabel);

      await db.tracks.clear();
      if (trackPolyline) {
        trackPolyline.setLatLngs([]);
      }
      await initDBStats();
    }

    loadingOverlay.style.display = "none";
    const shpMessage = trackZipName ? `\n・軌跡GeoJSONファイル: Googleドライブへ保存完了 (${trackZipName})` : "";
    alert(`送信完了しました！\n\n・調査データ: ${surveySuccessCount} 件 (スプレッドシート書き込み完了)${shpMessage}`);
    resetPhotoSelector();
    await initDBStats();

  } catch (err) {
    console.error("GAS送信エラー:", err);
    loadingOverlay.style.display = "none";
    await initDBStats();
    const remSurveys = await db.surveys.count();
    const remTracks = await db.tracks.count();
    alert(`電波状況等により送信が中断されました。\n\n・送信完了: ${surveySuccessCount} 件\n・未送信の調査データ: ${remSurveys} 件\n・未送信の軌跡データ: ${remTracks} 点\n\n未送信データは端末内に安全に保存されています。電波の良い場所で再度送信ボタンを押すと、残りから再開できます。\n\n詳細: ${err.message}`);
  }
}

// ==========================================
// 8. FIREBASE REALTIME SHARING FUNCTIONS
// ==========================================

// 自身の位置・軌跡情報をFirestoreに保存/上書きする (スロットリング制御付き: 基本10分に1回)
async function updateRealtimeLocation(username, lat, lng, force = false) {
  if (!lat || !lng) return;
  
  const now = Date.now();
  // force が false の場合、前回のアップロードから 10分 (600,000ms) 未満なら送信をスキップして電池消耗を防ぐ
  if (!force && (now - lastRealtimeUploadTime < 600000)) {
    return;
  }

  try {
    // メモリ上のセッションIDが空でもsessionStorageにあれば復元
    if (!currentSessionId) {
      currentSessionId = sessionStorage.getItem("current_session_id");
    }
    const sessionId = currentSessionId || "no_session";
    const docId = username;

    // IndexedDBから現在のセッションの軌跡データを取得してパス配列を作成
    const sessionTracks = await db.tracks.where("sessionId").equals(sessionId).sortBy("timestamp");
    const pathData = sessionTracks.map(t => ({ lat: t.lat, lng: t.lng }));

    await dbFirestore.collection("active_users").doc(docId).set({
      username: username,
      lat: lat,
      lng: lng,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      sessionId: sessionId,
      path: pathData // 軌跡配列をアップロード
    }, { merge: true });

    lastRealtimeUploadTime = now; // 実際の送信成功タイムスタンプを記録
    console.log(`リアルタイム位置・軌跡をFirestoreに更新: ${docId} (軌跡: ${pathData.length}点)`);
  } catch (error) {
    console.error("Firestoreへの位置・軌跡更新失敗:", error);
  }
}

// 自身の位置情報をFirestoreから削除する
async function removeRealtimeLocation() {
  const username = sessionStorage.getItem("surveyor_name");
  if (!username) return;
  try {
    await dbFirestore.collection("active_users").doc(username).delete();
    console.log("Firestoreから自身のリアルタイム位置を削除しました:", username);
  } catch (error) {
    console.error("Firestoreからの位置削除に失敗しました:", error);
  }
}

// 他の調査員の現在位置と軌跡をFirestoreからリッスンする
function listenToOtherUsers() {
  const currentUsername = sessionStorage.getItem("surveyor_name") || "匿名調査員";
  const realtimeDot = document.getElementById("realtime-status-dot");
  const lastSyncText = document.getElementById("realtime-last-sync");

  dbFirestore.collection("active_users").onSnapshot((snapshot) => {
    const listContainer = document.getElementById("active-users-list");
    if (listContainer) {
      listContainer.innerHTML = "";
    }
    
    let otherActiveCount = 0;
    const now = new Date();
    const activeUsernames = [];

    snapshot.forEach((doc) => {
      const username = doc.id;
      // 自分以外のユーザーのみ処理対象とする
      if (username === currentUsername) return;

      try {
        const data = doc.data();
        if (!data) return;

        // 最終更新からの経過時間（分）を算出
        const updateTime = data.timestamp ? data.timestamp.toDate() : new Date();
        const diffMin = Math.round((now - updateTime) / 60000);

        // 12分以上位置更新がないユーザーは非アクティブと判断して除外（10分間隔の定期更新に合わせた安全マージン）
        if (diffMin > 12) return;

        // 緯度・経度の抽出 (超堅牢な parseCoordinate ヘルパーによるフォールバック対応)
        const parsedDocCoords = parseCoordinate(data);
        if (!parsedDocCoords) {
          return; // 不完全または壊れた位置データは安全にスキップ
        }
        const [lat, lng] = parsedDocCoords;

        activeUsernames.push(username);
        otherActiveCount++;

        // 共通で使う時間・カラー変数を定義
        const timeStr = diffMin <= 0 ? "現在" : `${diffMin}分前`;
        const userColor = getUserColor(username);

        // 1. パネル of 接続中リストへ追加 (存在する場合のみ)
        if (listContainer) {
          const userRow = document.createElement("div");
          userRow.className = "d-flex justify-content-between align-items-center py-1 border-bottom border-light";
          userRow.style.borderColor = "rgba(15, 23, 42, 0.05) !important";
          userRow.innerHTML = `
            <div class="d-flex align-items-center" style="min-width: 0;">
              <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: ${userColor}; margin-right: 6px; flex-shrink: 0;"></span>
              <span class="fw-bold text-dark text-truncate" style="max-width: 110px;" title="${username}">${username}</span>
            </div>
            <span class="text-secondary text-nowrap" style="font-size: 0.68rem;">${timeStr} (${lat.toFixed(4)}, ${lng.toFixed(4)})</span>
          `;
          listContainer.appendChild(userRow);
        }

        // 2. マップ上の軌跡（ライン）描画・更新
        if (map && data.path && Array.isArray(data.path)) {
          // 有効な座標のみを厳密に抽出して配列化
          const latlngs = data.path
            .map(p => parseCoordinate(p))
            .filter(ll => ll !== null);
          
          // 最新座標をパスの末尾に補完して最新表示を担保
          const existsInPath = latlngs.some(ll => ll && Math.abs(ll[0] - lat) < 0.00001 && Math.abs(ll[1] - lng) < 0.00001);
          if (!existsInPath) {
            latlngs.push([lat, lng]);
          }

          if (latlngs.length >= 2) { // 2点以上で描画可能
            if (otherUsersPolylines[username]) {
              otherUsersPolylines[username].setLatLngs(latlngs);
              // 万が一マップから外れていれば再追加する安全対策
              if (showOtherUsers && !map.hasLayer(otherUsersPolylines[username])) {
                otherUsersPolylines[username].addTo(map);
              }
            } else {
              // 高コントラストな、調査員ごとの破線で軌跡を表示
              otherUsersPolylines[username] = L.polyline(latlngs, {
                color: userColor,
                weight: 3,
                opacity: 0.85,
                dashArray: "4, 6",
                lineJoin: "round"
              });
              
              if (showOtherUsers) {
                otherUsersPolylines[username].addTo(map);
              }
            }
          } else {
            // 軌跡が2点未満（リセットされた場合など）は古い軌跡ラインをマップから削除
            if (otherUsersPolylines[username]) {
              if (map) {
                map.removeLayer(otherUsersPolylines[username]);
              }
              delete otherUsersPolylines[username];
            }
          }
        }

        // 3. マップ上の最新位置ピン描画・更新
        if (map) {
          const popupContent = `
            <div style="font-size: 0.85rem; line-height: 1.4;">
              <span class="badge mb-1 text-white" style="background-color: ${userColor}; font-weight: 700;">他調査員 (リアルタイム)</span><br>
              <strong>調査者:</strong> ${username}<br>
              <strong>最新位置:</strong> ${lat.toFixed(6)}, ${lng.toFixed(6)}<br>
              <strong>記録点数:</strong> ${data.path ? data.path.length : 0} 点<br>
              <span class="small text-secondary">更新: ${updateTime.toLocaleTimeString()} (${timeStr})</span>
            </div>
          `;

          if (otherUsersMarkers[username]) {
            // マップにピンがあれば移動させてポップアップを更新
            otherUsersMarkers[username].setLatLng([lat, lng]);
            otherUsersMarkers[username].setPopupContent(popupContent);
            // 万が一マップから外れていれば再追加する安全対策
            if (showOtherUsers && !map.hasLayer(otherUsersMarkers[username])) {
              otherUsersMarkers[username].addTo(map);
            }
          } else {
            // 新規ピン作成 (高コントラストで美しい、調査員ごとの円ピン)
            const otherIcon = L.divIcon({
              className: `custom-other-gps-${username.replace(/\s+/g, '_')}`,
              html: `<div style="
                width: 16px; 
                height: 16px; 
                background: ${userColor}; 
                border: 2px solid #ffffff; 
                border-radius: 50%;
                box-shadow: 0 0 10px ${userColor};
                display: flex;
                justify-content: center;
                align-items: center;
              ">
                <div style="width: 6px; height: 6px; background: #ffffff; border-radius: 50%;"></div>
              </div>`,
              iconSize: [16, 16],
              iconAnchor: [8, 8]
            });

            const marker = L.marker([lat, lng], { icon: otherIcon })
              .bindPopup(popupContent);

            // 瞬時に判別できるようホバーツールチップを追加
            marker.bindTooltip(username, {
              permanent: false,
              direction: 'top',
              opacity: 0.95,
              className: 'bg-dark text-white px-2 py-1 rounded shadow border-0 small fw-bold'
            });

            otherUsersMarkers[username] = marker;

            // 表示設定がONの場合のみ地図へ描画
            if (showOtherUsers) {
              marker.addTo(map);
            }
          }
        }
      } catch (err) {
        console.error(`調査員 ${username} の描画ループ内個別例外:`, err);
      }
    });

    // 消えたユーザーや非アクティブ（30分以上無効）になったユーザーのマーカーおよび軌跡ラインを削除
    Object.keys(otherUsersMarkers).forEach(username => {
      if (!activeUsernames.includes(username)) {
        if (otherUsersMarkers[username]) {
          if (map) {
            map.removeLayer(otherUsersMarkers[username]);
          }
          delete otherUsersMarkers[username];
        }
        if (otherUsersPolylines[username]) {
          if (map) {
            map.removeLayer(otherUsersPolylines[username]);
          }
          delete otherUsersPolylines[username];
        }
      }
    });

    // 他調査員の接続がない場合のフォールバック表示
    if (otherActiveCount === 0 && listContainer) {
      listContainer.innerHTML = `<div class="text-secondary small py-1 text-center">他調査員の接続なし</div>`;
    }

    // 最終同期インジケーターの更新
    if (realtimeDot) {
      realtimeDot.className = "status-dot active";
      realtimeDot.style.backgroundColor = "#10b981";
      realtimeDot.style.boxShadow = "0 0 8px #10b981";
    }
    if (lastSyncText) {
      const timeNow = new Date();
      lastSyncText.innerText = `最終同期: ${timeNow.toLocaleTimeString()}`;
    }
  }, (error) => {
    console.error("Firestoreリアルタイム監視エラー:", error);
    if (realtimeDot) {
      realtimeDot.className = "status-dot";
      realtimeDot.style.backgroundColor = "#ef4444";
      realtimeDot.style.boxShadow = "0 0 8px #ef4444";
    }
    if (lastSyncText) {
      lastSyncText.innerText = "エラー: 同期切断";
    }
  });
}

// ==========================================
// 8. SURVEY DATA MANAGEMENT & EDIT MODAL
// ==========================================

// 保存済み調査データ一覧モーダルを表示
async function showSurveyListModal() {
  const surveys = await db.surveys.toArray();
  const container = document.getElementById("survey-list-container");
  if (!container) return;
  container.innerHTML = "";

  if (surveys.length === 0) {
    container.innerHTML = `
      <div class="text-center py-5 text-muted">
        <i class="fa-solid fa-folder-open fa-3x mb-3 d-block"></i>
        <span>保存されている調査データはありません。</span>
      </div>
    `;
  } else {
    // 最新が上に来るように日時の降順でソート
    surveys.sort((a, b) => {
      const dateTimeA = `${a.date} ${a.time}`;
      const dateTimeB = `${b.date} ${b.time}`;
      return dateTimeB.localeCompare(dateTimeA);
    });

    surveys.forEach(survey => {
      const card = document.createElement("div");
      card.className = "card bg-white border-2 border-secondary-subtle p-3 hover-shadow cursor-pointer transition-all";
      card.style.cursor = "pointer";
      card.style.borderRadius = "12px";
      card.style.transition = "all 0.2s";

      // ホバー効果
      card.addEventListener("mouseenter", () => {
        card.style.borderColor = "var(--accent-color)";
        card.style.boxShadow = "0 4px 12px rgba(15,23,42,0.1)";
      });
      card.addEventListener("mouseleave", () => {
        card.style.borderColor = "rgba(15, 23, 42, 0.16)";
        card.style.boxShadow = "none";
      });

      // 写真サムネイル部分のHTML
      let photoHtml = "";
      if (survey.photo) {
        photoHtml = `
          <div style="flex-shrink: 0; width: 64px; height: 64px; border-radius: 8px; overflow: hidden; border: 1px solid #cbd5e1; margin-left: 12px;">
            <img src="${survey.photo}" style="width: 100%; height: 100%; object-fit: cover;">
          </div>
        `;
      }

      const pinColor = getMarkerColorByCategory(survey.category);
      card.innerHTML = `
        <div class="d-flex align-items-center justify-content-between">
          <div class="d-flex align-items-start gap-2 flex-grow-1" style="min-width: 0;">
            <div style="flex-grow: 1; min-width: 0;">
              <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
                <span class="badge fw-bold px-2 py-1" style="background-color: ${pinColor}; color: #ffffff; font-size: 0.85rem; border-radius: 8px;">
                  ${survey.category}
                </span>
                <span class="fw-bold text-dark fs-5" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${survey.species}
                </span>
              </div>
              <div class="text-secondary small fw-bold mb-1">
                <i class="fa-regular fa-clock me-1"></i> ${survey.date} ${survey.time.substring(0, 5)}
              </div>
              ${survey.detail ? `
                <div class="text-dark small text-truncate" style="max-width: 250px; font-weight: 500;">
                  ${survey.detail}
                </div>
              ` : ''}
              ${survey.interview && survey.interview !== "聞き取りなし" ? `
                <div class="text-primary small text-truncate" style="max-width: 250px; font-weight: 600;">
                  <i class="fa-regular fa-comments me-1"></i> ${survey.interview}
                </div>
              ` : ''}
            </div>
            ${photoHtml}
          </div>
          <div class="ps-2 text-secondary">
            <i class="fa-solid fa-chevron-right fs-4"></i>
          </div>
        </div>
      `;

      card.addEventListener("click", () => {
        // 一覧モーダルを閉じる
        const listModalEl = document.getElementById("modal-survey-list");
        const listModal = bootstrap.Modal.getInstance(listModalEl);
        if (listModal) listModal.hide();

        // 編集モーダルを開く
        setTimeout(() => {
          showSurveyEditModal(survey.id);
        }, 350); // アニメーションが衝突しないようにディレイ
      });

      container.appendChild(card);
    });
  }

  const listModal = new bootstrap.Modal(document.getElementById("modal-survey-list"));
  listModal.show();
}

// 調査データ編集モーダルを表示
async function showSurveyEditModal(surveyId) {
  const survey = await db.surveys.get(surveyId);
  if (!survey) {
    alert("該当するデータが見つかりませんでした。");
    return;
  }

  // 各フォームフィールドにロード
  document.getElementById("edit-survey-id").value = survey.id;
  document.getElementById("edit-spot-category").value = survey.category;
  document.getElementById("edit-species-name").value = survey.species;
  document.getElementById("edit-info-detail").value = survey.detail || "";
  document.getElementById("edit-interview-target").value = (survey.interview === "聞き取りなし") ? "" : survey.interview;
  document.getElementById("edit-lat").value = survey.lat;
  document.getElementById("edit-lng").value = survey.lng;

  // 地点分類のチップ選択状態を初期化
  const categoryGroup = document.getElementById("edit-category-button-group");
  if (categoryGroup) {
    categoryGroup.querySelectorAll(".btn-chip").forEach(btn => {
      if (btn.getAttribute("data-value") === survey.category) {
        btn.classList.add("selected");
      } else {
        btn.classList.remove("selected");
      }
    });
  }

  // 種名のチップ選択状態を初期化
  const speciesGroup = document.getElementById("edit-species-button-group");
  if (speciesGroup) {
    speciesGroup.querySelectorAll(".btn-chip").forEach(btn => {
      if (btn.getAttribute("data-value") === survey.species) {
        btn.classList.add("selected");
      } else {
        btn.classList.remove("selected");
      }
    });
  }

  // 写真の初期化
  const cameraIcon = document.getElementById("edit-camera-icon");
  const photoStatus = document.getElementById("edit-photo-status");
  const previewImg = document.getElementById("edit-photo-preview-img");
  const deleteBtnContainer = document.getElementById("edit-photo-delete-container");

  if (survey.photo) {
    editCompressedPhotoBase64 = survey.photo;
    cameraIcon.style.display = "none";
    photoStatus.innerText = "写真を変更するにはタップ";
    photoStatus.className = "text-secondary small";
    previewImg.src = survey.photo;
    previewImg.style.display = "block";
    deleteBtnContainer.style.display = "block";
  } else {
    editCompressedPhotoBase64 = "";
    cameraIcon.style.display = "block";
    photoStatus.innerText = "カメラを起動して写真を変更";
    photoStatus.className = "text-secondary small";
    previewImg.src = "#";
    previewImg.style.display = "none";
    deleteBtnContainer.style.display = "none";
  }

  // 編集モーダルを表示
  const editModal = new bootstrap.Modal(document.getElementById("modal-survey-edit"));
  editModal.show();
}

// 編集画面での写真アップロード・圧縮
function handleEditPhotoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const photoStatus = document.getElementById("edit-photo-status");
  const cameraIcon = document.getElementById("edit-camera-icon");
  const previewImg = document.getElementById("edit-photo-preview-img");
  const deleteBtnContainer = document.getElementById("edit-photo-delete-container");

  photoStatus.innerText = "写真を圧縮中...";
  photoStatus.className = "text-warning small";

  // 画像リサイズ＆圧縮
  compressImage(file, 1024, 200)
    .then(base64 => {
      editCompressedPhotoBase64 = base64;
      
      // UIプレビューの更新
      cameraIcon.style.display = "none";
      photoStatus.innerText = "変更完了（200KB以下に圧縮済み）";
      photoStatus.className = "text-success small fw-bold";
      
      previewImg.src = base64;
      previewImg.style.display = "block";
      deleteBtnContainer.style.display = "block";
    })
    .catch(err => {
      console.error("編集画像圧縮エラー:", err);
      photoStatus.innerText = "エラー: 圧縮に失敗しました";
      photoStatus.className = "text-danger small";
      alert("画像の読み込みまたは圧縮に失敗しました。");
    });
}

// 編集データを保存（データベース更新）
async function saveEditedSurvey() {
  const surveyId = document.getElementById("edit-survey-id").value;
  const category = document.getElementById("edit-spot-category").value;
  const speciesName = document.getElementById("edit-species-name").value.trim();
  const infoDetail = document.getElementById("edit-info-detail").value.trim();
  const interviewTarget = document.getElementById("edit-interview-target").value.trim() || "聞き取りなし";
  const lat = parseFloat(document.getElementById("edit-lat").value);
  const lng = parseFloat(document.getElementById("edit-lng").value);

  if (!category) {
    alert("地点分類を選択してください。");
    return;
  }
  if (!speciesName) {
    alert("種名を選択または入力してください。");
    return;
  }
  if (isNaN(lat) || isNaN(lng)) {
    alert("有効な経緯度を入力してください。");
    return;
  }

  const existing = await db.surveys.get(surveyId);
  if (!existing) {
    alert("編集対象のデータが存在しません。");
    return;
  }

  // レコード上書き
  const updatedSurvey = {
    ...existing,
    category: category,
    species: speciesName,
    detail: infoDetail,
    interview: interviewTarget,
    lat: lat,
    lng: lng,
    photo: editCompressedPhotoBase64
  };

  try {
    await db.surveys.put(updatedSurvey);
    
    // モーダルを閉じる
    const editModalEl = document.getElementById("modal-survey-edit");
    const editModal = bootstrap.Modal.getInstance(editModalEl);
    if (editModal) editModal.hide();

    // UI統計およびマップピンの再同期
    await initDBStats();
    await loadExistingSurveysOnMap();

    alert("調査データを修正・保存しました。");
  } catch (err) {
    console.error("IndexedDB 修正保存失敗:", err);
    alert("データベースの更新に失敗しました。");
  }
}

// 編集中の調査データを削除
async function deleteEditedSurvey() {
  const surveyId = document.getElementById("edit-survey-id").value;
  if (!surveyId) return;

  if (confirm("この調査データを完全に削除してもよろしいですか？")) {
    try {
      await db.surveys.delete(surveyId);
      
      // モーダルを閉じる
      const editModalEl = document.getElementById("modal-survey-edit");
      const editModal = bootstrap.Modal.getInstance(editModalEl);
      if (editModal) editModal.hide();

      // UI統計およびマップピンの再同期
      await initDBStats();
      await loadExistingSurveysOnMap();

      alert("調査データを削除しました。");
    } catch (err) {
      console.error("IndexedDB 削除失敗:", err);
      alert("データの削除に失敗しました。");
    }
  }
}


