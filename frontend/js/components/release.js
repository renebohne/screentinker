/*
 * 3.0: "send this to the screen" for the Simple flows, honest about review.
 *
 * Publishes through the normal endpoint. When the workspace requires review, the release gate
 * refuses with an approval code; the change is then SUBMITTED for review (POST /approvals/submit,
 * which supersedes any older open submission for the same playlist) instead of being left as a
 * draft nobody knows about. Callers say "It's live" for 'live' and "Sent for review" for 'review' —
 * never that something is showing when it is waiting for a reviewer.
 *
 * 3.0 accessibility: before anything goes out, the playlist is checked (components/accessibility.js
 * confirmAccessibility). Errors or warnings are listed with "Publish anyway"; choosing to fix them
 * first throws an error with code 'a11y_cancelled' whose message says nothing was published, which
 * every caller already shows as its status line.
 */
import { api } from '../api.js';
import { confirmAccessibility, a11yCancelled } from './accessibility.js';

const NEEDS_REVIEW = new Set(['approval_required', 'approval_stale', 'deps_changed', 'changes_requested', 'awaiting_review', 'approver_ineligible']);

/** @returns {Promise<'live'|'review'>} */
export async function publishOrSubmit(playlistId, { note } = {}) {
  if (!playlistId) return 'live';
  if (!(await confirmAccessibility('playlist', playlistId))) throw a11yCancelled();
  try {
    await api.publishPlaylist(playlistId);
    return 'live';
  } catch (err) {
    if (!err || !NEEDS_REVIEW.has(String(err.code || ''))) throw err;
  }
  try {
    await api.submitForReview('playlist', playlistId, note || undefined);
  } catch (err) {
    // Already submitted with exactly this content: it is in the queue, which is what we wanted.
    if (!err || String(err.code || '') !== 'nothing_to_submit') throw err;
  }
  return 'review';
}
