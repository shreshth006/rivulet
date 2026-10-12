package dev.rivulet.sync

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Background sync through JobScheduler: Android decides when, within the
 * constraints given, so it costs nothing while there is no network and does
 * not need a notification or a foreground service.
 *
 * Two jobs: a periodic one (Android's floor is 15 minutes) that catches up
 * rooms whose apps are not running, and a one-off scheduled after every write,
 * so an edit made just before the app is closed is still pushed as soon as
 * there is a network.
 */
class SyncJobService : JobService() {

    override fun onStartJob(params: JobParameters): Boolean {
        val app = application as SyncApp
        app.worker.execute {
            var retry = false
            try {
                app.reopenAll()
                val result = EngineHost.call("sync", JSONObject(), timeoutMs = 60_000) as? JSONObject
                // A transport error is worth retrying with backoff; an auth or
                // validation error will not fix itself.
                retry = result?.keys()?.asSequence()?.any { room ->
                    result.optJSONObject(room)?.optString("status") == "offline"
                } ?: false
                Log.i(TAG, "job ${params.jobId} synced: $result")
            } catch (e: Exception) {
                Log.w(TAG, "job ${params.jobId} failed: ${e.message}")
                retry = true
            } finally {
                jobFinished(params, retry && params.jobId == SOON_JOB)
            }
        }
        return true // work continues on the worker thread
    }

    // Stopped by the system (constraints lost, quota): try again later.
    override fun onStopJob(params: JobParameters) = true

    companion object {
        private const val TAG = "RivuletSync"
        private const val PERIODIC_JOB = 1
        private const val SOON_JOB = 2

        fun schedulePeriodic(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (scheduler.getPendingJob(PERIODIC_JOB) != null) return
            scheduler.schedule(
                JobInfo.Builder(PERIODIC_JOB, ComponentName(context, SyncJobService::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(TimeUnit.MINUTES.toMillis(15))
                    .setPersisted(true)
                    .build(),
            )
        }

        /** Sync as soon as there is a network. Repeated calls replace the pending one. */
        fun scheduleSoon(context: Context) {
            context.getSystemService(JobScheduler::class.java).schedule(
                JobInfo.Builder(SOON_JOB, ComponentName(context, SyncJobService::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setBackoffCriteria(TimeUnit.SECONDS.toMillis(30), JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .setPersisted(true)
                    .build(),
            )
        }
    }
}
