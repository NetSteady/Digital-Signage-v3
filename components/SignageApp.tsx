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
  Dimensions,
  Image,
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
const MIN_ASSET_TIME = 5; // Minimum 5 seconds for any asset
const MAX_ASSET_TIME = 300; // Maximum 5 minutes for debugging (remove in production)

// Get screen dimensions
const { width: screenWidth, height: screenHeight } = Dimensions.get("window");

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
  const [currentAssetStartTime, setCurrentAssetStartTime] = useState<number>(0);
  const [remainingTime, setRemainingTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState(false); // Add playing state

  // Refs - Fixed timer types for React Native
  const webViewRef = useRef<WebView>(null);
  const playbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const apiCheckTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webViewRefreshTimer = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef(AppState.currentState);
  const lastApiResponseRef = useRef<string>("");
  const downloadQueue = useRef<Set<string>>(new Set());
  const isTransitioning = useRef<boolean>(false); // Prevent multiple transitions

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

        // Don't cache streaming platforms or live content
        if (
          filetype === "stream" ||
          filepath.includes("twitch.tv") ||
          filepath.includes("youtube.com") ||
          filepath.includes("facebook.com/watch") ||
          filepath.includes("instagram.com") ||
          filepath.includes(".m3u8") ||
          filepath.includes("rtmp://") ||
          filepath.includes("rtsp://")
        ) {
          console.log(`Skipping cache for streaming content: ${filename}`);
          return null;
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
          .map((asset) => {
            let time = parseInt(asset.time);

            // Enforce minimum time
            time = Math.max(time, MIN_ASSET_TIME);

            // For debugging: cap maximum time (remove this in production)
            if (process.env.NODE_ENV === "development") {
              time = Math.min(time, MAX_ASSET_TIME);
              console.log(
                `Asset ${asset.name || asset.filepath}: Original time ${
                  asset.time
                }s, Using ${time}s`
              );
            }

            return {
              filepath: asset.filepath,
              filetype: asset.filetype.toLowerCase(),
              time: time,
              name: asset.name || null,
            };
          });

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
    console.log(`🧹 Clearing all timers...`);

    if (playbackTimer.current) {
      console.log(`❌ Clearing playback timer:`, playbackTimer.current);
      clearTimeout(playbackTimer.current);
      playbackTimer.current = null;
    }
    if (retryTimer.current) {
      console.log(`❌ Clearing retry timer:`, retryTimer.current);
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    if (countdownTimer.current) {
      console.log(`❌ Clearing countdown timer:`, countdownTimer.current);
      clearInterval(countdownTimer.current);
      countdownTimer.current = null;
    }
  }, []);

  // Countdown timer for debugging
  const startCountdown = useCallback((duration: number) => {
    const startTime = Date.now();
    setCurrentAssetStartTime(startTime);
    setRemainingTime(duration);

    console.log(`⏳ Starting countdown: ${duration}s`);

    if (countdownTimer.current) {
      clearInterval(countdownTimer.current);
    }

    countdownTimer.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.max(0, duration - elapsed);
      setRemainingTime(remaining);

      // Log every 10 seconds or when less than 10 seconds remain
      if (remaining % 10 === 0 || (remaining <= 10 && remaining > 0)) {
        console.log(
          `⏰ Countdown: ${remaining}s remaining (elapsed: ${elapsed}s)`
        );
      }

      if (remaining <= 0) {
        console.log(`🔔 Countdown finished! Should be switching soon...`);
        clearInterval(countdownTimer.current!);
        countdownTimer.current = null;
      }
    }, 1000);
  }, []);

  // FIXED: Simplified asset switching function
  const switchToNextAsset = useCallback(() => {
    if (isTransitioning.current) {
      console.log("⏭️ Transition already in progress, ignoring");
      return;
    }

    if (assets.length === 0) {
      console.error("❌ No assets available for switching");
      return;
    }

    isTransitioning.current = true;
    console.log("⏭️ Switching to next asset");

    // Clear all timers
    clearAllTimers();

    // Calculate next index
    const nextIndex = (currentAssetIndex + 1) % assets.length;
    console.log(
      `➡️ Moving from asset ${currentAssetIndex + 1} to ${nextIndex + 1}/${
        assets.length
      }`
    );

    // Update the index immediately
    setCurrentAssetIndex(nextIndex);
    setIsPlaying(false); // Reset playing state

    // Allow transition after a brief moment
    setTimeout(() => {
      isTransitioning.current = false;
      setIsPlaying(true); // Trigger the new asset to start
    }, 100);
  }, [currentAssetIndex, assets.length, clearAllTimers]);

  // FIXED: Simplified asset playback function
  const startAssetPlayback = useCallback(
    (assetIndex: number) => {
      if (assets.length === 0 || !assets[assetIndex]) {
        console.error(`❌ Asset at index ${assetIndex} not found`);
        return;
      }

      const asset = assets[assetIndex];
      const duration = asset.time * 1000; // Convert to milliseconds

      console.log(
        `🎬 Starting playback for asset ${assetIndex + 1}/${assets.length}: ${
          asset.name || "Unnamed"
        } (${asset.filetype}) for ${asset.time}s`
      );

      // Clear any existing timers
      clearAllTimers();

      // Start countdown for debugging
      startCountdown(asset.time);

      // Set the playback timer
      console.log(`⏰ Setting timer for ${duration}ms`);
      playbackTimer.current = setTimeout(() => {
        console.log(`⏱️ Timer finished - switching to next asset`);
        switchToNextAsset();
      }, duration);

      console.log(`✅ Playback timer set`);
    },
    [assets, clearAllTimers, startCountdown, switchToNextAsset]
  );

  // FIXED: Effect to start playback when asset changes and is playing
  useEffect(() => {
    if (isPlaying && assets.length > 0 && assets[currentAssetIndex]) {
      startAssetPlayback(currentAssetIndex);
    }
  }, [currentAssetIndex, isPlaying, assets, startAssetPlayback]);

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

  // Pre-cache ALL assets for better reliability
  const preCacheAllAssets = useCallback(
    async (assets: Asset[]) => {
      if (!networkStatus) {
        console.log("⚠️ Skipping pre-cache - no network");
        return;
      }

      console.log(`📥 Starting pre-cache of ALL ${assets.length} assets...`);
      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        try {
          console.log(
            `📥 Pre-caching asset ${i + 1}/${assets.length}: ${
              asset.name || "Unnamed"
            }`
          );
          await getAssetPath(asset.filepath, asset.filetype);
          successCount++;
          console.log(`✅ Successfully cached asset ${i + 1}`);

          // Small delay to prevent overwhelming the system
          await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
          errorCount++;
          console.error(`❌ Pre-cache failed for asset ${i + 1}:`, error);
          // Continue with other assets even if one fails
        }
      }

      console.log(
        `📥 Pre-caching completed: ${successCount} success, ${errorCount} errors`
      );
    },
    [networkStatus, getAssetPath]
  );

  // FIXED: Main initialization
  const initializeApp = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      setIsPlaying(false); // Stop any current playback
      clearAllTimers();

      console.log("🚀 Starting app initialization...");

      const deviceName = await getDeviceName();
      console.log(`📱 Using device name: ${deviceName}`);

      const result = await fetchPlaylist(deviceName);

      if (result.hasChanged || assets.length === 0) {
        console.log("🔄 Playlist updated, refreshing assets");
        console.log(`📋 Found ${result.assets.length} assets to load`);

        // Update assets state
        setAssets(result.assets);
        setCurrentAssetIndex(0);

        // Pre-cache ALL assets before starting playback
        console.log("📥 Pre-caching all assets before starting playback...");
        await preCacheAllAssets(result.assets);

        console.log("🎬 Starting playback with fully cached assets");

        // Start playback after everything is ready
        setTimeout(() => {
          setIsPlaying(true);
        }, 500);
      } else {
        console.log("✅ Playlist unchanged, continuing with current assets");
        if (!isPlaying) {
          setIsPlaying(true);
        }
      }

      setRetryCount(0);
      setIsLoading(false);
      console.log("🎉 App initialization completed successfully");
    } catch (error) {
      console.error("💥 Initialization error:", error);
      setError(error instanceof Error ? error.message : String(error));
      setIsLoading(false);
      setIsPlaying(false);
      scheduleRetry();
    }
  }, [
    getDeviceName,
    fetchPlaylist,
    assets.length,
    clearAllTimers,
    scheduleRetry,
    preCacheAllAssets,
    isPlaying,
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
            setIsPlaying(false);
            clearAllTimers();

            // Pre-cache all assets before restarting
            await preCacheAllAssets(periodicResult.assets);
            setTimeout(() => setIsPlaying(true), 500);
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
    preCacheAllAssets,
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
  }, []); // Empty dependency array to run only on mount

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

  // Debug effect to monitor currentAssetIndex changes
  useEffect(() => {
    console.log(`📍 Current asset index changed to: ${currentAssetIndex}`);
    if (assets.length > 0 && assets[currentAssetIndex]) {
      console.log(
        `📍 Current asset: ${assets[currentAssetIndex].name || "Unnamed"}`
      );
    }
  }, [currentAssetIndex, assets]);

  // Asset rendering component
  const AssetRenderer: React.FC<{ asset: Asset }> = ({ asset }) => {
    const { filepath, filetype } = asset;
    const [localPath, setLocalPath] = useState<string>(filepath);
    const [loadError, setLoadError] = useState(false);
    const [imageError, setImageError] = useState(false);
    const [connectionError, setConnectionError] = useState<string | null>(null);

    useEffect(() => {
      setLoadError(false);
      setImageError(false);
      setConnectionError(null);
      getAssetPath(filepath, filetype).then(setLocalPath);
    }, [filepath, filetype]);

    const handleError = useCallback(
      (errorMessage?: string) => {
        console.error(`❌ Asset load error: ${filepath}`, errorMessage);

        if (errorMessage) {
          setConnectionError(errorMessage);
        }

        // Try fallback to original URL if cached version failed
        if (!loadError && localPath !== filepath) {
          console.log("🔄 Trying original URL as fallback");
          setLoadError(true);
          setLocalPath(filepath);
          return;
        }

        // If all attempts failed, skip to next asset
        console.log("⏭️ All attempts failed, skipping to next asset");
        setTimeout(() => {
          switchToNextAsset();
        }, 1000);
      },
      [filepath, localPath, loadError, switchToNextAsset]
    );

    const handleImageError = useCallback(() => {
      console.error(`🖼️ Image load error: ${filepath}`);

      // Try fallback to original URL if cached version failed
      if (!imageError && localPath !== filepath) {
        console.log("🔄 Trying original URL as fallback for image");
        setImageError(true);
        setLocalPath(filepath);
        return;
      }

      // If all attempts failed, skip to next asset
      console.log("⏭️ Image load failed, skipping to next asset");
      setTimeout(() => {
        switchToNextAsset();
      }, 1000);
    }, [filepath, localPath, imageError, switchToNextAsset]);

    // For HTML/URL content, use WebView with better error handling and HTTP support
    if (filetype === "html" || filetype === "url" || filetype === "stream") {
      const isLocal = localPath.startsWith("file://");
      const isLivestream =
        filetype === "stream" ||
        filepath.includes(".m3u8") ||
        filepath.includes("rtmp://") ||
        filepath.includes("rtsp://") ||
        filepath.includes("/live/") ||
        filepath.includes("webrtc.html") ||
        filepath.includes("twitch.tv") ||
        filepath.includes("youtube.com") ||
        filepath.includes("facebook.com/watch") ||
        filepath.includes("instagram.com");

      return (
        <View style={styles.webviewContainer}>
          <WebView
            ref={webViewRef}
            source={{ uri: localPath }}
            style={styles.webview}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback={true}
            cacheEnabled={isLocal && !isLivestream}
            incognito={!isLocal || isLivestream}
            androidLayerType="hardware"
            mixedContentMode="always"
            allowsBackForwardNavigationGestures={false}
            originWhitelist={["*"]}
            startInLoadingState={true}
            renderLoading={() => (
              <View style={styles.webviewLoading}>
                <Text style={styles.loadingText}>
                  {isLivestream ? "Connecting to stream..." : "Loading..."}
                </Text>
              </View>
            )}
            userAgent="Mozilla/5.0 (Linux; Android 10; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Safari/537.36 SmartTV"
            onShouldStartLoadWithRequest={(request) => {
              console.log("📡 Loading request:", request.url);
              return true;
            }}
            onError={(syntheticEvent) => {
              const error = syntheticEvent.nativeEvent;
              console.error("🌐 WebView error:", error);

              let errorMessage = error.description || "Unknown error";
              if (error.code === -2) {
                errorMessage =
                  "ERR_CONNECTION_REFUSED - Cannot connect to server";
              } else if (error.code === -6) {
                errorMessage = "ERR_CONNECTION_RESET - Connection was reset";
              } else if (error.code === -7) {
                errorMessage = "ERR_TIMED_OUT - Connection timed out";
              } else if (error.code === -8) {
                errorMessage = "ERR_CONNECTION_CLOSED - Connection closed";
              } else if (error.code === -109) {
                errorMessage = "ERR_ADDRESS_UNREACHABLE - Server unreachable";
              }

              handleError(errorMessage);
            }}
            onHttpError={(syntheticEvent) => {
              const httpError = syntheticEvent.nativeEvent;
              console.error("🌐 WebView HTTP error:", httpError);

              let errorMessage = `HTTP ${httpError.statusCode}`;
              if (httpError.statusCode === 404) {
                errorMessage += " - Stream not found or offline";
              } else if (httpError.statusCode === 403) {
                errorMessage += " - Access forbidden";
              } else if (httpError.statusCode === 500) {
                errorMessage += " - Server error";
              } else if (httpError.statusCode === 503) {
                errorMessage += " - Service unavailable";
              }

              handleError(errorMessage);
            }}
            onLoadStart={() => {
              console.log(
                "🔄 Loading:",
                isLocal ? "cached" : isLivestream ? "livestream" : "remote",
                localPath
              );
            }}
            onLoadEnd={() => {
              console.log(
                "✅ Load completed:",
                isLocal ? "cached" : isLivestream ? "livestream" : "remote"
              );
            }}
            onLoadProgress={({ nativeEvent }) => {
              if (!isLivestream && nativeEvent.progress < 1) {
                console.log(
                  `📊 Loading progress: ${Math.round(
                    nativeEvent.progress * 100
                  )}%`
                );
              }
            }}
            onNavigationStateChange={(navState) => {
              console.log("🧭 Navigation:", navState.url);
            }}
          />

          {/* Debug overlay for development */}
          {process.env.NODE_ENV === "development" && (
            <View style={styles.debugOverlay}>
              <Text style={styles.debugText}>
                Asset: {currentAssetIndex + 1}/{assets.length}
              </Text>
              <Text style={styles.debugText}>
                Time: {remainingTime}s remaining
              </Text>
              <Text style={styles.debugText}>
                Type:{" "}
                {isLivestream
                  ? "📡 Stream"
                  : isLocal
                  ? "💾 Cached"
                  : "🌐 Remote"}
              </Text>
              <Text style={styles.debugText}>
                Platform:{" "}
                {filepath.includes("twitch.tv")
                  ? "Twitch"
                  : filepath.includes("youtube.com")
                  ? "YouTube"
                  : filepath.includes("facebook.com")
                  ? "Facebook"
                  : filepath.includes("instagram.com")
                  ? "Instagram"
                  : filepath.includes("webrtc.html")
                  ? "WebRTC"
                  : "Web"}
              </Text>
              <Text style={styles.debugText}>
                URL:{" "}
                {localPath.length > 35
                  ? localPath.substring(0, 35) + "..."
                  : localPath}
              </Text>
              {connectionError && (
                <Text style={styles.errorDebugText}>
                  Error: {connectionError}
                </Text>
              )}
            </View>
          )}
        </View>
      );
    }

    // For images, use native Image component instead of WebView
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(filetype)) {
      return (
        <View style={styles.imageContainer}>
          <Image
            source={{ uri: localPath }}
            style={styles.image}
            resizeMode="contain"
            onError={(error) => {
              console.error("Image error:", error.nativeEvent.error);
              handleImageError();
            }}
            onLoad={() => {
              console.log("Image loaded successfully:", localPath);
            }}
            onLoadStart={() => {
              console.log("Image loading started:", localPath);
            }}
          />
          {imageError && (
            <View style={styles.errorOverlay}>
              <Text style={styles.errorText}>Image Load Failed</Text>
              <Text style={styles.errorSubtext}>{asset.name || filepath}</Text>
            </View>
          )}

          {/* Debug overlay for development */}
          {process.env.NODE_ENV === "development" && (
            <View style={styles.debugOverlay}>
              <Text style={styles.debugText}>
                Asset: {currentAssetIndex + 1}/{assets.length}
              </Text>
              <Text style={styles.debugText}>
                Time: {remainingTime}s remaining
              </Text>
            </View>
          )}
        </View>
      );
    }

    // For video files and livestreams, use WebView with video-optimized HTML
    if (
      filetype === "mp4" ||
      filetype === "m3u8" ||
      filetype === "hls" ||
      filetype === "livestream"
    ) {
      const isLocal = localPath.startsWith("file://");
      const isLivestream =
        filetype === "m3u8" ||
        filetype === "hls" ||
        filetype === "livestream" ||
        localPath.includes(".m3u8") ||
        localPath.includes("rtmp://") ||
        localPath.includes("rtsp://") ||
        localPath.includes("/live/");

      const videoHtml = `<!DOCTYPE html>
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
              video { 
                max-width: 100vw; 
                max-height: 100vh; 
                object-fit: contain;
                display: block;
              }
              .error {
                color: white;
                text-align: center;
                font-size: 18px;
                padding: 20px;
              }
              .loading {
                color: white;
                text-align: center;
                font-size: 16px;
                padding: 20px;
              }
            </style>
            ${
              isLivestream
                ? `<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.10/hls.min.js"></script>`
                : ""
            }
          </head>
          <body>
            <div id="loading" class="loading">Loading ${
              isLivestream ? "livestream" : "video"
            }...</div>
            <video id="video" style="display:none;" ${
              isLivestream ? "" : "controls"
            } autoplay muted ${
        isLivestream ? "playsinline" : "loop"
      } preload="auto">
              ${
                !isLivestream
                  ? `<source src="${localPath}" type="video/mp4">`
                  : ""
              }
            </video>
            
            <script>
              const video = document.getElementById('video');
              const loading = document.getElementById('loading');
              let loadTimeout;
              
              function showError(message) {
                loading.innerHTML = '<div class="error">Error: ' + message + '</div>';
                console.error('Video error:', message);
                // Notify parent about error after 3 seconds
                setTimeout(() => {
                  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({
                      type: 'error',
                      message: message
                    }));
                  }
                }, 3000);
              }
              
              function hideLoading() {
                if (loadTimeout) clearTimeout(loadTimeout);
                loading.style.display = 'none';
                video.style.display = 'block';
                console.log('Video ready to play');
                // Notify parent that video is ready
                if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({
                    type: 'ready'
                  }));
                }
              }
              
              // Set a timeout for loading
              loadTimeout = setTimeout(() => {
                if (loading.style.display !== 'none') {
                  showError('Loading timeout - video may be unavailable');
                }
              }, 15000); // 15 second timeout
              
              ${
                isLivestream
                  ? `
              // HLS/M3U8 Livestream support
              if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                const hls = new Hls({
                  enableWorker: true,
                  lowLatencyMode: false,
                  backBufferLength: 30,
                  maxBufferLength: 15,
                  maxMaxBufferLength: 30,
                  maxBufferSize: 30 * 1000 * 1000,
                  maxBufferHole: 0.5,
                  startLevel: -1,
                  autoStartLoad: true,
                  startFragPrefetch: true,
                  testBandwidth: false,
                  debug: false,
                  // Reduced jitter settings
                  liveSyncDurationCount: 3,
                  liveMaxLatencyDurationCount: 10,
                  liveDurationInfinity: true
                });
                
                hls.loadSource('${localPath}');
                hls.attachMedia(video);
                
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                  console.log('HLS manifest parsed, starting playback');
                  hideLoading();
                  video.play().catch(e => {
                    console.error('Playback start failed:', e);
                    showError('Playback failed: ' + e.message);
                  });
                });
                
                hls.on(Hls.Events.ERROR, (event, data) => {
                  console.error('HLS error:', data.type, data.details, data.fatal);
                  if (data.fatal) {
                    switch(data.type) {
                      case Hls.ErrorTypes.NETWORK_ERROR:
                        console.log('Network error, attempting recovery...');
                        hls.startLoad();
                        break;
                      case Hls.ErrorTypes.MEDIA_ERROR:
                        console.log('Media error, attempting recovery...');
                        hls.recoverMediaError();
                        break;
                      default:
                        showError('Fatal streaming error: ' + data.details);
                        break;
                    }
                  }
                });
                
                // Buffer monitoring for smooth playback
                hls.on(Hls.Events.BUFFER_APPENDED, () => {
                  // Keep buffer healthy
                  if (video.buffered.length > 0) {
                    const bufferEnd = video.buffered.end(video.buffered.length - 1);
                    const currentTime = video.currentTime;
                    if (bufferEnd - currentTime > 30) {
                      // Too much buffer, might cause memory issues
                      console.log('Large buffer detected, may cause jitter');
                    }
                  }
                });
                
              } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // Native HLS support (Safari, some Android browsers)
                video.src = '${localPath}';
                video.addEventListener('loadstart', () => {
                  console.log('Native HLS loading started');
                });
                video.addEventListener('canplay', () => {
                  hideLoading();
                  video.play().catch(e => showError('Playback failed: ' + e.message));
                });
                video.addEventListener('error', (e) => {
                  showError('Native HLS error: ' + e.message);
                });
              } else {
                showError('HLS streaming not supported on this device');
              }
              `
                  : `
              // Regular MP4 video
              video.addEventListener('loadstart', () => {
                console.log('MP4 video loading started');
              });
              
              video.addEventListener('loadedmetadata', () => {
                console.log('Video metadata loaded');
              });
              
              video.addEventListener('canplay', () => {
                console.log('Video can start playing');
                hideLoading();
              });
              
              video.addEventListener('canplaythrough', () => {
                console.log('Video can play through without buffering');
              });
              
              video.addEventListener('error', (e) => {
                let errorMsg = 'Video load failed';
                if (video.error) {
                  switch(video.error.code) {
                    case video.error.MEDIA_ERR_ABORTED:
                      errorMsg = 'Video load aborted';
                      break;
                    case video.error.MEDIA_ERR_NETWORK:
                      errorMsg = 'Network error loading video';
                      break;
                    case video.error.MEDIA_ERR_DECODE:
                      errorMsg = 'Video decode error';
                      break;
                    case video.error.MEDIA_ERR_SRC_NOT_SUPPORTED:
                      errorMsg = 'Video format not supported';
                      break;
                  }
                }
                console.error('Video error:', errorMsg, video.error);
                showError(errorMsg);
              });
              
              // Start loading the video
              video.load();
              `
              }
              
              // Common event handlers for both live and regular video
              video.addEventListener('waiting', () => {
                console.log('Video buffering...');
              });
              
              video.addEventListener('playing', () => {
                console.log('Video playing smoothly');
              });
              
              video.addEventListener('pause', () => {
                console.log('Video paused');
              });
              
              video.addEventListener('ended', () => {
                console.log('Video playback ended');
              });
              
              video.addEventListener('stalled', () => {
                console.log('Video stalled - network may be slow');
              });
              
              video.addEventListener('suspend', () => {
                console.log('Video loading suspended');
              });
              
            </script>
          </body>
        </html>`;

      return (
        <View style={styles.webviewContainer}>
          <WebView
            source={{ html: videoHtml }}
            style={styles.webview}
            javaScriptEnabled={true}
            domStorageEnabled={false}
            cacheEnabled={!isLivestream}
            incognito={isLivestream}
            androidLayerType="hardware"
            mixedContentMode="always"
            originWhitelist={["*"]}
            allowsInlineMediaPlayback={true}
            mediaPlaybackRequiresUserAction={false}
            startInLoadingState={false}
            onError={(error) => {
              console.error("📹 Video WebView error:", error.nativeEvent);
              handleError(`WebView error: ${error.nativeEvent.description}`);
            }}
            onHttpError={(error) => {
              console.error("📹 Video HTTP error:", error.nativeEvent);
              handleError(`HTTP error: ${error.nativeEvent.statusCode}`);
            }}
            onLoadStart={() =>
              console.log(
                "📹 Loading video:",
                isLivestream ? "livestream" : "file",
                localPath
              )
            }
            onLoadEnd={() => console.log("✅ Video WebView load completed")}
            onMessage={(event) => {
              try {
                const message = JSON.parse(event.nativeEvent.data);
                console.log("📹 Video message:", message);

                if (message.type === "error") {
                  handleError(message.message);
                } else if (message.type === "ready") {
                  console.log("📹 Video is ready to play");
                }
              } catch (e) {
                // If it's not JSON, just log the raw message
                console.log("📹 Video message (raw):", event.nativeEvent.data);
              }
            }}
          />

          {/* Debug overlay for development */}
          {process.env.NODE_ENV === "development" && (
            <View style={styles.debugOverlay}>
              <Text style={styles.debugText}>
                Asset: {currentAssetIndex + 1}/{assets.length}
              </Text>
              <Text style={styles.debugText}>
                Time: {remainingTime}s remaining
              </Text>
              <Text style={styles.debugText}>
                Type: {isLivestream ? "📡 Livestream" : "📹 Video"}
              </Text>
              <Text style={styles.debugText}>
                Format: {filetype.toUpperCase()}
              </Text>
              <Text style={styles.debugText}>
                Source: {isLocal ? "Local" : "Remote"}
              </Text>
            </View>
          )}
        </View>
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
  console.log(
    `🎯 Rendering check - currentAssetIndex: ${currentAssetIndex}, assets.length: ${assets.length}, isPlaying: ${isPlaying}`
  );
  console.log(`🎯 Current asset exists: ${!!currentAsset}`);

  if (!currentAsset) {
    console.error(
      `❌ No asset found at index ${currentAssetIndex}. Assets available:`,
      assets.map((a, i) => `${i}: ${a.name || "Unnamed"}`)
    );
    return (
      <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.centerContainer}>
          <Text style={styles.errorText}>No content available</Text>
          <Text style={styles.helpText}>
            Asset index: {currentAssetIndex}, Assets length: {assets.length}
          </Text>
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
  webviewContainer: {
    flex: 1,
    backgroundColor: "#000000",
  },
  webview: {
    flex: 1,
    backgroundColor: "#000000",
  },
  webviewLoading: {
    flex: 1,
    backgroundColor: "#000000",
    justifyContent: "center",
    alignItems: "center",
  },
  imageContainer: {
    flex: 1,
    backgroundColor: "#000000",
    justifyContent: "center",
    alignItems: "center",
  },
  image: {
    width: screenWidth,
    height: screenHeight,
    backgroundColor: "#000000",
  },
  errorOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    justifyContent: "center",
    alignItems: "center",
  },
  errorSubtext: {
    color: "#cccccc",
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
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
  debugOverlay: {
    position: "absolute",
    top: 20,
    left: 20,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    padding: 10,
    borderRadius: 5,
    maxWidth: 300,
  },
  debugText: {
    color: "#ffffff",
    fontSize: 12,
    marginBottom: 2,
    fontFamily: "monospace",
  },
  errorDebugText: {
    color: "#ff6666",
    fontSize: 12,
    marginTop: 5,
    fontFamily: "monospace",
  },
});
