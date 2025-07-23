import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as FileSystem from "expo-file-system";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  AppStateStatus,
  BackHandler,
  NativeModules,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

const TV_SAFE_AREA_MARGIN = 48;
const API_CHECK_INTERVAL = 30 * 60 * 1000;
const RETRY_DELAY = 60 * 1000;
const MAX_RETRIES = 5;
const WEBVIEW_REFRESH_INTERVAL = 6 * 60 * 60 * 1000;
const CACHE_DIR = `${FileSystem.documentDirectory}signage_cache/`;

export default function SignageApp() {
  // State
  const [currentAssetIndex, setCurrentAssetIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [assets, setAssets] = useState<any[]>([]);
  const [networkStatus, setNetworkStatus] = useState(true);
  const [retryCount, setRetryCount] = useState(0);
  const [cachedAssets, setCachedAssets] = useState<Map<string, string>>(
    new Map()
  );

  // Refs
  const webViewRef = useRef<WebView>(null);
  const playbackTimer = useRef<NodeJS.Timeout | null>(null);
  const apiCheckTimer = useRef<NodeJS.Timeout | null>(null);
  const retryTimer = useRef<NodeJS.Timeout | null>(null);
  const webViewRefreshTimer = useRef<NodeJS.Timeout | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const lastApiResponseRef = useRef<string>("");
  const downloadQueue = useRef<Set<string>>(new Set());

  // Initialize cache directory
  const initCacheDirectory = useCallback(async () => {
    try {
      const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
        console.log("Cache directory created");
      }
    } catch (error) {
      console.error("Failed to create cache directory:", error);
    }
  }, []);

  // Get user-configurable device name from Android settings
  const getDeviceName = useCallback(async () => {
    try {
      let savedDeviceName = await AsyncStorage.getItem("deviceName");

      if (!savedDeviceName) {
        let actualDeviceName = null;

        try {
          const { AndroidSettingsModule } = NativeModules;

          if (AndroidSettingsModule) {
            // Get the device name that users can set in Android Settings > About Device > Device Name
            actualDeviceName = await AndroidSettingsModule.getDeviceName();
            console.log("Got Android device name:", actualDeviceName);
          }
        } catch (e) {
          console.error("Failed to get Android device name:", e);
          throw new Error(
            "Cannot retrieve device name. Please ensure the device has a configured name in Android Settings."
          );
        }

        // Validate we got a real device name
        if (
          !actualDeviceName ||
          actualDeviceName === "unknown" ||
          actualDeviceName === "" ||
          actualDeviceName.toLowerCase().includes("mbox") ||
          actualDeviceName.toLowerCase().includes("android")
        ) {
          throw new Error(
            "Device name not properly configured. Please set a unique device name in Android Settings > About Device > Device Name"
          );
        }

        // Clean for URL safety
        savedDeviceName = actualDeviceName
          .replace(/[^a-zA-Z0-9-_.]/g, "_")
          .replace(/_{2,}/g, "_")
          .toLowerCase();

        await AsyncStorage.setItem("deviceName", savedDeviceName ?? "");
        console.log("Device name saved:", savedDeviceName);
      }

      setDeviceName(savedDeviceName ?? "");
      return savedDeviceName ?? "";
    } catch (error) {
      console.error("Error getting device name:", error);
      throw error; // Don't continue without proper device name
    }
  }, []);

  // Cache utilities
  const getCacheFilename = (url: string, filetype: string): string => {
    const urlHash = url.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
    const extension =
      filetype === "url" || filetype === "html" ? "html" : filetype;
    return `${urlHash}.${extension}`;
  };

  const isAssetCached = useCallback(
    async (filepath: string, filetype: string): Promise<string | null> => {
      try {
        const filename = getCacheFilename(filepath, filetype);
        const localPath = `${CACHE_DIR}${filename}`;
        const fileInfo = await FileSystem.getInfoAsync(localPath);

        if (fileInfo.exists) {
          console.log(`Asset cached: ${filename}`);
          return localPath;
        }
        return null;
      } catch (error) {
        console.error("Cache check error:", error);
        return null;
      }
    },
    []
  );

  const downloadAndCacheAsset = useCallback(
    async (filepath: string, filetype: string): Promise<string | null> => {
      const filename = getCacheFilename(filepath, filetype);
      const localPath = `${CACHE_DIR}${filename}`;

      if (downloadQueue.current.has(filepath)) {
        console.log(`Already downloading: ${filename}`);
        return null;
      }

      downloadQueue.current.add(filepath);

      try {
        console.log(`Downloading asset: ${filename}`);

        if (
          ["png", "jpg", "jpeg", "gif", "webp", "mp4", "pdf"].includes(
            filetype.toLowerCase()
          )
        ) {
          const downloadResult = await FileSystem.downloadAsync(
            filepath,
            localPath
          );

          if (downloadResult.status === 200) {
            console.log(`Downloaded: ${filename}`);
            return localPath;
          } else {
            throw new Error(
              `Download failed with status: ${downloadResult.status}`
            );
          }
        }

        if (filetype === "html" || filetype === "url") {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);
          try {
            const response = await fetch(filepath, {
              headers: { "User-Agent": "SignageApp/1.0" },
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const htmlContent = await response.text();
            await FileSystem.writeAsStringAsync(localPath, htmlContent);
            console.log(`Cached HTML: ${filename}`);
            return localPath;
          } catch (error) {
            clearTimeout(timeoutId);
            throw error;
          }
        }

        return null;
      } catch (error) {
        console.error(`Failed to download ${filename}:`, error);
        try {
          await FileSystem.deleteAsync(localPath, { idempotent: true });
        } catch (e) {
          // Ignore cleanup errors
        }
        return null;
      } finally {
        downloadQueue.current.delete(filepath);
      }
    },
    []
  );

  const getAssetPath = useCallback(
    async (filepath: string, filetype: string): Promise<string> => {
      const cachedPath = await isAssetCached(filepath, filetype);
      if (cachedPath) {
        return cachedPath;
      }

      if (networkStatus) {
        const downloadedPath = await downloadAndCacheAsset(filepath, filetype);
        if (downloadedPath) {
          return downloadedPath;
        }
      }

      console.log(`Using original URL for: ${filepath}`);
      return filepath;
    },
    [networkStatus, isAssetCached, downloadAndCacheAsset]
  );

  // Network monitoring
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected ?? false;
      setNetworkStatus(connected);

      if (connected && error && retryCount < MAX_RETRIES) {
        setTimeout(() => initializeApp(), 3000);
      }
    });

    return () => unsubscribe();
  }, [error, retryCount]);

  // App state monitoring
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (appStateRef.current === "background" && nextAppState === "active") {
        console.log("App resumed from background");
        if (error || assets.length === 0) {
          setTimeout(() => initializeApp(), 2000);
        }
      }
      appStateRef.current = nextAppState;
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange
    );
    return () => subscription?.remove();
  }, [error, assets.length]);

  // API fetch
  const fetchPlaylist = useCallback(
    async (deviceName: string) => {
      if (!networkStatus) {
        throw new Error("No network connection");
      }

      try {
        const apiUrl = `https://www.applicationbank.com/signage/api.php?id=${deviceName}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`API Error: ${response.status}`);
        }

        const data = await response.json();

        const responseString = JSON.stringify(data);
        const hasChanged = lastApiResponseRef.current !== responseString;
        lastApiResponseRef.current = responseString;

        if (data.functions?.is_restarting) {
          console.log("Restart flag detected - clearing cache");
          try {
            await AsyncStorage.clear();
            await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
            await initCacheDirectory();
          } catch (e) {
            console.error("Cache clear failed:", e);
          }
        }

        if (!data.playlists?.[0]?.assets) {
          throw new Error("No valid playlist data");
        }

        const playlist =
          data.playlists.find((p: any) => p.is_default) || data.playlists[0];

        const essentialAssets = playlist.assets
          .filter(
            (asset: any) =>
              asset.filepath && asset.time && parseInt(asset.time) > 0
          )
          .sort(
            (a: any, b: any) =>
              parseInt(a.playing_order || 0) - parseInt(b.playing_order || 0)
          )
          .map((asset: any) => ({
            filepath: asset.filepath,
            filetype: asset.filetype.toLowerCase(),
            time: parseInt(asset.time),
            name: asset.name || null,
          }));

        if (essentialAssets.length === 0) {
          throw new Error("No valid assets found");
        }

        console.log(`Loaded ${essentialAssets.length} assets`);
        return { assets: essentialAssets, hasChanged };
      } catch (error) {
        if ((error as any).name === "AbortError") {
          throw new Error("Request timeout");
        }
        throw error;
      }
    },
    [networkStatus]
  );

  // Timer cleanup
  const clearAllTimers = useCallback(() => {
    if (playbackTimer.current) {
      clearTimeout(playbackTimer.current);
      playbackTimer.current = null;
    }
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  // Asset playback
  const playAsset = useCallback(
    (assetIndex: number) => {
      if (!assets[assetIndex]) return;

      const asset = assets[assetIndex];
      console.log(
        `Playing asset ${assetIndex + 1}/${assets.length}: ${
          asset.name || "Unnamed"
        }`
      );

      clearAllTimers();

      const duration = Math.max(asset.time * 1000, 5000);

      playbackTimer.current = setTimeout(() => {
        const nextIndex = (assetIndex + 1) % assets.length;
        setCurrentAssetIndex(nextIndex);
        playAsset(nextIndex);
      }, duration);
    },
    [assets, clearAllTimers]
  );

  // Retry logic
  const scheduleRetry = useCallback(() => {
    if (retryCount >= MAX_RETRIES) {
      setError(
        "Max retries exceeded. Check network connection and device name configuration."
      );
      return;
    }

    const delay = Math.min(RETRY_DELAY * Math.pow(2, retryCount), 300000);
    console.log(`Retry ${retryCount + 1}/${MAX_RETRIES} in ${delay / 1000}s`);

    retryTimer.current = setTimeout(() => {
      setRetryCount((prev) => prev + 1);
      initializeApp();
    }, delay);
  }, [retryCount]);

  // Pre-cache assets
  const preCacheAssets = useCallback(
    async (assets: any[]) => {
      if (!networkStatus) return;

      console.log("Starting background asset pre-caching...");

      for (let i = 0; i < Math.min(assets.length, 5); i++) {
        const asset = assets[i];
        try {
          await getAssetPath(asset.filepath, asset.filetype);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Pre-cache failed for asset ${i}:`, error);
        }
      }

      console.log("Pre-caching completed");
    },
    [networkStatus, getAssetPath]
  );

  // Main initialization
  const initializeApp = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      clearAllTimers();

      console.log("Initializing app...");

      const deviceName = await getDeviceName();
      const result = await fetchPlaylist(deviceName ?? "");

      if (result.hasChanged || assets.length === 0) {
        setAssets(result.assets);
        setCurrentAssetIndex(0);

        setTimeout(() => {
          playAsset(0);
        }, 100);

        // Start pre-caching
        setTimeout(() => preCacheAssets(result.assets), 2000);
      }

      setRetryCount(0);
      setIsLoading(false);
      console.log("Initialization complete");
    } catch (error) {
      console.error("Init error:", error);
      setError(error instanceof Error ? error.message : String(error));
      setIsLoading(false);
      scheduleRetry();
    }
  }, [
    getDeviceName,
    fetchPlaylist,
    assets.length,
    clearAllTimers,
    playAsset,
    scheduleRetry,
    preCacheAssets,
  ]);

  // Periodic checks
  const startPeriodicCheck = useCallback(() => {
    if (apiCheckTimer.current) {
      clearInterval(apiCheckTimer.current);
    }

    apiCheckTimer.current = setInterval(async () => {
      if (!networkStatus || isLoading) return;

      try {
        const periodicResult = await fetchPlaylist(deviceName ?? "");

        if (
          periodicResult.hasChanged &&
          periodicResult.assets.length !== assets.length
        ) {
          console.log("Playlist changed significantly, restarting");
          setAssets(periodicResult.assets);
          setCurrentAssetIndex(0);
          clearAllTimers();
          setTimeout(() => playAsset(0), 100);
          setTimeout(() => preCacheAssets(periodicResult.assets), 1000);
        }
      } catch (error) {
        console.error("Periodic check failed:", error);
      }
    }, API_CHECK_INTERVAL);
  }, [
    deviceName,
    networkStatus,
    isLoading,
    fetchPlaylist,
    assets.length,
    clearAllTimers,
    playAsset,
    preCacheAssets,
  ]);

  const startWebViewRefresh = useCallback(() => {
    if (webViewRefreshTimer.current) {
      clearInterval(webViewRefreshTimer.current);
    }

    webViewRefreshTimer.current = setInterval(() => {
      console.log("Refreshing WebView for memory cleanup");
      webViewRef.current?.reload();
    }, WEBVIEW_REFRESH_INTERVAL);
  }, []);

  // Prevent back button
  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      "hardwareBackPress",
      () => true
    );
    return () => backHandler.remove();
  }, []);

  // Initialize
  useEffect(() => {
    initCacheDirectory().then(() => {
      initializeApp();
    });

    return () => {
      clearAllTimers();
      if (apiCheckTimer.current) clearInterval(apiCheckTimer.current);
      if (webViewRefreshTimer.current)
        clearInterval(webViewRefreshTimer.current);
    };
  }, []);

  // Start periodic checks
  useEffect(() => {
    if (assets.length > 0 && !error) {
      startPeriodicCheck();
      startWebViewRefresh();
    }
    return () => {
      if (apiCheckTimer.current) clearInterval(apiCheckTimer.current);
      if (webViewRefreshTimer.current)
        clearInterval(webViewRefreshTimer.current);
    };
  }, [assets.length, error, startPeriodicCheck, startWebViewRefresh]);

  const currentAsset = assets[currentAssetIndex];
  const [localPath, setLocalPath] = useState<string>(
    currentAsset?.filepath ?? ""
  );

  useEffect(() => {
    if (currentAsset) {
      setLocalPath(currentAsset.filepath);
      getAssetPath(currentAsset.filepath, currentAsset.filetype).then(
        setLocalPath
      );
    }
  }, [currentAsset]);

  // Asset rendering with caching
  const renderCurrentAsset = () => {
    if (!currentAsset) return null;
    const { filetype, filepath } = currentAsset;

    if (filetype === "html" || filetype === "url") {
      const isLocal = localPath.startsWith("file://");

      return (
        <WebView
          ref={webViewRef}
          source={{ uri: localPath }}
          style={styles.webview}
          javaScriptEnabled={true}
          domStorageEnabled={false}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          cacheEnabled={isLocal}
          incognito={!isLocal}
          androidLayerType="hardware"
          onError={() => {
            console.error("WebView error");
            if (localPath !== filepath) {
              setLocalPath(filepath);
            } else {
              const nextIndex = (currentAssetIndex + 1) % assets.length;
              setCurrentAssetIndex(nextIndex);
            }
          }}
          onLoadStart={() =>
            console.log("Loading:", isLocal ? "cached" : "remote", localPath)
          }
        />
      );
    }

    if (["png", "jpg", "jpeg", "gif", "webp"].includes(filetype)) {
      const isLocal = localPath.startsWith("file://");

      return (
        <WebView
          source={{
            html: `<!DOCTYPE html>
              <html>
                <head>
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <style>
                    * { margin: 0; padding: 0; }
                    body { 
                      background: black; 
                      display: flex; 
                      justify-content: center; 
                      align-items: center; 
                      height: 100vh;
                      overflow: hidden;
                    }
                    img { 
                      max-width: 100vw; 
                      max-height: 100vh; 
                      object-fit: contain;
                    }
                  </style>
                </head>
                <body>
                  <img src="${localPath}" alt="Signage" />
                </body>
              </html>`,
          }}
          style={styles.webview}
          javaScriptEnabled={false}
          domStorageEnabled={false}
          cacheEnabled={isLocal}
          incognito={!isLocal}
          onError={() => {
            console.error("Image load error");
            if (localPath !== filepath) {
              setLocalPath(filepath);
            } else {
              const nextIndex = (currentAssetIndex + 1) % assets.length;
              setCurrentAssetIndex(nextIndex);
            }
          }}
        />
      );
    }

    return (
      <View style={styles.centerContainer}>
        <Text style={styles.unsupportedText}>Unsupported: {filetype}</Text>
      </View>
    );
  };

  // Loading screen
  if (isLoading) {
    return (
      <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.centerContainer}>
          <Text style={styles.loadingText}>Loading Signage...</Text>
          <Text style={styles.deviceText}>Device: {deviceName}</Text>
          <Text style={styles.statusText}>
            Network: {networkStatus ? "Connected" : "Disconnected"}
          </Text>
          {retryCount > 0 && (
            <Text style={styles.retryText}>
              Retry: {retryCount}/{MAX_RETRIES}
            </Text>
          )}
        </View>
      </View>
    );
  }

  // Error screen
  if (error) {
    return (
      <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.centerContainer}>
          <Text style={styles.errorTitle}>Configuration Error</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.deviceText}>Device: {deviceName}</Text>
          <Text style={styles.statusText}>
            Network: {networkStatus ? "Connected" : "Disconnected"}
          </Text>
          {retryCount < MAX_RETRIES && (
            <Text style={styles.retryText}>
              Retrying... ({retryCount + 1}/{MAX_RETRIES})
            </Text>
          )}
        </View>
      </View>
    );
  }

  if (!currentAsset) {
    return (
      <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.centerContainer}>
          <Text style={styles.errorText}>No content available</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      {renderCurrentAsset()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: TV_SAFE_AREA_MARGIN,
    paddingVertical: TV_SAFE_AREA_MARGIN,
  },
  loadingText: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 16,
  },
  deviceText: {
    color: "#cccccc",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 8,
  },
  statusText: {
    color: "#888888",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 8,
  },
  retryText: {
    color: "#ffaa00",
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
  },
  errorTitle: {
    color: "#ff4444",
    fontSize: 24,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 16,
  },
  errorText: {
    color: "#ff6666",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 16,
    paddingHorizontal: 20,
  },
  webview: {
    flex: 1,
    backgroundColor: "#000000",
  },
  unsupportedText: {
    color: "#ffffff",
    fontSize: 20,
    textAlign: "center",
  },
});
