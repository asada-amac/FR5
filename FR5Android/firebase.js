import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  deleteDoc, 
  collection, 
  onSnapshot,
  serverTimestamp 
} from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { firebaseConfig } from './config';
import { getTracksBySession } from './db';

// Firebase初期化 (シングルトンパターン)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const dbFirestore = getFirestore(app);
const auth = getAuth(app);

// 匿名ログインの実行
export async function loginAnonymously() {
  try {
    if (auth.currentUser) {
      console.log('Firebase すでにログイン済みです: ', auth.currentUser.uid);
      return true;
    }
    const userCredential = await signInAnonymously(auth);
    console.log('Firebase 匿名ログイン成功: ', userCredential.user.uid);
    return true;
  } catch (error) {
    console.error('Firebase 匿名ログイン失敗: ', error);
    return false;
  }
}

// 自身の位置情報をFirestoreに送信・更新
export async function updateRealtimeLocation(username, lat, lng, sessionId) {
  if (!username || !lat || !lng) return;
  
  try {
    const docRef = doc(dbFirestore, 'active_users', username);
    
    // SQLiteから現在のセッションの軌跡データを取得してアップロード用パス配列を作成
    const sessionTracks = getTracksBySession(sessionId || 'no_session');
    const pathData = sessionTracks.map(t => ({ lat: t.lat, lng: t.lng }));

    await setDoc(docRef, {
      username: username,
      lat: lat,
      lng: lng,
      timestamp: serverTimestamp(),
      sessionId: sessionId || 'no_session',
      path: pathData
    }, { merge: true });

    console.log(`リアルタイム位置をFirestoreに同期しました: ${username} (軌跡: ${pathData.length}点)`);
  } catch (error) {
    console.error('Firestore位置同期失敗 (山林内/オフラインの可能性あり):', error);
  }
}

// 自身の位置情報をFirestoreから削除 (トラッキング停止・ログアウト時)
export async function removeRealtimeLocation(username) {
  if (!username) return;
  try {
    const docRef = doc(dbFirestore, 'active_users', username);
    await deleteDoc(docRef);
    console.log(`Firestoreから位置情報を削除しました: ${username}`);
  } catch (error) {
    console.error('Firestore位置削除失敗:', error);
  }
}

// 他の調査員の現在地と軌跡のリッスン (リアルタイム監視)
export function listenToOtherUsers(currentUsername, onUpdate) {
  const activeUsersCol = collection(dbFirestore, 'active_users');
  
  return onSnapshot(activeUsersCol, (snapshot) => {
    const otherUsers = [];
    const now = new Date();
    
    snapshot.forEach((doc) => {
      const username = doc.id;
      // 自分自身は除外
      if (username === currentUsername) return;

      const data = doc.data();
      if (!data) return;

      const timestamp = (data.timestamp && typeof data.timestamp.toDate === 'function') 
        ? data.timestamp.toDate() 
        : new Date();

      // 最終更新からの経過時間（分）を算出
      const diffMin = Math.round((now - timestamp) / 60000);

      // 12分以上位置更新がないユーザーは非アクティブと判断して除外 (10分間隔の定期更新に合わせた安全マージン)
      if (diffMin > 12) return;

      otherUsers.push({
        username,
        lat: data.lat,
        lng: data.lng,
        timestamp: timestamp,
        sessionId: data.sessionId,
        path: data.path || []
      });
    });

    onUpdate(otherUsers);
  }, (error) => {
    console.error('他調査員の監視エラー (オフラインかも):', error);
  });
}
