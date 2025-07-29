export interface Asset {
  filepath: string;
  filetype: string;
  time: string;
  name?: string;
  playing_order?: string;
}

export interface ApiResponse {
  playlists?: Array<{
    is_default?: boolean;
    assets: Asset[];
  }>;
  functions?: {
    is_restarting?: boolean;
  };
}

export const fetchPlaylist = async (deviceName: String): Promise<Asset[]> => {
  const API_BASE_URL = "https://www.applicationbank.com/signage/api.php";

  const apiUrl = `${API_BASE_URL}?id=${encodeURIComponent(String(deviceName))}`;

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application-json",
        "User-Agent": "SignageApp/2.0 (Android TV Box)",
      },
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data: ApiResponse = await response.json();

    if (!data.playlists || data.playlists.length === 0) {
      throw new Error("No playlists found");
    }

    const playlist =
      data.playlists.find((p) => p.is_default) || data.playlists[0];

    return playlist.assets
      .filter(
        (asset) => asset.filepath && asset.time && parseInt(asset.time) > 0
      )
      .sort(
        (a, b) =>
          parseInt(a.playing_order || "0") - parseInt(b.playing_order || "0")
      );
  } catch (error) {
    console.error("API fetch error:", error);
    throw error;
  }
};
