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
let latestCoords = { lat: null, lng: null, accuracy: null };

let trackingIntervalId = null;
let watchPositionId = null;
let currentSessionId = null;

// Firebaseリアルタイム共有用のグローバル変数
let realtimeLocationIntervalId = null; // 10分ごとのFirestore更新タイマーID
let otherUsersMarkers = {};            // 他の調査員のマーカー管理 (username -> L.marker)
let otherUsersPolylines = {};          // 他の調査員の軌跡ライン管理 (username -> L.polyline)
let showOtherUsers = true;             // 他ユーザーの表示切替フラグ

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
      const todayStr = new Date().toISOString().split("T")[0];
      localStorage.setItem("surveyor_name", nameInput);
      localStorage.setItem("surveyor_login_date", todayStr);
      document.getElementById("login-overlay").style.display = "none";
      initApp(nameInput);
    }
  });

  // ログアウトボタン (自身のリアルタイム位置を確実に消去してからログアウトするよう拡張)
  document.getElementById("btn-change-user").addEventListener("click", async () => {
    if (confirm("ログアウトしますか？（保存済みの調査データは削除されません）")) {
      const username = localStorage.getItem("surveyor_name");
      if (username) {
        try {
          await dbFirestore.collection("active_users").doc(username).delete();
          console.log("Firestoreから自身のリアルタイム位置を削除しました");
        } catch (e) {
          console.error("ログアウト時のFirestore削除失敗:", e);
        }
      }
      localStorage.removeItem("surveyor_name");
      localStorage.removeItem("surveyor_login_date");
      localStorage.removeItem("is_tracking_active");
      localStorage.removeItem("current_session_id");
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
  document.getElementById("btn-start-track").addEventListener("click", startTracking);
  document.getElementById("btn-stop-track").addEventListener("click", stopTracking);

  // 写真選択・撮影のトリガー
  const photoTrigger = document.getElementById("photo-trigger");
  const cameraInput = document.getElementById("camera-input");
  
  photoTrigger.addEventListener("click", () => cameraInput.click());
  cameraInput.addEventListener("change", handlePhotoUpload);

  // 新規調査フォームの更新ボタン
  document.getElementById("btn-refresh-form-coords").addEventListener("click", () => {
    updateFormCoordinates();
  });

  // 調査フォーム送信
  document.getElementById("survey-form").addEventListener("submit", handleSurveySubmit);

  // GAS一括送信ボタン
  document.getElementById("btn-submit-gas").addEventListener("click", submitAllDataToGAS);

  // 他調査員の表示トグルボタン
  const toggleOthersBtn = document.getElementById("btn-toggle-others");
  if (toggleOthersBtn) {
    toggleOthersBtn.addEventListener("click", () => {
      showOtherUsers = !showOtherUsers;
      if (showOtherUsers) {
        toggleOthersBtn.innerText = "表示ON";
        toggleOthersBtn.className = "btn btn-xs btn-primary p-0 px-2 fw-bold text-white";
        // ピンの再表示
        Object.keys(otherUsersMarkers).forEach(username => {
          if (otherUsersMarkers[username] && map) {
            otherUsersMarkers[username].addTo(map);
          }
        });
        // 軌跡ラインの再表示
        Object.keys(otherUsersPolylines).forEach(username => {
          if (otherUsersPolylines[username] && map) {
            otherUsersPolylines[username].addTo(map);
          }
        });
      } else {
        toggleOthersBtn.innerText = "表示OFF";
        toggleOthersBtn.className = "btn btn-xs btn-outline-secondary p-0 px-2 fw-bold text-white";
        // ピンの非表示
        Object.keys(otherUsersMarkers).forEach(username => {
          if (otherUsersMarkers[username] && map) {
            map.removeLayer(otherUsersMarkers[username]);
          }
        });
        // 軌跡ラインの非表示
        Object.keys(otherUsersPolylines).forEach(username => {
          if (otherUsersPolylines[username] && map) {
            map.removeLayer(otherUsersPolylines[username]);
          }
        });
      }
    });
  }

  // アプリがフォアグラウンドに戻った（スリープ解除や別アプリから戻った）時の処理
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      console.log("アプリがフォアグラウンドに戻りました。状態を確認します。");
      const username = localStorage.getItem("surveyor_name");
      const isTracking = localStorage.getItem("is_tracking_active") === "true";
      
      if (username && isTracking) {
        if (!trackingIntervalId) {
          // 何らかの理由（OSによるプロセス休止等）でタイマーが停止していた場合は復旧
          resumeTracking();
        } else {
          // スリープ中のデータ飛び対策として即時記録 & Firestore同期を実行
          recordCurrentTrackPoint();
        }
      }
    }
  });

  // ページを閉じる・遷移する際、非同期で自身のリアルタイム位置を削除する後始末
  window.addEventListener("beforeunload", () => {
    const isTracking = localStorage.getItem("is_tracking_active") === "true";
    const username = localStorage.getItem("surveyor_name");
    // トラッキング稼働中でない場合のみ、アクティブリストから削除
    if (username && !isTracking) {
      dbFirestore.collection("active_users").doc(username).delete();
    }
  });


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

// ログイン確認 (本日分のログイン維持に対応)
function checkLogin() {
  const username = localStorage.getItem("surveyor_name");
  const loginDate = localStorage.getItem("surveyor_login_date");
  const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  if (username && loginDate === todayStr) {
    document.getElementById("login-overlay").style.display = "none";
    return username;
  } else {
    // 期限切れ、または未ログインならクリア
    localStorage.removeItem("surveyor_name");
    localStorage.removeItem("surveyor_login_date");
    localStorage.removeItem("is_tracking_active");
    localStorage.removeItem("current_session_id");
    document.getElementById("login-overlay").style.display = "flex";
    return null;
  }
}

// ログイン後のアプリ初期化
function initApp(username) {
  document.getElementById("badge-username").innerText = username;
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

      // 以前トラッキング中だった場合は自動復旧
      const wasTracking = localStorage.getItem("is_tracking_active") === "true";
      if (wasTracking) {
        resumeTracking();
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

  // 保存済みの軌跡があれば初期表示する
  loadExistingTracksOnMap();
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
function startGpsMonitoring() {
  if (!navigator.geolocation) {
    updateGpsStatus(false, "GPS非対応端末");
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
      
      updateGpsStatus(true, `精度: ±${Math.round(accuracy)}m`);
      updateFormCoordinates();

      // マップの現在地マーク更新
      updateMapMarker(lat, lng, accuracy);
    },
    (error) => {
      console.warn("GPSエラー:", error.message);
      updateGpsStatus(false, "位置取得失敗");
    },
    gpsOptions
  );
}

// GPSステータスUIの更新
function updateGpsStatus(isActive, message) {
  const dot = document.getElementById("gps-status-dot");
  const text = document.getElementById("gps-status-text");

  if (isActive) {
    dot.className = "status-dot active";
    text.innerText = message;
    text.className = "text-light";
  } else {
    dot.className = "status-dot";
    text.innerText = message;
    text.className = "text-danger";
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
  localStorage.setItem("current_session_id", currentSessionId);
  localStorage.setItem("is_tracking_active", "true");

  // UI状態の更新
  document.getElementById("btn-start-track").disabled = true;
  document.getElementById("btn-stop-track").disabled = false;
  document.getElementById("track-stat").innerText = "調査中 (1分間隔で記録)";
  document.getElementById("track-stat").className = "text-success fw-bold";

  // 開始時の現在点を直ちに記録
  recordCurrentTrackPoint();

  // Firebase リアルタイム位置情報の即時更新 & 10分ごとの定期更新タイマー開始
  const username = localStorage.getItem("surveyor_name") || "匿名調査員";
  updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng);
  realtimeLocationIntervalId = setInterval(() => {
    const currentUsername = localStorage.getItem("surveyor_name") || "匿名調査員";
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
    const username = localStorage.getItem("surveyor_name") || "匿名調査員";

    await db.tracks.add({
      sessionId: currentSessionId,
      username: username,
      timestamp: now,
      lat: lat,
      lng: lng
    });

    lastRecordedTime = now;
    updateTrackUiAndMap();
    
    // Firestoreのリアルタイム位置 & 本日の軌跡を同期
    updateRealtimeLocation(username, lat, lng);
  }
}

// 1分ごとの定期記録実行コア
async function recordCurrentTrackPoint() {
  // GPSの最新値がある場合のみ記録
  if (latestCoords.lat && latestCoords.lng) {
    const now = Date.now();
    const username = localStorage.getItem("surveyor_name") || "匿名調査員";

    await db.tracks.add({
      sessionId: currentSessionId,
      username: username,
      timestamp: now,
      lat: latestCoords.lat,
      lng: latestCoords.lng
    });

    lastRecordedTime = now;
    updateTrackUiAndMap();
    
    // Firestoreのリアルタイム位置 & 本日の軌跡を同期
    updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng);
  }
}

// トラックUIとマップ描画のリアルタイム同期
async function updateTrackUiAndMap() {
  const allTracks = await db.tracks.orderBy("timestamp").toArray();
  document.getElementById("track-count").innerText = `${allTracks.length} 点記録`;
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

  localStorage.setItem("is_tracking_active", "false");

  // 調査一時停止時に自身のリアルタイム位置情報をFirestoreから確実に削除
  await removeRealtimeLocation();

  document.getElementById("btn-start-track").disabled = false;
  document.getElementById("btn-stop-track").disabled = true;
  document.getElementById("track-stat").innerText = "一時停止中";
  document.getElementById("track-stat").className = "text-warning";

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
  const surveyorName = localStorage.getItem("surveyor_name") || "匿名調査員";
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
    
    // UI同期
    await initDBStats();
    
    // 地図にもピンを追加 (即座の確認用)
    if (map) {
      const pinColor = getMarkerColorByCategory(category);
      const surveyPin = L.circleMarker([latestCoords.lat, latestCoords.lng], {
        radius: 8,
        fillColor: pinColor,
        color: "#ffffff",
        weight: 1.5,
        fillOpacity: 0.9
      }).addTo(map);
      
      surveyPin.bindPopup(`<strong>[${category}] ${speciesName}</strong><br><span class="small text-secondary">${surveyTime} 保存完了</span>`);
    }

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

// 分類別のピンカラー選定
function getMarkerColorByCategory(cat) {
  switch (cat) {
    case "哺乳類": return "#ef4444";
    case "鳥類": return "#3b82f6";
    case "両生・爬虫類": return "#10b981";
    case "昆虫類": return "#f59e0b";
    case "植物・植生": return "#84cc16";
    case "人工構造物": return "#64748b";
    case "自然地形": return "#06b6d4";
    default: return "#a855f7";
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

// 自身の位置情報をFirestoreに保存/上書きする
async function updateRealtimeLocation(username, lat, lng) {
  if (!lat || !lng) return;
  try {
    const sessionId = currentSessionId || sessionStorage.getItem("current_session_id") || "no_session";
    const docId = username;

    // 本日分の軌跡データを IndexedDB から抽出して Firestore に同期する
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayTracks = await db.tracks
      .where("timestamp").aboveOrEqual(todayStart.getTime())
      .toArray();
    
    const pathPoints = todayTracks.map(t => ({
      lat: t.lat,
      lng: t.lng,
      timestamp: t.timestamp
    }));

    await dbFirestore.collection("active_users").doc(docId).set({
      username: username,
      lat: lat,
      lng: lng,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      sessionId: sessionId,
      path: pathPoints
    }, { merge: true });

    console.log("リアルタイム位置・軌跡をFirestoreに同期しました:", docId, lat, lng, `${pathPoints.length}点`);
  } catch (error) {
    console.error("Firestoreへの位置・軌跡更新失敗:", error);
  }
}

// 自身の位置情報をFirestoreから削除する
async function removeRealtimeLocation() {
  const username = localStorage.getItem("surveyor_name");
  if (!username) return;
  try {
    await dbFirestore.collection("active_users").doc(username).delete();
    console.log("Firestoreから自身のリアルタイム位置を削除しました:", username);
  } catch (error) {
    console.error("Firestoreからの位置削除に失敗しました:", error);
  }
}

// 他の調査員の現在位置をFirestoreからリッスンする
function listenToOtherUsers() {
  const currentUsername = localStorage.getItem("surveyor_name") || "匿名調査員";
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

        // 2. マップ上のマーカー・本日分軌跡ライン描画・更新
        if (map) {
          // 2-a. マーカー（現在地ピン）の更新
          const popupContent = `
            <div style="font-size: 0.85rem; line-height: 1.4;">
              <span class="badge mb-1 text-white" style="background-color: #a855f7; font-weight: 700;">他調査員 (リアルタイム)</span><br>
              <strong>調査者:</strong> ${username}<br>
              <strong>座標:</strong> ${data.lat.toFixed(6)}, ${data.lng.toFixed(6)}<br>
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

          // 2-b. 本日分軌跡ラインの更新・描画
          const pathPoints = data.path || [];
          // タイムスタンプ順に昇順ソートして線を正しく引く
          pathPoints.sort((a, b) => a.timestamp - b.timestamp);
          const latlngs = pathPoints.map(p => [p.lat, p.lng]);
          
          if (otherUsersPolylines[username]) {
            otherUsersPolylines[username].setLatLngs(latlngs);
          } else {
            // 明るく柔らかいパープルの破線で美しく描画
            const polylineColor = "#c084fc";
            const polyline = L.polyline(latlngs, {
              color: polylineColor,
              weight: 3,
              opacity: 0.75,
              dashArray: "4, 6", // 自身の軌跡と視覚的に区別するため破線に
              lineJoin: "round"
            });
            
            otherUsersPolylines[username] = polyline;
            
            if (showOtherUsers) {
              polyline.addTo(map);
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

// トラッキングセッションの復旧
function resumeTracking() {
  if (trackingIntervalId) return;

  // 既存のセッションIDを取得
  currentSessionId = localStorage.getItem("current_session_id");
  if (!currentSessionId) {
    currentSessionId = crypto.randomUUID();
    localStorage.setItem("current_session_id", currentSessionId);
  }

  // UI状態の更新
  document.getElementById("btn-start-track").disabled = true;
  document.getElementById("btn-stop-track").disabled = false;
  document.getElementById("track-stat").innerText = "調査中 (自動復旧・1分間隔記録)";
  document.getElementById("track-stat").className = "text-success fw-bold";

  // 定期記録の開始
  trackingIntervalId = setInterval(() => {
    recordCurrentTrackPoint();
  }, 60000);

  // バックグラウンド補強の watchPosition 開始
  watchPositionId = navigator.geolocation.watchPosition(
    (pos) => {
      checkAndRecordAsync(pos);
    },
    null,
    { enableHighAccuracy: true }
  );

  // Firestoreへのリアルタイム位置情報の同期開始
  const username = localStorage.getItem("surveyor_name") || "匿名調査員";
  if (latestCoords.lat && latestCoords.lng) {
    updateRealtimeLocation(username, latestCoords.lat, latestCoords.lng);
  }
  realtimeLocationIntervalId = setInterval(() => {
    const currentUsername = localStorage.getItem("surveyor_name") || "匿名調査員";
    if (latestCoords.lat && latestCoords.lng) {
      updateRealtimeLocation(currentUsername, latestCoords.lat, latestCoords.lng);
    }
  }, 10 * 60 * 1000);

  console.log("トラッキングセッションを自動復旧しました:", currentSessionId);
}


