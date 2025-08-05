package com.ghutch55.DigitalSignagev3;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.util.Log;

public class AutoStartService extends Service {
    private static final String TAG = "AutoStartService";
    private static final long RESTART_DELAY = 30000; // 30 seconds
    private Handler handler;
    private Runnable restartRunnable;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "AutoStartService created");
        handler = new Handler();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "AutoStartService started");

        // Start the signage app immediately
        startSignageApp();

        // Set up periodic restart (optional - you can remove this if not needed)
        setupPeriodicRestart();

        // Return START_STICKY so the service restarts if killed
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "AutoStartService destroyed");

        if (handler != null && restartRunnable != null) {
            handler.removeCallbacks(restartRunnable);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // We don't provide binding
    }

    private void startSignageApp() {
        try {
            Intent signageIntent = new Intent(this, MainActivity.class);
            signageIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK |
                    Intent.FLAG_ACTIVITY_CLEAR_TOP |
                    Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(signageIntent);
            Log.d(TAG, "Started signage app from service");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start signage app from service", e);
        }
    }

    private void setupPeriodicRestart() {
        // Cancel any existing restart timer
        if (restartRunnable != null) {
            handler.removeCallbacks(restartRunnable);
        }

        restartRunnable = new Runnable() {
            @Override
            public void run() {
                Log.d(TAG, "Periodic restart triggered");
                startSignageApp();

                // Schedule next restart
                handler.postDelayed(this, RESTART_DELAY);
            }
        };

        // Schedule first restart
        handler.postDelayed(restartRunnable, RESTART_DELAY);
    }
}