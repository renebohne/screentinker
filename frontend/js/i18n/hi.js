// Hindi translations — INTENTIONALLY SKELETON.
//
// We have an active user in India. Rather than ship machine-quality Hindi that
// could read as unprofessional or get formality register / gendered verbs
// wrong, this file starts with only carefully scoped workflow translations;
// every other key falls back to English via the t() loader. Additional keys
// can be added after native review without any code change in views.
//
// Translation guidelines for whoever fills this in:
//   - Use formal आप register (this is B2B software, not consumer chat).
//   - Keep technical terms in English when borrowed (Playlist, YouTube, MIME)
//     — these are familiar to Indian users in their English form.
//   - Translate UI verbs (Save, Cancel, etc.) into proper Hindi.
//   - Test on the dashboard and content views first; those are wired to t().
//
// To add a key: copy from en.js and translate the value. Order doesn't matter;
// the loader merges over English fallback.
export default {
  'dashboard.select_all': 'सभी',
  'dashboard.invert_selection': 'चयन उलटें',
  'dashboard.cancel_selection': 'रद्द करें',
  'dashboard.add_to_group': 'समूह में जोड़ें',
  'dashboard.create_group_and_add': 'समूह बनाएं और जोड़ें',
  // --- 2.0.1: शुरुआती चेकलिस्ट, नया क्या है ---
  'gs.playlist.cta_here': 'सामग्री जोड़ें',
  'gs.assign.desc': 'जिस स्क्रीन पर सामग्री चलानी है उसे खोलें, Playlist पर क्लिक करें, अपना लेआउट चुनें; अगर पूरी स्क्रीन का उपयोग नहीं कर रहे हैं तो चुनें कि सामग्री कहाँ चले, और Publish पर क्लिक करें।',
  'gs.assign.cta_here': 'प्लेलिस्ट चुनें',
  'whatsnew.title': '{version} में नया क्या है',
  'whatsnew.dismiss': 'बंद करें',
  'whatsnew.full_notes': 'पूरी जानकारी',
  'whatsnew.history_title': 'नया क्या है',
  'whatsnew.version_line': '{version} — {date}',
  'whatsnew.version_current': '{version} — {date} (वर्तमान में चल रहा)',
  'onboarding.step.done.assign_label': 'इस स्क्रीन पर क्या चलना चाहिए?',
  'onboarding.step.done.assign_none': 'अभी कुछ नहीं',
  'onboarding.toast.playlist_assigned': 'प्लेलिस्ट असाइन कर दी गई',
  'onboarding.toast.assign_failed': 'वह प्लेलिस्ट असाइन नहीं की जा सकी',
  'onboarding.toast.publish_failed': 'प्लेलिस्ट प्रकाशित नहीं हो सकी, इसलिए अभी कुछ नहीं चलेगा',
};
