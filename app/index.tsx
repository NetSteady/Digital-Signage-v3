import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Asset, fetchPlaylist } from "../services/Api";
import { getDeviceName } from "../services/DeviceName";

export default function App() {
  const [deviceName, setDeviceName] = useState<string>("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const test = async () => {
      try {
        const name = await getDeviceName();
        console.log("Device name:", name);
        setDeviceName(name);

        const playlist = await fetchPlaylist(name);
        console.log("Assets:", playlist);
        setAssets(playlist);
      } catch (err) {
        console.error("Test error:", err);
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    };

    test();
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>Device: {deviceName}</Text>
      <Text style={styles.text}>Assets: {assets.length}</Text>
      {error && <Text style={styles.error}>Error: {error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center" },
  text: { color: "white", fontSize: 18, marginBottom: 10 },
  error: { color: "red", fontSize: 16 },
});
