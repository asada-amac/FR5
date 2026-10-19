import React, { useState, useEffect, useRef } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  TouchableOpacity, 
  FlatList, 
  Modal, 
  TextInput, 
  Image, 
  Alert, 
  ActivityIndicator, 
  ScrollView 
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/src/legacy';
import { FontAwesome5 } from '@expo/vector-icons';
import shpwrite from '@mapbox/shp-write';
import JSZip from 'jszip';

import { 
  getAllSurveys, 
  getAllTracks, 
  updateSurvey, 
  deleteSurvey, 
  clearSurveys, 
  clearTracks 
} from '../db';
import { GAS_URL, APP_VERSION } from '../config';
import { listenToOtherUsers, loginAnonymously } from '../firebase';

// 定数定義
const CATEGORIES = [
  '聞き取り', '掘り起こし', '足跡', '獣道', '食痕', '泥こすり', 'ヌタ場', '寝屋', 
  '爪痕', '目撃', '被害', '箱わな', 'くくりわな', '囲いわな', '小型わな', 
  '電気柵', 'ワイヤーメッシュ', '金網柵', 'その他柵', 'その他', 'カメラ'
];

const SPECIES = [
  'イノシシ', 'アライグマ', 'ハクビシン', 'シカ', 'サル', 'キョン', 'アナグマ', 'タヌキ', 'その他'
];

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

// 分類別のピンカラー選定
function getMarkerColorByCategory(cat) {
  switch (cat) {
    case '聞き取り': return '#ef4444';
    case '目撃': return '#ec4899';
    case '被害': return '#dc2626';
    case '掘り起こし': return '#d97706';
    case '足跡': return '#f59e0b';
    case '獣道': return '#84cc16';
    case '食痕': return '#10b981';
    case '泥こすり': return '#059669';
    case 'ヌタ場': return '#0d9488';
    case '寝屋': return '#06b6d4';
    case '爪痕': return '#ea580c';
    case '箱わな': return '#2563eb';
    case 'くくりわな': return '#3b82f6';
    case '囲いわな': return '#4f46e5';
    case '小型わな': return '#6366f1';
    case '電気柵': return '#475569';
    case 'ワイヤーメッシュ': return '#64748b';
    case '金網柵': return '#94a3b8';
    case 'その他柵': return '#cbd5e1';
    case 'カメラ': return '#16a34a';
    default: return '#a855f7';
  }
}

export default function DataManagementScreen({ isActive, onLogout }) {
  console.log('DataManagementScreen rendering, isActive:', isActive);
  const [surveyCount, setSurveyCount] = useState(0);
  const [trackCount, setTrackCount] = useState(0);
  const [surveysList, setSurveysList] = useState([]);
  const [showListModal, setShowListModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedSurvey, setSelectedSurvey] = useState(null);
  
  // 編集用のState
  const [editCategory, setEditCategory] = useState('');
  const [editSpecies, setEditSpecies] = useState('');
  const [editDetail, setEditDetail] = useState('');
  const [editInterview, setEditInterview] = useState('');
  const [editPhotoUri, setEditPhotoUri] = useState(null);
  const [editPhotoBase64, setEditPhotoBase64] = useState('');
  const [editLat, setEditLat] = useState('');
  const [editLng, setEditLng] = useState('');

  // 送信・同期関連
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [otherActiveUsers, setOtherActiveUsers] = useState([]);
  const [surveyorName, setSurveyorName] = useState('---');
  
  const firebaseUnsubscribe = useRef(null);

  useEffect(() => {
    if (isActive) {
      loadStats();
      loadSystemInfo();
      initFirebaseListen();
    }
    return () => {
      if (firebaseUnsubscribe.current) firebaseUnsubscribe.current();
    };
  }, [isActive]);

  const loadStats = () => {
    const surveys = getAllSurveys();
    const tracks = getAllTracks();
    setSurveyCount(surveys.length);
    setTrackCount(tracks.length);
    setSurveysList(surveys);
  };

  const loadSystemInfo = async () => {
    const name = await AsyncStorage.getItem('surveyor_name');
    if (name) setSurveyorName(name);
  };

  const initFirebaseListen = async () => {
    const name = await AsyncStorage.getItem('surveyor_name') || '匿名調査員';
    const loggedIn = await loginAnonymously();
    if (loggedIn) {
      if (firebaseUnsubscribe.current) firebaseUnsubscribe.current();
      firebaseUnsubscribe.current = listenToOtherUsers(name, (users) => {
        setOtherActiveUsers(users);
      });
    }
  };

  // 編集モーダルを開く
  const handleOpenEdit = (survey) => {
    setSelectedSurvey(survey);
    setEditCategory(survey.category);
    setEditSpecies(survey.species);
    setEditDetail(survey.detail || '');
    setEditInterview(survey.interview === '聞き取りなし' ? '' : survey.interview);
    setEditPhotoUri(survey.photo ? survey.photo : null); // Base64をUriとして渡す
    setEditPhotoBase64(survey.photo || '');
    setEditLat(survey.lat.toString());
    setEditLng(survey.lng.toString());
    
    setShowListModal(false);
    // 少し遅らせてモーダル同士の衝突を回避
    setTimeout(() => {
      setShowEditModal(true);
    }, 300);
  };

  // 編集画面でのカメラ撮影・圧縮
  const handleLaunchCamera = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('権限エラー', 'カメラへのアクセスが許可されていません');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: false,
      quality: 1,
    });

    if (!result.canceled && result.assets && result.assets.length > 0) {
      const uri = result.assets[0].uri;
      setEditPhotoUri(uri);
      
      // 画像の圧縮
      try {
        let quality = 0.8;
        let fileUri = uri;
        let manipResult = await manipulateAsync(
          fileUri,
          [{ resize: { width: 1024 } }],
          { compress: quality, format: SaveFormat.JPEG }
        );
        fileUri = manipResult.uri;
        let fileInfo = await FileSystem.getInfoAsync(fileUri);
        let sizeKB = fileInfo ? (fileInfo.size / 1024) : 999;

        while (sizeKB > 200 && quality > 0.15) {
          quality -= 0.1;
          const safeQuality = Math.max(0.1, quality);
          manipResult = await manipulateAsync(
            uri,
            [{ resize: { width: 1024 } }],
            { compress: safeQuality, format: SaveFormat.JPEG }
          );
          fileUri = manipResult.uri;
          fileInfo = await FileSystem.getInfoAsync(fileUri);
          sizeKB = fileInfo ? (fileInfo.size / 1024) : 0;
        }

        const base64Content = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        setEditPhotoBase64(`data:image/jpeg;base64,${base64Content}`);
      } catch (err) {
        console.log('編集時の画像圧縮失敗 (log):', err.message || err);
        Alert.alert('エラー', '画像の圧縮に失敗しました。\n\n詳細: ' + (err.message || err));
      }
    }
  };

  // 編集データの保存
  const handleSaveEdit = async () => {
    if (!editCategory || !editSpecies || !editLat || !editLng) {
      Alert.alert('エラー', '必須項目を入力してください。');
      return;
    }

    const latVal = parseFloat(editLat);
    const lngVal = parseFloat(editLng);
    if (isNaN(latVal) || isNaN(lngVal)) {
      Alert.alert('エラー', '経緯度には数値を入力してください。');
      return;
    }

    const updatedItem = {
      id: selectedSurvey.id,
      category: editCategory,
      species: editSpecies,
      detail: editDetail.trim(),
      interview: editInterview.trim() || '聞き取りなし',
      photo: editPhotoBase64,
      lat: latVal,
      lng: lngVal
    };

    try {
      await updateSurvey(updatedItem);
      setShowEditModal(false);
      loadStats();
      Alert.alert('完了', '調査データを修正しました。');
    } catch (err) {
      Alert.alert('エラー', '修正データの保存に失敗しました。');
    }
  };

  // 編集データの削除
  const handleDeleteSurvey = async () => {
    Alert.alert('削除の確認', 'この調査データを完全に削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteSurvey(selectedSurvey.id);
            setShowEditModal(false);
            loadStats();
            Alert.alert('完了', 'データを削除しました。');
          } catch (err) {
            Alert.alert('エラー', 'データの削除に失敗しました。');
          }
        }
      }
    ]);
  };

  // 強制クリア処理
  const handleForceClear = () => {
    Alert.alert('警告', '端末内のすべての未送信データを消去します。よろしいですか？', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '強制消去',
        style: 'destructive',
        onPress: () => {
          clearSurveys();
          clearTracks();
          loadStats();
          Alert.alert('完了', 'データをクリアしました。');
        }
      }
    ]);
  };

  // ログアウト処理
  const handleLogoutClick = () => {
    Alert.alert(
      'ログアウト',
      'ログアウトしますか？（保存済みの調査データは削除されません）',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'ログアウト',
          style: 'destructive',
          onPress: async () => {
            try {
              const name = await AsyncStorage.getItem('surveyor_name');
              if (name) {
                // 自身の位置情報をFirestoreから削除
                const { removeRealtimeLocation } = require('../firebase');
                await removeRealtimeLocation(name);
              }
              await AsyncStorage.removeItem('surveyor_name');
              if (onLogout) onLogout();
            } catch (err) {
              console.error('ログアウトエラー:', err);
            }
          }
        }
      ]
    );
  };

  // UTF-8対応の純粋なJavaScript Base64エンコーダー
  const toBase64 = (str) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bytes = [];
    for (let i = 0; i < str.length; i++) {
      let code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0xd800 || code >= 0xe000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        i++;
        let utf32 = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        bytes.push(
          0xf0 | (utf32 >> 18),
          0x80 | ((utf32 >> 12) & 0x3f),
          0x80 | ((utf32 >> 6) & 0x3f),
          0x80 | (utf32 & 0x3f)
        );
      }
    }
    let base64 = '';
    let i = 0;
    while (i < bytes.length) {
      let b1 = bytes[i++];
      let b2 = i < bytes.length ? bytes[i++] : NaN;
      let b3 = i < bytes.length ? bytes[i++] : NaN;
      let enc1 = b1 >> 2;
      let enc2 = ((b1 & 3) << 4) | (isNaN(b2) ? 0 : b2 >> 4);
      let enc3 = isNaN(b2) ? 64 : ((b2 & 15) << 2) | (isNaN(b3) ? 0 : b3 >> 6);
      let enc4 = isNaN(b3) ? 64 : b3 & 63;
      base64 += chars.charAt(enc1) + chars.charAt(enc2) +
                (enc3 === 64 ? '=' : chars.charAt(enc3)) +
                (enc4 === 64 ? '=' : chars.charAt(enc4));
    }
    return base64;
  };

  // 軌跡データのGeoJSON化 (ZIP圧縮なしで生のGeoJSONをBase64変換)
  const generateTrackGeoJson = (tracks, username) => {
    if (!tracks || tracks.length === 0) return { geojsonBase64: "", trackFileName: "" };

    const coordinates = tracks.map(t => [t.lng, t.lat]);
    const geojson = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coordinates
        },
        properties: {
          id: tracks[0].sessionId || "track_line",
          surveyor: username,
          start: new Date(tracks[0].timestamp).toISOString(),
          end: new Date(tracks[tracks.length - 1].timestamp).toISOString()
        }
      }]
    };

    const startTime = new Date(tracks[0].timestamp);
    const yyyy = startTime.getFullYear();
    const mm = String(startTime.getMonth() + 1).padStart(2, '0');
    const dd = String(startTime.getDate()).padStart(2, '0');
    const hh = String(startTime.getHours()).padStart(2, '0');
    const min = String(startTime.getMinutes()).padStart(2, '0');
    
    const yyyymmdd = `${yyyy}${mm}${dd}`;
    const hhmm = `${hh}${min}`;
    const cleanUsername = username.replace(/[\\/:*?"<>|]/g, "_");
    const trackFileName = `${yyyymmdd}_${hhmm}_${cleanUsername}_line.geojson`;

    const geojsonBase64 = toBase64(JSON.stringify(geojson));

    return { geojsonBase64, trackFileName };
  };

  // 弱電界対応: タイムアウト＆指数バックオフ付きPOST送信ヘルパー
  const postToGASWithRetry = async (payload, label, maxRetries = 2, timeoutMs = 30000) => {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        if (attempt > 0) {
          setUploadProgress(`${label} (再試行 ${attempt}/${maxRetries})...`);
          await new Promise(res => setTimeout(res, 1500 * attempt));
        }
        const response = await fetch(GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timer);
        const result = await response.json();
        if (result.status !== 'success') {
          throw new Error(result.message || 'GASサーバーエラー');
        }
        return result;
      } catch (err) {
        clearTimeout(timer);
        lastError = err.name === 'AbortError'
          ? new Error('通信がタイムアウトしました（電波が弱い可能性があります）')
          : err;
      }
    }
    throw lastError;
  };

  // Googleクラウド(GAS)への送信処理 (弱電界対応・1件成功ごと即時ローカル削除)
  const handleUploadToGAS = async () => {
    const surveys = getAllSurveys();
    const tracks = getAllTracks();

    if (surveys.length === 0 && tracks.length === 0) {
      Alert.alert('情報', '送信するデータがありません。');
      return;
    }

    Alert.alert(
      'クラウド送信',
      `調査データ ${surveys.length}件、軌跡ログ ${tracks.length}点 をGoogleクラウドへ順次送信しますか？\n(送信に成功したデータから順に端末から消去されます。途中で電波が切れても残りのデータは保持されます)`,
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '送信する',
          onPress: async () => {
            setIsUploading(true);
            let surveySuccessCount = 0;
            let isTrackSent = 0;
            try {
              // 1. 調査データを 1件ずつ順番に直列送信し、1件成功するごとに即座にSQLiteから削除
              for (let i = 0; i < surveys.length; i++) {
                const progressLabel = `調査データを送信中... (${i + 1} / ${surveys.length} 件)`;
                setUploadProgress(progressLabel);

                const payload = {
                  surveys: [surveys[i]],
                  trackZip: "",
                  trackZipName: ""
                };

                await postToGASWithRetry(payload, progressLabel);

                // 送信成功した1件のみ即座にローカルDBから削除（途中失敗時の二重送信防止）
                await deleteSurvey(surveys[i].id);
                surveySuccessCount++;
                loadStats();
              }

              // 2. 最後に軌跡（トラック）データを送信 (ZIP圧縮なしの生GeoJSON)
              if (tracks.length > 0) {
                setUploadProgress("軌跡データをGeoJSONに変換中...");
                const username = surveyorName || "匿名調査員";
                const { geojsonBase64, trackFileName } = generateTrackGeoJson(tracks, username);

                const trackLabel = "軌跡データを送信中...";
                setUploadProgress(trackLabel);
                const payload = {
                  surveys: [],
                  trackZip: geojsonBase64,
                  trackZipName: trackFileName
                };

                await postToGASWithRetry(payload, trackLabel);
                clearTracks();
                isTrackSent = 1;
                loadStats();
              }

              setIsUploading(false);
              setUploadProgress('');
              loadStats();

              Alert.alert(
                '送信完了',
                `クラウドへの送信がすべて完了しました！\n\n・送信データ: ${surveySuccessCount}件\n・軌跡データ: ${isTrackSent ? '保存完了' : 'なし'}`
              );
            } catch (err) {
              console.error('GAS送信エラー:', err);
              setIsUploading(false);
              setUploadProgress('');
              loadStats();
              const remainingSurveys = getAllSurveys().length;
              const remainingTracks = getAllTracks().length;
              Alert.alert(
                '送信中断（一部未送信）',
                `電波状況により送信が中断されました。\n\n・送信完了: ${surveySuccessCount}件\n・未送信の調査データ: ${remainingSurveys}件\n・未送信の軌跡点数: ${remainingTracks}点\n\n未送信のデータは端末内に安全に保存されています。電波の良い場所で再度「Googleクラウドへ送信」を押すと、残りのデータから再開できます。\n\n詳細: ${err.message}`
              );
            }
          }
        }
      ]
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.contentContainer}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            <FontAwesome5 name="database" size={20} color="#1e40af" /> 調査データ管理
          </Text>

          {/* 件数表示エリア (大きく、高コントラスト) */}
          <View style={styles.statsRow}>
            {/* 調査データ件数 (タップ可能) */}
            <TouchableOpacity style={styles.statsCardPrimary} onPress={() => setShowListModal(true)}>
              <Text style={styles.statsNumberPrimary}>{surveyCount}</Text>
              <Text style={styles.statsLabelPrimary}>調査データ件数 (修正・削除)</Text>
            </TouchableOpacity>

            {/* トラック軌跡件数 */}
            <View style={styles.statsCardSuccess}>
              <Text style={styles.statsNumberSuccess}>{trackCount}</Text>
              <Text style={styles.statsLabelSuccess}>トラック軌跡点数</Text>
            </View>
          </View>

          <View style={styles.divider} />

          {/* クラウド送信アクション */}
          <Text style={styles.sectionLabel}>アクション</Text>
          <TouchableOpacity style={styles.uploadButton} onPress={handleUploadToGAS} disabled={isUploading}>
            <FontAwesome5 name="cloud-upload-alt" size={18} color="#ffffff" />
            <Text style={styles.uploadButtonText}>Googleクラウドへ送信</Text>
            <View style={styles.uploadBadge}>
              <Text style={styles.uploadBadgeText}>{surveyCount}件</Text>
            </View>
          </TouchableOpacity>

          <View style={styles.divider} />

          {/* 接続中の他調査員リストカード */}
          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>
              <FontAwesome5 name="users" size={16} color="#1e40af" /> 接続中の他調査員
            </Text>
            
            <View style={styles.usersListContainer}>
              {otherActiveUsers.length === 0 ? (
                <Text style={styles.noUsersText}>他調査員の接続なし</Text>
              ) : (
                otherActiveUsers.map((user) => {
                  const userColor = getUserColor(user.username);
                  return (
                    <View key={user.username} style={styles.userRow}>
                      <View style={styles.userMeta}>
                        <View style={[styles.userColorDot, { backgroundColor: userColor }]} />
                        <Text style={styles.userName} numberOfLines={1}>
                          {user.username}
                        </Text>
                      </View>
                      <Text style={styles.userStatus}>
                        {user.lat.toFixed(4)}, {user.lng.toFixed(4)}
                      </Text>
                    </View>
                  );
                })
              )}
            </View>
          </View>

          {/* システム情報・設定カード */}
          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>
              <FontAwesome5 name="user-cog" size={16} color="#0f172a" /> システム設定・情報
            </Text>
            
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>ログインユーザー:</Text>
              <Text style={styles.infoValue}>{surveyorName}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>アプリバージョン:</Text>
              <Text style={styles.infoValue}>{APP_VERSION}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>データベース状態:</Text>
              <Text style={styles.dbStatusValue}>
                <FontAwesome5 name="check-circle" size={14} color="#059669" /> 接続済み
              </Text>
            </View>

            {/* ログインユーザー名変更 (ログアウト) ボタンを追加 */}
            <TouchableOpacity style={styles.logoutButton} onPress={handleLogoutClick}>
              <FontAwesome5 name="sign-out-alt" size={14} color="#dc2626" />
              <Text style={styles.logoutButtonText}>ユーザー名変更 (ログアウト)</Text>
            </TouchableOpacity>
          </View>

          {/* 端末データ強制リセットボタン */}
          <TouchableOpacity style={styles.clearButton} onPress={handleForceClear}>
            <FontAwesome5 name="exclamation-triangle" size={14} color="#d97706" />
            <Text style={styles.clearButtonText}>端末内データを強制リセット</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* 送信中のローディングオーバーレイ */}
      {isUploading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#ffffff" />
          <Text style={styles.loadingText}>{uploadProgress}</Text>
        </View>
      )}

      {/* 保存済み調査データ一覧モーダル */}
      <Modal
        visible={showListModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowListModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>保存済み調査データ一覧</Text>
              <TouchableOpacity onPress={() => setShowListModal(false)} style={styles.closeButton}>
                <FontAwesome5 name="times" size={20} color="#64748b" />
              </TouchableOpacity>
            </View>

            <FlatList
              data={surveysList}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listContainer}
              ListEmptyComponent={
                <View style={styles.emptyList}>
                  <FontAwesome5 name="folder-open" size={40} color="#94a3b8" />
                  <Text style={styles.emptyListText}>保存されているデータはありません</Text>
                </View>
              }
              renderItem={({ item }) => {
                const pinColor = getMarkerColorByCategory(item.category);
                return (
                  <TouchableOpacity style={styles.surveyItemCard} onPress={() => handleOpenEdit(item)}>
                    <View style={styles.surveyItemHeader}>
                      <View style={[styles.categoryBadge, { backgroundColor: pinColor }]}>
                        <Text style={styles.categoryBadgeText}>{item.category}</Text>
                      </View>
                      <Text style={styles.speciesName}>{item.species}</Text>
                    </View>
                    <Text style={styles.surveyItemTime}>
                      <FontAwesome5 name="clock" size={12} color="#64748b" /> {item.date} {item.time.substring(0, 5)}
                    </Text>
                    {item.detail ? (
                      <Text style={styles.surveyItemDetail} numberOfLines={2}>{item.detail}</Text>
                    ) : null}
                    {item.photo ? (
                      <View style={styles.thumbnailContainer}>
                        <Image source={{ uri: item.photo }} style={styles.thumbnail} />
                        <Text style={styles.thumbnailText}>画像あり</Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>

      {/* 修正・編集モーダル */}
      <Modal
        visible={showEditModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowEditModal(false)}
      >
        <View style={styles.modalOverlay}>
          <ScrollView style={styles.modalContentScroll} contentContainerStyle={styles.modalContentScrollContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>調査データの修正</Text>
              <TouchableOpacity onPress={() => setShowEditModal(false)} style={styles.closeButton}>
                <FontAwesome5 name="times" size={20} color="#64748b" />
              </TouchableOpacity>
            </View>

            {/* 地点分類選択 */}
            <Text style={styles.editLabel}>地点分類</Text>
            <View style={styles.chipGroup}>
              {CATEGORIES.map((item) => (
                <TouchableOpacity
                  key={item}
                  style={[styles.chipButton, editCategory === item ? styles.chipSelected : styles.chipUnselected]}
                  onPress={() => setEditCategory(item)}
                >
                  <Text style={[styles.chipText, editCategory === item ? styles.chipTextSelected : styles.chipTextUnselected]}>
                    {item}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* 種名選択 */}
            <Text style={styles.editLabel}>種名</Text>
            <View style={styles.chipGroup}>
              {SPECIES.map((item) => (
                <TouchableOpacity
                  key={item}
                  style={[styles.chipButton, editSpecies === item ? styles.chipSelected : styles.chipUnselected]}
                  onPress={() => setEditSpecies(item)}
                >
                  <Text style={[styles.chipText, editSpecies === item ? styles.chipTextSelected : styles.chipTextUnselected]}>
                    {item}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* 詳細 */}
            <Text style={styles.editLabel}>情報詳細</Text>
            <TextInput
              style={styles.textArea}
              multiline
              numberOfLines={3}
              value={editDetail}
              onChangeText={setEditDetail}
            />

            {/* 聞き取り */}
            <Text style={styles.editLabel}>聞き取り対象</Text>
            <TextInput
              style={styles.textInput}
              value={editInterview}
              onChangeText={setEditInterview}
            />

            {/* 緯度・経度 */}
            <View style={styles.coordsRow}>
              <View style={styles.coordField}>
                <Text style={styles.editLabel}>緯度</Text>
                <TextInput
                  style={styles.textInput}
                  keyboardType="numeric"
                  value={editLat}
                  onChangeText={setEditLat}
                />
              </View>
              <View style={styles.coordField}>
                <Text style={styles.editLabel}>経度</Text>
                <TextInput
                  style={styles.textInput}
                  keyboardType="numeric"
                  value={editLng}
                  onChangeText={setEditLng}
                />
              </View>
            </View>

            {/* 現地写真 */}
            <Text style={styles.editLabel}>現地写真</Text>
            <View style={styles.photoContainer}>
              {editPhotoUri ? (
                <View style={styles.previewContainer}>
                  <Image source={{ uri: editPhotoUri }} style={styles.photoPreview} />
                  <TouchableOpacity style={styles.cameraTrigger} onPress={handleLaunchCamera}>
                    <FontAwesome5 name="camera" size={20} color="#64748b" />
                    <Text style={styles.cameraTriggerText}>写真を変更</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.cameraTrigger} onPress={handleLaunchCamera}>
                  <FontAwesome5 name="camera" size={28} color="#64748b" />
                  <Text style={styles.cameraTriggerText}>写真を撮影して追加</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* 下部アクションボタン */}
            <View style={styles.editActions}>
              <TouchableOpacity style={styles.deleteActionButton} onPress={handleDeleteSurvey}>
                <FontAwesome5 name="trash-alt" size={14} color="#dc2626" />
                <Text style={styles.deleteActionButtonText}>データ削除</Text>
              </TouchableOpacity>
              
              <View style={styles.editRightActions}>
                <TouchableOpacity style={styles.cancelActionButton} onPress={() => setShowEditModal(false)}>
                  <Text style={styles.cancelActionButtonText}>キャンセル</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveActionButton} onPress={handleSaveEdit}>
                  <FontAwesome5 name="save" size={14} color="#ffffff" />
                  <Text style={styles.saveActionButtonText}>保存</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 100,
  },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: 'rgba(15, 23, 42, 0.16)',
    borderRadius: 16,
    padding: 20,
  },
  cardTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
    paddingBottom: 8,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  statsCardPrimary: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#1e40af',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsCardSuccess: {
    flex: 1,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#059669',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsNumberPrimary: {
    fontSize: 32,
    fontWeight: '800',
    color: '#1e40af',
  },
  statsLabelPrimary: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1e40af',
    textAlign: 'center',
    marginTop: 4,
  },
  statsNumberSuccess: {
    fontSize: 32,
    fontWeight: '800',
    color: '#059669',
  },
  statsLabelSuccess: {
    fontSize: 12,
    fontWeight: '700',
    color: '#059669',
    textAlign: 'center',
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 20,
  },
  sectionLabel: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 12,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    minHeight: 56,
  },
  uploadButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
    marginLeft: 8,
  },
  uploadBadge: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#059669',
  },
  uploadBadgeText: {
    color: '#059669',
    fontSize: 14,
    fontWeight: '800',
  },
  infoCard: {
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: 'rgba(15, 23, 42, 0.16)',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  infoCardTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingBottom: 6,
  },
  usersListContainer: {
    gap: 8,
  },
  noUsersText: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    paddingVertical: 8,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    paddingBottom: 6,
  },
  userMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  userColorDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  userName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    maxWidth: 120,
  },
  userStatus: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '600',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  infoLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#64748b',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1e40af',
  },
  dbStatusValue: {
    fontSize: 14,
    fontWeight: '800',
    color: '#059669',
  },
  clearButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#d97706',
    borderRadius: 10,
    paddingVertical: 12,
    minHeight: 48,
    marginTop: 10,
  },
  clearButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#d97706',
    marginLeft: 6,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#dc2626',
    borderRadius: 10,
    paddingVertical: 12,
    minHeight: 48,
    marginTop: 14,
  },
  logoutButtonText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#dc2626',
    marginLeft: 6,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  loadingText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 16,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    width: '100%',
    maxHeight: '85%',
    borderWidth: 2,
    borderColor: 'rgba(15, 23, 42, 0.2)',
  },
  modalContentScroll: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    width: '100%',
    maxHeight: '90%',
    borderWidth: 2,
    borderColor: 'rgba(15, 23, 42, 0.2)',
  },
  modalContentScrollContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1e40af',
  },
  closeButton: {
    padding: 4,
  },
  listContainer: {
    padding: 16,
    gap: 12,
  },
  emptyList: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyListText: {
    color: '#94a3b8',
    fontSize: 16,
    fontWeight: '700',
    marginTop: 12,
  },
  surveyItemCard: {
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 14,
  },
  surveyItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  categoryBadge: {
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  categoryBadgeText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  speciesName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  surveyItemTime: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '600',
    marginBottom: 6,
  },
  surveyItemDetail: {
    fontSize: 15,
    color: '#334155',
    fontWeight: '500',
    marginBottom: 8,
  },
  thumbnailContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: 6,
    resizeMode: 'cover',
  },
  thumbnailText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '700',
  },
  editLabel: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 14,
    marginBottom: 6,
  },
  chipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  chipButton: {
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 2,
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chipSelected: {
    backgroundColor: '#1e40af',
    borderColor: '#1e40af',
  },
  chipUnselected: {
    backgroundColor: '#ffffff',
    borderColor: '#cbd5e1',
  },
  chipText: {
    fontSize: 14,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: '#ffffff',
  },
  chipTextUnselected: {
    color: '#0f172a',
  },
  textInput: {
    borderWidth: 2,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    backgroundColor: '#ffffff',
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 16,
    color: '#0f172a',
    fontWeight: '600',
    marginBottom: 10,
  },
  textArea: {
    borderWidth: 2,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    backgroundColor: '#ffffff',
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 16,
    color: '#0f172a',
    fontWeight: '600',
    height: 80,
    textAlignVertical: 'top',
    marginBottom: 10,
  },
  coordsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  coordField: {
    flex: 1,
  },
  photoContainer: {
    borderWidth: 2,
    borderColor: '#cbd5e1',
    borderStyle: 'dashed',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  cameraTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 8,
  },
  cameraTriggerText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#64748b',
  },
  previewContainer: {
    alignItems: 'center',
    width: '100%',
  },
  photoPreview: {
    width: '100%',
    height: 140,
    borderRadius: 8,
    resizeMode: 'cover',
    marginBottom: 8,
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    paddingTop: 16,
    marginTop: 16,
  },
  editRightActions: {
    flexDirection: 'row',
    gap: 8,
  },
  deleteActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#dc2626',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
  },
  deleteActionButtonText: {
    color: '#dc2626',
    fontSize: 14,
    fontWeight: '800',
    marginLeft: 6,
  },
  cancelActionButton: {
    borderWidth: 2,
    borderColor: '#64748b',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  cancelActionButtonText: {
    color: '#64748b',
    fontSize: 14,
    fontWeight: '800',
  },
  saveActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1e40af',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  saveActionButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
    marginLeft: 6,
  },
});
