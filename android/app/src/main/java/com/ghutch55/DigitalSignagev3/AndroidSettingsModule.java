package com.ghutch55.DigitalSignagev3;

import android.content.Context;
import android.provider.Settings;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;

public class AndroidSettingsModule extends ReactContextBaseJavaModule {
    private static final String MODULE_NAME = "AndroidSettingsModule";

    public AndroidSettingsModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return MODULE_NAME;
    }

    @ReactMethod
    public void getDeviceName(Promise promise) {
        try {
            Context context = getReactApplicationContext();

            String deviceName = Settings.Global.getString(
                    context.getContentResolver(),
                    Settings.Global.DEVICE_NAME);

            if (deviceName == null || deviceName.isEmpty()) {
                deviceName = Settings.Secure.getString(
                        context.getContentResolver(),
                        "bluetooth_name");
            }

            if (deviceName != null && !deviceName.isEmpty()) {
                promise.resolve(deviceName);
            } else {
                promise.reject("DEVICE_NAME_ERROR", "Could not retrieve device name from Android settings");
            }

        } catch (Exception e) {
            promise.reject("DEVICE_NAME_ERROR", "Error getting device name: " + e.getMessage());
        }
    }
}