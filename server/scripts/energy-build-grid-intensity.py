import csv, json, sys
SRC = sys.argv[1]
OUT = sys.argv[2]
M = {
 'AUT':'AT','BEL':'BE','BGR':'BG','HRV':'HR','CYP':'CY','CZE':'CZ','DNK':'DK','EST':'EE','FIN':'FI','FRA':'FR','DEU':'DE','GRC':'GR',
 'HUN':'HU','IRL':'IE','ITA':'IT','LVA':'LV','LTU':'LT','LUX':'LU','MLT':'MT','NLD':'NL','POL':'PL','PRT':'PT','ROU':'RO','SVK':'SK',
 'SVN':'SI','ESP':'ES','SWE':'SE','NOR':'NO','ISL':'IS','CHE':'CH','GBR':'GB','USA':'US','CAN':'CA','MEX':'MX','BRA':'BR','ARG':'AR',
 'CHL':'CL','COL':'CO','PER':'PE','AUS':'AU','NZL':'NZ','JPN':'JP','KOR':'KR','CHN':'CN','TWN':'TW','HKG':'HK','SGP':'SG','MYS':'MY',
 'THA':'TH','IDN':'ID','PHL':'PH','VNM':'VN','IND':'IN','PAK':'PK','BGD':'BD','ZAF':'ZA','EGY':'EG','MAR':'MA','NGA':'NG','KEN':'KE',
 'TUR':'TR','ISR':'IL','SAU':'SA','ARE':'AE','QAT':'QA','UKR':'UA','SRB':'RS','BIH':'BA','MKD':'MK','ALB':'AL','MNE':'ME','MDA':'MD',
}
countries = {}
world = None
for r in csv.DictReader(open(SRC)):
    if r['Variable'] != 'CO2 intensity' or r['Year'] != '2024':
        continue
    if r['Area'] == 'World':
        world = round(float(r['Value']), 1)
        continue
    cc = M.get(r['ISO 3 code'])
    if cc and r['Value']:
        countries[cc] = {'name': r['Area'], 'g': round(float(r['Value']), 1), 'year': 2024}
missing = sorted(set(M.values()) - set(countries))
print('missing', missing, 'count', len(countries), 'world', world)
ZONES = {
 'Europe/Vienna':'AT','Europe/Brussels':'BE','Europe/Sofia':'BG','Europe/Zagreb':'HR','Asia/Nicosia':'CY','Europe/Prague':'CZ',
 'Europe/Copenhagen':'DK','Europe/Tallinn':'EE','Europe/Helsinki':'FI','Europe/Paris':'FR','Europe/Berlin':'DE','Europe/Athens':'GR',
 'Europe/Budapest':'HU','Europe/Dublin':'IE','Europe/Rome':'IT','Europe/Riga':'LV','Europe/Vilnius':'LT','Europe/Luxembourg':'LU',
 'Europe/Malta':'MT','Europe/Amsterdam':'NL','Europe/Warsaw':'PL','Europe/Lisbon':'PT','Europe/Bucharest':'RO','Europe/Bratislava':'SK',
 'Europe/Ljubljana':'SI','Europe/Madrid':'ES','Europe/Stockholm':'SE','Europe/Oslo':'NO','Atlantic/Reykjavik':'IS','Europe/Zurich':'CH',
 'Europe/London':'GB','Asia/Tokyo':'JP','Asia/Seoul':'KR','Asia/Shanghai':'CN','Asia/Taipei':'TW','Asia/Hong_Kong':'HK',
 'Asia/Singapore':'SG','Asia/Kuala_Lumpur':'MY','Asia/Bangkok':'TH','Asia/Jakarta':'ID','Asia/Manila':'PH','Asia/Ho_Chi_Minh':'VN',
 'Asia/Kolkata':'IN','Asia/Calcutta':'IN','Asia/Karachi':'PK','Asia/Dhaka':'BD','Africa/Johannesburg':'ZA','Africa/Cairo':'EG',
 'Africa/Casablanca':'MA','Africa/Lagos':'NG','Africa/Nairobi':'KE','Europe/Istanbul':'TR','Asia/Jerusalem':'IL','Asia/Riyadh':'SA',
 'Asia/Dubai':'AE','Asia/Qatar':'QA','Europe/Kyiv':'UA','Europe/Kiev':'UA','Europe/Belgrade':'RS','Europe/Sarajevo':'BA',
 'Europe/Skopje':'MK','Europe/Tirane':'AL','Europe/Podgorica':'ME','Europe/Chisinau':'MD',
 'America/New_York':'US','America/Chicago':'US','America/Denver':'US','America/Phoenix':'US','America/Los_Angeles':'US',
 'America/Anchorage':'US','Pacific/Honolulu':'US','America/Detroit':'US','America/Indiana/Indianapolis':'US','America/Boise':'US',
 'America/Toronto':'CA','America/Vancouver':'CA','America/Edmonton':'CA','America/Winnipeg':'CA','America/Halifax':'CA',
 'America/St_Johns':'CA','America/Regina':'CA','America/Montreal':'CA',
 'America/Mexico_City':'MX','America/Monterrey':'MX','America/Cancun':'MX','America/Tijuana':'MX',
 'America/Sao_Paulo':'BR','America/Manaus':'BR','America/Fortaleza':'BR','America/Recife':'BR','America/Bahia':'BR',
 'America/Argentina/Buenos_Aires':'AR','America/Buenos_Aires':'AR','America/Santiago':'CL','America/Bogota':'CO','America/Lima':'PE',
 'Australia/Sydney':'AU','Australia/Melbourne':'AU','Australia/Brisbane':'AU','Australia/Perth':'AU','Australia/Adelaide':'AU',
 'Australia/Hobart':'AU','Australia/Darwin':'AU','Pacific/Auckland':'NZ',
}
zones = {z: c for z, c in sorted(ZONES.items()) if c in countries}
doc = {
  '_note': 'Generated from Ember yearly electricity data (see source). Country annual averages, power sector CO2 intensity. Regenerate, never hand-edit values.',
  'source': {'name': 'Ember, Yearly electricity data', 'year': 2024, 'url': 'https://ember-energy.org/data/yearly-electricity-data/',
             'dataset': 'https://storage.googleapis.com/emb-prod-bkt-publicdata/public-downloads/yearly_full_release_long_format.csv',
             'variable': 'CO2 intensity (Power sector emissions), gCO2/kWh', 'licence': 'CC-BY-4.0', 'retrieved': '2026-10-14'},
  'world': {'name': 'World', 'g': world, 'year': 2024},
  'countries': dict(sorted(countries.items())),
  'zone_country': zones,
}
json.dump(doc, open(OUT, 'w'), indent=1, ensure_ascii=False)
open(OUT, 'a').write('\n')
