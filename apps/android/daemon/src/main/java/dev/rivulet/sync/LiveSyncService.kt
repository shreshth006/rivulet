package dev.rivulet.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONObject

/**
 * Optional "live sync": a foreground service that keeps the process -- and
 * so the engine -- alive, and syncs every room every [INTERVAL_MS]. Without
 * it, edits from other devices arrive on the next scheduled job instead.
 *
 * Android 15 caps data-sync foreground services at about six hours a day;
 * when the system says time is up ([onTimeout]) the service stops, and the
 * scheduled jobs carry on.
 */
class LiveSyncService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            val app = application as SyncApp
            app.worker.execute {
                runCatching { EngineHost.call("sync", JSONObject(), timeoutMs = 60_000) }
                val count = app.rooms.all().size
                notify("Keeping $count room${if (count == 1) "" else "s"} in sync")
            }
            handler.postDelayed(this, INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = build("Starting live sync")
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // The daily foreground allowance is spent; fall back to scheduled jobs.
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    private fun notify(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(text))
    }

    private fun build(text: String): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Live sync", NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setContentTitle("Rivulet Sync")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL = "live-sync"
        private const val NOTIFICATION_ID = 1
        private const val INTERVAL_MS = 30_000L

        fun start(context: Context) {
            context.startForegroundService(Intent(context, LiveSyncService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LiveSyncService::class.java))
        }
    }
}
