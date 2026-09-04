'use strict';

/**
 * iCal (.ics) Data Source Resolver for ScreenTinker.
 *
 * Ingests VCALENDAR feeds, handles RRULE recurring series, timezones,
 * and extracts standard structured fields for room signage and agenda displays.
 */

const ical = require('node-ical');

/**
 * Fetch and parse an iCal feed from a URL or raw string.
 *
 * @param {object} config Configuration object:
 *   - url: string (HTTP/HTTPS/webcal URL)
 *   - ics_data: string (optional raw .ics content)
 *   - locale: string ('de', 'en', default 'de')
 *   - timezone: string (IANA timezone, default 'local')
 *   - lookahead_days: number (default 14)
 *   - max_events: number (default 10)
 *   - event_type: 'all' | 'timed' | 'allday' (default 'all')
 *   - filter_text: string (case-insensitive include keyword / regex)
 *   - exclude_text: string (case-insensitive exclude keyword / regex)
 *   - hide_private: boolean (mask summary as 'Busy' / 'Belegt')
 * @param {Date} [nowRef] Reference timestamp for testing (default new Date())
 * @returns {Promise<object>} Structured data dictionary for template interpolation
 */
async function resolveIcalData(config = {}, nowRef = new Date()) {
  const url = (config.url || '').trim().replace(/^webcal:\/\//i, 'https://');
  const locale = (config.locale || 'de').toLowerCase().startsWith('en') ? 'en' : 'de';
  const lookaheadDays = Math.max(1, Math.min(365, parseInt(config.lookahead_days, 10) || 14));
  const maxEvents = Math.max(1, Math.min(50, parseInt(config.max_events, 10) || 10));
  const eventType = config.event_type || 'all';
  const filterText = (config.filter_text || config.filter_include || '').trim();
  const excludeText = (config.exclude_text || config.filter_exclude || '').trim();
  const hidePrivate = !!config.hide_private;

  let parsedEvents = {};

  const inlineIcs = config.ics_data || config.raw_data || config.raw_ics;
  if (inlineIcs) {
    parsedEvents = ical.sync.parseICS(inlineIcs);
  } else if (url) {
    parsedEvents = await ical.async.fromURL(url, {
      headers: {
        'User-Agent': 'ScreenTinker-DataSource/2.0',
        'Accept': 'text/calendar, application/json, text/plain',
      },
    });
  } else {
    throw new Error('No valid iCal URL or data provided');
  }

  const now = new Date(nowRef);
  const startWindow = new Date(now);
  startWindow.setHours(0, 0, 0, 0); // Start of today

  const endWindow = new Date(startWindow);
  endWindow.setDate(endWindow.getDate() + lookaheadDays);
  endWindow.setHours(23, 59, 59, 999);

  const flatEvents = [];

  for (const k in parsedEvents) {
    if (!Object.prototype.hasOwnProperty.call(parsedEvents, k)) continue;
    const ev = parsedEvents[k];
    if (ev.type !== 'VEVENT') continue;

    // Filter by text if configured
    const rawSummary = ev.summary || '';
    if (filterText) {
      try {
        const re = new RegExp(filterText, 'i');
        if (!re.test(rawSummary)) continue;
      } catch {
        if (!rawSummary.toLowerCase().includes(filterText.toLowerCase())) continue;
      }
    }
    if (excludeText) {
      try {
        const re = new RegExp(excludeText, 'i');
        if (re.test(rawSummary)) continue;
      } catch {
        if (rawSummary.toLowerCase().includes(excludeText.toLowerCase())) continue;
      }
    }

    // Check if event is all-day (datetype === 'date' or 00:00 to 00:00 next day)
    const isAllDay = ev.datetype === 'date' || (ev.start && ev.end && (ev.end - ev.start >= 86400000));
    if (eventType === 'timed' && isAllDay) continue;
    if (eventType === 'allday' && !isAllDay) continue;

    const summary = hidePrivate ? (locale === 'de' ? 'Belegt' : 'Busy') : (rawSummary || (locale === 'de' ? 'Termin' : 'Event'));
    const organizer = hidePrivate ? '' : (ev.organizer?.val || ev.organizer || '');
    const location = ev.location || '';
    const description = hidePrivate ? '' : (ev.description || '');

    // Handle RRULE series
    if (ev.rrule) {
      try {
        const dates = ev.rrule.between(startWindow, endWindow, true);
        const durationMs = ev.end ? (new Date(ev.end).getTime() - new Date(ev.start).getTime()) : 3600000;

        for (const date of dates) {
          const occStart = new Date(date);
          const occEnd = new Date(occStart.getTime() + durationMs);

          // Skip if occurrence has already ended before now
          if (occEnd < now && !isAllDay) continue;

          flatEvents.push({
            summary,
            start: occStart,
            end: occEnd,
            isAllDay,
            organizer,
            location,
            description,
          });
        }
      } catch (e) {
        console.warn(`[ical-resolver] Failed to expand RRULE for "${ev.summary}": ${e.message}`);
      }
    } else if (ev.start) {
      const evStart = new Date(ev.start);
      const evEnd = ev.end ? new Date(ev.end) : new Date(evStart.getTime() + 3600000);

      // Include if within window and hasn't already ended
      if (evEnd >= now && evStart <= endWindow) {
        flatEvents.push({
          summary,
          start: evStart,
          end: evEnd,
          isAllDay,
          organizer,
          location,
          description,
        });
      }
    }
  }

  // Sort events chronologically
  flatEvents.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Truncate to max events
  const selectedEvents = flatEvents.slice(0, maxEvents);

  // Determine current active event (DTSTART <= now < DTEND)
  const currentEvent = flatEvents.find(e => !e.isAllDay && e.start <= now && e.end > now) || null;

  // Determine next upcoming event (DTSTART > now)
  const nextEvent = flatEvents.find(e => e.start > now) || null;

  // Format date and time helpers
  const formatTime = (d) => d.toLocaleTimeString(locale === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: locale !== 'de' });
  const formatDate = (d) => {
    const isToday = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();

    if (isToday) return locale === 'de' ? 'Heute' : 'Today';
    if (isTomorrow) return locale === 'de' ? 'Morgen' : 'Tomorrow';

    return d.toLocaleDateString(locale === 'de' ? 'de-DE' : 'en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  };

  const isBusy = !!currentEvent;
  const statusDe = isBusy ? 'BELEGT' : 'FREI';
  const statusEn = isBusy ? 'BUSY' : 'AVAILABLE';
  const status = locale === 'de' ? statusDe : statusEn;

  let statusDetail = '';
  if (isBusy) {
    statusDetail = locale === 'de'
      ? `Belegt bis ${formatTime(currentEvent.end)}`
      : `Busy until ${formatTime(currentEvent.end)}`;
  } else if (nextEvent) {
    statusDetail = locale === 'de'
      ? `Frei bis ${formatTime(nextEvent.start)}`
      : `Free until ${formatTime(nextEvent.start)}`;
  } else {
    statusDetail = locale === 'de' ? 'Ganztägig frei' : 'Free all day';
  }

  // Build root dictionary payload
  const payload = {
    status,
    status_de: statusDe,
    status_en: statusEn,
    status_detail: statusDetail,
    is_busy: isBusy,

    current_title: currentEvent ? currentEvent.summary : '',
    current_summary: currentEvent ? currentEvent.summary : '',
    current_event_summary: currentEvent ? currentEvent.summary : '',
    current_time: currentEvent ? `${formatTime(currentEvent.start)} – ${formatTime(currentEvent.end)}` : '',
    current_organizer: currentEvent ? currentEvent.organizer : '',
    current_location: currentEvent ? currentEvent.location : '',
    current_event_location: currentEvent ? currentEvent.location : '',
    current_event_description: currentEvent ? currentEvent.description : '',

    next_title: nextEvent ? nextEvent.summary : '',
    next_summary: nextEvent ? nextEvent.summary : '',
    next_event_summary: nextEvent ? nextEvent.summary : '',
    next_time: nextEvent ? (nextEvent.isAllDay ? formatDate(nextEvent.start) : `${formatDate(nextEvent.start)}, ${formatTime(nextEvent.start)}`) : '',
    next_event_time: nextEvent ? (nextEvent.isAllDay ? formatDate(nextEvent.start) : `${formatDate(nextEvent.start)}, ${formatTime(nextEvent.start)}`) : '',
    next_date: nextEvent ? formatDate(nextEvent.start) : '',
    next_organizer: nextEvent ? nextEvent.organizer : '',

    total_upcoming_count: selectedEvents.length,
    event_count: selectedEvents.length,
    events_today_count: flatEvents.filter(e => e.start.toDateString() === now.toDateString()).length,
  };

  // Populate indexed items (event_0_title, event_1_title, ...)
  selectedEvents.forEach((ev, idx) => {
    payload[`event_${idx}_title`] = ev.summary;
    payload[`event_${idx}_summary`] = ev.summary;
    payload[`event_${idx}_date`] = ev.isAllDay ? formatDate(ev.start) : `${formatDate(ev.start)}, ${formatTime(ev.start)}`;
    payload[`event_${idx}_time`] = ev.isAllDay ? (locale === 'de' ? 'Ganztägig' : 'All day') : `${formatTime(ev.start)} – ${formatTime(ev.end)}`;
    payload[`event_${idx}_location`] = ev.location || '';
    payload[`event_${idx}_organizer`] = ev.organizer || '';
  });

  // Multi-line formatted agenda text
  payload.agenda_text = selectedEvents
    .map(ev => `${ev.isAllDay ? formatDate(ev.start) : formatTime(ev.start)}: ${ev.summary}`)
    .join('\n');

  return payload;
}

module.exports = {
  resolveIcalData,
};
