import json, math, sys, statistics
OUT = sys.argv[1]
SAM = 'https://image-us.samsung.com/SamsungUS/samsungbusiness/pdf/spec-sheets/Digital_Signage_QBB_QMB_QHB_4K_UHD_DisplaySeries.pdf'
EP = 'https://eprel.ec.europa.eu/screen/product/electronicdisplays/'
LG = 'https://www.lg.com/uk/business/commercial-display/digital-signage/standard/'
P = []
def add(manu, model, diag, w, kind, url, standby=0.5, nits=None, match=None, note=None):
    e = {'manufacturer': manu, 'model': model, 'diagonal_in': diag, 'on_watts': w, 'figure': kind,
         'standby_watts': standby, 'brightness_nits': nits, 'source_url': url, 'match': match or [model]}
    if note: e['note'] = note
    P.append(e)
# Samsung QBB/QMB/QHB: "Power Consumption Typical", "Sleep Mode <0.5W" (US spec sheet)
for m, d, n, w in [('QM43B',43,500,79),('QM50B',50,500,91),('QM55B',55,500,108),('QM65B',65,500,127),('QM75B',75,500,161),
                   ('QB43B',43,350,79),('QB50B',50,350,91),('QB55B',55,350,96),('QB65B',65,350,124),('QB75B',75,350,174),
                   ('QH43B',43,700,93),('QH55B',55,700,115),('QH65B',65,700,152)]:
    add('Samsung', m, d, w, 'typical', SAM, nits=n)
add('Samsung', 'OM55B', 55, 450, 'max', 'https://www.samsung.com/uk/smart-signage/outdoor-signage/outdoor-signage-om55b-55-inch-uhd-4k-3000nit-ip5x-lh55ombebgbxen/',
    nits=3000, note='Only the on-mode (maximum) figure is published; a 3,000-nit window panel. No EU label (>= 1,000 cd/m2 is exempt).')
for m, d, w, reg in [('QM43C',43,74,1590748),('QM55C',55,102,1588325),('QM65C',65,135,1588326),('QB43C',43,74,1644948),('QB55C',55,85,1653476),('QB65C',65,104,1653478)]:
    add('Samsung', m, d, w, 'eu_label', EP + str(reg))
# LG UK spec pages: "Typ." power; DPM / power-off 0.5 W
for m, d, w in [('55UH5J-H',55,110),('43UH5J-H',43,80),('55UH5F-H',55,105),('49UH5F-H',49,95)]:
    add('LG', m, d, w, 'typical', LG + m.lower(), nits=500, match=[m.split('-')[0]])
for m, d, w, reg in [('49UH5J',49,92.1,1220838),('65UH5J',65,120.4,1220840),('43UH5F',43,77.9,387044),('65UH5F',65,133,385497),
                     ('55SM5KE',55,135,385481),('49SM5KE',49,114,384939),('43SM5KE',43,77.9,384924),
                     ('55UH5N-H',55,103,1589510),('55UH5Q-E',55,103,2374136),('43UH5Q-E',43,82.6,2406049)]:
    add('LG', m, d, w, 'eu_label', EP + str(reg), match=[m.split('-')[0]])
# Philips
add('Philips', '55BDL4050D', 55, 76, 'typical', 'https://www.philips.co.uk/p-p/55BDL4050D_00/signage-solutions-d-line-display', standby=0.4, nits=450)
for m, d, w, reg in [('55BDL5050D',55,72,2456233),('43BDL5050D',43,50,2456384),('65BDL5050D',65,98,2463480),('55BDL4050Q',55,63,2262754),
                     ('43BDL4050Q',43,43,2242412),('75BDL4050Q',75,70,2247597),('86BDL4050Q',86,85,2272015),('55BDL3751T',55,100,2143923)]:
    add('Philips', m, d, w, 'eu_label', EP + str(reg))
# Sharp/NEC
add('Sharp/NEC', 'MultiSync ME551', 55, 120, 'max', 'https://www.sharp.co.uk/sharp-nec-multisync-me551', standby=None, nits=400, match=['ME551'],
    note='Only the operating maximum is published.')
for m, d, w, reg in [('PN-ME552',55,123,1692939),('PN-M552',55,103,1926028),('PN-P556',55,102,1926060)]:
    add('Sharp/NEC', m, d, w, 'eu_label', EP + str(reg), match=[m])
# Sony Bravia Professional (EU label, SDR)
for m, w, reg in [('FW-55BZ35L',71,1393006),('FW-55BZ40L',76,1393011),('FW-55BZ30L',92,1392992)]:
    add('Sony', m, 55, w, 'eu_label', EP + str(reg))
# iiyama
add('iiyama', 'ProLite LH5560UHS-B1AG', 55, 88.7, 'eu_label', EP + '1594947', match=['LH5560UHS-B1'])
add('iiyama', 'ProLite LH5560UHS-B2AG', 55, 54.9, 'eu_label', EP + '2272429', match=['LH5560UHS-B2'])

# Samsung's full order codes put the size first: LH55QMBEBGCXEN is a QM55B, LH55OMBEBGBXEN an OM55B.
import re
for e in P:
    m = re.match(r'^(Q[MBH]|OM)(\d\d)([BC])$', e['model']) if e['manufacturer'] == 'Samsung' else None
    if m:
        e['match'].append('LH' + m.group(2) + m.group(1) + m.group(3))
def area(diag):
    k = diag * 2.54 / math.hypot(16, 9)
    return (k * 16 * k * 9) / 100
def eei(w, a):
    return (w + 1) / (3 * (90 * math.tanh(0.025 + 0.0035 * (a - 11)) + 4) + 3)
# Calibrate on the panels whose figure means the same thing as the label's P_measured or a typical
# draw, and inside the label's area range (30-130 dm2). 'max' figures are excluded.
vals = sorted(round(eei(p['on_watts'], area(p['diagonal_in'])), 3) for p in P if p['figure'] != 'max' and 30 <= area(p['diagonal_in']) <= 130)
med = round(statistics.median(vals), 2)
doc = {
  '_note': 'Curated signage panel power figures. Every value was read from the cited page on 2026-10-14; nothing is estimated. figure: typical = the manufacturer\'s typical power; eu_label = P_measured (SDR) from the EU energy label in EPREL; max = the only figure published, the maximum. Add an entry only with a source URL.',
  'calibration': {'median_eei': med, 'samples': len(vals), 'method': 'median of (P+1)/(3*(90*tanh(0.025+0.0035*(A-11))+4)+3) over the typical and eu_label entries with 30 <= A <= 130 dm2, A from a 16:9 diagonal'},
  'panels': P,
}
json.dump(doc, open(OUT, 'w'), indent=1)
open(OUT, 'a').write('\n')
print('entries', len(P), 'median eei', med, 'min', vals[0], 'max', vals[-1])
