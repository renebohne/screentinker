'use strict';

/*
 * Energy & carbon (docs/energy.md): grams of CO2-equivalent per kWh of electricity where a screen is.
 *
 * A STATIC table of country annual averages (./grid-intensity.json, with its source and year), and
 * a user override. Live, hourly grid intensity (Electricity Maps, WattTime, National Grid ESO) is
 * out of scope on purpose: it needs a third-party key per self-hoster, and an annual average is what
 * location-based Scope 2 reporting under the GHG Protocol asks for in the first place.
 *
 * Resolution, first answer wins:
 *   1. the screen's own country override            (energy_device_settings.country)
 *   2. the workspace's typed gCO2e/kWh figure        (energy_settings.grid_g_per_kwh) — a number
 *      somebody chose, e.g. from their supplier's contract or a market-based figure
 *   3. the country the screen's time zone implies    (Europe/Paris -> FR; only unambiguous zones)
 *   4. the workspace's country                       (energy_settings.country)
 *   5. the world average from the same source
 */

const grid = require('./grid-intensity.json');

const COUNTRY_RE = /^[A-Z]{2}$/;

function countryValue(cc) {
  const v = cc && grid.countries[cc];
  return v && Number.isFinite(v.g) ? v : null;
}

/*
 * IANA zone -> ISO country, for zones that belong to exactly one country in the table. A zone that
 * several countries share as a link target (tzdb merged e.g. Europe/Oslo into Europe/Berlin in 2022)
 * is still REPORTED by a device under the name its OS was set to, so mapping by name stays honest.
 */
const ZONE_COUNTRY = grid.zone_country || {};

function countryFromZone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  const cc = ZONE_COUNTRY[tz];
  return cc && countryValue(cc) ? cc : null;
}

function validIntensity(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2000; }

/**
 * @returns {{g_per_kwh:number, source:'device_country'|'workspace_override'|'timezone'|'workspace_country'|'world', country:string|null}}
 */
function resolveIntensity({ deviceCountry, deviceTz, wsSettings } = {}) {
  if (deviceCountry && countryValue(deviceCountry)) return { g_per_kwh: countryValue(deviceCountry).g, source: 'device_country', country: deviceCountry };
  if (wsSettings && validIntensity(wsSettings.grid_g_per_kwh)) return { g_per_kwh: wsSettings.grid_g_per_kwh, source: 'workspace_override', country: null };
  const tzc = countryFromZone(deviceTz);
  if (tzc) return { g_per_kwh: countryValue(tzc).g, source: 'timezone', country: tzc };
  if (wsSettings && wsSettings.country && countryValue(wsSettings.country)) return { g_per_kwh: countryValue(wsSettings.country).g, source: 'workspace_country', country: wsSettings.country };
  return { g_per_kwh: grid.world.g, source: 'world', country: null };
}

/** kg CO2e for an amount of energy at an intensity. */
function kgCo2e(kwh, gPerKwh) { return (kwh * gPerKwh) / 1000; }

function isCountry(cc) { return typeof cc === 'string' && COUNTRY_RE.test(cc) && !!countryValue(cc); }

/** The table as the settings page shows it: code, name, value, year. */
function countryList() {
  return Object.entries(grid.countries).map(([code, v]) => ({ code, name: v.name, g_per_kwh: v.g, year: v.year }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { resolveIntensity, kgCo2e, isCountry, countryList, countryFromZone, validIntensity, SOURCE: grid.source, WORLD: grid.world };
