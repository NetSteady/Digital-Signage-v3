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
    <title>Digital Signage Display</title>
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
            opacity: 0 !important;
        }
        
        .content-item {
            width: 100%;
            height: 100%;
            position: absolute;
            top: 0;
            left: 0;
            opacity: 1;
            transition: opacity 0.3s ease-in-out;
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
            z-index: 1000;
        }
    </style>
</head>
<body>
    <div class="content-container">
        <iframe id="content-frame" class="content-item hidden" 
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-top-navigation allow-downloads"
                allow="autoplay; encrypted-media; fullscreen;" loading="eager">
        </iframe>
        <img id="content-image" class="content-item hidden" alt="Display Image">
        <video id="content-video" class="content-item hidden" autoplay muted playsinline preload="auto"></video>
        
        <div id="error-display" class="error-message hidden">
            <div id="error-text"></div>
        </div>
    </div>
    
    <script>
        console.log('Digital signage display initialized');
        
        const contentList = ${JSON.stringify(localAssets)};
        let currentIndex = 0;
        let rotationTimeout;
        let isTransitioning = false;
        let currentVideoElement = null;
        let webContentLoadTimeout = null;
        let videoLoadTimeout = null;
        
        const errorDisplay = document.getElementById('error-display');
        const errorText = document.getElementById('error-text');
        
        function showError(message) {
            console.error('Display Error:', message);
            errorText.textContent = message;
            errorDisplay.classList.remove('hidden');
            setTimeout(() => {
                errorDisplay.classList.add('hidden');
            }, 3000); // Reduced error display time
        }
        
        function hideAllContent() {
            const frame = document.getElementById('content-frame');
            const img = document.getElementById('content-image');
            const video = document.getElementById('content-video');
            
            // Clear timeouts
            if (webContentLoadTimeout) {
                clearTimeout(webContentLoadTimeout);
                webContentLoadTimeout = null;
            }
            if (videoLoadTimeout) {
                clearTimeout(videoLoadTimeout);
                videoLoadTimeout = null;
            }
            
            // Clean up video playback
            if (currentVideoElement && !currentVideoElement.paused) {
                currentVideoElement.pause();
                currentVideoElement.currentTime = 0;
                currentVideoElement.src = '';
                currentVideoElement.load();
            }
            currentVideoElement = null;
            
            // Clean up iframe
            if (!frame.classList.contains('hidden')) {
                frame.src = 'about:blank';
            }
            
            // Hide all elements
            frame.classList.add('hidden');
            img.classList.add('hidden');
            video.classList.add('hidden');
        }
        
        function showContent() {
            if (contentList.length === 0) {
                showError('No content available to display');
                return;
            }
            
            if (isTransitioning) {
                return;
            }
            
            isTransitioning = true;
            const currentItem = contentList[currentIndex];
            
            console.log(\`Displaying: \${currentItem.name || 'Item ' + (currentIndex + 1)} (\${currentItem.type})\`);
            
            const frame = document.getElementById('content-frame');
            const img = document.getElementById('content-image');
            const video = document.getElementById('content-video');

            // Clear any existing timeout
            if (rotationTimeout) {
                clearTimeout(rotationTimeout);
                rotationTimeout = null;
            }

            // Hide all content with proper cleanup
            hideAllContent();

            // Reduced delay for faster transitions
            setTimeout(() => {
                if (currentItem.type === 'web') {
                    console.log(\`Loading web content: \${currentItem.url}\`);
                    
                    let webContentLoaded = false;
                    
                    // Set up iframe load handler
                    frame.onload = () => {
                        if (!webContentLoaded) {
                            webContentLoaded = true;
                            console.log('Web content loaded successfully');
                            
                            if (webContentLoadTimeout) {
                                clearTimeout(webContentLoadTimeout);
                                webContentLoadTimeout = null;
                            }
                            
                            frame.classList.remove('hidden');
                            scheduleNext(currentItem.duration);
                        }
                    };
                    
                    frame.onerror = () => {
                        if (!webContentLoaded) {
                            webContentLoaded = true;
                            console.error(\`Web content failed to load: \${currentItem.url}\`);
                            showError('Web content failed to load');
                            skipToNext();
                        }
                    };
                    
                    // Reduced timeout for web content (10 seconds)
                    webContentLoadTimeout = setTimeout(() => {
                        if (!webContentLoaded) {
                            webContentLoaded = true;
                            console.log('Web content timeout - showing anyway');
                            frame.classList.remove('hidden');
                            scheduleNext(currentItem.duration);
                        }
                    }, 10000);
                    
                    // Load iframe with proper error handling
                    try {
                        frame.src = currentItem.url;
                    } catch (e) {
                        console.error('Error setting iframe src:', e);
                        skipToNext();
                    }
                    
                } else if (currentItem.type === 'image') {
                    console.log(\`Loading image: \${currentItem.url}\`);
                    
                    const testImg = new Image();
                    testImg.onload = () => {
                        console.log(\`Image loaded: \${testImg.width}x\${testImg.height}\`);
                        img.src = currentItem.url;
                        img.classList.remove('hidden');
                        scheduleNext(currentItem.duration);
                    };
                    testImg.onerror = () => {
                        console.error(\`Image failed to load: \${currentItem.url}\`);
                        showError('Image failed to load');
                        skipToNext();
                    };
                    
                    testImg.src = currentItem.url;
                    
                } else if (currentItem.type === 'video') {
                    console.log(\`Loading video: \${currentItem.url}\`);
                    
                    let videoLoaded = false;
                    
                    // Clear any existing handlers
                    video.oncanplay = null;
                    video.onerror = null;
                    video.onloadeddata = null;
                    video.onended = null;
                    
                    // Reset video
                    video.src = '';
                    video.load();
                    
                    // Set up error handler with timeout fallback
                    video.onerror = (e) => {
                        if (!videoLoaded) {
                            videoLoaded = true;
                            console.error('Video error:', e, 'URL:', currentItem.url);
                            showError('Video playback failed');
                            skipToNext();
                        }
                    };
                    
                    // Try multiple events for better compatibility
                    const handleVideoReady = () => {
                        if (!videoLoaded) {
                            videoLoaded = true;
                            console.log('Video ready to play');
                            currentVideoElement = video;
                            
                            if (videoLoadTimeout) {
                                clearTimeout(videoLoadTimeout);
                                videoLoadTimeout = null;
                            }
                            
                            video.play().then(() => {
                                console.log('Video playing successfully');
                                video.classList.remove('hidden');
                                scheduleNext(currentItem.duration);
                                
                                // Set up end handler
                                video.onended = () => {
                                    console.log('Video ended naturally');
                                    // Let the timer handle transitions for consistency
                                };
                                
                            }).catch((error) => {
                                console.error('Video play failed:', error);
                                showError('Video play failed');
                                skipToNext();
                            });
                        }
                    };
                    
                    video.oncanplay = handleVideoReady;
                    video.onloadeddata = handleVideoReady;
                    
                    // Set timeout for video loading (5 seconds)
                    videoLoadTimeout = setTimeout(() => {
                        if (!videoLoaded) {
                            videoLoaded = true;
                            console.error('Video load timeout:', currentItem.url);
                            showError('Video load timeout');
                            skipToNext();
                        }
                    }, 5000);
                    
                    // Load the video
                    try {
                        video.src = currentItem.url;
                        video.currentTime = 0;
                        video.loop = false;
                        video.muted = true; // Ensure muted for autoplay
                        video.load();
                    } catch (e) {
                        console.error('Error setting video src:', e);
                        skipToNext();
                    }
                }
                
                isTransitioning = false;
            }, 100); // Reduced from 200ms to 100ms
        }
        
        function scheduleNext(duration) {
            // Further reduced minimum duration for faster transitions
            const timeoutDuration = Math.max(duration * 1000, 1000); // Minimum 1 second (was 1.5)
            console.log(\`Next content in \${duration} seconds\`);
            
            rotationTimeout = setTimeout(() => {
                rotateToNext();
            }, timeoutDuration);
        }
        
        function skipToNext() {
            console.log('Skipping to next content due to error');
            setTimeout(() => {
                rotateToNext();
            }, 250); // Reduced from 500ms to 250ms
        }
        
        function rotateToNext() {
            if (isTransitioning) {
                return;
            }
            
            currentIndex = (currentIndex + 1) % contentList.length;
            console.log(\`Rotating to item \${currentIndex + 1} of \${contentList.length}\`);
            
            // Further reduced delay for faster transitions
            setTimeout(() => {
                showContent();
            }, 50); // Reduced from 100ms to 50ms
        }

        // Initialize display
        console.log(\`Starting content rotation with \${contentList.length} items\`);
        if (contentList.length > 0) {
            showContent();
        } else {
            showError('No content items configured');
        }
        
        // Global error handler
        window.onerror = function(msg, url, lineNo, columnNo, error) {
            console.error('JavaScript error:', msg, 'at line', lineNo);
            return false;
        };
        
        // Prevent context menu and other interactions
        document.addEventListener('contextmenu', e => e.preventDefault());
        document.addEventListener('selectstart', e => e.preventDefault());
        document.addEventListener('dragstart', e => e.preventDefault());
    </script>
</body>
</html>`;
};
