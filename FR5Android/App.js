import React, { useState, useEffect } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  TextInput, 
  TouchableOpacity, 
  StatusBar, 
  Alert,
  Platform
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FontAwesome5 } from '@expo/vector-icons';

import { initDatabase, getAllSurveys } from './db';
import MapScreen from './screens/MapScreen';
import SurveyFormScreen from './screens/SurveyFormScreen';
import DataManagementScreen from './screens/DataManagementScreen';

export default function App() {
  const insets = useSafeAreaInsets();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [activeTab, setActiveTab] = useState('map');
  const [surveyCount, setSurveyCount] = useState(0);

  // 起動時の初期化
  useEffect(() => {
    // 1. SQLiteの初期化
    initDatabase();
    
    // 2. ログイン状態の確認
    checkLoginStatus();

    // 3. データ件数の定期更新タイマー
    const timer = setInterval(updateBadgeCount, 3000);
    return () => clearInterval(timer);
  }, []);

  const checkLoginStatus = async () => {
    const savedName = await AsyncStorage.getItem('surveyor_name');
    if (savedName) {
      setIsLoggedIn(true);
    }
  };

  const updateBadgeCount = () => {
    if (isLoggedIn) {
      const surveys = getAllSurveys();
      setSurveyCount(surveys.length);
    }
  };

  // ログイン処理
  const handleLogin = async () => {
    const trimmed = usernameInput.trim();
    if (!trimmed) {
      Alert.alert('入力エラー', '調査者名を入力してください。');
      return;
    }

    try {
      await AsyncStorage.setItem('surveyor_name', trimmed);
      setIsLoggedIn(true);
    } catch (error) {
      Alert.alert('エラー', 'ログイン情報の保存に失敗しました。');
    }
  };

  // ログアウト・ユーザー名変更時のリセット処理
  const handleLogout = async () => {
    setIsLoggedIn(false);
    setUsernameInput('');
    setActiveTab('map');
  };

  // ログイン前のUI
  if (!isLoggedIn) {
    return (
      <SafeAreaView style={styles.loginContainer}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.loginCard}>
          <FontAwesome5 name="map-marked-alt" size={60} color="#1e40af" style={styles.loginIcon} />
          <Text style={styles.loginTitle}>FR5</Text>
          <Text style={styles.loginSubtitle}>
            調査を開始する前に、あなたの調査者名を入力してください。
          </Text>

          <TextInput
            style={styles.loginInput}
            placeholder="調査者名を入力"
            placeholderTextColor="#94a3b8"
            value={usernameInput}
            onChangeText={setUsernameInput}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <TouchableOpacity style={styles.loginButton} onPress={handleLogin}>
            <Text style={styles.loginButtonText}>ログインして調査開始</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ログイン後のメイン画面 (自作ボトムタブによる安定制御)
  const bottomPadding = insets.bottom > 0 ? insets.bottom : (Platform.OS === 'android' ? 6 : 0);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      
      {/* 画面コンテンツの出し分け */}
      <View style={styles.mainContent}>
        {activeTab === 'map' && <MapScreen isActive={activeTab === 'map'} />}
        {activeTab === 'form' && <SurveyFormScreen isActive={activeTab === 'form'} />}
        {activeTab === 'data' && (
          <DataManagementScreen 
            isActive={activeTab === 'data'} 
            onLogout={handleLogout} 
          />
        )}
      </View>

      {/* ボトムタブナビゲーション (アイコンのみの極小スタイル) */}
      <View style={[styles.tabBar, { paddingBottom: bottomPadding, height: 32 + bottomPadding }]}>
          {/* 調査マップタブ */}
          <TouchableOpacity 
            style={styles.tabItem} 
            onPress={() => {
              console.log('Tab pressed: map');
              setActiveTab('map');
            }}
          >
            <FontAwesome5 
              name="map" 
              size={22} 
              color={activeTab === 'map' ? '#1e40af' : '#64748b'} 
              style={{ marginTop: 1 }}
            />
          </TouchableOpacity>

          {/* 新規調査タブ */}
          <TouchableOpacity 
            style={styles.tabItem} 
            onPress={() => {
              console.log('Tab pressed: form');
              setActiveTab('form');
            }}
          >
            <FontAwesome5 
              name="plus-circle" 
              size={22} 
              color={activeTab === 'form' ? '#1e40af' : '#64748b'} 
              style={{ marginTop: 1 }}
            />
          </TouchableOpacity>

          {/* データ管理タブ (バッジカウンター付き) */}
          <TouchableOpacity 
            style={styles.tabItem} 
            onPress={() => {
              console.log('Tab pressed: data');
              setActiveTab('data');
            }}
          >
            <View style={styles.badgeContainer}>
              <FontAwesome5 
                name="poll-h" 
                size={22} 
                color={activeTab === 'data' ? '#1e40af' : '#64748b'} 
                style={{ marginTop: 1 }}
              />
              {surveyCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{surveyCount}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  mainContent: {
    flex: 1,
    overflow: 'hidden',
  },
  loginContainer: {
    flex: 1,
    backgroundColor: '#cbd5e1', // 屋外用高コントラスト
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loginCard: {
    backgroundColor: '#ffffff',
    borderWidth: 3,
    borderColor: 'rgba(15, 23, 42, 0.16)',
    borderRadius: 20,
    padding: 30,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    elevation: 5,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
  },
  loginIcon: {
    marginBottom: 16,
  },
  loginTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#1e40af',
    marginBottom: 12,
  },
  loginSubtitle: {
    fontSize: 15,
    color: '#64748b',
    textAlign: 'center',
    marginBottom: 24,
    fontWeight: '600',
    lineHeight: 22,
  },
  loginInput: {
    borderWidth: 2,
    borderColor: '#94a3b8',
    borderRadius: 10,
    width: '100%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    fontSize: 18,
    color: '#0f172a',
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 20,
    backgroundColor: '#ffffff',
  },
  loginButton: {
    backgroundColor: '#1e40af',
    borderRadius: 12,
    paddingVertical: 14,
    width: '100%',
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
  loginButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
  },
  tabBar: {
    height: 32,
    borderTopWidth: 2,
    borderTopColor: 'rgba(15, 23, 42, 0.16)',
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    elevation: 10,
    zIndex: 1000,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 0,
    height: 32,
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  tabLabelActive: {
    color: '#1e40af',
    fontWeight: '800',
  },
  tabLabelInactive: {
    color: '#64748b',
  },
  badgeContainer: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -10,
    backgroundColor: '#dc2626',
    borderRadius: 9,
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#ffffff',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '900',
  },
});
