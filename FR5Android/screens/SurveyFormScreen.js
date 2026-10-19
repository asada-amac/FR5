import React, { useState, useEffect, useRef } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  ScrollView, 
  Alert, 
  Image, 
  ActivityIndicator 
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/src/legacy';
import { FontAwesome5 } from '@expo/vector-icons';

import { addSurvey } from '../db';

// 定数定義
const CATEGORIES = [
  '聞き取り', '掘り起こし', '足跡', '獣道', '食痕', '泥こすり', 'ヌタ場', '寝屋', 
  '爪痕', '目撃', '被害', '箱わな', 'くくりわな', '囲いわな', '小型わな', 
  '電気柵', 'ワイヤーメッシュ', '金網柵', 'その他柵', 'その他', 'カメラ'
];

const SPECIES = [
  'イノシシ', 'アライグマ', 'ハクビシン', 'シカ', 'サル', 'キョン', 'アナグマ', 'タヌキ', 'その他'
];

export default function SurveyFormScreen({ isActive }) {
  console.log('SurveyFormScreen rendering, isActive:', isActive);
  const [surveyorName, setSurveyorName] = useState('匿名調査員');
  const [toastVisible, setToastVisible] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const toastTimeout = useRef(null);

  const showToast = (msg) => {
    if (toastTimeout.current) {
      clearTimeout(toastTimeout.current);
    }
    setToastMessage(msg);
    setToastVisible(true);
    toastTimeout.current = setTimeout(() => {
      setToastVisible(false);
      toastTimeout.current = null;
    }, 3000);
  };
  const [category, setCategory] = useState('');
  const [species, setSpecies] = useState('イノシシ'); // デフォルトはイノシシ
  const [detail, setDetail] = useState('');
  const [interview, setInterview] = useState('');
  const [photoUri, setPhotoUri] = useState(null);
  const [photoBase64, setPhotoBase64] = useState('');
  const [coords, setCoords] = useState(null);
  const [gpsAccuracy, setGpsAccuracy] = useState(null);
  const [isLocating, setIsLocating] = useState(false);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);

  // 画面アクティブ時にユーザー名と現在地を取得
  useEffect(() => {
    if (isActive) {
      loadUsername();
      fetchCurrentLocation();
    }
  }, [isActive]);

  const loadUsername = async () => {
    const name = await AsyncStorage.getItem('surveyor_name');
    if (name) setSurveyorName(name);
  };

  // 現在地GPSの単発取得
  const fetchCurrentLocation = async () => {
    setIsLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('警告', '位置情報の権限がありません。フォームへの入力用位置を取得できません。');
        setIsLocating(false);
        return;
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setCoords(location.coords);
      setGpsAccuracy(location.coords.accuracy);
    } catch (error) {
      console.warn('GPS取得失敗:', error);
      // フォールバック: 最後の座標があれば利用
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown) {
        setCoords(lastKnown.coords);
        setGpsAccuracy(lastKnown.coords.accuracy);
      } else {
        setCoords(null);
        setGpsAccuracy(null);
      }
    } finally {
      setIsLocating(false);
    }
  };

  // カメラを起動して撮影
  const handleLaunchCamera = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('権限エラー', 'カメラへのアクセス権限がありません。設定から許可してください。');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 1, // 高品質で撮影し、後から自前で圧縮
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        setPhotoUri(uri);
        await processAndCompressImage(uri);
      }
    } catch (error) {
      console.error('カメラ起動エラー:', error);
      Alert.alert('エラー', 'カメラの起動に失敗しました。');
    }
  };

  // 画像のリサイズ・200KB以下自動圧縮
  const processAndCompressImage = async (uri) => {
    setIsProcessingPhoto(true);
    try {
      let quality = 0.8;
      let fileUri = uri;

      // 1. 最大幅1024pxにリサイズ
      let manipResult = await manipulateAsync(
        fileUri,
        [{ resize: { width: 1024 } }],
        { compress: quality, format: SaveFormat.JPEG }
      );
      fileUri = manipResult.uri;
      
      let fileInfo = await FileSystem.getInfoAsync(fileUri);
      let sizeKB = fileInfo ? (fileInfo.size / 1024) : 999;
      console.log(`リサイズ後画像サイズ: ${sizeKB.toFixed(1)} KB`);

      // 2. 200KB以下になるまで品質を下げてループ再圧縮
      while (sizeKB > 200 && quality > 0.15) {
        quality -= 0.1;
        const safeQuality = Math.max(0.1, quality);
        manipResult = await manipulateAsync(
          uri, // 元画像からリサイズ・再圧縮
          [{ resize: { width: 1024 } }],
          { compress: safeQuality, format: SaveFormat.JPEG }
        );
        fileUri = manipResult.uri;
        fileInfo = await FileSystem.getInfoAsync(fileUri);
        sizeKB = fileInfo ? (fileInfo.size / 1024) : 0;
        console.log(`再圧縮品質 ${safeQuality.toFixed(1)} -> サイズ: ${sizeKB.toFixed(1)} KB`);
      }

      // 3. Base64エンコード
      const base64Content = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      setPhotoBase64(`data:image/jpeg;base64,${base64Content}`);
    } catch (err) {
      console.log('画像圧縮失敗 (log):', err.message || err);
      console.error('画像圧縮失敗:', err);
      Alert.alert('圧縮エラー', '画像の圧縮に失敗しました。元のままで登録します。\n\n詳細: ' + (err.message || err));
      
      // フォールバック: そのままBase64にする
      try {
        const base64Content = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        setPhotoBase64(`data:image/jpeg;base64,${base64Content}`);
      } catch (e) {
        console.log('Base64変換エラー (log):', e.message || e);
        console.error('Base64変換エラー:', e);
      }
    } finally {
      setIsProcessingPhoto(false);
    }
  };

  // 写真の削除
  const handleDeletePhoto = () => {
    Alert.alert('写真の削除', '撮影した写真を削除しますか？', [
      { text: 'キャンセル', style: 'cancel' },
      { 
        text: '削除', 
        style: 'destructive',
        onPress: () => {
          setPhotoUri(null);
          setPhotoBase64('');
        }
      }
    ]);
  };

  // フォーム送信（SQLite保存）
  const handleSubmit = async () => {
    if (!coords) {
      Alert.alert('バリデーションエラー', 'GPS座標が取得できていません。「更新」を押して再度取得してください。');
      return;
    }
    if (!category) {
      Alert.alert('項目未選択', '地点分類をボタンから選択してください。');
      return;
    }
    if (!species) {
      Alert.alert('項目未選択', '種名を選択してください。');
      return;
    }

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const surveyDate = `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD (ローカル日時基準)
    const surveyTime = now.toTimeString().split(' ')[0]; // HH:MM:SS
    const surveyId = 'survey_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 11);

    const surveyItem = {
      id: surveyId,
      username: surveyorName,
      date: surveyDate,
      time: surveyTime,
      category: category,
      species: species,
      detail: detail.trim(),
      interview: interview.trim() || '聞き取りなし',
      photo: photoBase64, // 200KB以下圧縮済みBase64
      lat: coords.latitude,
      lng: coords.longitude
    };

    try {
      await addSurvey(surveyItem);
      
      // フォームリセット
      setCategory('');
      setSpecies('イノシシ');
      setDetail('');
      setInterview('');
      setPhotoUri(null);
      setPhotoBase64('');
      
      showToast('保存成功\n調査データを端末のSQLiteデータベースに保存しました。データ管理タブから送信してください。');
      
      // 位置情報を最新のものに更新
      fetchCurrentLocation();
    } catch (error) {
      Alert.alert('エラー', 'データベースへの保存に失敗しました。');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>
          <FontAwesome5 name="pen-square" size={20} color="#1e40af" /> 現地調査入力
        </Text>

        {/* GPS現在位置表示エリア (Outlined, 高コントラスト) */}
        <View style={styles.gpsContainer}>
          <View style={styles.gpsInfo}>
            <FontAwesome5 name="map-marker-alt" size={18} color="#1e40af" style={styles.gpsIcon} />
            <View>
              <Text style={styles.gpsLabel}>現在位置:</Text>
              {isLocating ? (
                <ActivityIndicator size="small" color="#1e40af" style={styles.gpsLoader} />
              ) : coords ? (
                <Text style={styles.gpsCoords}>
                  {coords.latitude.toFixed(6)}, {coords.longitude.toFixed(6)} (±{Math.round(gpsAccuracy)}m)
                </Text>
              ) : (
                <Text style={styles.gpsCoordsWarning}>GPS位置情報未取得</Text>
              )}
            </View>
          </View>
          <TouchableOpacity style={styles.gpsRefreshButton} onPress={fetchCurrentLocation} disabled={isLocating}>
            <FontAwesome5 name="sync-alt" size={14} color="#1e40af" />
            <Text style={styles.gpsRefreshText}>更新</Text>
          </TouchableOpacity>
        </View>

        {/* 地点分類の選択 (48dp以上のタップ領域、枠線付きチップ) */}
        <Text style={styles.fieldLabel}>地点分類 <Text style={styles.required}>*</Text></Text>
        <View style={styles.chipGroup}>
          {CATEGORIES.map((item) => {
            const isSelected = category === item;
            return (
              <TouchableOpacity
                key={item}
                style={[styles.chipButton, isSelected ? styles.chipSelected : styles.chipUnselected]}
                onPress={() => setCategory(item)}
              >
                <Text style={[styles.chipText, isSelected ? styles.chipTextSelected : styles.chipTextUnselected]}>
                  {item}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* 種名の選択 */}
        <Text style={styles.fieldLabel}>種名 <Text style={styles.required}>*</Text></Text>
        <View style={styles.chipGroup}>
          {SPECIES.map((item) => {
            const isSelected = species === item;
            return (
              <TouchableOpacity
                key={item}
                style={[styles.chipButton, isSelected ? styles.chipSelected : styles.chipUnselected]}
                onPress={() => setSpecies(item)}
              >
                <Text style={[styles.chipText, isSelected ? styles.chipTextSelected : styles.chipTextUnselected]}>
                  {item}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* 情報詳細 */}
        <Text style={styles.fieldLabel} htmlFor="detail-input">情報詳細</Text>
        <TextInput
          id="detail-input"
          style={styles.textArea}
          multiline
          numberOfLines={3}
          placeholder="行動、状態、周辺環境などの詳細情報を記入"
          placeholderTextColor="#64748b"
          value={detail}
          onChangeText={setDetail}
        />

        {/* 聞き取り対象 */}
        <Text style={styles.fieldLabel} htmlFor="interview-input">聞き取り対象</Text>
        <TextInput
          id="interview-input"
          style={styles.textInput}
          placeholder="例：70代女性 など"
          placeholderTextColor="#64748b"
          value={interview}
          onChangeText={setInterview}
        />

        {/* 現地写真撮影 */}
        <Text style={styles.fieldLabel}>現地写真</Text>
        <View style={styles.photoContainer}>
          {photoUri ? (
            <View style={styles.previewContainer}>
              <Image source={{ uri: photoUri }} style={styles.photoPreview} />
              <TouchableOpacity style={styles.deletePhotoButton} onPress={handleDeletePhoto}>
                <FontAwesome5 name="trash-alt" size={14} color="#dc2626" />
                <Text style={styles.deletePhotoText}>写真を削除</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={styles.cameraTrigger} onPress={handleLaunchCamera} disabled={isProcessingPhoto}>
              {isProcessingPhoto ? (
                <ActivityIndicator size="large" color="#1e40af" />
              ) : (
                <>
                  <FontAwesome5 name="camera" size={32} color="#64748b" />
                  <Text style={styles.cameraTriggerText}>カメラを起動して撮影</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* 保存ボタン (高コントラスト) */}
        <TouchableOpacity style={styles.submitButton} onPress={handleSubmit}>
          <FontAwesome5 name="save" size={18} color="#ffffff" style={styles.submitIcon} />
          <Text style={styles.submitButtonText}>保存</Text>
        </TouchableOpacity>
      </View>
      </ScrollView>
      {toastVisible && (
        <View style={styles.toastContainer}>
          <FontAwesome5 name="check-circle" size={20} color="#ffffff" style={styles.toastIcon} />
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      )}
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
    paddingBottom: 100, // ボトムタブバーとの干渉を防ぐ
  },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: 'rgba(15, 23, 42, 0.16)',
    borderRadius: 16,
    padding: 20,
    elevation: 3,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
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
  gpsContainer: {
    borderWidth: 2,
    borderColor: '#93c5fd',
    backgroundColor: '#eff6ff',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  gpsInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  gpsIcon: {
    marginRight: 10,
  },
  gpsLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e40af',
  },
  gpsCoords: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1e40af',
  },
  gpsCoordsWarning: {
    fontSize: 16,
    fontWeight: '800',
    color: '#d97706',
  },
  gpsLoader: {
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  gpsRefreshButton: {
    borderWidth: 2,
    borderColor: '#1e40af',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
  },
  gpsRefreshText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#1e40af',
    marginLeft: 6,
  },
  fieldLabel: {
    fontSize: 19, // 高齢者/フィールド視認性向上のため19px基準
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 16,
    marginBottom: 8,
  },
  required: {
    color: '#dc2626',
  },
  chipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  chipButton: {
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: 2,
    minHeight: 48, // 48dp以上のタップ領域
    justifyContent: 'center',
    alignItems: 'center',
  },
  chipSelected: {
    backgroundColor: '#1e40af',
    borderColor: '#1e40af',
  },
  chipUnselected: {
    backgroundColor: '#ffffff',
    borderColor: '#94a3b8',
  },
  chipText: {
    fontSize: 16,
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
    borderColor: '#94a3b8',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 18,
    color: '#0f172a',
    fontWeight: '600',
    marginBottom: 16,
  },
  textArea: {
    borderWidth: 2,
    borderColor: '#94a3b8',
    borderRadius: 10,
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 18,
    color: '#0f172a',
    fontWeight: '600',
    height: 100,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  photoContainer: {
    borderWidth: 2,
    borderColor: '#94a3b8',
    borderStyle: 'dashed',
    borderRadius: 14,
    backgroundColor: '#f8fafc',
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  cameraTrigger: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    width: '100%',
    minHeight: 80,
  },
  cameraTriggerText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#64748b',
    marginTop: 8,
  },
  previewContainer: {
    alignItems: 'center',
    width: '100%',
  },
  photoPreview: {
    width: '100%',
    height: 200,
    borderRadius: 10,
    resizeMode: 'cover',
    marginBottom: 12,
  },
  deletePhotoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#dc2626',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 40,
    backgroundColor: '#ffffff',
  },
  deletePhotoText: {
    fontSize: 14,
    fontWeight: '800',
    color: '#dc2626',
    marginLeft: 6,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e40af',
    borderRadius: 12,
    paddingVertical: 16,
    minHeight: 56, // 押しやすい大きなボタン
    elevation: 3,
    shadowColor: '#1e40af',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 5,
    marginTop: 10,
  },
  submitIcon: {
    marginRight: 8,
  },
  submitButtonText: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '800',
  },
  toastContainer: {
    position: 'absolute',
    bottom: 30,
    left: 20,
    right: 20,
    backgroundColor: '#059669', // Emerald success green
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
    zIndex: 9999,
  },
  toastIcon: {
    marginRight: 10,
  },
  toastText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
    textAlign: 'center',
    flexShrink: 1,
  },
});
