import { useKeepAwake } from "expo-keep-awake";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { Asset, fetchPlaylist } from "../services/Api";
import {
  clearCache,
  createHTMLWithData,
  downloadAssets,
  getCachedAssets,
} from "../services/AssetDownloader";
import { getDeviceName } from "../services/DeviceName";

interface SignageDisplayProps {
  refreshInterval?: number; // minutes
  retryDelay?: number; // seconds
}

const checkInternetConnection = async (retries = 3): Promise<boolean> => {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

      const response = await fetch("https://www.applicationbank.com", {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "User-Agent": "SignageApp/2.0 (Android TV Box)",
        },
      });

      clearTimeout(timeoutId);

      // Check if we got a reasonable response (200-399 range)
      if (response.status >= 200 && response.status < 400) {
        return true;
      }

      console.log(`Connectivity check failed with status: ${response.status}`);
    } catch (error) {
      console.log(
        `Connectivity check attempt ${i + 1}/${retries} failed:`,
        error
      );

      if (i === retries - 1) {
        console.log("No internet connection after retries");
        return false;
      }

      // Wait between retries with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, i), 5000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return false;
};

// Helper function to compare asset arrays
const assetsAreEqual = (assets1: Asset[], assets2: Asset[]): boolean => {
  if (assets1.length !== assets2.length) {
    return false;
  }

  return assets1.every((asset1, index) => {
    const asset2 = assets2[index];
    return (
      asset1.filepath === asset2.filepath &&
      asset1.filetype === asset2.filetype &&
      asset1.time === asset2.time &&
      asset1.playing_order === asset2.playing_order &&
      asset1.name === asset2.name
    );
  });
};

const SignageDisplay: React.FC<SignageDisplayProps> = ({
  refreshInterval = 1,
  retryDelay = 60,
}) => {
  // Keep screen awake at component level
  useKeepAwake();

  const [htmlContent, setHtmlContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [deviceName, setDeviceName] = useState<string>("");
  const [isOffline, setIsOffline] = useState<boolean>(false);

  // Store the last fetched assets for comparison
  const lastFetchedAssets = useRef<Asset[]>([]);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const loadContent = useCallback(
    async (forceDownload: boolean = false) => {
      try {
        console.log("Starting content load...");
        setIsLoading(true);
        setError("");

        // Get device name
        console.log("Getting device name...");
        const device = await getDeviceName();
        setDeviceName(device);
        console.log(`Device name: ${device}`);

        // Check internet connection first
        console.log("Checking internet connection...");
        const hasInternet = await checkInternetConnection();
        setIsOffline(!hasInternet);
        console.log(
          `Internet connection: ${hasInternet ? "Available" : "Not available"}`
        );

        if (!hasInternet) {
          console.log(
            "No internet connection - attempting to use cached content"
          );

          // Try to load cached content
          const cachedAssets = await getCachedAssets();

          if (cachedAssets.length > 0) {
            console.log(
              `Using ${cachedAssets.length} cached assets (offline mode)`
            );
            const html = createHTMLWithData(cachedAssets);
            setHtmlContent(html);
            setLastUpdate(new Date());
            setIsLoading(false);

            // Schedule retry when back online
            setTimeout(() => {
              console.log("Retrying connection after offline mode...");
              loadContent();
            }, retryDelay * 1000);
            return;
          } else {
            throw new Error(
              "No internet connection and no cached content available"
            );
          }
        }

        // Online mode - fetch fresh content
        setIsOffline(false);
        console.log("Fetching playlist from API...");

        // Fetch playlist from API
        const assets = await fetchPlaylist(device);

        if (assets.length === 0) {
          throw new Error("No valid assets found in playlist");
        }

        console.log(`Found ${assets.length} assets from API`);

        // Compare with previously fetched assets
        const contentChanged =
          forceDownload || !assetsAreEqual(assets, lastFetchedAssets.current);

        if (!contentChanged) {
          console.log("Content unchanged - skipping download");
          setLastUpdate(new Date());
          setIsLoading(false);
          return;
        }

        console.log("Content has changed - proceeding with download");

        // Store the new assets for future comparison
        lastFetchedAssets.current = [...assets];

        // Clear old cache and download new assets (only when content changes)
        console.log("Clearing cache...");
        await clearCache();

        console.log("Downloading assets...");
        const localAssets = await downloadAssets(assets, device);

        if (localAssets.length === 0) {
          throw new Error("Failed to download any assets");
        }

        console.log(`Successfully downloaded ${localAssets.length} assets`);

        // Generate HTML for display
        console.log("Generating HTML content...");
        const html = createHTMLWithData(localAssets);
        setHtmlContent(html);
        setLastUpdate(new Date());
        console.log("Content loaded successfully!");
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error occurred";
        console.error("Failed to load content:", errorMessage);
        setError(errorMessage);

        // Schedule retry
        setTimeout(() => {
          console.log(`Retrying after error in ${retryDelay} seconds...`);
          loadContent();
        }, retryDelay * 1000);
      } finally {
        setIsLoading(false);
      }
    },
    [retryDelay]
  );

  // Initial load
  useEffect(() => {
    console.log("Component mounted, starting initial load...");
    loadContent(true); // Force download on initial load
  }, [loadContent]);

  // Set up refresh interval
  useEffect(() => {
    // Clear any existing interval
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
    }

    if (refreshInterval > 0) {
      console.log(`Setting up refresh interval: ${refreshInterval} minutes`);
      refreshIntervalRef.current = setInterval(() => {
        console.log("Refreshing content...");
        loadContent(); // Don't force download on refresh - let comparison decide
      }, refreshInterval * 60 * 1000);
    }

    return () => {
      if (refreshIntervalRef.current) {
        console.log("Clearing refresh interval");
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
  }, [refreshInterval, loadContent]);

  // Garbage collection
  useEffect(() => {
    const cleanup = () => {
      if (global.gc) {
        console.log("Running garbage collection");
        global.gc();
      }
    };

    const interval = setInterval(cleanup, 5 * 60 * 1000); // Every 5 minutes
    return () => {
      clearInterval(interval);
      cleanup();
    };
  }, []);

  // Loading state (only when no content exists)
  if (isLoading && !htmlContent) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#ffffff" />
        <Text style={styles.loadingText}>
          {deviceName
            ? `Loading content for ${deviceName}...`
            : "Initializing digital signage..."}
        </Text>
        {isOffline && (
          <Text style={styles.offlineText}>
            No internet connection - checking for cached content...
          </Text>
        )}
      </View>
    );
  }

  // Error state (when no content is available at all)
  if (error && !htmlContent) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorTitle}>Unable to Load Content</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Text style={styles.retryText}>
          Retrying in {retryDelay} seconds...
        </Text>
        {deviceName && (
          <Text style={styles.deviceText}>Device: {deviceName}</Text>
        )}
        {isOffline && (
          <Text style={styles.offlineText}>
            Device is offline - will retry when connection is restored
          </Text>
        )}
      </View>
    );
  }

  // Success state - display content
  return (
    <View style={styles.container}>
      {htmlContent && (
        <WebView
          source={{ html: htmlContent }}
          style={styles.webView}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback={true}
          mixedContentMode="compatibility"
          originWhitelist={["*"]}
          allowFileAccess={true}
          allowFileAccessFromFileURLs={true}
          allowUniversalAccessFromFileURLs={true}
          cacheEnabled={false}
          incognito={false}
          thirdPartyCookiesEnabled={true}
          scalesPageToFit={false}
          androidLayerType="hardware"
          onError={(syntheticEvent) => {
            const { nativeEvent } = syntheticEvent;
            console.error("WebView error:", nativeEvent);
          }}
          onLoad={() => {
            console.log("WebView content loaded successfully");
          }}
          startInLoadingState={false}
          onHttpError={(syntheticEvent) => {
            console.error("HTTP error in WebView:", syntheticEvent.nativeEvent);
          }}
          renderError={(errorName) => {
            console.error("WebView render error:", errorName);
            return (
              <View style={styles.centerContainer}>
                <Text style={styles.errorText}>Display error: {errorName}</Text>
                <Text style={styles.retryText}>
                  Content will retry automatically...
                </Text>
              </View>
            );
          }}
        />
      )}

      {/* Minimal status indicator - only show when there are issues */}
      {isOffline && !isLoading && (
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>
            OFFLINE MODE
            {lastUpdate &&
              ` • Last updated: ${lastUpdate.toLocaleTimeString()}`}
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000000",
    padding: 20,
  },
  webView: {
    flex: 1,
    backgroundColor: "#000000",
  },
  loadingText: {
    color: "#ffffff",
    fontSize: 18,
    marginTop: 20,
    textAlign: "center",
  },
  errorTitle: {
    color: "#ff4444",
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 10,
    textAlign: "center",
  },
  errorText: {
    color: "#ffffff",
    fontSize: 16,
    marginBottom: 20,
    textAlign: "center",
    lineHeight: 24,
  },
  retryText: {
    color: "#cccccc",
    fontSize: 14,
    marginBottom: 10,
    textAlign: "center",
  },
  deviceText: {
    color: "#888888",
    fontSize: 12,
    textAlign: "center",
  },
  offlineText: {
    color: "#ffaa00",
    fontSize: 14,
    marginTop: 10,
    textAlign: "center",
    fontStyle: "italic",
  },
  statusBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.8)",
    padding: 8,
  },
  statusText: {
    color: "#ffffff",
    fontSize: 10,
    textAlign: "center",
  },
});

export default SignageDisplay;
