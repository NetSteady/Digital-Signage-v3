import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules } from "react-native";

const { AndroidSettingsModule } = NativeModules;

export const getDeviceName = async (): Promise<string> => {
  try {
    let savedDeviceName = await AsyncStorage.getItem("deviceName");

    if (savedDeviceName) {
      return savedDeviceName;
    }

    let deviceName = await AndroidSettingsModule.getDeviceName();

    if (!deviceName || deviceName === "unknown" || deviceName === "") {
      deviceName = `T95_${Math.random().toString(36).substring(2, 9)}`;
    }

    const cleanDeviceName = deviceName
      .replace(/[^a-zA-Z0-9-_.]/g, "_")
      .replace(/_{2,}/g, "_")
      .toLowerCase();

    await AsyncStorage.setItem("deviceName", cleanDeviceName);

    return cleanDeviceName;
  } catch (error) {
    console.error("Error getting device name:", error);

    const fallbackName = `tvbox_${Date.now()}`;
    await AsyncStorage.setItem("deviceName", fallbackName);
    return fallbackName;
  }
};
