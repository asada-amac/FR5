import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { addTrackPoint } from './db';
import { updateRealtimeLocation } from './firebase';

export const LOCATION_TRACKING_TASK = 'LOCATION_TRACKING_TASK';

// ==========================================
// 1. バックグラウンドGPSタスクの定義
// ==========================================
TaskManager.defineTask(LOCATION_TRACKING_TASK, async ({ data, error }) => {
  if (error) {
    console.error('バックグラウンドGPSタスクエラー:', error);
    return;
  }
  if (data) {
    const { locations } = data;
    if (locations && locations.length > 0) {
      const location = locations[0];
      const lat = location.coords.latitude;
      const lng = location.coords.longitude;
      const accuracy = location.coords.accuracy;
      const now = Date.now();

      // セッションIDとトラッキング状態の取得
      const sessionId = await AsyncStorage.getItem('current_session_id');
      const surveyorName = await AsyncStorage.getItem('surveyor_name') || '匿名調査員';
      const isTracking = await AsyncStorage.getItem('is_tracking') === 'true';

      if (isTracking && sessionId) {
        // 前回のSQLite記録時間との比較 (1分おきに蓄積)
        const lastTimeStr = await AsyncStorage.getItem('last_track_time');
        const lastTime = lastTimeStr ? parseInt(lastTimeStr, 10) : 0;

        // 50秒以上経過していたらSQLiteに記録
        if (now - lastTime >= 50000) {
          addTrackPoint({
            sessionId: sessionId,
            username: surveyorName,
            timestamp: now,
            lat: lat,
            lng: lng
          });
          await AsyncStorage.setItem('last_track_time', now.toString());
          console.log(`[Background] 軌跡をSQLiteに記録: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);

          // 10分おきのFirestoreへのリアルタイム送信スロットリング
          const lastRealtimeTimeStr = await AsyncStorage.getItem('last_realtime_send_time');
          const lastRealtimeTime = lastRealtimeTimeStr ? parseInt(lastRealtimeTimeStr, 10) : 0;

          if (now - lastRealtimeTime >= 600000) { // 600,000ms = 10分
            try {
              await updateRealtimeLocation(surveyorName, lat, lng, sessionId);
              await AsyncStorage.setItem('last_realtime_send_time', now.toString());
            } catch (err) {
              console.warn('[Background] Firestore同期エラー (オフライン状態の可能性あり):', err);
            }
          }
        }
      }
    }
  }
});

// ==========================================
// 2. トラッキング制御関数
// ==========================================

// GPSトラッキングの開始
export async function startLocationTracking() {
  try {
    // 1. 位置情報の権限要求 (フォアグラウンド)
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      throw new Error('位置情報(フォアグラウンド)の権限が拒否されました');
    }

    // 2. 位置情報の権限要求 (バックグラウンド)
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus !== 'granted') {
      throw new Error('位置情報(バックグラウンド)の権限が拒否されました。スリープ時の記録には「常に許可」が必要です。');
    }

    // 3. すでに開始されているか確認
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TRACKING_TASK);
    if (hasStarted) {
      console.log('すでにバックグラウンドGPSタスクは開始されています');
      return true;
    }

    // 4. トラッキング開始 (通知を伴うAndroidフォアグラウンドサービス)
    await Location.startLocationUpdatesAsync(LOCATION_TRACKING_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 15000, // 15秒ごとにイベント受信 (SQLite側で1分にスロットリング)
      distanceInterval: 5, // 5メートル以上移動で取得
      showsBackgroundLocationIndicator: true, // iOS用のステータスバー表示
      foregroundService: {
        notificationTitle: "FR5 トラック中",
        notificationBody: "山林内の位置情報をバックグラウンドで記録しています",
        notificationColor: "#1e40af"
      }
    });

    console.log('バックグラウンドGPSタスクを開始しました');
    return true;
  } catch (error) {
    console.error('バックグラウンドGPS開始失敗:', error);
    throw error;
  }
}

// GPSトラッキングの停止
export async function stopLocationTracking() {
  try {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TRACKING_TASK);
    if (hasStarted) {
      await Location.stopLocationUpdatesAsync(LOCATION_TRACKING_TASK);
      console.log('バックグラウンドGPSタスクを停止しました');
    }
    return true;
  } catch (error) {
    console.error('バックグラウンドGPS停止失敗:', error);
    return false;
  }
}
