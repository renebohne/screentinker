'use strict';

/*
 * OptiSigns — listed, but NOT importable through its API, and here is why (docs read 2026-10):
 *   https://docs.optisigns.com/quickstart.md, https://docs.optisigns.com/generate-api-key.md,
 *   https://api-doc.optisigns.com (GraphQL schema reference)
 *
 * The GraphQL API (Pro Plus plan and above, account owner or super admin) lists assets, playlists,
 * schedules (RRULE) and devices — but it documents NO way to download an asset's file: there is no
 * download query or mutation, and the Asset type's storage fields (AWSS3ID, bucket, video_1080p,
 * thumbnail) are not documented as fetchable addresses. Fetching them anyway would be relying on
 * undocumented behaviour, which this importer does not do. Without the files, the playlists and
 * schedules would arrive empty.
 *
 * The wizard therefore explains this and offers the generic zip: download the files from OptiSigns,
 * put them in folders (one per playlist) or describe them in playlists.csv / screens.csv.
 */

module.exports = {
  id: 'optisigns',
  name: 'OptiSigns',
  mode: 'none',
  docs: ['https://docs.optisigns.com/quickstart', 'https://api-doc.optisigns.com'],
  fields: [],
  checkCredentials() { const e = new Error('OptiSigns cannot be imported through its API. Use the zip import.'); e.userMessage = e.message; throw e; },
  async open() { throw Object.assign(new Error('not supported'), { userMessage: 'OptiSigns cannot be imported through its API.' }); },
};
