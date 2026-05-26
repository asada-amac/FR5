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
      
      // すでにトラッキングタイマーが動作中（リロード時など）なら直ちに初回位置更新を行う
      if (trackingIntervalId && latestCoords.lat && latestCoords.lng) {
        updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng);
      }
    })
    .catch((error) => {
      console.error("Firebase 匿名ログイン失敗: ", error);
      alert("リアルタイム同期サーバーとの接続に失敗しました。オフライン機能は引き続き動作します。");
    });
}

// ==========================================
// 3. MAP & GPS FUNCTIONS
// ==========================================
function initMap() {
  if (map) return;

  // デフォルト位置 (日本中心) でマップ作成
  map = L.map("map", {
    zoomControl: false,
    maxZoom: 19
  }).setView([35.681236, 139.767125], 13);

  // L.control.zoomを右上等に配置
  L.control.zoom({ position: 'topleft' }).addTo(map);

  // 国土地理院 標準地図タイル
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
    minZoom: 2,
    maxZoom: 18
  }).addTo(map);

  // 軌跡描画用のレイヤーを作成
  trackPolyline = L.polyline([], {
    color: "#06b6d4", // シアン
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

  const myIcon = L.divIcon({
    className: 'custom-gps-icon',
    html: `<div style="
      width: 14px; 
      height: 14px; 
      background: #00e5ff; 
      border: 2px solid #ffffff; 
      border-radius: 50%;
      box-shadow: 0 0 10px #00e5ff;"></div>`,
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
      color: "#00e5ff",
      fillColor: "#00e5ff",
      fillOpacity: 0.1,
      weight: 1
    }).addTo(map);
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

  // 開始時の現在点を直ちに記録
  recordCurrentTrackPoint();

  // Firebase リアルタイム位置情報の即時更新 & 10分ごとの定期更新タイマー開始
  const username = sessionStorage.getItem("surveyor_name") || "匿名調査員";
  updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng);
  realtimeLocationIntervalId = setInterval(() => {
    const currentUsername = sessionStorage.getItem("surveyor_name") || "匿名調査員";
    if (latestCoords.lat && latestCoords.lng) {
      updateRealtimeLocation(currentUsername, latestCoords.lat, latestCoords.lng);
    }
  }, 10 * 60 * 1000); // 10分間隔

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
  const surveyDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
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

  if (!confirm(`端末内に保存されている調査データ ${surveyCount} 件と軌跡データ ${trackCount} 点をパッケージしてGoogleクラウドへ送信しますか？`)) {
    return;
  }

  // ローディングオーバーレイの表示
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");
  
  loadingOverlay.style.display = "flex";
  loadingText.innerText = "データを抽出してパッケージ中...";

  // データの取り出し
  const surveys = await db.surveys.toArray();
  const tracks = await db.tracks.orderBy("timestamp").toArray();

  let trackZipBase64 = "";
  let trackZipName = "";

  // トラック軌跡データが存在する場合、ブラウザ側でSHP (ZIP) ファイルを自動生成
  if (tracks.length > 0) {
    loadingText.innerText = "軌跡データをGIS (SHP) 形式にブラウザ内で高速変換中...";

    // 1. トラックデータをGeoJSON LineStringにコンバート
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
    trackZipName = `${yyyymmdd}_${hhmm}_${cleanUsername}_line.zip`;

    if (coordinates.length === 1) {
      geojson.features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: coordinates[0]
        },
        properties: {
          id: tracks[0].sessionId || "single_point",
          surveyor: username,
          time: startTime.toISOString()
        }
      });
    } else {
      geojson.features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coordinates
        },
        properties: {
          id: tracks[0].sessionId || "track_line",
          surveyor: username,
          start: startTime.toISOString(),
          end: new Date(tracks[tracks.length - 1].timestamp).toISOString()
        }
      });
    }

    const baseFileName = trackZipName.replace(".zip", "");
    const zipBlob = await shpwrite.zip(geojson, {
      compression: "STORE",
      outputType: "blob",
      filename: baseFileName,
      file: baseFileName,
      types: {
        // 大文字小文字や複数形のブレを完璧に網羅して上書きを強制適用
        line: baseFileName,
        Line: baseFileName,
        polyline: baseFileName,
        Polyline: baseFileName,
        linestring: baseFileName,
        LineString: baseFileName,
        point: baseFileName,
        Point: baseFileName,
        points: baseFileName,
        Points: baseFileName
      }
    });

    // Blob を Base64 文字列にエンコード
    trackZipBase64 = await blobToBase64(zipBlob);
  }

  loadingText.innerText = `Googleサーバーへ送信中 (調査 ${surveys.length}件 / GIS-SHP ZIP 1件)...`;

  const payload = {
    surveys: surveys,
    trackZip: trackZipBase64,
    trackZipName: trackZipName
  };

  try {
    // CORS対応でPOSTリクエストを送信
    const response = await fetch(GAS_URL, {
      method: "POST",
      mode: "cors",
      headers: {
        "Content-Type": "text/plain"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log("GASレスポンス:", result);

    if (result.status === "success") {
      loadingOverlay.style.display = "none";
      const shpMessage = trackZipName ? `\n・軌跡SHPファイル: Googleドライブへ保存完了 (${trackZipName})` : "";
      alert(`送信成功しました！\n\n・調査データ: ${result.insertedSurveys} 件 (スプレッドシート書き込み完了)${shpMessage}\n\n端末内の送信済みデータをリセットします。`);
      
      // 送信成功したため端末のIndexedDBを消去
      await db.surveys.clear();
      await db.tracks.clear();
      
      // UIの再読み込み
      if (trackPolyline) {
        trackPolyline.setLatLngs([]);
      }
      resetPhotoSelector();
      await initDBStats();
    } else {
      throw new Error(result.message || "サーバー側で書き込みエラーが発生しました。");
    }

  } catch (err) {
    console.error("GAS送信エラー:", err);
    loadingOverlay.style.display = "none";
    alert(`送信に失敗しました。\n接続環境を確認するか、時間をおいてやり直してください。\n\n詳細: ${err.message}`);
  }
}

// ==========================================
// 8. FIREBASE REALTIME SHARING FUNCTIONS
// ==========================================

// 自身の位置・軌跡情報をFirestoreに保存/上書きする
async function updateRealtimeLocation(username, lat, lng) {
  if (!lat || !lng) return;
  try {
    const sessionId = currentSessionId || sessionStorage.getItem("current_session_id") || "no_session";
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

    console.log("リアルタイム位置・軌跡をFirestoreに更新しました:", docId, pathData.length, "点");
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
    if (!listContainer) return;
    
    listContainer.innerHTML = "";
    let otherActiveCount = 0;
    const now = new Date();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const username = doc.id;

      // 自分以外のユーザーのみ処理対象とする
      if (username !== currentUsername && data.lat && data.lng) {
        otherActiveCount++;

        // 1. パネルの接続中リストへ追加
        const updateTime = data.timestamp ? data.timestamp.toDate() : new Date();
        const diffMin = Math.round((now - updateTime) / 60000);
        const timeStr = diffMin <= 0 ? "現在" : `${diffMin}分前`;

        const userRow = document.createElement("div");
        userRow.className = "d-flex justify-content-between align-items-center py-1 border-bottom border-light";
        userRow.style.borderColor = "rgba(15, 23, 42, 0.05) !important";
        userRow.innerHTML = `
          <span class="fw-bold text-dark text-truncate" style="max-width: 110px;" title="${username}">${username}</span>
          <span class="text-secondary text-nowrap" style="font-size: 0.68rem;">${timeStr} (${data.lat.toFixed(4)}, ${data.lng.toFixed(4)})</span>
        `;
        listContainer.appendChild(userRow);

        // 2. マップ上の軌跡（ライン）描画・更新
        if (map && data.path && Array.isArray(data.path)) {
          const latlngs = data.path.map(p => [p.lat, p.lng]);
          
          // 最新座標をパスの末尾に補完して最新表示を担保
          const existsInPath = latlngs.some(ll => Math.abs(ll[0] - data.lat) < 0.00001 && Math.abs(ll[1] - data.lng) < 0.00001);
          if (!existsInPath) {
            latlngs.push([data.lat, data.lng]);
          }

          if (otherUsersPolylines[username]) {
            otherUsersPolylines[username].setLatLngs(latlngs);
          } else {
            // 高コントラストな紫色の破線で美しい軌跡を表示
            otherUsersPolylines[username] = L.polyline(latlngs, {
              color: "#a855f7", // 紫色
              weight: 3,
              opacity: 0.85,
              dashArray: "4, 6", // 美しい破線
              lineJoin: "round"
            });
            
            if (showOtherUsers) {
              otherUsersPolylines[username].addTo(map);
            }
          }
        }

        // 3. マップ上の最新位置ピン描画・更新
        if (map) {
          const popupContent = `
            <div style="font-size: 0.85rem; line-height: 1.4;">
              <span class="badge mb-1 text-white" style="background-color: #a855f7; font-weight: 700;">他調査員 (リアルタイム)</span><br>
              <strong>調査者:</strong> ${username}<br>
              <strong>最新位置:</strong> ${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}<br>
              <strong>記録点数:</strong> ${data.path ? data.path.length : 0} 点<br>
              <span class="small text-secondary">更新: ${updateTime.toLocaleTimeString()} (${timeStr})</span>
            </div>
          `;

          if (otherUsersMarkers[username]) {
            // マップにピンがあれば移動させてポップアップを更新
            otherUsersMarkers[username].setLatLng([data.lat, data.lng]);
            otherUsersMarkers[username].setPopupContent(popupContent);
          } else {
            // 新規ピン作成 (高コントラストで美しい紫色の円ピン)
            const pinColor = "#a855f7";
            const otherIcon = L.divIcon({
              className: `custom-other-gps-${username.replace(/\s+/g, '_')}`,
              html: `<div style="
                width: 16px; 
                height: 16px; 
                background: ${pinColor}; 
                border: 2px solid #ffffff; 
                border-radius: 50%;
                box-shadow: 0 0 10px ${pinColor};
                display: flex;
                justify-content: center;
                align-items: center;
              ">
                <div style="width: 6px; height: 6px; background: #ffffff; border-radius: 50%;"></div>
              </div>`,
              iconSize: [16, 16],
              iconAnchor: [8, 8]
            });

            const marker = L.marker([data.lat, data.lng], { icon: otherIcon })
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
      }
    });

    // 消えたユーザー（Firestoreからドキュメントがなくなった等）のマーカーおよび軌跡ライン削除
    const currentDocIds = snapshot.docs.map(d => d.id);
    Object.keys(otherUsersMarkers).forEach(username => {
      if (!currentDocIds.includes(username)) {
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
    if (otherActiveCount === 0) {
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


