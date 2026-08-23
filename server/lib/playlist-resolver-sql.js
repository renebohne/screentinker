'use strict';

/*
 * The playlist-inheritance resolver, as SQL, in ONE place.
 *
 * Both the boot migration (db/database.js) and any test fixture that hand-builds a schema apply it
 * from here. The alternative — pasting CREATE VIEW into a fixture — is how a fixture drifts from
 * the real schema and starts proving things about a database that does not exist.
 *
 * ⚠️ Apply this AFTER every table-rebuilding migration. SQLite refuses to drop a table a view still
 * references, so defining these early broke the tenant delete-cascade migration on every install
 * ("no such table: main.devices"). A view is a dependency on every table it names.
 *
 * DROP-then-CREATE rather than IF NOT EXISTS, so the definition can never drift from the code that
 * ships with it: a view pinned at first-create is a migration you cannot amend.
 */

// Where a device would inherit from, ignoring anything chosen for the device itself. Kept separate
// so the backfill can ask "what WOULD this device inherit?" without consulting playlist_source —
// the column it is in the middle of computing.
const INHERITED_VIEW = `CREATE VIEW device_inherited_playlist AS
  SELECT d.id AS device_id,
         (SELECT vw.playlist_id FROM video_walls vw
           WHERE vw.id = d.wall_id AND vw.playlist_id IS NOT NULL) AS wall_playlist_id,
         (SELECT g.playlist_id FROM device_groups g
            JOIN device_group_members m ON m.group_id = g.id
           WHERE m.device_id = d.id AND g.playlist_id IS NOT NULL
           ORDER BY g.priority DESC, g.created_at ASC, g.id ASC LIMIT 1) AS group_playlist_id
    FROM devices d`;

/*
 * The rule itself. Order mirrors routes/schedules.js (device beats group, then priority, then
 * oldest) deliberately: two inheritance systems in one product that disagree is how an operator
 * stops trusting both. Walls sit above groups because a wall member playing the group's playlist
 * tears the picture across the seam — visibly broken — while a grouped screen playing the wall's is
 * merely not what you asked for. Where precedence must guess, guess toward the legible failure.
 */
const RESOLVED_VIEW = `CREATE VIEW device_resolved_playlist AS
  SELECT d.id AS device_id,
         -- 'none' short-circuits everything: "deliberately plays nothing" is not the same as
         -- "nothing was chosen". Without this branch the backfill's carefully-preserved dark
         -- screens inherit their group's playlist and light up during an upgrade.
         CASE WHEN d.playlist_source = 'none' THEN NULL ELSE COALESCE(
           CASE WHEN d.playlist_source = 'device' THEN d.playlist_id END,
           i.wall_playlist_id,
           i.group_playlist_id,
           -- LAST RESORT: an id nobody has classified. playlist_source is NULL both for "inherits"
           -- and for "a writer set playlist_id and never learned about the column", and resolving
           -- the second case to NOTHING turned 12 tests red. Honouring the raw id BELOW the
           -- inherited sources means an unconverted writer keeps working while the migration is
           -- staged, and a stale copy still loses to the group.
           d.playlist_id
         ) END AS playlist_id,
         CASE
           WHEN d.playlist_source = 'none' THEN NULL
           WHEN d.playlist_source = 'device' AND d.playlist_id IS NOT NULL THEN 'device'
           WHEN i.wall_playlist_id  IS NOT NULL THEN 'wall'
           WHEN i.group_playlist_id IS NOT NULL THEN 'group'
           WHEN d.playlist_id IS NOT NULL THEN 'device'
           ELSE NULL
         END AS source
    FROM devices d
    JOIN device_inherited_playlist i ON i.device_id = d.id`;

/**
 * (Re)create both views. Idempotent, and safe to call on a fixture whose tables were hand-built —
 * the columns referenced are `devices.wall_id`, `devices.playlist_id`, `devices.playlist_source`,
 * `video_walls.playlist_id`, `device_groups.playlist_id/priority/created_at` and
 * `device_group_members`, so a fixture must provide those or SQLite will reject the view.
 */
function applyResolverViews(db) {
  db.exec('DROP VIEW IF EXISTS device_resolved_playlist');
  db.exec('DROP VIEW IF EXISTS device_inherited_playlist');
  db.exec(INHERITED_VIEW);
  db.exec(RESOLVED_VIEW);
}

module.exports = { applyResolverViews, INHERITED_VIEW, RESOLVED_VIEW };
