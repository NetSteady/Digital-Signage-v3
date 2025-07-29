export interface Asset {
  id?: string;
  filepath: string;
  filetype: string;
  time: string;
  name?: string;
  playing_order?: string;
}

export interface Playlist {
  id?: string;
  name?: string;
  starttime?: string | null;
  endtime?: string | null;
  startdate?: string | null;
  enddate?: string | null;
  weekdays?: string | null;
  is_default?: boolean;
  assets: Asset[];
}

export interface ApiResponse {
  playlists?: Playlist[];
  functions?: {
    is_restarting?: boolean;
  };
}

// Helper function to check if current time/date matches playlist schedule
const isPlaylistActive = (
  playlist: Playlist,
  now: Date = new Date()
): boolean => {
  // Default playlist is always active if no other playlist matches
  if (playlist.is_default) {
    return true;
  }

  // Check date range
  if (playlist.startdate || playlist.enddate) {
    const currentDate = now.getTime();

    if (playlist.startdate) {
      const startDate = new Date(playlist.startdate).getTime();
      if (currentDate < startDate) {
        return false;
      }
    }

    if (playlist.enddate) {
      const endDate = new Date(playlist.enddate).getTime();
      if (currentDate > endDate) {
        return false;
      }
    }
  }

  // Check day of week
  if (playlist.weekdays) {
    const currentDay = now.toLocaleDateString("en-US", { weekday: "short" });
    const dayMap: { [key: string]: string } = {
      Mon: "Monday",
      Tue: "Tuesday",
      Wed: "Wednesday",
      Thu: "Thursday",
      Fri: "Friday",
      Sat: "Saturday",
      Sun: "Sunday",
    };

    const scheduledDays = playlist.weekdays.split(", ");
    const isScheduledDay = scheduledDays.some(
      (day) =>
        day === currentDay ||
        dayMap[day] === now.toLocaleDateString("en-US", { weekday: "long" })
    );

    if (!isScheduledDay) {
      return false;
    }
  }

  // Check time range (if specified)
  if (playlist.starttime || playlist.endtime) {
    const currentTime = now.toTimeString().slice(0, 8); // HH:MM:SS format

    if (playlist.starttime && currentTime < playlist.starttime) {
      return false;
    }

    if (playlist.endtime && currentTime > playlist.endtime) {
      return false;
    }
  }

  return true;
};

export const fetchPlaylist = async (deviceName: String): Promise<Asset[]> => {
  const API_BASE_URL = "https://www.applicationbank.com/signage/api.php";
  const apiUrl = `${API_BASE_URL}?id=${encodeURIComponent(String(deviceName))}`;

  try {
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
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

    const now = new Date();

    // Find the first active non-default playlist
    let activePlaylist = data.playlists.find(
      (playlist) => !playlist.is_default && isPlaylistActive(playlist, now)
    );

    // If no scheduled playlist is active, use default
    if (!activePlaylist) {
      activePlaylist =
        data.playlists.find((p) => p.is_default) || data.playlists[0];
    }

    console.log(
      `Using playlist: ${activePlaylist.name || "Default"} (ID: ${
        activePlaylist.id
      })`
    );

    return activePlaylist.assets
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
