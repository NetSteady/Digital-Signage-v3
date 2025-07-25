import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as FileSystem from "expo-file-system";
import { useKeepAwake } from "expo-keep-awake";
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
const API_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
const RETRY_DELAY = 60 * 1000; // 1 minute
const MAX_RETRIES = 5;
const WEBVIEW_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_DIR = `${FileSystem.documentDirectory}signage_cache/`;

interface Asset {
  filepath: string;
  filetype: string;
  time: number;
  name: string | null;
}

interface ApiResponse {
  functions?: {
    is_restarting?: boolean;
  };
  playlists?: Array<{
    is_default?: boolean;
    assets: Array<{
      filepath: string;
      filetype: string;
      time: string;
      name?: string;
      playing_order?: string;
    }>;
  }>;
}

export default function SignageApp() {
  // State
  const [currentAssetIndex, setCurrentAssetIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [networkStatus, setNetworkStatus] = useState(true);
  const [retryCount, setRetryCount] = useState(0);

  // Refs - Fixed timer types for React Native
  const webViewRef = useRef<WebView>(null);
  const playbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiCheckTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webViewRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const appStateRef = useRef(AppState.currentState);
  const lastApiResponseRef = useRef<string>("");
  const downloadQueue = useRef<Set<string>>(new Set());

  useKeepAwake(); //keeping the app awake

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
  const getDeviceName = useCallback(async (): Promise<string> => {
    try {
      let savedDeviceName = await AsyncStorage.getItem("deviceName");

      if (!savedDeviceName) {
        let actualDeviceName: string | null = null;

        try {
          const { AndroidSettingsModule } = NativeModules;

          if (AndroidSettingsModule) {
            // Get the device name that users can set in Android Settings > About Device > Device Name
            actualDeviceName = await AndroidSettingsModule.getDeviceName();
            console.log("Got Android device name:", actualDeviceName);
          }
        } catch (e) {
          console.error("Failed to get Android device name:", e);
          // For T95 TV boxes, provide a fallback
          actualDeviceName = "T95_TV_Box";
          console.log("Using fallback device name for TV box");
        }

        // Validate we got a real device name
        if (
          !actualDeviceName ||
          actualDeviceName === "unknown" ||
          actualDeviceName === ""
        ) {
          // Generate a unique identifier for the TV box
          actualDeviceName = `T95_${Math.random().toString(36).substr(2, 9)}`;
          console.log("Generated unique device name:", actualDeviceName);
        }

        // Clean for URL safety
        savedDeviceName = actualDeviceName
          .replace(/[^a-zA-Z0-9-_.]/g, "_")
          .replace(/_{2,}/g, "_")
          .toLowerCase();

        await AsyncStorage.setItem("deviceName", savedDeviceName);
        console.log("Device name saved:", savedDeviceName);
      }

      setDeviceName(savedDeviceName);
      return savedDeviceName;
    } catch (error) {
      console.error("Error getting device name:", error);
      // Fallback for TV boxes
      const fallbackName = `tvbox_${Date.now()}`;
      setDeviceName(fallbackName);
      await AsyncStorage.setItem("deviceName", fallbackName);
      return fallbackName;
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
              headers: {
                "User-Agent": "SignageApp/1.0 (Android TV Box)",
                Accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              },
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }

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
      console.log(
        `Network status: ${connected ? "Connected" : "Disconnected"}`
      );

      if (connected && error && retryCount < MAX_RETRIES) {
        console.log("Network reconnected, attempting to recover...");
        setTimeout(() => initializeApp(), 3000);
      }
    });

    return () => unsubscribe();
  }, [error, retryCount]);

  // App state monitoring - optimized for TV boxes
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      console.log(
        `App state changed: ${appStateRef.current} -> ${nextAppState}`
      );

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
        const apiUrl = `https://www.applicationbank.com/signage/api.php?id=${encodeURIComponent(
          deviceName
        )}`;
        console.log(`Fetching playlist from: ${apiUrl}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "SignageApp/1.0 (Android TV Box)",
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(
            `API Error: ${response.status} ${response.statusText}`
          );
        }

        const data: ApiResponse = await response.json();
        console.log("API Response received:", JSON.stringify(data, null, 2));

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

        if (!data.playlists || data.playlists.length === 0) {
          throw new Error("No playlists found in API response");
        }

        if (!data.playlists[0]?.assets) {
          throw new Error("No assets found in playlist");
        }

        const playlist =
          data.playlists.find((p) => p.is_default) || data.playlists[0];

        const essentialAssets: Asset[] = playlist.assets
          .filter(
            (asset) => asset.filepath && asset.time && parseInt(asset.time) > 0
          )
          .sort(
            (a, b) =>
              parseInt(a.playing_order || "0") -
              parseInt(b.playing_order || "0")
          )
          .map((asset) => ({
            filepath: asset.filepath,
            filetype: asset.filetype.toLowerCase(),
            time: parseInt(asset.time),
            name: asset.name || null,
          }));

        if (essentialAssets.length === 0) {
          throw new Error("No valid assets found in playlist");
        }

        console.log(`Loaded ${essentialAssets.length} assets successfully`);
        return { assets: essentialAssets, hasChanged };
      } catch (error) {
        if ((error as any).name === "AbortError") {
          throw new Error("Request timeout - check network connection");
        }
        console.error("API fetch error:", error);
        throw error;
      }
    },
    [networkStatus, initCacheDirectory]
  );

  // Timer cleanup - Fixed for React Native
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
      if (!assets[assetIndex]) {
        console.error(`Asset at index ${assetIndex} not found`);
        return;
      }

      const asset = assets[assetIndex];
      console.log(
        `Playing asset ${assetIndex + 1}/${assets.length}: ${
          asset.name || "Unnamed"
        } (${asset.filetype}) for ${asset.time}s`
      );

      clearAllTimers();

      const duration = Math.max(asset.time * 1000, 5000); // Minimum 5 seconds

      playbackTimer.current = setTimeout(() => {
        const nextIndex = (assetIndex + 1) % assets.length;
        console.log(`Moving to next asset: ${nextIndex}`);
        setCurrentAssetIndex(nextIndex);
        playAsset(nextIndex);
      }, duration);
    },
    [assets, clearAllTimers]
  );

  // Retry logic with exponential backoff
  const scheduleRetry = useCallback(() => {
    if (retryCount >= MAX_RETRIES) {
      setError(
        "Maximum retry attempts exceeded. Please check your network connection and device configuration."
      );
      return;
    }

    const delay = Math.min(RETRY_DELAY * Math.pow(2, retryCount), 300000); // Max 5 minutes
    console.log(
      `Scheduling retry ${retryCount + 1}/${MAX_RETRIES} in ${delay / 1000}s`
    );

    retryTimer.current = setTimeout(() => {
      setRetryCount((prev) => prev + 1);
      initializeApp();
    }, delay);
  }, [retryCount]);

  // Pre-cache assets for better performance
  const preCacheAssets = useCallback(
    async (assets: Asset[]) => {
      if (!networkStatus) {
        console.log("Skipping pre-cache - no network");
        return;
      }

      console.log("Starting background asset pre-caching...");

      // Cache first 5 assets to improve performance
      for (let i = 0; i < Math.min(assets.length, 5); i++) {
        const asset = assets[i];
        try {
          await getAssetPath(asset.filepath, asset.filetype);
          // Small delay to prevent overwhelming the system
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

      console.log("Starting app initialization...");

      const deviceName = await getDeviceName();
      console.log(`Using device name: ${deviceName}`);

      const result = await fetchPlaylist(deviceName);

      if (result.hasChanged || assets.length === 0) {
        console.log("Playlist updated, refreshing assets");
        setAssets(result.assets);
        setCurrentAssetIndex(0);

        // Start playback with a small delay
        setTimeout(() => {
          playAsset(0);
        }, 100);

        // Start pre-caching after a delay
        setTimeout(() => preCacheAssets(result.assets), 2000);
      } else {
        console.log("Playlist unchanged, continuing with current assets");
      }

      setRetryCount(0);
      setIsLoading(false);
      console.log("App initialization completed successfully");
    } catch (error) {
      console.error("Initialization error:", error);
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

  // Periodic API checks
  const startPeriodicCheck = useCallback(() => {
    if (apiCheckTimer.current) {
      clearInterval(apiCheckTimer.current);
    }

    apiCheckTimer.current = setInterval(async () => {
      if (!networkStatus || isLoading) {
        console.log("Skipping periodic check - no network or loading");
        return;
      }

      try {
        console.log("Running periodic playlist check...");
        const periodicResult = await fetchPlaylist(deviceName);

        if (periodicResult.hasChanged) {
          console.log("Playlist changed during periodic check");

          if (periodicResult.assets.length !== assets.length) {
            console.log("Asset count changed, restarting playback");
            setAssets(periodicResult.assets);
            setCurrentAssetIndex(0);
            clearAllTimers();
            setTimeout(() => playAsset(0), 100);
            setTimeout(() => preCacheAssets(periodicResult.assets), 1000);
          }
        }
      } catch (error) {
        console.error("Periodic check failed:", error);
        // Don't show error UI for periodic failures, just log them
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

  // WebView refresh for memory management
  const startWebViewRefresh = useCallback(() => {
    if (webViewRefreshTimer.current) {
      clearInterval(webViewRefreshTimer.current);
    }

    webViewRefreshTimer.current = setInterval(() => {
      console.log("Refreshing WebView for memory cleanup");
      if (webViewRef.current) {
        webViewRef.current.reload();
      }
    }, WEBVIEW_REFRESH_INTERVAL);
  }, []);

  // Prevent back button from closing app (TV box behavior)
  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        console.log("Back button pressed - preventing exit");
        return true; // Prevent default behavior
      }
    );
    return () => backHandler.remove();
  }, []);

  // Initialize app on mount
  useEffect(() => {
    console.log("Component mounted, starting initialization");
    initCacheDirectory().then(() => {
      initializeApp();
    });

    return () => {
      console.log("Component unmounting, cleaning up");
      clearAllTimers();
      if (apiCheckTimer.current) clearInterval(apiCheckTimer.current);
      if (webViewRefreshTimer.current)
        clearInterval(webViewRefreshTimer.current);
    };
  }, []);

  // Start periodic checks when assets are loaded
  useEffect(() => {
    if (assets.length > 0 && !error) {
      console.log("Starting periodic checks and WebView refresh");
      startPeriodicCheck();
      startWebViewRefresh();
    }
    return () => {
      if (apiCheckTimer.current) clearInterval(apiCheckTimer.current);
      if (webViewRefreshTimer.current)
        clearInterval(webViewRefreshTimer.current);
    };
  }, [assets.length, error, startPeriodicCheck, startWebViewRefresh]);

  // Asset rendering component
  const AssetRenderer: React.FC<{ asset: Asset }> = ({ asset }) => {
    const { filepath, filetype } = asset;
    const [localPath, setLocalPath] = useState<string>(filepath);
    const [loadError, setLoadError] = useState(false);

    useEffect(() => {
      setLoadError(false);
      getAssetPath(filepath, filetype).then(setLocalPath);
    }, [filepath, filetype]);

    const handleError = useCallback(() => {
      console.error(`Asset load error: ${filepath}`);
      setLoadError(true);

      if (!loadError) {
        // Try fallback to original URL if cached version failed
        if (localPath !== filepath) {
          console.log("Trying original URL as fallback");
          setLocalPath(filepath);
        } else {
          // Skip to next asset if all attempts failed
          console.log("Skipping to next asset due to load failure");
          setTimeout(() => {
            const nextIndex = (currentAssetIndex + 1) % assets.length;
            setCurrentAssetIndex(nextIndex);
          }, 1000);
        }
      }
    }, [filepath, localPath, loadError, currentAssetIndex, assets.length]);

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
          mixedContentMode="compatibility"
          allowsBackForwardNavigationGestures={false}
          onError={handleError}
          onHttpError={(syntheticEvent) => {
            console.error("WebView HTTP error:", syntheticEvent.nativeEvent);
            handleError();
          }}
          onLoadStart={() =>
            console.log("Loading:", isLocal ? "cached" : "remote", localPath)
          }
          onLoadEnd={() =>
            console.log("Load completed:", isLocal ? "cached" : "remote")
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
                  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
                  <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { 
                      background: #000; 
                      display: flex; 
                      justify-content: center; 
                      align-items: center; 
                      height: 100vh;
                      overflow: hidden;
                      font-family: Arial, sans-serif;
                    }
                    img { 
                      max-width: 100vw; 
                      max-height: 100vh; 
                      object-fit: contain;
                      display: block;
                    }
                    .error {
                      color: white;
                      text-align: center;
                      font-size: 18px;
                    }
                  </style>
                </head>
                <body>
                  <img src="${localPath}" alt="Signage Content" 
                       onerror="this.style.display='none'; document.body.innerHTML='<div class=error>Image load failed</div>'" />
                </body>
              </html>`,
          }}
          style={styles.webview}
          javaScriptEnabled={true}
          domStorageEnabled={false}
          cacheEnabled={isLocal}
          incognito={!isLocal}
          androidLayerType="hardware"
          onError={handleError}
          onLoadStart={() => console.log("Loading image:", localPath)}
        />
      );
    }

    // Unsupported file type
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.unsupportedText}>
          Unsupported file type: {filetype}
        </Text>
        <Text style={styles.unsupportedSubtext}>
          {asset.name || "Unnamed asset"}
        </Text>
      </View>
    );
  };

  // Loading screen
  if (isLoading) {
    return (
      <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.centerContainer}>
          <Text style={styles.loadingText}>Loading Digital Signage...</Text>
          <Text style={styles.deviceText}>Device: {deviceName}</Text>
          <Text style={styles.statusText}>
            Network: {networkStatus ? "Connected ✓" : "Disconnected ✗"}
          </Text>
          {retryCount > 0 && (
            <Text style={styles.retryText}>
              Retry attempt: {retryCount}/{MAX_RETRIES}
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
            Network: {networkStatus ? "Connected ✓" : "Disconnected ✗"}
          </Text>
          {retryCount < MAX_RETRIES && (
            <Text style={styles.retryText}>
              Retrying... ({retryCount + 1}/{MAX_RETRIES})
            </Text>
          )}
          <Text style={styles.helpText}>
            Check your network connection and device configuration
          </Text>
        </View>
      </View>
    );
  }

  const currentAsset = assets[currentAssetIndex];
  if (!currentAsset) {
    return (
      <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.centerContainer}>
          <Text style={styles.errorText}>No content available</Text>
          <Text style={styles.helpText}>
            Please check your playlist configuration
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <AssetRenderer asset={currentAsset} />
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
    fontSize: 32,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 20,
  },
  deviceText: {
    color: "#cccccc",
    fontSize: 18,
    textAlign: "center",
    marginBottom: 12,
    fontFamily: "monospace",
  },
  statusText: {
    color: "#888888",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 12,
  },
  retryText: {
    color: "#ffaa00",
    fontSize: 16,
    textAlign: "center",
    marginTop: 12,
    fontWeight: "600",
  },
  errorTitle: {
    color: "#ff4444",
    fontSize: 28,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 20,
  },
  errorText: {
    color: "#ff6666",
    fontSize: 18,
    textAlign: "center",
    marginBottom: 20,
    paddingHorizontal: 20,
    lineHeight: 24,
  },
  helpText: {
    color: "#999999",
    fontSize: 14,
    textAlign: "center",
    marginTop: 16,
    fontStyle: "italic",
  },
  webview: {
    flex: 1,
    backgroundColor: "#000000",
  },
  unsupportedText: {
    color: "#ffffff",
    fontSize: 24,
    textAlign: "center",
    marginBottom: 8,
  },
  unsupportedSubtext: {
    color: "#cccccc",
    fontSize: 16,
    textAlign: "center",
  },
});
