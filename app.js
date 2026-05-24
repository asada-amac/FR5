// ==========================================
// 1. CONSTANTS & INITIALIZATION
// ==========================================
const GAS_URL = "https://script.google.com/macros/s/AKfycbx_OirHKvZF_zeee6ZqgwiKR4yRqRj_jnHH5KbwJcRWe6i3iPppxGFlm5lYQccSG_rW/exec";

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

  // ログアウトボタン
  document.getElementById("btn-change-user").addEventListener("click", () => {
    if (confirm("ログアウトしますか？（保存済みの調査データは削除されません）")) {
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

  // SHPファイルダウンロードボタン
  document.getElementById("btn-download-shp").addEventListener("click", downloadShpFile);
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
  document.getElementById("badge-username").innerText = username;
  document.getElementById("config-username").innerText = username;

  // 地図の初期化
  initMap();

  // Geolocationの監視を開始
  startGpsMonitoring();
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

  // 標準のカラーマップタイル (OpenStreetMap)
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
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
  sessionStorage.setItem("current_session_id", currentSessionId);

  // UI状態の更新
  document.getElementById("btn-start-track").disabled = true;
  document.getElementById("btn-stop-track").disabled = false;
  document.getElementById("track-stat").innerText = "調査中 (1分間隔で記録)";
  document.getElementById("track-stat").className = "text-success fw-bold";

  // 開始時の現在点を直ちに記録
  recordCurrentTrackPoint();

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
  document.getElementById("track-count").innerText = `${allTracks.length} 点記録`;
  document.getElementById("track-count-display").innerText = allTracks.length;

  // マップのラインを引く
  const latlngs = allTracks.map(t => [t.lat, t.lng]);
  trackPolyline.setLatLngs(latlngs);
}

// トラッキングの一時停止
function stopTracking() {
  if (trackingIntervalId) {
    clearInterval(trackingIntervalId);
    trackingIntervalId = null;
  }
  if (watchPositionId) {
    navigator.geolocation.clearWatch(watchPositionId);
    watchPositionId = null;
  }

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

  if (!confirm(`端末内に保存されている調査データ ${surveyCount} 件と軌跡データ ${trackCount} 点をGoogleスプレッドシートへ送信しますか？`)) {
    return;
  }

  // ローディングオーバーレイの表示
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");
  
  loadingOverlay.style.display = "flex";
  loadingText.innerText = "データを抽出してパッケージ中...";

  // データの取り出し
  const surveys = await db.surveys.toArray();
  const tracks = await db.tracks.toArray();

  loadingText.innerText = `Googleサーバーへ送信中 (調査 ${surveys.length}件 / 軌跡 ${tracks.length}点)...`;

  const payload = {
    surveys: surveys,
    tracks: tracks
  };

  try {
    // CORS対応でPOSTリクエストを送信
    const response = await fetch(GAS_URL, {
      method: "POST",
      mode: "cors",
      headers: {
        "Content-Type": "text/plain" // GASのCORS制約を回避するためプレーンテキストで送るのが無難
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log("GASレスポンス:", result);

    if (result.status === "success") {
      loadingOverlay.style.display = "none";
      alert(`送信成功しました！\n\n・調査データ: ${result.insertedSurveys} 件\n・軌跡ポイント: ${result.insertedTracks} 点\n\n端末内の送信済みデータをリセットします。`);
      
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
// 8. SHP FILE GENERATION (shp-write)
// ==========================================
async function downloadShpFile() {
  const tracks = await db.tracks.orderBy("timestamp").toArray();
  
  if (tracks.length === 0) {
    alert("出力するトラック（軌跡）データがありません。");
    return;
  }

  const loadingOverlay = document.getElementById("loading-overlay");
  loadingOverlay.style.display = "flex";
  document.getElementById("loading-text").innerText = "SHPファイルをブラウザ内で生成中...";

  try {
    // 1. トラックデータをGeoJSON LineStringにコンバート
    // 緯度・経度の配列を作成 (lng, lat の順に格納)
    const coordinates = tracks.map(t => [t.lng, t.lat]);

    // GeoJSONデータの定義
    const geojson = {
      type: "FeatureCollection",
      features: []
    };

    // 軌跡が点（単数）の場合は Point で出力し、複数の場合は LineString とする
    if (coordinates.length === 1) {
      geojson.features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: coordinates[0]
        },
        properties: {
          id: tracks[0].sessionId || "single_point",
          surveyor: tracks[0].username,
          time: new Date(tracks[0].timestamp).toISOString()
        }
      });
    } else {
      // 軌跡全体を1本のラインとして出力
      geojson.features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coordinates
        },
        properties: {
          id: tracks[0].sessionId || "track_line",
          surveyor: tracks[0].username,
          start: new Date(tracks[0].timestamp).toISOString(),
          end: new Date(tracks[tracks.length - 1].timestamp).toISOString()
        }
      });
    }

    // ファイル名（ベース名）の動的組み立て: 調査日（YYYYMMDD)_調査開始時刻(HHMM)_調査者名_line
    const startTime = new Date(tracks[0].timestamp);
    const yyyy = startTime.getFullYear();
    const mm = String(startTime.getMonth() + 1).padStart(2, '0');
    const dd = String(startTime.getDate()).padStart(2, '0');
    const hh = String(startTime.getHours()).padStart(2, '0');
    const min = String(startTime.getMinutes()).padStart(2, '0');
    
    const yyyymmdd = `${yyyy}${mm}${dd}`;
    const hhmm = `${hh}${min}`;
    const username = tracks[0].username || "匿名調査員";
    
    // ファイル名として使用できないOS禁止文字を安全に置換
    const cleanUsername = username.replace(/[\\/:*?"<>|]/g, "_");
    const baseFileName = `${yyyymmdd}_${hhmm}_${cleanUsername}_line`;

    // 2. shp-write ライブラリを使い、ZIP化されたSHPデータを生成
    // 最新の shp-write では、内部で JSZip v3 が使用されているため、.zip() は Promise を返します。
    // filename / file オプションに baseFileName を指定することで、ZIP内の各ファイル（.shp, .shx, .dbf, .prj）の名称が置き換わります。
    const zipBlob = await shpwrite.zip(geojson, {
      compression: "STORE",
      outputType: "blob",
      filename: baseFileName,
      file: baseFileName
    });

    // 3. ブラウザから即ダウンロード
    const downloadUrl = URL.createObjectURL(zipBlob);
    
    // ダウンロード要素の作成とトリガー
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = `${baseFileName}.zip`;
    document.body.appendChild(a);
    a.click();
    
    // 後処理
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
    }, 100);

    loadingOverlay.style.display = "none";
    alert("SHPファイル一式 (ZIP) のブラウザ生成とダウンロードが完了しました！");

  } catch (err) {
    console.error("SHP出力エラー:", err);
    loadingOverlay.style.display = "none";
    alert(`SHPファイルの生成中にエラーが発生しました。\n詳細: ${err.message}`);
  }
}
