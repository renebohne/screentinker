'use strict';

// CI runs in UTC; the resolver's day window uses server-local midnight, so pin the process to
// UTC and every window-edge case below means the same thing on a laptop as on the runner.
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveIcalData } = require('../lib/data-sources/ical-resolver');
const { renderSlideHtml, interpolateDataSources } = require('../lib/slide-render');

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:evt-today-1
SUMMARY:Projekt-Sync & Review
DESCRIPTION:Wöchentliches Team-Meeting
LOCATION:Konferenzraum Berlin
DTSTART:20260904T090000Z
DTEND:20260904T100000Z
END:VEVENT
BEGIN:VEVENT
UID:evt-today-2
SUMMARY:Kunden-Präsentation
DESCRIPTION:Vorstellung Release 2.0
LOCATION:Konferenzraum Berlin
DTSTART:20260904T140000Z
DTEND:20260904T153000Z
END:VEVENT
BEGIN:VEVENT
UID:evt-future-3
SUMMARY:Gelber Sack Abholung
DESCRIPTION:Entsorgung Wertstoffe
LOCATION:Musterstraße 1
DTSTART:20260905T060000Z
DTEND:20260905T070000Z
END:VEVENT
END:VCALENDAR`;

const RECURRING_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-daily-standup
SUMMARY:Daily Standup
LOCATION:Raum 101
DTSTART:20260901T080000Z
DTEND:20260901T083000Z
RRULE:FREQ=DAILY;COUNT=10
END:VEVENT
END:VCALENDAR`;

test('iCal resolver parses events and formats room status', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  const data = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'UTC', locale: 'de' }, now);

  assert.equal(data.status, 'BELEGT');
  assert.equal(data.status_de, 'BELEGT');
  assert.equal(data.status_en, 'BUSY');
  assert.equal(data.is_busy, true);
  assert.equal(data.current_event_summary, 'Projekt-Sync & Review');
  assert.equal(data.current_event_location, 'Konferenzraum Berlin');
  assert.match(data.status_detail, /Belegt bis/);
  assert.equal(data.next_event_summary, 'Kunden-Präsentation');
  assert.equal(data.event_count, 3);
  assert.ok(data.agenda_text.includes('Projekt-Sync & Review'));
});

test('iCal resolver reports AVAILABLE when no active event', async () => {
  const now = new Date('2026-09-04T11:00:00Z');
  const data = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'UTC', locale: 'de' }, now);

  assert.equal(data.status, 'FREI');
  assert.equal(data.status_de, 'FREI');
  assert.equal(data.status_en, 'AVAILABLE');
  assert.equal(data.is_busy, false);
  assert.equal(data.current_event_summary, '');
  assert.equal(data.next_event_summary, 'Kunden-Präsentation');
  assert.match(data.status_detail, /Frei bis/);
});

test('iCal resolver handles recurring RRULE events', async () => {
  const now = new Date('2026-09-04T08:15:00Z');
  const data = await resolveIcalData({ raw_data: RECURRING_ICS, timezone: 'UTC' }, now);

  assert.equal(data.status_en, 'BUSY');
  assert.equal(data.current_event_summary, 'Daily Standup');
  assert.equal(data.current_event_location, 'Raum 101');
});

test('iCal resolver respects keyword filters', async () => {
  const now = new Date('2026-09-04T07:00:00Z');
  const data = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    filter_include: 'Gelber Sack',
    timezone: 'UTC'
  }, now);

  assert.equal(data.event_count, 1);
  assert.equal(data.next_event_summary, 'Gelber Sack Abholung');
});

test('iCal resolver respects privacy mode', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  const data = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    hide_private: true,
    timezone: 'UTC'
  }, now);

  assert.equal(data.status_en, 'BUSY');
  assert.equal(data.current_event_summary, 'Belegt');
  assert.equal(data.current_event_description, '');
});

test('interpolateDataSources correctly replaces {{ds:slug.key}} tags', () => {
  const dataMap = {
    room_berlin: {
      status: 'BELEGT',
      status_detail: 'Belegt bis 11:30 (Projekt-Sync)',
      next_event_summary: 'Kunden-Präsentation',
      next_event_time: '14:00 - 15:30',
    },
    weather_berlin: {
      temp: '22°C',
    }
  };

  const resolver = (slug, key) => dataMap[slug]?.[key];

  const templateText = 'Status: {{ds:room_berlin.status}} | Details: {{ds:room_berlin.status_detail}}';
  const resolved = interpolateDataSources(templateText, resolver);

  assert.equal(resolved, 'Status: BELEGT | Details: Belegt bis 11:30 (Projekt-Sync)');

  // Missing data source returns empty string
  const missing = interpolateDataSources('Missing: {{ds:unknown.field}}', resolver);
  assert.equal(missing, 'Missing: ');
});

test('renderSlideHtml integrates data source variables into rendered slide HTML', () => {
  const slideConfig = {
    template: {
      aspect: '16:9',
      background: '#000000',
      elements: [
        { id: 'el-1', kind: 'head', slot: 'headline', x: 5, y: 10, w: 90, h: 20, style: { color: '#ffffff', size: 5, weight: 700, align: 'left', font: 'f:inter' } },
        { id: 'el-2', kind: 'body', slot: 'subhead', x: 5, y: 35, w: 90, h: 20, style: { color: '#cccccc', size: 3, weight: 400, align: 'left', font: 'f:inter' } },
      ]
    },
    fields: {
      headline: 'Raum Berlin: {{ds:room_berlin.status}}',
      subhead: '{{ds:room_berlin.status_detail}}',
    }
  };

  const dataSources = {
    room_berlin: {
      status: 'FREI',
      status_detail: 'Frei bis 14:00 (Nächstes Meeting: Kunden-Präsentation)',
    }
  };

  const html = renderSlideHtml(slideConfig, { dataSources });

  assert.ok(html.includes('Raum Berlin: FREI'), 'Rendered HTML contains interpolated status');
  assert.ok(html.includes('Frei bis 14:00 (Nächstes Meeting: Kunden-Präsentation)'), 'Rendered HTML contains interpolated status detail');
});

test('iCal resolver rejects SSRF targets (loopback / private ranges)', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  // Loopback and cloud-metadata endpoints must never be fetched.
  for (const bad of [
    'http://127.0.0.1:8080/feed.ics',
    'http://127.0.0.1/private.ics',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/feed.ics',
    'http://192.168.1.10/feed.ics',
    'http://10.0.0.5/feed.ics',
  ]) {
    await assert.rejects(
      () => resolveIcalData({ url: bad, timezone: 'UTC' }, now),
      /blocked-ip|SSRF|loopback|private/i,
      `expected SSRF guard to reject ${bad}`,
    );
  }
});

test('iCal resolver rejects non-HTTP(S) URL schemes', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  await assert.rejects(
    () => resolveIcalData({ url: 'file:///etc/passwd', timezone: 'UTC' }, now),
    /disallowed-scheme|protocol|SSRF/i,
    'file:// scheme must be rejected',
  );
});

test('iCal resolver tolerates malformed inline ICS without crashing', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  // node-ical is lenient: garbage fails gracefully as an empty feed rather than throwing.
  // The contract is "no crash / no 500", not "reject".
  const data = await resolveIcalData({ raw_data: 'this is not a valid calendar{', timezone: 'UTC' }, now);
  assert.equal(typeof data, 'object');
  assert.equal(data.event_count, 0);
});

test('iCal resolver treats empty config as a clean error (not a crash)', async () => {
  const now = new Date('2026-09-04T09:30:00Z');
  await assert.rejects(
    () => resolveIcalData({}, now),
    /No valid iCal URL or data provided/,
  );
  await assert.rejects(
    () => resolveIcalData(null, now),
    /No valid iCal URL or data provided/,
  );
});

test('iCal resolver honours exclude_text and plain-substring (non-ReDoS) filtering', async () => {
  const now = new Date('2026-09-04T07:00:00Z');
  // exclude_text drops matching events.
  const excluded = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    exclude_text: 'Gelber Sack',
    timezone: 'UTC',
  }, now);
  assert.equal(excluded.event_count, 2);
  assert.notEqual(excluded.next_event_summary, 'Gelber Sack Abholung');

  // A "regex-looking" filter pattern is treated as a literal substring, so a pathological
  // pattern cannot trigger catastrophic backtracking (ReDoS) on hostile summaries.
  const data = await resolveIcalData({
    raw_data: SAMPLE_ICS,
    filter_text: '(a+)+$',
    timezone: 'UTC',
  }, now);
  assert.equal(data.event_count, 0);
});

test('iCal resolver formats times in the configured timezone', async () => {
  const now = new Date('2026-09-04T09:30:00Z'); // 10:30 in Europe/Berlin (CEST), 09:30 in UTC
  const utc = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'UTC', locale: 'de' }, now);
  const berlin = await resolveIcalData({ raw_data: SAMPLE_ICS, timezone: 'Europe/Berlin', locale: 'de' }, now);

  assert.ok(String(utc.current_time).startsWith('09:00'), `UTC expected 09:00, got ${utc.current_time}`);
  assert.ok(String(berlin.current_time).startsWith('11:00'), `Berlin expected 11:00, got ${berlin.current_time}`);
});

test('data-source values are HTML-escaped when rendered into slide HTML (XSS invariant)', () => {
  const slideConfig = {
    template: {
      aspect: '16:9',
      background: '#000000',
      elements: [
        { id: 'el-1', kind: 'head', slot: 'headline', x: 5, y: 10, w: 90, h: 20, style: { color: '#ffffff', size: 5, weight: 700, align: 'left', font: 'f:inter' } },
      ]
    },
    fields: {
      headline: '{{ds:room.title}}',
    }
  };

  // A hostile data-source value containing script/attribute-breaking markup must be escaped,
  // never emitted verbatim into the rendered document.
  const dataSources = {
    room: {
      title: '<script>alert(1)</script>" onmouseover="x',
    }
  };

  const html = renderSlideHtml(slideConfig, { dataSources });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script must not appear');
  assert.ok(html.includes('&lt;script&gt;'), 'script tag must be HTML-escaped');
  assert.ok(!html.includes('onmouseover="x'), 'attribute-breaking markup must be escaped');
});

test('iCal resolver honours EXDATE for recurring RRULE events', async () => {
  const EXDATE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-daily-standup-exdate
SUMMARY:Daily Standup
LOCATION:Raum 101
DTSTART:20260901T080000Z
DTEND:20260901T083000Z
RRULE:FREQ=DAILY;COUNT=10
EXDATE:20260904T080000Z
END:VEVENT
END:VCALENDAR`;

  const now = new Date('2026-09-04T08:15:00Z');
  const data = await resolveIcalData({ raw_data: EXDATE_ICS, timezone: 'UTC' }, now);

  assert.equal(data.is_busy, false);
  assert.notEqual(data.current_event_summary, 'Daily Standup');
});

test('interpolateDataSources caps long values to MAX_FIELD_CHARS', () => {
  const longText = 'A'.repeat(5000);
  const resolver = (slug, key) => (slug === 'test' && key === 'long' ? longText : null);
  const interpolated = interpolateDataSources('{{ds:test.long}}', resolver);

  assert.equal(interpolated.length, 2000);
  assert.equal(interpolated, 'A'.repeat(2000));
});

test('background poller functions export cleanly', () => {
  const { pollDueDataSources, startDataSourcesPoller, stopDataSourcesPoller } = require('../lib/data-sources/service');
  assert.equal(typeof pollDueDataSources, 'function');
  assert.equal(typeof startDataSourcesPoller, 'function');
  assert.equal(typeof stopDataSourcesPoller, 'function');
});

test('iCal resolver honours RECURRENCE-ID time overrides', async () => {
  const RECURRENCE_OVERRIDE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-recurring-override
SUMMARY:Team Meeting
LOCATION:Room A
DTSTART:20260904T100000Z
DTEND:20260904T110000Z
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT
BEGIN:VEVENT
UID:evt-recurring-override
RECURRENCE-ID:20260904T100000Z
SUMMARY:Team Meeting (Moved)
LOCATION:Room B
DTSTART:20260904T140000Z
DTEND:20260904T150000Z
END:VEVENT
END:VCALENDAR`;

  // At 10:30 (the original time), the room should be FREE because the meeting moved to 14:00
  const nowMorning = new Date('2026-09-04T10:30:00Z');
  const dataMorning = await resolveIcalData({ raw_data: RECURRENCE_OVERRIDE_ICS, timezone: 'UTC' }, nowMorning);
  assert.equal(dataMorning.is_busy, false);
  assert.equal(dataMorning.next_event_summary, 'Team Meeting (Moved)');

  // At 14:30 (the moved time), the room should be BUSY
  const nowAfternoon = new Date('2026-09-04T14:30:00Z');
  const dataAfternoon = await resolveIcalData({ raw_data: RECURRENCE_OVERRIDE_ICS, timezone: 'UTC' }, nowAfternoon);
  assert.equal(dataAfternoon.is_busy, true);
  assert.equal(dataAfternoon.current_event_summary, 'Team Meeting (Moved)');
  assert.equal(dataAfternoon.current_event_location, 'Room B');
});

test('all-day events format consistently without shifting days across timezones', async () => {
  const ALLDAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-allday-holiday
SUMMARY:Tag der Arbeit
DTSTART;VALUE=DATE:20260501
DTEND;VALUE=DATE:20260502
END:VEVENT
END:VCALENDAR`;

  const now = new Date('2026-04-20T10:00:00Z');
  const dataUtc = await resolveIcalData({ raw_data: ALLDAY_ICS, timezone: 'UTC', locale: 'de' }, now);
  const dataNy = await resolveIcalData({ raw_data: ALLDAY_ICS, timezone: 'America/New_York', locale: 'de' }, now);

  assert.ok(dataUtc.next_date.includes('1. Mai') || dataUtc.next_date.includes('1. May'), `UTC next_date: ${dataUtc.next_date}`);
  assert.ok(dataNy.next_date.includes('1. Mai') || dataNy.next_date.includes('1. May'), `NY next_date: ${dataNy.next_date}`);
});

test('status_detail reports "Ganztägig frei" when the next meeting is on a subsequent day', async () => {
  const MONDAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-monday-standup
SUMMARY:Monday Standup
DTSTART:20260907T090000Z
DTEND:20260907T100000Z
END:VEVENT
END:VCALENDAR`;

  // Friday at 17:00
  const nowFriday = new Date('2026-09-04T17:00:00Z');
  const data = await resolveIcalData({ raw_data: MONDAY_ICS, timezone: 'UTC', locale: 'de' }, nowFriday);

  assert.equal(data.is_busy, false);
  assert.equal(data.status_detail, 'Ganztägig frei');
});

test('iCal resolver bounds high-frequency RRULE series (e.g. FREQ=MINUTELY)', async () => {
  const HIGH_FREQ_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ScreenTinker Test//DE
BEGIN:VEVENT
UID:evt-high-freq
SUMMARY:Minutely Pulse
DTSTART:20260904T000000Z
DTEND:20260904T000100Z
RRULE:FREQ=MINUTELY;INTERVAL=1
END:VEVENT
END:VCALENDAR`;

  const now = new Date('2026-09-04T08:00:00Z');
  const data = await resolveIcalData({ raw_data: HIGH_FREQ_ICS, max_events: 10, timezone: 'UTC' }, now);
  assert.ok(data.event_count <= 10);
});

test('pinnedLookup returns full array when options.all is true', (t, done) => {
  const { pinnedLookup } = require('../lib/ssrf-guard');
  const lookup = pinnedLookup(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);

  lookup('example.com', { all: true }, (err, addresses) => {
    assert.ifError(err);
    assert.ok(Array.isArray(addresses));
    assert.equal(addresses.length, 2);
    assert.equal(addresses[0].address, '93.184.216.34');
    assert.equal(addresses[0].family, 4);
    assert.equal(addresses[1].address, '2606:2800:220:1:248:1893:25c8:1946');
    assert.equal(addresses[1].family, 6);
    done();
  });
});

test('withFetchSlot limits concurrent executions and hands slot to waiter', async () => {
  const { withFetchSlot } = require('../lib/data-sources/service');
  let running = 0;
  let maxConcurrent = 0;

  const tasks = Array.from({ length: 10 }).map((_, i) =>
    withFetchSlot(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 20));
      running -= 1;
      return i;
    })
  );

  const results = await Promise.all(tasks);
  assert.equal(results.length, 10);
  assert.ok(maxConcurrent <= 4, `expected max concurrency <= 4, was ${maxConcurrent}`);
});

// ---------------------------------------------------------------------------------------------
// Follow-ups to #332, fixed on main after the merge.

const { describeSyncError } = require('../lib/data-sources/service');
const { pinnedLookup } = require('../lib/ssrf-guard');

test('THE BUG: a recurring meeting that began before local midnight and is still running is BUSY', async () => {
  // Daily 23:30-01:30 UTC. At 00:30 the occurrence that started at 23:30 yesterday is live, but
  // the expansion window used to start at today's midnight, so the room read as free.
  const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-overnight
SUMMARY:Night Shift Standup
DTSTART:20260101T233000Z
DTEND:20260102T013000Z
RRULE:FREQ=DAILY
END:VEVENT
END:VCALENDAR`;
  const data = await resolveIcalData({ raw_data: ICS, timezone: 'UTC', locale: 'en' }, new Date('2026-09-07T00:30:00Z'));
  assert.equal(data.current_title, 'Night Shift Standup');
  assert.equal(data.status, 'BUSY');
});

test('THE BUG: a FREQ=MINUTELY series with the default lookahead is expanded, not dropped', async () => {
  // node-ical ignores the iterator argument, so the old "bound" never ran and the library's
  // 10,000-iteration throw dropped the whole series as FREE.
  const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-minutely
SUMMARY:Minutely Pulse
DTSTART:20260904T000000Z
DTEND:20260904T000100Z
RRULE:FREQ=MINUTELY
END:VEVENT
END:VCALENDAR`;
  const data = await resolveIcalData({ raw_data: ICS, timezone: 'UTC' }, new Date('2026-09-10T08:00:30Z'));
  assert.equal(data.current_title, 'Minutely Pulse', 'the live occurrence must be found');
  assert.ok(data.event_count > 0);
  assert.ok(data.event_count <= 50, 'and the result is bounded to what a sign can show');
});

test('a FREQ=SECONDLY series is bounded the same way', async () => {
  const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-secondly
SUMMARY:Tick
DTSTART:20260904T000000Z
DTEND:20260904T000010Z
RRULE:FREQ=SECONDLY
END:VEVENT
END:VCALENDAR`;
  const data = await resolveIcalData({ raw_data: ICS, timezone: 'UTC' }, new Date('2026-09-10T08:00:05Z'));
  assert.equal(data.current_title, 'Tick');
  assert.ok(data.event_count <= 50);
});

test('last_error never carries an address, a port, or a raw upstream string', () => {
  const ssrf = Object.assign(new Error('blocked: blocked-ip:10.0.0.5'), { name: 'SsrfError' });
  assert.doesNotMatch(describeSyncError(ssrf), /10\.0\.0\.5|blocked-ip/);
  assert.doesNotMatch(describeSyncError(new Error('connect ECONNREFUSED 203.0.113.5:443')), /203|443|ECONNREFUSED/);
  assert.match(describeSyncError(new Error('Calendar feed responded 401')), /401/);
  assert.match(describeSyncError(new Error('Calendar feed timed out')), /did not respond/);
  assert.equal(describeSyncError(new Error('something internal: /srv/x')), 'Sync failed');
});

test('THE BUG: pinnedLookup with no vetted address fails closed, never to loopback', (t, done) => {
  const lookup = pinnedLookup([]);
  lookup('example.com', {}, (err, addr) => {
    assert.ok(err, 'an empty vetted list must be an error');
    assert.notEqual(addr, '127.0.0.1');
    assert.equal(addr, undefined);
    done();
  });
});

test('THE BUG: the assembled field is re-capped after interpolation, not only each token', () => {
  const tokens = '{{ds:cal.agenda}}'.repeat(90);                   // 90 x 17 = 1530 chars, under the field cap
  const html = renderSlideHtml(
    { fields: { body: tokens }, elements: [{ id: 'e', kind: 'body', slot: 'body', box: { x: 0, y: 0, w: 100, h: 50 } }] },
    { resolveData: () => '§'.repeat(2000) },
  );
  const emitted = (html.match(/§/g) || []).length;
  assert.ok(emitted <= 2000, `field expanded to ${emitted} chars; the renderer promises MAX_FIELD_CHARS`);
});
