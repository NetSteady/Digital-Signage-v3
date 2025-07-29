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

  if (["jpg", "jpeg", "png", "gif", "webp"].includes(filetype.toLowerCase())) {
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
      url: localPath,
      duration: parseInt(time),
      name,
    };
  }

  if (["mp4", "webm", "mov", "avi"].includes(filetype.toLowerCase())) {
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
      url: localPath,
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dynamic Content Rotator</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            margin: 0;
            padding: 0;
            background: #000;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            overflow: hidden;
            font-family: Arial, sans-serif;
        }
        
        .content-container {
            width: 100vw;
            height: 100vh;
            position: relative;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        
        .hidden {
            display: none !important;
        }
        
        .content-item {
            width: 100%;
            height: 100%;
            position: absolute;
            top: 0;
            left: 0;
        }
        
        iframe {
            width: 100%;
            height: 100%;
            border: none;
            background: #000;
        }
        
        img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
            display: block;
        }
        
        video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
            display: block;
        }
        
        .debug-info {
            position: absolute;
            top: 10px;
            left: 10px;
            color: #fff;
            background: rgba(0,0,0,0.7);
            padding: 5px 10px;
            font-size: 12px;
            border-radius: 3px;
            z-index: 1000;
        }
        
        .error-message {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: #ff4444;
            background: rgba(0,0,0,0.8);
            padding: 20px;
            border-radius: 5px;
            text-align: center;
            font-size: 16px;
        }
    </style>
</head>
<body>
    <div class="content-container">
        <div id="debug-info" class="debug-info"></div>
        
        <iframe id="content-frame" class="content-item hidden"></iframe>
        <img id="content-image" class="content-item hidden" alt="Display Image">
        <video id="content-video" class="content-item hidden" autoplay muted playsinline></video>
        
        <div id="error-display" class="error-message hidden">
            <div id="error-text"></div>
        </div>
    </div>
    
    <script>
        console.log('HTML loaded, starting content rotation...');
        
        const contentList = ${JSON.stringify(localAssets)};
        let currentIndex = 0;
        let rotationTimeout;
        let isRotating = false;
        
        const debugInfo = document.getElementById('debug-info');
        const errorDisplay = document.getElementById('error-display');
        const errorText = document.getElementById('error-text');
        
        function updateDebugInfo(message) {
            console.log('Debug:', message);
            debugInfo.textContent = \`[\${new Date().toLocaleTimeString()}] \${message}\`;
        }
        
        function showError(message) {
            console.error('Error:', message);
            errorText.textContent = message;
            errorDisplay.classList.remove('hidden');
            setTimeout(() => {
                errorDisplay.classList.add('hidden');
            }, 3000);
        }
        
        function hideAllContent() {
            document.getElementById('content-frame').classList.add('hidden');
            document.getElementById('content-image').classList.add('hidden');
            document.getElementById('content-video').classList.add('hidden');
        }
        
        function showContent() {
            if (contentList.length === 0) {
                showError('No content available');
                return;
            }
            
            if (isRotating) {
                console.log('Already rotating, skipping...');
                return;
            }
            
            isRotating = true;
            const currentItem = contentList[currentIndex];
            
            updateDebugInfo(\`Loading: \${currentItem.name || 'Item ' + (currentIndex + 1)} (\${currentItem.type})\`);
            
            const frame = document.getElementById('content-frame');
            const img = document.getElementById('content-image');
            const video = document.getElementById('content-video');

            // Clear any existing timeout
            if (rotationTimeout) {
                clearTimeout(rotationTimeout);
            }

            // Hide all content first
            hideAllContent();

            // Show the correct content type
            if (currentItem.type === 'web') {
                updateDebugInfo(\`Loading web content: \${currentItem.url}\`);
                frame.src = currentItem.url;
                frame.onload = () => {
                    updateDebugInfo('Web content loaded successfully');
                };
                frame.onerror = () => {
                    showError(\`Web content failed to load: \${currentItem.url}\`);
                    skipToNext();
                };
                frame.classList.remove('hidden');
                
            } else if (currentItem.type === 'image') {
                updateDebugInfo(\`Loading image: \${currentItem.url}\`);
                
                // Create new image to test loading
                const testImg = new Image();
                testImg.onload = () => {
                    updateDebugInfo(\`Image loaded successfully: \${testImg.width}x\${testImg.height}\`);
                    img.src = currentItem.url;
                    img.classList.remove('hidden');
                };
                testImg.onerror = () => {
                    showError(\`Image failed to load: \${currentItem.url}\`);
                    skipToNext();
                };
                
                // Load the test image
                testImg.src = currentItem.url;
                
            } else if (currentItem.type === 'video') {
                updateDebugInfo(\`Loading video: \${currentItem.url}\`);
                
                video.src = currentItem.url;
                video.loop = true;
                
                // Set up event handlers before loading
                video.onerror = (e) => {
                    console.error('Video error details:', e);
                    showError(\`Video failed to load: \${currentItem.url}\`);
                    skipToNext();
                };
                
                video.onended = () => {
                    updateDebugInfo('Video ended naturally');
                };
                
                // Better video loading handling for T95 boxes
                video.oncanplaythrough = () => {
                    updateDebugInfo('Video ready to play');
                    video.play().then(() => {
                        updateDebugInfo('Video playing successfully');
                        video.classList.remove('hidden');
                    }).catch((error) => {
                        console.error('Video play failed:', error);
                        showError(\`Video play failed: \${error.message}\`);
                        skipToNext();
                    });
                };
                
                // Fallback if oncanplaythrough doesn't fire
                video.onloadeddata = () => {
                    updateDebugInfo('Video data loaded, attempting play');
                    setTimeout(() => {
                        if (video.paused && video.classList.contains('hidden')) {
                            video.play().then(() => {
                                video.classList.remove('hidden');
                            }).catch(console.error);
                        }
                    }, 500);
                };

                video.load();
            }

            // Calculate duration and set next rotation
            const duration = Math.max(currentItem.duration * 1000, 1000); // Minimum 1 second
            updateDebugInfo(\`Next rotation in \${currentItem.duration} seconds\`);
            
            rotationTimeout = setTimeout(() => {
                rotateToNext();
            }, duration);
            
            isRotating = false;
        }
        
        function skipToNext() {
            updateDebugInfo('Skipping to next item due to error');
            rotateToNext();
        }
        
        function rotateToNext() {
            currentIndex = (currentIndex + 1) % contentList.length;
            updateDebugInfo(\`Moving to item \${currentIndex + 1} of \${contentList.length}\`);
            setTimeout(showContent, 500); // Small delay before showing next content
        }

        // Initialize
        updateDebugInfo(\`Starting rotation with \${contentList.length} items\`);
        showContent();
        
        // Global error handler
        window.onerror = function(msg, url, lineNo, columnNo, error) {
            console.error('Global error:', msg, 'at', url, ':', lineNo);
            showError(\`JavaScript error: \${msg}\`);
            return false;
        };
    </script>
</body>
</html>`;
};
