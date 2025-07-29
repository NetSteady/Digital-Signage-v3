import * as FileSystem from "expo-file-system";
import { Asset } from "./Api";

const CACHE_DIR = `${FileSystem.documentDirectory}signage_cache/`;
const CACHE_MANIFEST_FILE = `${CACHE_DIR}manifest.json`;

export interface LocalAsset {
  type: "image" | "video" | "web";
  url: string;
  duration: number;
  name?: string;
}

interface CacheManifest {
  assets: LocalAsset[];
  timestamp: number;
  deviceName: string;
}

export const clearCache = async (): Promise<void> => {
  try {
    console.log("Clearing cache directory ... ");

    const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
    if (dirInfo.exists) {
      await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
      console.log("Cache cleared successfully");
    }

    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
    console.log("Cache directory created");
  } catch (error) {
    console.error("Error creating cache", error);
  }
};

// Save cache manifest for offline access
const saveCacheManifest = async (
  assets: LocalAsset[],
  deviceName: string
): Promise<void> => {
  try {
    const manifest: CacheManifest = {
      assets,
      timestamp: Date.now(),
      deviceName,
    };

    await FileSystem.writeAsStringAsync(
      CACHE_MANIFEST_FILE,
      JSON.stringify(manifest),
      { encoding: FileSystem.EncodingType.UTF8 }
    );

    console.log(`Cache manifest saved with ${assets.length} assets`);
  } catch (error) {
    console.error("Error saving cache manifest:", error);
  }
};

// Load cached assets for offline mode
export const getCachedAssets = async (): Promise<LocalAsset[]> => {
  try {
    const manifestExists = await FileSystem.getInfoAsync(CACHE_MANIFEST_FILE);
    if (!manifestExists.exists) {
      console.log("No cache manifest found");
      return [];
    }

    const manifestContent = await FileSystem.readAsStringAsync(
      CACHE_MANIFEST_FILE,
      { encoding: FileSystem.EncodingType.UTF8 }
    );

    const manifest: CacheManifest = JSON.parse(manifestContent);

    // Verify cached files still exist
    const validAssets: LocalAsset[] = [];

    for (const asset of manifest.assets) {
      if (asset.type === "web") {
        // Web assets don't need file verification
        validAssets.push(asset);
      } else {
        // Check if local file still exists
        const fileExists = await FileSystem.getInfoAsync(asset.url);
        if (fileExists.exists) {
          validAssets.push(asset);
        } else {
          console.log(`Cached file missing: ${asset.url}`);
        }
      }
    }

    console.log(`Found ${validAssets.length} valid cached assets`);
    return validAssets;
  } catch (error) {
    console.error("Error loading cached assets:", error);
    return [];
  }
};

export const downloadAssets = async (
  assets: Asset[],
  deviceName?: string
): Promise<LocalAsset[]> => {
  const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  }

  const localAssets: LocalAsset[] = [];

  for (const asset of assets) {
    try {
      console.log(`Downloading: ${asset.name || asset.filepath}`);

      const localAsset = await downloadSingleAsset(asset);
      localAssets.push(localAsset);
    } catch (error) {
      console.error(`Failed to download ${asset.filepath}:`, error);
    }
  }

  // Save manifest for offline access
  if (deviceName && localAssets.length > 0) {
    await saveCacheManifest(localAssets, deviceName);
  }

  return localAssets;
};

const downloadSingleAsset = async (asset: Asset): Promise<LocalAsset> => {
  const { filepath, filetype, time, name } = asset;

  if (["jpg", "png"].includes(filetype.toLowerCase())) {
    const filename = `${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 9)}.${filetype}`;
    const localPath = `${CACHE_DIR}${filename}`;

    const result = await FileSystem.downloadAsync(filepath, localPath);
    if (result.status !== 200) {
      throw new Error(`Download failed: ${result.status}`);
    }

    return {
      type: "image",
      url: `file://${localPath}`,
      duration: parseInt(time),
      name,
    };
  }

  if (filetype.toLowerCase() === "mp4") {
    const filename = `${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 9)}.${filetype}`;
    const localPath = `${CACHE_DIR}${filename}`;

    const result = await FileSystem.downloadAsync(filepath, localPath);
    if (result.status !== 200) {
      throw new Error(`Download failed: ${result.status}`);
    }

    return {
      type: "video",
      url: `file://${localPath}`,
      duration: parseInt(time),
      name,
    };
  }

  if (["url", "html", "stream"].includes(filetype.toLowerCase())) {
    return {
      type: "web",
      url: filepath,
      duration: parseInt(time),
      name,
    };
  }

  throw new Error(`Unsupported file type: ${filetype}`);
};

export const createHTMLWithData = (localAssets: LocalAsset[]): string => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Dynamic Content Rotator</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background: #000;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            overflow: hidden;
        }
        .hidden {
            display: none;
        }
        iframe, img, video {
            width: 100%;
            height: 100%;
            object-fit: cover;
            border: none;
        }
        video {
            background: #000;
        }
    </style>
</head>
<body>
    <iframe id="content-frame" class="hidden"></iframe>
    <img id="content-image" class="hidden" alt="Display Image">
    <video id="content-video" class="hidden" autoplay muted></video>
    
    <script>
        const contentList = ${JSON.stringify(localAssets)};
        let currentIndex = 0;
        let rotationTimeout;

        function showContent() {
            if (contentList.length === 0) return;

            const currentItem = contentList[currentIndex];
            const frame = document.getElementById('content-frame');
            const img = document.getElementById('content-image');
            const video = document.getElementById('content-video');

            // Clear any existing timeout
            if (rotationTimeout) {
                clearTimeout(rotationTimeout);
            }

            // Hide all
            frame.classList.add('hidden');
            img.classList.add('hidden');
            video.classList.add('hidden');

            // Show the correct content type
            if (currentItem.type === 'web') {
                frame.src = currentItem.url;
                frame.classList.remove('hidden');
            } else if (currentItem.type === 'image') {
                img.src = currentItem.url;
                img.onerror = () => {
                    console.error('Image failed to load:', currentItem.url);
                    // Skip to next item immediately
                    currentIndex = (currentIndex + 1) % contentList.length;
                    setTimeout(showContent, 100);
                };
                img.classList.remove('hidden');
            } else if (currentItem.type === 'video') {
                video.src = currentItem.url;
                video.loop = true;
                
                // Set up event handlers before loading
                video.onerror = () => {
                    console.error('Video failed to load:', currentItem.url);
                    // Skip to next item immediately
                    currentIndex = (currentIndex + 1) % contentList.length;
                    setTimeout(showContent, 100);
                };
                
                video.onended = () => {
                    console.log('Video ended naturally');
                };
                
                // Better video loading handling for T95 boxes
                video.oncanplaythrough = () => {
                    console.log('Video ready to play:', currentItem.url);
                    video.play().catch((error) => {
                        console.error('Video play failed:', error);
                        // Skip to next item if play fails
                        currentIndex = (currentIndex + 1) % contentList.length;
                        setTimeout(showContent, 100);
                    });
                };
                
                // Fallback if oncanplaythrough doesn't fire
                video.onloadeddata = () => {
                    console.log('Video data loaded, attempting play');
                    setTimeout(() => {
                        if (video.paused) {
                            video.play().catch(console.error);
                        }
                    }, 500);
                };

                video.load();
                video.classList.remove('hidden');
            }

            // Calculate duration and set next rotation
            const duration = currentItem.duration * 1000; // Convert to ms
            currentIndex = (currentIndex + 1) % contentList.length;
            rotationTimeout = setTimeout(showContent, duration);
        }

        showContent();
    </script>
</body>
</html>`;
};
