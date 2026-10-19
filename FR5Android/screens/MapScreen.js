import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { FontAwesome5 } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';

import { startLocationTracking, stopLocationTracking } from '../gps';
import { getAllTracks } from '../db';
import { loginAnonymously, listenToOtherUsers, removeRealtimeLocation, updateRealtimeLocation } from '../firebase';

// 調査員名から一意のカラーコードを決定する
function getUserColor(username) {
  if (!username) return "#a855f7";
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 80%, 45%)`;
}

// GeoJSON（JSON）アセットファイルの安全な読み込み（存在しない場合はnull）
let agriFieldsData = null; // 田畑の地図表示は削除されました
let villageBoundaryData = null;
try {
  villageBoundaryData = require('../assets/village_boundary.json');
} catch (e) {
  console.log('[GeoJSON] assets/village_boundary.json が配置されていません (省略します)');
}


// WebViewに読み込ませるLeaflet HTMLテンプレート
const LEAFLET_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      background-color: #f1f5f9;
    }
    .custom-gps-icon-inner {
      width: 14px;
      height: 14px;
      border: 2px solid #ffffff;
      border-radius: 50%;
      box-shadow: 0 0 10px rgba(0,0,0,0.5);
    }
    .leaflet-tooltip.village-tooltip {
      background-color: transparent;
      border: none;
      box-shadow: none;
      color: #ea580c;
      font-weight: 800;
      font-size: 16px;
      text-shadow: 
        -1.5px -1.5px 0 #ffffff,  
         1.5px -1.5px 0 #ffffff,
        -1.5px  1.5px 0 #ffffff,
         1.5px  1.5px 0 #ffffff;
      padding: 0;
      white-space: nowrap;
    }
    /* ヘッダー(70px)との重なりを防ぐためLeafletのトップコントロール位置を下げる */
    .leaflet-top {
      margin-top: 80px;
    }
    /* スマホ用にボタンサイズを大きく(44px)し、アイコン色を設定 */
    .leaflet-bar a {
      background-color: #ffffff !important;
      color: #0f172a !important;
      width: 44px !important;
      height: 44px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
    /* Cache Card Styles */
    .cache-card {
      position: absolute;
      top: 15px;
      left: 70px;
      z-index: 1000;
      width: 250px;
      background: #ffffff;
      border: 2px solid rgba(15, 23, 42, 0.16);
      border-radius: 12px;
      padding: 12px;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.2);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
      display: none;
    }
    .cache-toast-banner {
      position: absolute;
      bottom: 24px;
      left: 16px;
      right: 16px;
      background-color: rgba(15, 23, 42, 0.9);
      color: #ffffff;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 800;
      text-align: center;
      z-index: 2000;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.25);
      display: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .cache-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .cache-card-title {
      font-size: 14px;
      font-weight: 800;
      color: #1e40af;
      display: flex;
      align-items: center;
      gap: 5px;
      margin: 0;
    }
    .cache-close-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
    }
    .cache-card-desc {
      font-size: 11px;
      color: #64748b;
      line-height: 1.4;
      margin: 0 0 10px 0;
    }
    .cache-card-info {
      font-size: 12px;
      margin-bottom: 8px;
      line-height: 1.5;
    }
    .cache-progress-container {
      display: none;
      margin-bottom: 10px;
    }
    .cache-progress-bar-bg {
      height: 10px;
      background: #e2e8f0;
      border-radius: 5px;
      overflow: hidden;
    }
    .cache-progress-bar-fill {
      height: 100%;
      background: #059669;
      width: 0%;
    }
    .cache-progress-text {
      text-align: center;
      font-size: 10px;
      color: #64748b;
      margin-top: 4px;
    }
    .cache-download-btn {
      width: 100%;
      background: linear-gradient(135deg, #1e40af 0%, #3b82f6 100%);
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .cache-download-btn:disabled {
      background: #cbd5e1;
      color: #64748b;
      cursor: not-allowed;
    }
  </style>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body>
  <div id="map"></div>
  <div id="cache-toast-banner" class="cache-toast-banner">調査地の範囲に移動し、地図タイルの読み込みをしてください</div>
  <script>
    // WebView内のエラーを検知してMetroコンソールに送るデバッグ用グローバルハンドラ
    window.onerror = function(message, source, lineno, colno, error) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'log',
          message: 'WebView JS Error: ' + message + ' (line ' + lineno + ', col ' + colno + ')'
        }));
      }
      return false;
    };

    L.TileLayer.OfflineCache = L.TileLayer.extend({
      createTile: function(coords, done) {
        var tile = document.createElement('img');
        var url = this.getTileUrl(coords);
        var cacheName = 'gsi-tile-cache';
        
        L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
        L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
        
        if (window.caches) {
          window.caches.open(cacheName).then(function(cache) {
            cache.match(url).then(function(response) {
              if (response) {
                response.blob().then(function(blob) {
                  var objectURL = URL.createObjectURL(blob);
                  tile.addEventListener('load', function() { URL.revokeObjectURL(objectURL); }, { once: true });
                  tile.addEventListener('error', function() { URL.revokeObjectURL(objectURL); }, { once: true });
                  tile.src = objectURL;
                }).catch(function(err) {
                  console.warn("Blob conversion error, falling back to network:", err);
                  tile.src = url;
                });
              } else {
                if (navigator.onLine === false) {
                  tile.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
                  setTimeout(function() { done(null, tile); }, 0);
                  return;
                }
                
                var controller = new AbortController();
                var timeoutId = setTimeout(function() { controller.abort(); }, 3000);
                
                fetch(url, { signal: controller.signal })
                  .then(function(res) {
                    clearTimeout(timeoutId);
                    if (res.ok) {
                      var resClone = res.clone();
                      cache.put(url, resClone);
                      return res.blob();
                    }
                    throw new Error("Tile fetch failed");
                  })
                  .then(function(blob) {
                    var objectURL = URL.createObjectURL(blob);
                    tile.addEventListener('load', function() { URL.revokeObjectURL(objectURL); }, { once: true });
                    tile.addEventListener('error', function() { URL.revokeObjectURL(objectURL); }, { once: true });
                    tile.src = objectURL;
                  })
                  .catch(function(err) {
                    clearTimeout(timeoutId);
                    if (err.name === 'AbortError') {
                      console.warn("Tile fetch aborted (timeout):", url);
                    }
                    tile.src = url;
                  });
              }
            });
          }).catch(function(err) {
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
        var container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        var button = L.DomUtil.create('a', '', container);
        button.href = '#';
        button.title = '現在の表示エリアの地図を事前保存';
        button.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#0f172a" style="display:block;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>';
        button.style.width = '44px';
        button.style.height = '44px';
        button.style.display = 'flex';
        button.style.alignItems = 'center';
        button.style.justifyContent = 'center';
        button.style.cursor = 'pointer';
        
        L.DomEvent.disableClickPropagation(container);
        
        var mapParent = map.getContainer();
        var card = L.DomUtil.create('div', 'cache-card', mapParent);
        
        card.innerHTML = 
          '<div class="cache-card-header">' +
            '<h6 class="cache-card-title">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="#1e40af" style="vertical-align:middle;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>' +
              'オフライン地図保存' +
            '</h6>' +
            '<button type="button" class="cache-close-btn">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="#64748b"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>' +
            '</button>' +
          '</div>' +
          '<p class="cache-card-desc">' +
            '現在表示されている範囲の地図を保存します。電波のある環境で実行してください。' +
          '</p>' +
          '<div class="cache-card-info">' +
            '<strong>保存ズーム:</strong> <span id="cache-zoom-range">15 〜 18</span><br>' +
            '<strong>予想タイル数:</strong> <span id="cache-tile-count">計算中...</span><br>' +
            '<strong>端末内の保存済タイル:</strong> <span id="cache-stored-count">確認中...</span>' +
          '</div>' +
          '<div id="cache-progress-container" class="cache-progress-container">' +
            '<div class="cache-progress-bar-bg">' +
              '<div id="cache-progress-bar" class="cache-progress-bar-fill"></div>' +
            '</div>' +
            '<div id="cache-progress-text" class="cache-progress-text">0 / 0 タイル (0%)</div>' +
          '</div>' +
          '<button type="button" class="cache-download-btn" id="btn-start-cache-download">ダウンロード開始</button>';
        
        var closeBtn = card.querySelector('.cache-close-btn');
        var startBtn = card.querySelector('#btn-start-cache-download');
        var tileCountSpan = card.querySelector('#cache-tile-count');
        var storedCountSpan = card.querySelector('#cache-stored-count');
        var zoomRangeSpan = card.querySelector('#cache-zoom-range');
        var progressContainer = card.querySelector('#cache-progress-container');
        var progressBar = card.querySelector('#cache-progress-bar');
        var progressText = card.querySelector('#cache-progress-text');
        
        var isDownloading = false;
        var abortController = null;

        function refreshStoredCount() {
          if (window.caches && storedCountSpan) {
            window.caches.open('gsi-tile-cache').then(function(cache) {
              return cache.keys();
            }).then(function(keys) {
              storedCountSpan.innerText = keys.length + ' 枚';
            }).catch(function() {
              storedCountSpan.innerText = '0 枚';
            });
          }
        }
        
        L.DomEvent.on(button, 'click', function(e) {
          L.DomEvent.preventDefault(e);
          var banner = document.getElementById('cache-toast-banner');
          
          // 1回のタップで現在地追従を自動解除し、即座に事前保存カードを開閉する
          isLocationFixed = false;
          if (card.style.display === 'none' || card.style.display === '') {
            card.style.display = 'block';
            if (banner) banner.style.display = 'block';
            updateTileEstimate();
            refreshStoredCount();
          } else {
            closeCard();
          }
        });
        
        L.DomEvent.on(closeBtn, 'click', closeCard);
        
        function closeCard() {
          var banner = document.getElementById('cache-toast-banner');
          if (isDownloading) {
            if (confirm("ダウンロードを中止しますか？")) {
              if (abortController) abortController.abort();
              resetUI();
              card.style.display = 'none';
              if (banner) banner.style.display = 'none';
            }
          } else {
            card.style.display = 'none';
            if (banner) banner.style.display = 'none';
          }
        }
        
        function resetUI() {
          isDownloading = false;
          progressContainer.style.display = 'none';
          progressBar.style.width = '0%';
          progressText.innerText = '0 / 0 タイル (0%)';
          startBtn.disabled = false;
          startBtn.innerText = 'ダウンロード開始';
          startBtn.style.background = 'linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)';
        }
        
        function lng2tile(lon, zoom) {
          return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
        }
        function lat2tile(lat, zoom) {
          return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
        }
        
        function getTilesList() {
          var bounds = map.getBounds();
          var currentZoom = Math.max(12, Math.round(map.getZoom()));
          var minZoom = currentZoom;
          var maxZoom = Math.min(18, currentZoom + 3);
          
          zoomRangeSpan.innerText = minZoom + ' 〜 ' + maxZoom;
          
          var tiles = [];
          for (var z = minZoom; z <= maxZoom; z++) {
            var north = bounds.getNorth();
            var south = bounds.getSouth();
            var west = bounds.getWest();
            var east = bounds.getEast();
            
            var xMin = lng2tile(west, z);
            var xMax = lng2tile(east, z);
            var yMin = lat2tile(north, z);
            var yMax = lat2tile(south, z);
            
            for (var x = xMin; x <= xMax; x++) {
              for (var y = yMin; y <= yMax; y++) {
                tiles.push({ x: x, y: y, z: z });
              }
            }
          }
          return tiles;
        }
        
        function updateTileEstimate() {
          if (isDownloading) return;
          var tiles = getTilesList();
          tileCountSpan.innerText = tiles.length + ' タイル';
          if (tiles.length > 1000) {
            tileCountSpan.style.color = '#ef4444';
            tileCountSpan.style.fontWeight = 'bold';
            tileCountSpan.innerText += ' (多すぎます)';
            startBtn.disabled = true;
            startBtn.innerText = '地図を拡大してください';
          } else {
            tileCountSpan.style.color = '#10b981';
            tileCountSpan.style.fontWeight = 'bold';
            startBtn.disabled = false;
            startBtn.innerText = 'ダウンロード開始';
          }
        }
        
        map.on('moveend', updateTileEstimate);
        
        L.DomEvent.on(startBtn, 'click', function() {
          if (isDownloading) return;
          
          var tiles = getTilesList();
          if (tiles.length === 0) return;
          
          isDownloading = true;
          startBtn.disabled = true;
          startBtn.innerText = 'ダウンロード中...';
          startBtn.style.background = '#64748b';
          progressContainer.style.display = 'block';
          
          abortController = new AbortController();
          var signal = abortController.signal;
          
          var cacheName = 'gsi-tile-cache';
          var loadedCount = 0;
          var totalCount = tiles.length;
          
          window.caches.open(cacheName).then(function(cache) {
            var index = 0;
            var limit = 5;
            
            function downloadNext() {
              if (signal.aborted || index >= tiles.length) {
                if (index >= tiles.length && !signal.aborted) {
                  progressBar.style.width = '100%';
                  progressText.innerText = '完了! ' + totalCount + ' タイル保存';
                  startBtn.style.background = '#10b981';
                  startBtn.innerText = '保存完了';
                  setTimeout(function() {
                    resetUI();
                    card.style.display = 'none';
                    var banner = document.getElementById('cache-toast-banner');
                    if (banner) banner.style.display = 'none';
                  }, 2000);
                }
                return;
              }
              
              var tile = tiles[index++];
              var url = 'https://cyberjapandata.gsi.go.jp/xyz/std/' + tile.z + '/' + tile.x + '/' + tile.y + '.png';
              
              cache.match(url).then(function(matched) {
                if (matched) {
                  loadedCount++;
                  var pct = Math.round((loadedCount / totalCount) * 100);
                  progressBar.style.width = pct + '%';
                  progressText.innerText = loadedCount + ' / ' + totalCount + ' タイル (' + pct + '%)';
                  downloadNext();
                } else {
                  fetch(url, { signal: signal }).then(function(response) {
                    if (response.ok) {
                      cache.put(url, response.clone());
                    }
                    loadedCount++;
                    var pct = Math.round((loadedCount / totalCount) * 100);
                    progressBar.style.width = pct + '%';
                    progressText.innerText = loadedCount + ' / ' + totalCount + ' タイル (' + pct + '%)';
                    downloadNext();
                  }).catch(function(err) {
                    loadedCount++;
                    var pct = Math.round((loadedCount / totalCount) * 100);
                    progressBar.style.width = pct + '%';
                    progressText.innerText = loadedCount + ' / ' + totalCount + ' タイル (' + pct + '%)';
                    downloadNext();
                  });
                }
              });
            }
            
            for (var c = 0; c < limit; c++) {
              downloadNext();
            }
          }).catch(function(err) {
            console.error("Cache open error:", err);
            alert("地図の事前保存中にエラーが発生しました。");
            resetUI();
          });
        });
        
        return container;
      }
    });

    L.control.mapCache = function(options) {
      return new L.Control.MapCache(options);
    };

    var map = L.map('map', {
      zoomControl: false,
      maxZoom: 19,
      preferCanvas: true
    }).setView([35.681236, 139.767125], 13);

    // 国土地理院 標準地図タイル (キャッシュ対応のカスタムレイヤーを使用)
    L.tileLayer.offlineCache('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
      minZoom: 2,
      maxZoom: 18
    }).addTo(map);

    // 事前ダウンロード用のカスタムコントロールを追加
    L.control.mapCache({ position: 'topleft' }).addTo(map);

    var isLocationFixed = true;

    // 手動操作（クリック・タッチドラッグ・ピンチ等）が開始された時点で、現在地の自動追従（センタリング）を解除する
    map.on('mousedown touchstart', function() {
      isLocationFixed = false;
    });

    var myMarker = null;
    var myCircle = null;
    var myTrackPolyline = null;
    var otherMarkers = {};
    var otherPolylines = {};

    myTrackPolyline = L.polyline([], {
      color: '#1e40af',
      weight: 4,
      opacity: 0.85,
      dashArray: "1, 1",
      lineJoin: "round"
    }).addTo(map);

    function logToNative(msg) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', message: msg }));
      }
    }

    function handleMessage(event) {
      var message;
      try {
        message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch (e) {
        logToNative("JSON parse error: " + e.message);
        return;
      }

      if (!message || !message.type) return;
      logToNative("Message received: " + message.type);

      if (message.type === 'updateMyCoords') {
        var lat = message.lat;
        var lng = message.lng;
        var accuracy = message.accuracy;
        var color = message.color;

        var customIcon = L.divIcon({
          className: 'custom-gps-icon',
          html: '<div class="custom-gps-icon-inner" style="background: ' + color + '; box-shadow: 0 0 10px ' + color + ';"></div>',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });

        if (myMarker) {
          myMarker.setLatLng([lat, lng]);
          myMarker.setIcon(customIcon);
        } else {
          myMarker = L.marker([lat, lng], { icon: customIcon }).addTo(map);
          if (isLocationFixed) {
            map.setView([lat, lng], 17);
          }
        }

        if (isLocationFixed) {
          map.panTo([lat, lng]);
        }

        if (myCircle) {
          myCircle.setLatLng([lat, lng]);
          myCircle.setRadius(accuracy);
          myCircle.setStyle({ color: color, fillColor: color });
        } else {
          myCircle = L.circle([lat, lng], {
            radius: accuracy,
            color: color,
            fillColor: color,
            fillOpacity: 0.1,
            weight: 1
          }).addTo(map);
        }
      } 
      
      else if (message.type === 'updateMyTracks') {
        var latlngs = message.tracks;
        var path = latlngs.map(function(t) { return [t.latitude, t.longitude]; });
        myTrackPolyline.setLatLngs(path);
        if (message.color) {
          myTrackPolyline.setStyle({ color: message.color });
        }
      } 
      
      else if (message.type === 'updateOtherUsers') {
        var users = message.users;
        var userNamesInMessage = users.map(function(u) { return u.username; });
        
        for (var name in otherMarkers) {
          if (userNamesInMessage.indexOf(name) === -1) {
            map.removeLayer(otherMarkers[name]);
            delete otherMarkers[name];
          }
        }
        for (var name in otherPolylines) {
          if (userNamesInMessage.indexOf(name) === -1) {
            map.removeLayer(otherPolylines[name]);
            delete otherPolylines[name];
          }
        }

        users.forEach(function(user) {
          var userColor = user.color || '#a855f7';
          var latlng = [user.lat, user.lng];
          
          var otherIcon = L.divIcon({
            className: 'other-gps-icon',
            html: '<div style="width: 16px; height: 16px; border-radius: 50%; border: 2px solid #ffffff; background: ' + userColor + '; box-shadow: 0 0 10px ' + userColor + '; display: flex; justify-content: center; align-items: center;"><div style="width: 6px; height: 6px; background: #ffffff; border-radius: 50%;"></div></div>',
            iconSize: [16, 16],
            iconAnchor: [8, 8]
          });

          if (otherMarkers[user.username]) {
            otherMarkers[user.username].setLatLng(latlng);
          } else {
            otherMarkers[user.username] = L.marker(latlng, { icon: otherIcon })
              .bindPopup('<strong>' + user.username + '</strong><br><span class="small text-secondary">最新位置: ' + user.lat.toFixed(5) + ', ' + user.lng.toFixed(5) + '</span>')
              .addTo(map);
          }

          var pathCoords = (user.path || []).map(function(p) { return [p.lat, p.lng]; });
          var exists = pathCoords.some(function(p) {
            return Math.abs(p[0] - user.lat) < 0.0001 && Math.abs(p[1] - user.lng) < 0.0001;
          });
          if (!exists) {
            pathCoords.push(latlng);
          }

          if (otherPolylines[user.username]) {
            otherPolylines[user.username].setLatLngs(pathCoords);
            otherPolylines[user.username].setStyle({ color: userColor });
          } else {
            otherPolylines[user.username] = L.polyline(pathCoords, {
              color: userColor,
              weight: 3,
              opacity: 0.8,
              dashArray: "4, 6",
              lineJoin: "round"
            }).addTo(map);
          }
        });
      } 
      
      else if (message.type === 'initGeoJsonLayers') {
        logToNative("Initializing GeoJSON layers");
        if (message.agriFields) {
          L.geoJSON(message.agriFields, {
            style: {
              color: '#059669',
              weight: 1.5,
              fill: false,
              interactive: false
            }
          }).addTo(map);
        }
        if (message.villageBoundary) {
          L.geoJSON(message.villageBoundary, {
            style: {
              color: '#ea580c',
              weight: 2,
              fill: true,
              fillColor: '#ea580c',
              fillOpacity: 0,
              dashArray: '5, 5',
              interactive: true
            },
            onEachFeature: function(feature, layer) {
              var label = feature.properties && (feature.properties.AGRI_N || feature.properties.Moji);
              if (label) {
                var popupContent = '<div style="color: #ea580c; font-weight: 800; font-size: 16px; text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff; padding: 2px;">' + label + '</div>';
                layer.bindPopup(popupContent, {
                  closeButton: false,
                  autoPan: false
                });
              }
            }
          }).addTo(map);
        }
      }
      
      else if (message.type === 'recenter') {
        logToNative("Recentering to: " + message.lat + ", " + message.lng);
        isLocationFixed = true;
        var banner = document.getElementById('cache-toast-banner');
        if (banner) {
          banner.style.display = 'none';
        }
        map.setView([message.lat, message.lng], 17);
      }
    }

    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage);

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  </script>
</body>
</html>
`;

export default function MapScreen({ isActive }) {
  const [surveyorName, setSurveyorName] = useState('匿名調査員');
  const [isTracking, setIsTracking] = useState(false);
  const [myCoords, setMyCoords] = useState(null);
  const [myTracks, setMyTracks] = useState([]);
  const [otherUsers, setOtherUsers] = useState([]);
  const [showOtherUsers, setShowOtherUsers] = useState(true);
  const [gpsAccuracy, setGpsAccuracy] = useState(null);
  const [gpsStatus, setGpsStatus] = useState('positioning');
  const [isWebViewReady, setIsWebViewReady] = useState(false);

  const webViewRef = useRef(null);
  const otherUsersUnsubscribe = useRef(null);
  const gpsWatcher = useRef(null);

  // マウント時
  useEffect(() => {
    const loadUser = async () => {
      const name = await AsyncStorage.getItem('surveyor_name');
      if (name) setSurveyorName(name);

      const tracking = await AsyncStorage.getItem('is_tracking') === 'true';
      setIsTracking(tracking);
    };

    loadUser();
    loadLocalTracks();
    initFirebaseSync();
    startGpsWatch();

    return () => {
      if (otherUsersUnsubscribe.current) otherUsersUnsubscribe.current();
      if (gpsWatcher.current) gpsWatcher.current.remove();
    };
  }, []);

  // 画面アクティブ時
  useEffect(() => {
    if (isActive) {
      loadLocalTracks();
    }
  }, [isActive]);

  // データ同期の監視 (WebViewが準備完了してから送信する)
  useEffect(() => {
    if (isWebViewReady && webViewRef.current) {
      // 0. GeoJSONレイヤーの送信
      sendToWebView({
        type: 'initGeoJsonLayers',
        agriFields: agriFieldsData,
        villageBoundary: villageBoundaryData
      });

      // 1. 自分の現在地をWebViewに送信
      if (myCoords) {
        sendToWebView({
          type: 'updateMyCoords',
          lat: myCoords.latitude,
          lng: myCoords.longitude,
          accuracy: gpsAccuracy || 10,
          color: getUserColor(surveyorName)
        });
      }
      
      // 2. 自分の軌跡をWebViewに送信
      sendToWebView({
        type: 'updateMyTracks',
        tracks: myTracks,
        color: getUserColor(surveyorName)
      });

      // 3. 他調査員をWebViewに送信
      if (showOtherUsers) {
        const mappedUsers = otherUsers.map(u => ({
          ...u,
          color: getUserColor(u.username)
        }));
        sendToWebView({
          type: 'updateOtherUsers',
          users: mappedUsers
        });
      } else {
        sendToWebView({
          type: 'updateOtherUsers',
          users: []
        });
      }
    }
  }, [isWebViewReady, myCoords, myTracks, otherUsers, showOtherUsers, surveyorName]);

  const sendToWebView = (data) => {
    if (webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify(data));
    }
  };

  const loadLocalTracks = () => {
    const tracks = getAllTracks();
    const latlngs = tracks.map(t => ({ latitude: t.lat, longitude: t.lng }));
    setMyTracks(latlngs);
  };

  const initFirebaseSync = async () => {
    const name = await AsyncStorage.getItem('surveyor_name') || '匿名調査員';
    const loggedIn = await loginAnonymously();
    if (loggedIn) {
      otherUsersUnsubscribe.current = listenToOtherUsers(name, (users) => {
        if (showOtherUsers) {
          setOtherUsers(users);
        }
      });
    }
  };

  const startGpsWatch = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setGpsStatus('error');
        return;
      }

      gpsWatcher.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 5000,
          distanceInterval: 1
        },
        async (location) => {
          const { latitude, longitude, accuracy } = location.coords;
          setMyCoords({ latitude, longitude });
          setGpsAccuracy(accuracy);
          setGpsStatus('active');

          const isTrack = await AsyncStorage.getItem('is_tracking') === 'true';
          const name = await AsyncStorage.getItem('surveyor_name') || '匿名調査員';
          
          if (!isTrack) {
            const now = Date.now();
            const lastSendStr = await AsyncStorage.getItem('last_realtime_send_time');
            const lastSend = lastSendStr ? parseInt(lastSendStr, 10) : 0;
            
            if (now - lastSend >= 600000) {
              const sessId = await AsyncStorage.getItem('current_session_id') || 'no_session';
              await updateRealtimeLocation(name, latitude, longitude, sessId);
              await AsyncStorage.setItem('last_realtime_send_time', now.toString());
            }
          }
        }
      );
    } catch (error) {
      console.warn('GPS Watcher Error:', error);
      setGpsStatus('positioning');
    }
  };

  const handleToggleTracking = async () => {
    if (!isTracking) {
      if (!myCoords) {
        Alert.alert('警告', 'GPS位置が測定できていません。電波の良い屋外でお待ちください。');
        return;
      }

      try {
        const sessId = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 11);
        await AsyncStorage.setItem('current_session_id', sessId);
        await AsyncStorage.setItem('is_tracking', 'true');
        await AsyncStorage.setItem('last_track_time', Date.now().toString());

        await startLocationTracking();
        setIsTracking(true);

        const name = await AsyncStorage.getItem('surveyor_name') || '匿名調査員';
        await updateRealtimeLocation(name, myCoords.latitude, myCoords.longitude, sessId);
        await AsyncStorage.setItem('last_realtime_send_time', Date.now().toString());

        Alert.alert('成功', '調査軌跡ログの記録を開始しました。');
      } catch (err) {
        Alert.alert('エラー', 'トラッキングの起動に失敗しました。\n\n詳細: ' + err.message);
      }
    } else {
      await AsyncStorage.setItem('is_tracking', 'false');
      await stopLocationTracking();
      setIsTracking(false);

      const name = await AsyncStorage.getItem('surveyor_name');
      if (name) {
        await removeRealtimeLocation(name);
      }
      Alert.alert('停止', 'トラッキングを停止しました。');
    }
  };

  const handleRecenter = () => {
    if (myCoords) {
      sendToWebView({
        type: 'recenter',
        lat: myCoords.latitude,
        lng: myCoords.longitude
      });
    } else {
      Alert.alert('情報', '現在地情報を取得中です。');
    }
  };

  const handleWebViewMessage = (event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'ready') {
        setIsWebViewReady(true);
      } else if (data.type === 'log') {
        console.log('WebView Log:', data.message);
      }
    } catch (err) {
      console.warn('WebView Message Error:', err);
    }
  };

  return (
    <View style={styles.container}>
      {/* ヘッダーエリア */}
      <View style={styles.header}>
        <View style={styles.titleContainer}>
          <FontAwesome5 name="compass" size={22} color="#1e40af" style={styles.headerIcon} />
          <Text style={styles.titleText}>FR5</Text>
        </View>

        <View style={styles.headerActions}>
          <View style={styles.gpsBadge}>
            <View style={[
              styles.gpsDot, 
              gpsStatus === 'active' ? styles.gpsActive : (gpsStatus === 'positioning' ? styles.gpsPositioning : styles.gpsError)
            ]} />
            <Text style={styles.gpsText}>
              {gpsStatus === 'active' ? `±${Math.round(gpsAccuracy)}m` : (gpsStatus === 'positioning' ? '測位中' : 'GPSエラー')}
            </Text>
          </View>

          <TouchableOpacity 
            style={[styles.trackButton, isTracking ? styles.trackButtonActive : styles.trackButtonInactive]}
            onPress={handleToggleTracking}
          >
            <FontAwesome5 name={isTracking ? "stop-circle" : "play"} size={16} color="#ffffff" />
            <Text style={styles.trackButtonText}>
              {isTracking ? 'トラック中' : 'トラック開始'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 地図コンポーネント (WebView) */}
      <WebView
        ref={webViewRef}
        style={styles.map}
        source={{ html: LEAFLET_HTML, baseUrl: 'https://localhost' }}
        onMessage={handleWebViewMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        originWhitelist={['*']}
        mixedContentMode="always"
      />

      {/* フローティングマップコントロール */}
      <View style={styles.controlsContainer}>
        <TouchableOpacity style={styles.controlButton} onPress={handleRecenter}>
          <FontAwesome5 name="crosshairs" size={18} color="#0f172a" />
        </TouchableOpacity>

        <TouchableOpacity 
          style={styles.controlButton} 
          onPress={() => {
            setShowOtherUsers(!showOtherUsers);
            if (showOtherUsers) {
              setOtherUsers([]);
            } else {
              initFirebaseSync();
            }
          }}
        >
          <FontAwesome5 name={showOtherUsers ? "users-slash" : "users"} size={18} color="#0f172a" />
        </TouchableOpacity>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 70,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: 'rgba(15, 23, 42, 0.16)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    zIndex: 10,
  },
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIcon: {
    marginRight: 8,
  },
  titleText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1e40af',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  gpsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: 'rgba(15, 23, 42, 0.12)',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginRight: 10,
  },
  gpsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  gpsActive: {
    backgroundColor: '#059669',
  },
  gpsPositioning: {
    backgroundColor: '#d97706',
  },
  gpsError: {
    backgroundColor: '#dc2626',
  },
  gpsText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
  },
  trackButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    elevation: 2,
  },
  trackButtonActive: {
    backgroundColor: '#059669',
  },
  trackButtonInactive: {
    backgroundColor: '#1e40af',
  },
  trackButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 6,
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  controlsContainer: {
    position: 'absolute',
    top: 86,
    right: 16,
    zIndex: 100,
    gap: 12,
  },
  controlButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderWidth: 2,
    borderColor: 'rgba(15, 23, 42, 0.16)',
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
  },
  controlButtonText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
    marginLeft: 8,
  },
});
