'use strict';

/*
 * 3.0 news feeds — the pure half (lib/news-feed/parse.js, lib/news-feed/discover.js): every feed
 * format to one item shape, and what a web page offers when it is not a feed. Local fixtures only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parse = require('../lib/news-feed/parse');
const discover = require('../lib/news-feed/discover');

const FX = path.join(__dirname, 'fixtures', 'news-feed');
const fx = (f) => fs.readFileSync(path.join(FX, f), 'utf8');

/* ───────────── feeds ───────────── */

test('RSS 2.0 with CDATA titles (a TV station category feed): titles, links, dates, images', () => {
  const f = parse.parseFeed(fx('rss2-cdata.xml'), 'https://news.example.test/rss/category/local-news');
  assert.equal(f.format, 'rss');
  assert.equal(f.title, 'Latest News | Channel 9 Test', 'the channel title, not the <image> block\'s');
  assert.equal(f.link, 'https://news.example.test/local-news', 'the channel link, not atom:link');
  assert.equal(f.items.length, 3);
  const [a, b, c] = f.items;
  assert.equal(a.title, 'City Weather: Rainy, chilly Thursday');
  assert.equal(a.link, 'https://news.example.test/weather/forecast-101426');
  assert.equal(a.published, '2026-10-15T01:34:03.000Z');
  assert.equal(a.image, 'https://static.example.test/uploads/forecast_1280x720.jpg', 'an enclosure typed image/jpg');
  assert.equal(a.summary, 'Cloudy skies overnight with temperatures in the 50s. Over 1" of rain is expected in many areas.', 'tags stripped');
  assert.equal(b.title, 'Police chase ends near 48th & Hadley; officer hurt', 'CDATA text is verbatim, & included');
  assert.equal(b.link, 'https://news.example.test/news/police-chase-officer-hurt');
  assert.equal(b.image, 'https://news.example.test/uploads/scene.jpg', 'a relative enclosure resolves against the feed');
  assert.equal(c.title, 'School board votes & budget — what’s next', 'entities, numeric and hex');
  assert.equal(c.link, 'https://news.example.test/news/school-board', '<link> before <title> is fine');
  assert.equal(c.summary, 'Heading The board met & voted.', 'escaped HTML in content:encoded becomes text');
  assert.equal(c.image, 'https://static.example.test/board.jpg', 'first <img> of the content');
  assert.equal(c.published, '2026-10-15T01:44:21.000Z', 'RFC 822 with a numeric zone');
});

test('Atom: html-typed titles, rel=alternate link over rel=replies, relative links, media:thumbnail', () => {
  const f = parse.parseFeed(fx('atom.xml'), 'https://blog.example.test/atom.xml');
  assert.equal(f.format, 'atom');
  assert.equal(f.title, 'Example Engineering Blog');
  assert.equal(f.link, 'https://blog.example.test/');
  assert.equal(f.items[0].title, 'Shipping faster builds');
  assert.equal(f.items[0].link, 'https://blog.example.test/posts/faster-builds');
  assert.equal(f.items[0].published, '2026-10-09T06:30:00.000Z', 'published wins over updated');
  assert.equal(f.items[0].summary, 'We cut CI time in half.');
  assert.equal(f.items[0].image, 'https://blog.example.test/img/builds.png');
  assert.equal(f.items[1].link, 'https://blog.example.test/posts/second', 'a <link> with no rel is the alternate');
  assert.equal(f.items[1].image, 'https://blog.example.test/img/second.webp');
});

test('RSS 1.0 (RDF): items outside the channel, rdf:about when there is no <link>', () => {
  const f = parse.parseFeed(fx('rss1.rdf'), 'https://rdf.example.test/index.rdf');
  assert.equal(f.format, 'rdf');
  assert.equal(f.title, 'RDF News');
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].title, 'Tram line reopens after repairs');
  assert.equal(f.items[0].published, '2026-10-12T07:00:00.000Z');
  assert.equal(f.items[1].link, 'https://rdf.example.test/a/2');
});

test('JSON Feed: titles, untitled items titled from their text, junk entries skipped', () => {
  const f = parse.parseFeed(fx('feed.json'), 'https://json.example.test/feed.json');
  assert.equal(f.format, 'json');
  assert.equal(f.title, 'JSON Example');
  assert.equal(f.items.length, 2);
  assert.equal(f.items[0].title, 'First JSON item');
  assert.equal(f.items[0].summary, 'Hello world');
  assert.equal(f.items[0].image, 'https://json.example.test/p/1.jpg');
  assert.equal(f.items[1].title, 'A status update with no title, which becomes the title.');
  assert.equal(f.items[1].summary, '', 'not repeated as a summary');
  assert.equal(f.items[1].link, 'https://elsewhere.example.test/x');
});

test('malformed feeds are read, not refused: a bare &, an HTML entity XML lacks, a missing close tag', () => {
  const xml = `<rss><channel><title>Broken & Co</title>
    <item><title>Fish &amp; chips &nbsp;&hellip; &bogus; R&D</title><link>https://x.example.test/1</link></item>
    <item><title>Unclosed item at the end</title><link>https://x.example.test/2</link>`;
  const f = parse.parseFeed(xml, 'https://x.example.test/feed');
  assert.equal(f.title, 'Broken & Co');
  assert.equal(f.items.length, 1, 'the unclosed trailing item is dropped, the rest kept');
  assert.equal(f.items[0].title, 'Fish & chips … &bogus; R&D');
});

test('⚠️ no entity expansion beyond the fixed table: a DTD bomb and an external entity stay inert', () => {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE rss [ <!ENTITY a "AAAAAAAAAA"> <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"> <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<rss><channel><title>t</title><item><title>&b; &xxe;</title><link>https://x.example.test/1</link></item></channel></rss>`;
  const f = parse.parseFeed(xml, '');
  assert.equal(f.items[0].title, '&b; &xxe;');
});

test('links and images are http(s) only: javascript:, data: and credentials are dropped', () => {
  const xml = `<rss><channel><item><title>x item title</title><link>javascript:alert(1)</link>
    <media:content url="data:image/png;base64,AAAA" medium="image"/><enclosure url="https://u:p@evil.example.test/a.jpg" type="image/jpeg"/></item></channel></rss>`;
  const it = parse.parseFeed(xml, 'https://x.example.test/').items[0];
  assert.equal(it.link, '');
  assert.equal(it.image, '');
});

test('not a feed: HTML, plain JSON and empty text answer null', () => {
  assert.equal(parse.parseFeed(fx('site-with-feeds.html'), ''), null);
  assert.equal(parse.parseFeed('{"items":[]}', ''), null);
  assert.equal(parse.parseFeed('', ''), null);
  assert.equal(parse.detectFormat('<?xml version="1.0"?>\n<!-- c --><rss version="2.0">'), 'rss');
});

test('decodeBody: charset from the header, the XML declaration, a BOM; unknown labels fall back to UTF-8', () => {
  const latin = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><title>Straßenbahn fährt</title><link>https://x.example.test/a</link></item></channel></rss>', 'latin1');
  assert.equal(parse.parseFeed(parse.decodeBody(latin, 'application/xml'), '').items[0].title, 'Straßenbahn fährt');
  const cp1252 = Buffer.concat([Buffer.from('<rss><channel><item><title>'), Buffer.from([0x93, 0x51, 0x94, 0x20, 0x97, 0x20, 0x80]), Buffer.from('</title><link>https://x.example.test/a</link></item></channel></rss>')]);
  assert.equal(parse.parseFeed(parse.decodeBody(cp1252, 'text/xml; charset=windows-1252'), '').items[0].title, '“Q” — €');
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<rss><channel><item><title>Ünïcode</title><link>https://x.example.test/a</link></item></channel></rss>')]);
  assert.equal(parse.parseFeed(parse.decodeBody(bom, ''), '').items[0].title, 'Ünïcode');
  assert.equal(parse.decodeBody(Buffer.from('ok'), 'text/xml; charset=x-made-up'), 'ok');
});

test('a huge feed is bounded: at most MAX_ITEMS items', () => {
  const items = Array.from({ length: 150 }, (_, i) => `<item><title>Story number ${i}</title><link>https://x.example.test/${i}</link></item>`).join('');
  assert.equal(parse.parseFeed(`<rss><channel>${items}</channel></rss>`, '').items.length, parse.MAX_ITEMS);
});

/* ───────────── discovery ───────────── */

test('findFeedLinks: rss/atom/json alternates by title, resolved and de-duplicated; stylesheets and hreflang ignored', () => {
  const feeds = discover.findFeedLinks(fx('site-with-feeds.html'), 'https://news.example.test/');
  assert.deepEqual(feeds.map((f) => f.url), [
    'https://news.example.test/rss.xml',
    'https://news.example.test/rss/category/news',
    'https://news.example.test/rss/category/local-news',
    'https://news.example.test/atom.xml',
    'https://news.example.test/feed.json',
  ]);
  assert.equal(feeds[0].title, 'Channel 9 News | Local News, Weather');
  assert.equal(feeds[3].title, 'Atom & more');
  assert.deepEqual(feeds.map((f) => f.type), ['rss', 'rss', 'rss', 'atom', 'json']);
});

test('JSON-LD: NewsArticle/Article in @graph, ItemList entries, malformed blocks skipped', () => {
  const items = discover.extractJsonLd(fx('page-jsonld.html'), 'https://crier.example.test/');
  assert.deepEqual(items.map((i) => i.title), [
    'Library extends weekend hours', 'Farmers market moves indoors', 'Bridge repair finishes early', 'Council approves new park',
  ]);
  assert.equal(items[0].image, 'https://crier.example.test/img/library.jpg');
  assert.equal(items[0].published, '2026-10-13T14:00:00.000Z');
  assert.equal(items[0].summary, 'Starting next month the main branch stays open until 8 pm.');
  assert.equal(items[1].link, 'https://crier.example.test/2026/10/market-indoors', 'mainEntityOfPage @id');
  assert.equal(items[1].image, 'https://crier.example.test/img/market.jpg', 'image as an array');
  assert.equal(items[3].link, 'https://crier.example.test/2026/10/new-park', 'relative url resolved');
});

test('JSON-LD walking is bounded: a deeply nested or enormous graph cannot run away', () => {
  let deep = { '@type': 'NewsArticle', headline: 'Deep headline here', url: 'https://d.example.test/x' };
  for (let i = 0; i < 50; i++) deep = { '@graph': [deep] };
  const html = `<script type="application/ld+json">${JSON.stringify(deep)}</script>`;
  assert.deepEqual(discover.extractJsonLd(html, 'https://d.example.test/'), [], 'beyond the depth limit');
  const many = { '@graph': Array.from({ length: 5000 }, (_, i) => ({ '@type': 'NewsArticle', headline: `Headline number ${i}`, url: `https://d.example.test/${i}` })) };
  assert.ok(discover.extractJsonLd(`<script type="application/ld+json">${JSON.stringify(many)}</script>`, 'https://d.example.test/').length <= discover.MAX_ITEMS);
});

test('Google News sitemap: news entries only, newest first, CDATA titles; an index lists its children', () => {
  const sm = discover.parseSitemap(fx('news-sitemap.xml'), 'https://plain.example.test/sitemap.xml');
  assert.deepEqual(sm.news.map((n) => n.title), ['Newest story: rail service & bus changes', 'Middle story on the new clinic', 'Older story about the harvest festival']);
  assert.equal(sm.news[0].image, 'https://plain.example.test/img/rail.jpg');
  assert.equal(sm.news[0].published, '2026-10-14T08:00:00.000Z');
  const idx = discover.parseSitemap(`<sitemapindex><sitemap><loc>https://plain.example.test/sitemap-news.xml</loc></sitemap><sitemap><loc><![CDATA[https://plain.example.test/sitemap-pages.xml]]></loc></sitemap></sitemapindex>`, 'https://plain.example.test/');
  assert.deepEqual(idx.index, ['https://plain.example.test/sitemap-news.xml', 'https://plain.example.test/sitemap-pages.xml']);
  assert.deepEqual(idx.news, []);
});

test('robots.txt: our own group over *, longest match wins, wildcards, Sitemap lines', () => {
  const r = discover.parseRobots(`User-agent: GPTBot
Disallow: /

User-agent: *
Disallow: /search
Disallow: /*email=*
Allow: /search/news$

Sitemap: https://news.example.test/sitemap.xml
Sitemap: https://news.example.test/sitemap.xml?type=articles`);
  assert.equal(r.allows('/'), true, 'another bot\'s Disallow: / does not apply to us');
  assert.equal(r.allows('/news/story'), true);
  assert.equal(r.allows('/search?q=x'), false);
  assert.equal(r.allows('/search/news'), true, 'the longer Allow wins');
  assert.equal(r.allows('/a?email=me'), false, 'wildcard');
  assert.deepEqual(r.sitemaps, ['https://news.example.test/sitemap.xml', 'https://news.example.test/sitemap.xml?type=articles']);
  const mine = discover.parseRobots(`User-agent: *\nAllow: /\n\nUser-agent: ScreenTinker-FeedReader\nDisallow: /`);
  assert.equal(mine.allows('/anything'), false, 'a group naming our reader applies instead of *');
  assert.equal(discover.parseRobots('User-agent: *\nDisallow:').allows('/x'), true, 'an empty Disallow allows everything');
  assert.equal(discover.parseRobots('').allows('/x'), true);
});

test('headline links: <article> cards, same site only, nav/short/script links ignored, lazy images found', () => {
  const items = discover.extractHeadlineLinks(fx('page-links.html'), 'https://gazette.example.test/');
  assert.deepEqual(items.map((i) => i.title), [
    'New bakery opens on Main Street this weekend',
    'Road closures planned for the autumn parade',
    'High school team wins the regional title',
  ]);
  assert.equal(items[0].link, 'https://gazette.example.test/stories/2026/new-bakery-opens-on-main-street');
  assert.equal(items[0].image, 'https://gazette.example.test/img/bakery.jpg', 'data-src over a placeholder');
  assert.equal(items[2].image, 'https://gazette.example.test/img/team-1280.jpg', 'the largest srcset candidate');
  for (const it of items) assert.equal(it.summary, '', 'never article text');
});

test('headline links without <article>: links in headings, and headings inside links', () => {
  const html = `<div><h2><a href="/n/one-two-three">First headline in a heading link</a></h2>
    <a href="/n/four"><span><h3>Second headline wrapped by its link</h3></span></a>
    <h2><a href="https://other.example.test/n/x">Offsite headline that must not appear</a></h2></div>`;
  const items = discover.extractHeadlineLinks(html, 'https://site.example.test/');
  assert.deepEqual(items.map((i) => i.title), ['First headline in a heading link', 'Second headline wrapped by its link']);
});

test('pageMeta: og tags and title', () => {
  const m = discover.pageMeta('<title>T &amp; T</title><meta property="og:image" content="/i.png"><meta content="Site" property="og:site_name">', 'https://m.example.test/a/');
  assert.equal(m.title, 'T & T');
  assert.equal(m.image, 'https://m.example.test/i.png');
  assert.equal(m.siteName, 'Site');
});
