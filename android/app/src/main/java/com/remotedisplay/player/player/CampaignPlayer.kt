package com.remotedisplay.player.player

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View

/**
 * 3.0 campaigns: switches WHOLE LAYOUTS (and full-screen items) on the screen, step by step
 * (Campaign.kt has the model, docs/layouts-and-campaigns.md the feature).
 *
 * Each step is drawn through the ZoneManager — a layout step as its own zones, a full-screen item as
 * a one-zone layout — so a zone in a campaign rotates its items, honours dayparts and plays every
 * media type exactly as a zone of an ordinary layout does. The switch is a short fade of the stage,
 * and media is already on disk before it is needed: MainActivity's download sweep includes every
 * campaign item (that is this player's "preload the next layout").
 *
 * Main thread only. While a campaign runs, MainActivity keeps the single-item engine stopped.
 */
class CampaignPlayer(
    private val stage: View,
    private val zones: () -> ZoneManager?,
    private val render: (CampaignStep) -> Unit,
    private val onLayoutStart: (CampaignStep.Layout) -> Unit,
    private val onItemStart: (CampaignStep.Item) -> Unit,
    private val onNothingAllowed: () -> Unit,
) {
    private val TAG = "CampaignPlayer"
    private val handler = Handler(Looper.getMainLooper())
    private var campaign: Campaign? = null
    private var index = -1
    private var advance: Runnable? = null

    val isActive: Boolean get() = campaign != null
    val currentIndex: Int get() = index

    /** Adopt a campaign: restart only when it actually changed (a refresh of the same one is a no-op). */
    fun apply(c: Campaign) {
        if (campaign?.sig == c.sig) return
        stop()
        campaign = c
        Log.i(TAG, "playing ${c.steps.size} step(s)")
        runStep(0)
    }

    fun stop() {
        advance?.let { handler.removeCallbacks(it) }
        advance = null
        campaign = null
        index = -1
    }

    private fun allowed(s: CampaignStep): Boolean = try {
        if (s is CampaignStep.Layout && s.zoneItems.isEmpty()) false else zones()?.allows(s.gate) ?: true
    } catch (e: Throwable) { true }   // a gate that cannot be evaluated fails OPEN, like an item

    private fun runStep(from: Int) {
        val c = campaign ?: return
        advance?.let { handler.removeCallbacks(it) }
        val idx = Campaign.nextAllowed(c.steps, from) { allowed(it) }
        if (idx == -1) {
            index = -1
            onNothingAllowed()
            schedule(30_000L) { runStep(from) }
            return
        }
        index = idx
        val step = c.steps[idx]
        // Fade out, swap, fade in: the old layout never blinks to black for a frame first.
        stage.animate().cancel()
        stage.animate().alpha(0f).setDuration(FADE_MS).withEndAction {
            if (campaign !== c || index != idx) return@withEndAction
            try { render(step) } catch (e: Throwable) { Log.w(TAG, "step $idx failed to render: ${e.message}") }
            when (step) {
                is CampaignStep.Layout -> onLayoutStart(step)
                is CampaignStep.Item -> onItemStart(step)
            }
            stage.animate().alpha(1f).setDuration(FADE_MS).start()
        }.start()
        schedule(step.durationMs + FADE_MS) { runStep(idx + 1) }
    }

    private fun schedule(ms: Long, fn: () -> Unit) {
        val r = Runnable { fn() }
        advance = r
        handler.postDelayed(r, ms)
    }

    companion object { const val FADE_MS = 250L }
}
