package com.ghutch55.DigitalSignagev3;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        Log.d(TAG, "Received broadcast: " + action);

        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
                Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action) ||
                "android.intent.action.QUICKBOOT_POWERON".equals(action) ||
                "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {

            Log.d(TAG, "Boot completed, starting Digital Signage app and service");

            // Start the auto-start service
            Intent serviceIntent = new Intent(context, AutoStartService.class);
            context.startForegroundService(serviceIntent);

            // Also directly start the app with a delay
            new Thread(() -> {
                try {
                    Thread.sleep(10000); // 10 second delay for boot

                    Intent launchIntent = new Intent(context, MainActivity.class);
                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK |
                            Intent.FLAG_ACTIVITY_CLEAR_TASK |
                            Intent.FLAG_ACTIVITY_CLEAR_TOP);

                    context.startActivity(launchIntent);
                    Log.d(TAG, "Digital Signage app started successfully from boot");

                } catch (InterruptedException e) {
                    Log.e(TAG, "Boot delay interrupted", e);
                } catch (Exception e) {
                    Log.e(TAG, "Failed to start app on boot", e);
                }
            }).start();
        }
    }
}