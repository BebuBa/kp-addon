'use strict';
/**
 * Аддон для Nuvio / Stremio: каталоги фильмов и сериалов из Кинопоиска (poiskkino.dev).
 * Все запросы к API идут с сервера, приложению нужен только адрес самого аддона.
 * Node 18+, без зависимостей.
 *
 * Переменные окружения:
 *   KP_TOKEN  — API-ключ с poiskkino.dev (обязательно)
 *   KP_API    — база API, по умолчанию https://api.poiskkino.dev/v1.4
 *   PORT      — порт при запуске через `node index.js` (по умолчанию 7000)
 */
const http = require('http');

const TOKEN = process.env.KP_TOKEN || '';
const API = (process.env.KP_API || 'https://api.poiskkino.dev/v1.4').replace(/\/$/, '');
const PAGE = 50;
const HOUR = 3600 * 1000;
const BIG = 10000000;
const year = () => new Date().getFullYear();

const GENRES = [
  'боевик', 'вестерн', 'военный', 'детектив', 'документальный', 'драма', 'история',
  'комедия', 'криминал', 'мелодрама', 'мюзикл', 'приключения', 'семейный', 'спорт',
  'триллер', 'ужасы', 'фантастика', 'фэнтези', 'биография', 'аниме', 'мультфильм',
];

// ---------- Каталоги ----------
// q(genre) возвращает список [параметр, значение] для api /v1.4/movie
const rng = (a, b = BIG) => `${a}-${b}`;
const bySort = (field) => [['sortField', field], ['sortType', '-1']];

const CATALOGS = [
  // ----- Фильмы -----
  { type: 'movie', id: 'kp-top250', name: 'Кинопоиск: Топ 250', genres: false,
    q: () => [['type', 'movie'], ['lists', 'top250'], ...bySort('rating.kp')] },
  { type: 'movie', id: 'kp-new', name: 'Новинки', genres: true,
    q: () => [['type', 'movie'], ['year', `${year() - 1}-${year()}`], ['votes.kp', rng(1000)], ...bySort('votes.kp')] },
  { type: 'movie', id: 'kp-best', name: 'Лучшие фильмы', genres: true,
    q: (g) => [['type', 'movie'], ['rating.kp', '7-10'], ['votes.kp', rng(g ? 5000 : 30000)], ...bySort('rating.kp')] },
  { type: 'movie', id: 'kp-popular', name: 'Все фильмы (по популярности)', genres: true,
    q: () => [['type', 'movie'], ['votes.kp', rng(3000)], ...bySort('votes.kp')] },
  { type: 'movie', id: 'kp-ru', name: 'Российские фильмы', genres: true,
    q: () => [['type', 'movie'], ['countries.name', 'Россия'], ['votes.kp', rng(3000)], ['rating.kp', '5.5-10'], ...bySort('votes.kp')] },
  // ----- Мультфильмы и аниме-фильмы -----
  { type: 'movie', id: 'kp-cartoons', name: 'Мультфильмы', genres: true,
    q: () => [['type', 'cartoon'], ['votes.kp', rng(2000)], ...bySort('votes.kp')] },
  { type: 'movie', id: 'kp-anime-movies', name: 'Аниме: фильмы', genres: true,
    q: () => [['type', 'anime'], ['isSeries', 'false'], ['votes.kp', rng(500)], ...bySort('votes.kp')] },
  { type: 'movie', id: 'kp-search', name: 'Кинопоиск: поиск', search: true },

  // ----- Сериалы -----
  { type: 'series', id: 'kp-series-best', name: 'Лучшие сериалы', genres: true,
    q: () => [['type', 'tv-series'], ['rating.kp', '7.5-10'], ['votes.kp', rng(8000)], ...bySort('rating.kp')] },
  { type: 'series', id: 'kp-series-popular', name: 'Все сериалы (по популярности)', genres: true,
    q: () => [['type', 'tv-series'], ['votes.kp', rng(2000)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-series-new', name: 'Новые сериалы', genres: true,
    q: () => [['type', 'tv-series'], ['year', `${year() - 1}-${year()}`], ['votes.kp', rng(500)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-series-ru', name: 'Российские сериалы', genres: true,
    q: () => [['type', 'tv-series'], ['countries.name', 'Россия'], ['votes.kp', rng(2000)], ['rating.kp', '5.5-10'], ...bySort('votes.kp')] },
  // ----- Мультсериалы и аниме-сериалы -----
  { type: 'series', id: 'kp-cartoon-series', name: 'Мультсериалы', genres: true,
    q: () => [['type', 'animated-series'], ['votes.kp', rng(1000)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-anime-series', name: 'Аниме: сериалы', genres: true,
    q: () => [['type', 'anime'], ['isSeries', 'true'], ['votes.kp', rng(500)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-series-search', name: 'Кинопоиск: поиск сериалов', search: true },
];

function manifest() {
  return {
    id: 'community.kinopoisk.catalogs',
    version: '1.0.0',
    name: 'Кинопоиск: каталоги',
    description: 'Каталоги фильмов и сериалов из Кинопоиска (без TMDB и Cinemeta). Только списки и описания, без потоков.',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: CATALOGS.map((c) => ({
      type: c.type,
      id: c.id,
      name: c.name,
      extra: c.search
        ? [{ name: 'search', isRequired: true }, { name: 'skip' }]
        : [
            ...(c.genres ? [{ name: 'genre', isRequired: false, options: GENRES, optionsLimit: 1 }] : []),
            { name: 'skip' },
          ],
    })),
    behaviorHints: { configurable: false },
  };
}

// ---------- Кэш и запросы к API ----------
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttl });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return val;
}

async function kp(path, params) {
  if (!TOKEN) throw new Error('KP_TOKEN не задан');
  const url = new URL(API + path);
  for (const [k, v] of params) url.searchParams.append(k, String(v));
  const r = await fetch(url, {
    headers: { 'X-API-KEY': TOKEN, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`poiskkino ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// ---------- Преобразование данных ----------
const imdbOf = (m) => {
  const id = m && m.externalId && m.externalId.imdb;
  return /^tt\d+$/.test(id || '') ? id : null;
};
const isMovieItem = (m) => (typeof m.isSeries === 'boolean'
  ? !m.isSeries
  : !m.type || m.type === 'movie' || m.type === 'cartoon');
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const titleOf = (m) => m.name || m.alternativeName || m.enName;

function toPreview(m, type) {
  const id = imdbOf(m);
  if (!id || !titleOf(m)) return null;
  const rating = m.rating && (m.rating.imdb || m.rating.kp);
  return clean({
    id,
    type,
    name: titleOf(m),
    poster: m.poster && (m.poster.previewUrl || m.poster.url),
    posterShape: 'poster',
    releaseInfo: m.year ? String(m.year) : undefined,
    imdbRating: rating ? Number(rating).toFixed(1) : undefined,
    description: m.shortDescription || m.description,
    genres: (m.genres || []).map((g) => g.name),
  });
}

const SELECT = ['id', 'name', 'alternativeName', 'enName', 'type', 'isSeries', 'year', 'description',
  'shortDescription', 'rating', 'poster', 'externalId', 'genres'];

async function listMovies(path, params) {
  try {
    return await kp(path, [...params, ...SELECT.map((f) => ['selectFields', f])]);
  } catch (e) {
    // если сервер не принял selectFields — пробуем без него
    if (/ 400:/.test(e.message)) return kp(path, params);
    throw e;
  }
}

async function getCatalog(def, extra) {
  const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
  // round, а не floor: часть записей без imdb-id отбрасывается, и skip может быть чуть меньше PAGE*n
  const page = Math.round(skip / PAGE) + 1;

  if (def.search) {
    const query = (extra.search || '').trim();
    if (!query) return [];
    return cached(`s:${def.type}:${query.toLowerCase()}:${page}`, HOUR, async () => {
      const d = await listMovies('/movie/search', [['query', query], ['page', page], ['limit', PAGE]]);
      return (d.docs || [])
        .filter((m) => (def.type === 'movie') === isMovieItem(m))
        .map((m) => toPreview(m, def.type))
        .filter(Boolean);
    });
  }

  const genre = def.genres && GENRES.includes(extra.genre) ? extra.genre : null;
  return cached(`c:${def.id}:${genre || ''}:${page}`, 6 * HOUR, async () => {
    const params = [...def.q(genre), ['notNullFields', 'externalId.imdb'], ['notNullFields', 'poster.url'],
      ['page', page], ['limit', PAGE]];
    if (genre) params.push(['genres.name', genre]);
    const d = await listMovies('/movie', params);
    return (d.docs || []).map((m) => toPreview(m, def.type)).filter(Boolean);
  });
}

async function getMeta(type, imdb) {
  return cached(`m:${type}:${imdb}`, 24 * HOUR, async () => {
    const d = await kp('/movie', [['externalId.imdb', imdb], ['limit', 1]]);
    const m = d.docs && d.docs[0];
    if (!m) return null;

    const people = (role) => (m.persons || []).filter((p) => p.enProfession === role)
      .map((p) => p.name || p.enName).filter(Boolean);
    const ratings = [];
    if (m.rating && m.rating.kp) ratings.push(`Кинопоиск ${Number(m.rating.kp).toFixed(1)}`);
    if (m.rating && m.rating.imdb) ratings.push(`IMDb ${Number(m.rating.imdb).toFixed(1)}`);
    const desc = [ratings.join(' · '), m.description || m.shortDescription].filter(Boolean).join('\n\n');

    let releaseInfo = m.year ? String(m.year) : undefined;
    const ry = m.releaseYears && m.releaseYears[0];
    if (type === 'series' && ry && ry.start) releaseInfo = `${ry.start}–${ry.end || ''}`;

    const meta = clean({
      id: imdb,
      type,
      name: titleOf(m),
      poster: m.poster && (m.poster.url || m.poster.previewUrl),
      background: m.backdrop && m.backdrop.url,
      logo: m.logo && m.logo.url,
      description: desc,
      releaseInfo,
      runtime: m.movieLength ? `${m.movieLength} мин` : undefined,
      genres: (m.genres || []).map((g) => g.name),
      country: (m.countries || []).map((c) => c.name).join(', '),
      imdbRating: m.rating && (m.rating.imdb || m.rating.kp) ? Number(m.rating.imdb || m.rating.kp).toFixed(1) : undefined,
      cast: people('actor').slice(0, 12),
      director: people('director').slice(0, 3),
    });
    if (!meta.cast || !meta.cast.length) delete meta.cast;
    if (!meta.director || !meta.director.length) delete meta.director;

    if (type === 'series') {
      const released = new Date(Date.UTC(m.year || 2000, 0, 1)).toISOString();
      meta.videos = [];
      let seasons = m.seasonsInfo || [];
      if (!seasons.length) {
        try {
          const sd = await kp('/season', [['movieId', m.id], ['limit', 100]]);
          seasons = (sd.docs || []).map((s) => ({
            number: s.number,
            episodesCount: s.episodesCount || (s.episodes ? s.episodes.length : 0),
          }));
        } catch (e) { /* без списка серий */ }
      }
      for (const s of seasons) {
        if (!s.number || s.number < 1) continue;
        for (let e = 1; e <= (s.episodesCount || 0); e++) {
          meta.videos.push({ id: `${imdb}:${s.number}:${e}`, title: `Серия ${e}`, season: s.number, episode: e, released });
        }
      }
    }
    return meta;
  });
}

// ---------- HTTP ----------
const CACHE_OK = 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400';

function send(res, status, body, type, cacheControl) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (body === null) return res.end();
  res.setHeader('Content-Type', type || 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl || 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function landing(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.|192\.168\.)/.test(host) ? 'http' : 'https');
  const url = `${proto}://${host}/manifest.json`.replace(/[<>"&]/g, '');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Кинопоиск: каталоги</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">
<h2>Кинопоиск: каталоги для Nuvio</h2>
<p>Ссылка для установки аддона (вставь её в Nuvio → Аддоны):</p>
<p><code style="word-break:break-all">${url}</code></p>
<p>Ключ API: <b>${TOKEN ? 'задан' : 'НЕ задан (переменная KP_TOKEN)'}</b>. Проверка связи с API: <a href="/health">/health</a></p>`;
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, null);
  const path = (new URL(req.url, 'http://x').pathname.replace(/\/+$/, '')) || '/';
  try {
    if (path === '/') return send(res, 200, landing(req), 'text/html; charset=utf-8');
    if (path === '/manifest.json') return send(res, 200, manifest(), null, 'public, max-age=3600');

    if (path === '/health') {
      try {
        await kp('/movie', [['limit', 1]]);
        return send(res, 200, { ok: true, tokenSet: !!TOKEN });
      } catch (e) {
        return send(res, 200, { ok: false, tokenSet: !!TOKEN, error: e.message });
      }
    }

    let m = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/);
    if (m) {
      const [type, id] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const def = CATALOGS.find((c) => c.id === id && c.type === type);
      if (!def) return send(res, 404, { err: 'unknown catalog' });
      const extra = Object.fromEntries(new URLSearchParams(m[3] || ''));
      try {
        const metas = await getCatalog(def, extra);
        return send(res, 200, { metas }, null, CACHE_OK);
      } catch (e) {
        console.error('catalog error:', e.message);
        return send(res, 200, { metas: [] });
      }
    }

    m = path.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/);
    if (m) {
      const type = decodeURIComponent(m[1]);
      const id = decodeURIComponent(m[2]);
      if (!/^tt\d+$/.test(id) || !['movie', 'series'].includes(type)) return send(res, 404, { err: 'not found' });
      try {
        const meta = await getMeta(type, id);
        if (!meta) return send(res, 404, { err: 'not found' });
        return send(res, 200, { meta }, null, CACHE_OK);
      } catch (e) {
        console.error('meta error:', e.message);
        return send(res, 404, { err: 'upstream error' });
      }
    }

    return send(res, 404, { err: 'not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { err: 'internal error' });
  }
}

module.exports = handler;
module.exports._internal = { CATALOGS, manifest, GENRES };

if (require.main === module) {
  const port = process.env.PORT || 7000;
  http.createServer(handler).listen(port, () => {
    console.log(`Аддон запущен: http://localhost:${port}/manifest.json`);
    if (!TOKEN) console.warn('ВНИМАНИЕ: переменная KP_TOKEN не задана');
  });
}
