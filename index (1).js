'use strict';
/**
 * Аддон для Nuvio / Stremio: каталоги фильмов, сериалов, аниме и мультиков.
 * Источники: Кинопоиск (poiskkino.dev, ключ KP_TOKEN) и/или TMDB (ключ TMDB_KEY).
 * Все запросы к API и картинкам идут с сервера, приложению нужен только адрес аддона,
 * поэтому VPN на телефоне не нужен. Node 18+, без зависимостей.
 *
 * Переменные окружения (достаточно одной из двух, можно обе):
 *   KP_TOKEN  — ключ poiskkino.dev
 *   TMDB_KEY  — ключ TMDB (v3 api_key или длинный "Read Access Token" v4)
 *   TMDB_LANG — язык TMDB, по умолчанию ru-RU
 *   PORT      — порт при запуске через `node index.js` (по умолчанию 7000)
 */
const http = require('http');

const TOKEN = process.env.KP_TOKEN || '';
const KP_API = (process.env.KP_API || 'https://api.poiskkino.dev/v1.4').replace(/\/$/, '');
const TMDB_KEY = (process.env.TMDB_KEY || '').trim();
const TMDB_API = (process.env.TMDB_API || 'https://api.themoviedb.org/3').replace(/\/$/, '');
const TMDB_LANG = process.env.TMDB_LANG || 'ru-RU';

const THUMBS = process.env.TM_THUMBS === '1'; // миниатюры серий (много лишних картинок), по умолчанию выключены
const KP_PAGE = 50;
const TM_PAGE = 20;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const BIG = 10000000;
const IMG = '@@IMG@@'; // при отправке заменяется на адрес этого аддона (картинки идут через /img/...)
const year = () => new Date().getFullYear();

// ---------- Общие помощники ----------
const cache = new Map();
async function cached(key, ttl, fn, shouldCache) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  if (!shouldCache || shouldCache(val)) {
    cache.set(key, { val, exp: Date.now() + ttl });
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
  }
  return val;
}
// Ограничитель одновременных запросов, чтобы пачка запросов не забивала сервер и не упиралась в лимиты TMDB
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const idsPool = limiter(10); // поиск IMDb-id для списков
const imgPool = limiter(8);  // загрузка картинок
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const isoDate = (s) => { const t = Date.parse(s); return new Date(isNaN(t) ? 0 : t).toISOString(); };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// =====================================================================
//                              КИНОПОИСК
// =====================================================================
const KP_GENRES = [
  'боевик', 'вестерн', 'военный', 'детектив', 'документальный', 'драма', 'история',
  'комедия', 'криминал', 'мелодрама', 'мюзикл', 'приключения', 'семейный', 'спорт',
  'триллер', 'ужасы', 'фантастика', 'фэнтези', 'биография', 'аниме', 'мультфильм',
];
const rng = (a, b = BIG) => `${a}-${b}`;
const bySort = (field) => [['sortField', field], ['sortType', '-1']];

const KP_CATALOGS = [
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
  { type: 'movie', id: 'kp-cartoons', name: 'Мультфильмы', genres: true,
    q: () => [['type', 'cartoon'], ['votes.kp', rng(2000)], ...bySort('votes.kp')] },
  { type: 'movie', id: 'kp-anime-movies', name: 'Аниме: фильмы', genres: true,
    q: () => [['type', 'anime'], ['isSeries', 'false'], ['votes.kp', rng(500)], ...bySort('votes.kp')] },
  { type: 'movie', id: 'kp-search', name: 'Кинопоиск: поиск', search: true },

  { type: 'series', id: 'kp-series-best', name: 'Лучшие сериалы', genres: true,
    q: () => [['type', 'tv-series'], ['rating.kp', '7.5-10'], ['votes.kp', rng(8000)], ...bySort('rating.kp')] },
  { type: 'series', id: 'kp-series-popular', name: 'Все сериалы (по популярности)', genres: true,
    q: () => [['type', 'tv-series'], ['votes.kp', rng(2000)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-series-new', name: 'Новые сериалы', genres: true,
    q: () => [['type', 'tv-series'], ['year', `${year() - 1}-${year()}`], ['votes.kp', rng(500)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-series-ru', name: 'Российские сериалы', genres: true,
    q: () => [['type', 'tv-series'], ['countries.name', 'Россия'], ['votes.kp', rng(2000)], ['rating.kp', '5.5-10'], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-cartoon-series', name: 'Мультсериалы', genres: true,
    q: () => [['type', 'animated-series'], ['votes.kp', rng(1000)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-anime-series', name: 'Аниме: сериалы', genres: true,
    q: () => [['type', 'anime'], ['isSeries', 'true'], ['votes.kp', rng(500)], ...bySort('votes.kp')] },
  { type: 'series', id: 'kp-series-search', name: 'Кинопоиск: поиск сериалов', search: true },
].map((c) => ({ ...c, src: 'kp', genreList: KP_GENRES }));

async function kp(path, params) {
  if (!TOKEN) throw new Error('KP_TOKEN не задан');
  const url = new URL(KP_API + path);
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

const imdbOf = (m) => {
  const id = m && m.externalId && m.externalId.imdb;
  return /^tt\d+$/.test(id || '') ? id : null;
};
const isMovieItem = (m) => (typeof m.isSeries === 'boolean'
  ? !m.isSeries
  : !m.type || m.type === 'movie' || m.type === 'cartoon');
const kpTitle = (m) => m.name || m.alternativeName || m.enName;

function kpPreview(m, type) {
  const id = imdbOf(m);
  if (!id || !kpTitle(m)) return null;
  const rating = m.rating && (m.rating.imdb || m.rating.kp);
  return clean({
    id,
    type,
    name: kpTitle(m),
    poster: m.poster && (m.poster.previewUrl || m.poster.url),
    posterShape: 'poster',
    releaseInfo: m.year ? String(m.year) : undefined,
    imdbRating: rating ? Number(rating).toFixed(1) : undefined,
    description: m.shortDescription || m.description,
    genres: (m.genres || []).map((g) => g.name),
  });
}

const KP_SELECT = ['id', 'name', 'alternativeName', 'enName', 'type', 'isSeries', 'year', 'description',
  'shortDescription', 'rating', 'poster', 'externalId', 'genres'];

async function kpList(path, params) {
  try {
    return await kp(path, [...params, ...KP_SELECT.map((f) => ['selectFields', f])]);
  } catch (e) {
    if (/ 400:/.test(e.message)) return kp(path, params); // сервер не принял selectFields
    throw e;
  }
}

async function kpCatalog(def, extra) {
  const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
  const page = Math.ceil(skip / KP_PAGE) + 1; // ceil: часть записей без imdb-id отбрасывается

  if (def.search) {
    const query = (extra.search || '').trim();
    if (!query) return [];
    return cached(`kps:${def.type}:${query.toLowerCase()}:${page}`, HOUR, async () => {
      const d = await kpList('/movie/search', [['query', query], ['page', page], ['limit', KP_PAGE]]);
      return (d.docs || [])
        .filter((m) => (def.type === 'movie') === isMovieItem(m))
        .map((m) => kpPreview(m, def.type))
        .filter(Boolean);
    });
  }

  const genre = def.genres && KP_GENRES.includes(extra.genre) ? extra.genre : null;
  return cached(`kpc:${def.id}:${genre || ''}:${page}`, 6 * HOUR, async () => {
    const params = [...def.q(genre), ['notNullFields', 'externalId.imdb'], ['notNullFields', 'poster.url'],
      ['page', page], ['limit', KP_PAGE]];
    if (genre) params.push(['genres.name', genre]);
    const d = await kpList('/movie', params);
    return (d.docs || []).map((m) => kpPreview(m, def.type)).filter(Boolean);
  }, (v) => v.length > 0);
}

async function kpMeta(type, imdb) {
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
    name: kpTitle(m),
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
}

// =====================================================================
//                                TMDB
// =====================================================================
const TM_GENRES = {
  movie: {
    'боевик': 28, 'приключения': 12, 'мультфильм': 16, 'комедия': 35, 'криминал': 80, 'документальный': 99,
    'драма': 18, 'семейный': 10751, 'фэнтези': 14, 'история': 36, 'ужасы': 27, 'музыка': 10402,
    'детектив': 9648, 'мелодрама': 10749, 'фантастика': 878, 'триллер': 53, 'военный': 10752, 'вестерн': 37,
  },
  series: {
    'боевик и приключения': 10759, 'мультфильм': 16, 'комедия': 35, 'криминал': 80, 'документальный': 99,
    'драма': 18, 'семейный': 10751, 'детский': 10762, 'детектив': 9648, 'фантастика и фэнтези': 10765,
    'война и политика': 10768, 'вестерн': 37,
  },
};
const popular = (extra = []) => [['sort_by', 'popularity.desc'], ...extra];

const TM_CATALOGS = [
  { type: 'movie', id: 'tm-popular', name: 'TMDB: Популярные фильмы', genres: true, path: '/discover/movie',
    q: () => popular([['vote_count.gte', '200']]) },
  { type: 'movie', id: 'tm-top', name: 'TMDB: Лучшие фильмы', genres: true, path: '/discover/movie',
    q: () => [['sort_by', 'vote_average.desc'], ['vote_count.gte', '3000']] },
  { type: 'movie', id: 'tm-new', name: 'TMDB: Новинки', genres: true, path: '/discover/movie',
    q: () => popular([['primary_release_date.gte', daysAgo(120)], ['primary_release_date.lte', daysAgo(0)]]) },
  { type: 'movie', id: 'tm-trending', name: 'TMDB: В тренде', genres: false, path: '/trending/movie/week', q: () => [] },
  { type: 'movie', id: 'tm-ru', name: 'TMDB: Российские фильмы', genres: true, path: '/discover/movie',
    q: () => popular([['with_original_language', 'ru'], ['vote_count.gte', '30']]) },
  { type: 'movie', id: 'tm-cartoons', name: 'TMDB: Мультфильмы (вся анимация)', genres: false, path: '/discover/movie',
    q: () => popular([['with_genres', '16'], ['vote_count.gte', '100']]) },
  { type: 'movie', id: 'tm-anime-movies', name: 'TMDB: Аниме-фильмы', genres: false, path: '/discover/movie',
    q: () => popular([['with_genres', '16'], ['with_original_language', 'ja'], ['vote_count.gte', '30']]) },
  { type: 'movie', id: 'tm-search', name: 'TMDB: поиск', search: true, path: '/search/movie' },

  { type: 'series', id: 'tm-series-popular', name: 'TMDB: Популярные сериалы', genres: true, path: '/discover/tv',
    q: () => popular([['vote_count.gte', '100']]) },
  { type: 'series', id: 'tm-series-top', name: 'TMDB: Лучшие сериалы', genres: true, path: '/discover/tv',
    q: () => [['sort_by', 'vote_average.desc'], ['vote_count.gte', '1500']] },
  { type: 'series', id: 'tm-series-new', name: 'TMDB: Новые сериалы', genres: true, path: '/discover/tv',
    q: () => popular([['first_air_date.gte', daysAgo(180)], ['first_air_date.lte', daysAgo(0)]]) },
  { type: 'series', id: 'tm-series-trending', name: 'TMDB: Сериалы в тренде', genres: false, path: '/trending/tv/week', q: () => [] },
  { type: 'series', id: 'tm-series-ru', name: 'TMDB: Российские сериалы', genres: true, path: '/discover/tv',
    q: () => popular([['with_original_language', 'ru'], ['vote_count.gte', '20']]) },
  { type: 'series', id: 'tm-cartoon-series', name: 'TMDB: Мультсериалы (вся анимация)', genres: false, path: '/discover/tv',
    q: () => popular([['with_genres', '16'], ['vote_count.gte', '50']]) },
  { type: 'series', id: 'tm-anime-series', name: 'TMDB: Аниме-сериалы', genres: false, path: '/discover/tv',
    q: () => popular([['with_genres', '16'], ['with_original_language', 'ja'], ['vote_count.gte', '30']]) },
  { type: 'series', id: 'tm-series-search', name: 'TMDB: поиск сериалов', search: true, path: '/search/tv' },
].map((c) => ({ ...c, src: 'tm', genreList: Object.keys(TM_GENRES[c.type]) }));

async function tmdb(path, params = []) {
  if (!TMDB_KEY) throw new Error('TMDB_KEY не задан');
  const url = new URL(TMDB_API + path);
  url.searchParams.set('language', TMDB_LANG);
  for (const [k, v] of params) url.searchParams.set(k, String(v));
  const headers = { accept: 'application/json' };
  if (TMDB_KEY.length > 40) headers.Authorization = `Bearer ${TMDB_KEY}`; // токен v4
  else url.searchParams.set('api_key', TMDB_KEY);                          // ключ v3
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    // сетевые ошибки и таймаут сразу уходят вверх, повторяем только 429 и 5xx
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
    if (r.ok) return r.json();
    const t = await r.text().catch(() => '');
    last = new Error(`tmdb ${r.status}: ${t.slice(0, 200)}`);
    if (r.status !== 429 && r.status < 500) throw last;
    const ra = parseInt(r.headers && r.headers.get ? r.headers.get('retry-after') : '', 10);
    await new Promise((ok) => setTimeout(ok, Math.min(2000, ra ? ra * 1000 : 400 * (attempt + 1))));
  }
  throw last;
}

async function tmImdbId(kind, id) {
  try {
    const v = await cached(`tmx:${kind}:${id}`, 30 * DAY, () => idsPool(async () => {
      const d = await tmdb(`/${kind}/${id}/external_ids`);
      return /^tt\d+$/.test(d.imdb_id || '') ? d.imdb_id : '';
    }));
    return v || null;
  } catch (e) {
    return undefined; // ошибка запроса (не путать с «у тайтла нет IMDb-id»)
  }
}

async function tmPreviews(results, type) {
  const kind = type === 'movie' ? 'movie' : 'tv';
  let failed = 0;
  const items = await Promise.all((results || []).map(async (r) => {
    if (!r.poster_path) return null;
    const imdb = await tmImdbId(kind, r.id);
    if (imdb === undefined) { failed++; return null; }
    const name = r.title || r.name || r.original_title || r.original_name;
    if (!imdb || !name) return null;
    return clean({
      id: imdb,
      type,
      name,
      poster: `${IMG}/img/w342${r.poster_path}`,
      posterShape: 'poster',
      releaseInfo: (r.release_date || r.first_air_date || '').slice(0, 4),
      description: r.overview,
    });
  }));
  const out = items.filter(Boolean);
  if (failed) out.partial = true; // часть запросов не удалась, такой список нельзя кэшировать
  return out;
}

async function tmCatalog(def, extra) {
  const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
  const page = Math.min(500, Math.ceil(skip / TM_PAGE) + 1);

  if (def.search) {
    const query = (extra.search || '').trim();
    if (!query) return [];
    return cached(`tms:${def.type}:${query.toLowerCase()}:${page}`, HOUR, async () => {
      const d = await tmdb(def.path, [['query', query], ['page', page]]);
      return tmPreviews(d.results, def.type);
    }, (v) => v.length > 0 && !v.partial);
  }

  const genreId = def.genres ? TM_GENRES[def.type][extra.genre] : undefined;
  return cached(`tmc:${def.id}:${genreId || ''}:${page}`, 6 * HOUR, async () => {
    const params = [...def.q(), ['page', page]];
    if (genreId) params.push(['with_genres', genreId]);
    const d = await tmdb(def.path, params);
    return tmPreviews(d.results, def.type);
  }, (v) => v.length > 0 && !v.partial);
}

async function tmMeta(type, imdb) {
  const f = await tmdb(`/find/${imdb}`, [['external_source', 'imdb_id']]);
  const hit = ((type === 'movie' ? f.movie_results : f.tv_results) || [])[0];
  if (!hit) return null;
  const kind = type === 'movie' ? 'movie' : 'tv';
  const d = await tmdb(`/${kind}/${hit.id}`, [['append_to_response', 'credits']]);
  const credits = d.credits || {};

  const rating = d.vote_average ? `TMDB ${Number(d.vote_average).toFixed(1)}` : '';
  const y = (s) => (s || '').slice(0, 4);
  let releaseInfo = y(d.release_date) || undefined;
  if (type === 'series') {
    const end = d.status === 'Ended' || d.status === 'Canceled' ? y(d.last_air_date) : '';
    releaseInfo = y(d.first_air_date) ? `${y(d.first_air_date)}–${end}` : undefined;
  }
  const runtime = type === 'movie' ? d.runtime : (d.episode_run_time || [])[0];
  const meta = clean({
    id: imdb,
    type,
    name: d.title || d.name || d.original_title || d.original_name,
    poster: d.poster_path ? `${IMG}/img/w500${d.poster_path}` : undefined,
    background: d.backdrop_path ? `${IMG}/img/w1280${d.backdrop_path}` : undefined,
    description: [rating, d.overview].filter(Boolean).join('\n\n'),
    releaseInfo,
    runtime: runtime ? `${runtime} мин` : undefined,
    genres: (d.genres || []).map((g) => g.name),
    country: (d.production_countries || []).map((c) => c.name).join(', '),
    cast: (credits.cast || []).slice(0, 12).map((p) => p.name),
    director: (type === 'movie'
      ? (credits.crew || []).filter((p) => p.job === 'Director')
      : (d.created_by || [])).slice(0, 3).map((p) => p.name),
  });
  if (!meta.cast.length) delete meta.cast;
  if (!meta.director.length) delete meta.director;

  if (type === 'series') {
    const nums = (d.seasons || []).map((s) => s.season_number).filter((n) => n >= 1);
    const seasons = await Promise.all(nums.map((n) => tmdb(`/tv/${hit.id}/season/${n}`).catch(() => null)));
    meta.videos = [];
    for (const s of seasons) {
      if (!s) continue;
      for (const e of s.episodes || []) {
        meta.videos.push(clean({
          id: `${imdb}:${s.season_number}:${e.episode_number}`,
          title: e.name || `Серия ${e.episode_number}`,
          season: s.season_number,
          episode: e.episode_number,
          released: isoDate(e.air_date || d.first_air_date),
          overview: e.overview,
          thumbnail: THUMBS && e.still_path ? `${IMG}/img/w300${e.still_path}` : undefined,
        }));
      }
    }
  }
  return meta;
}

// =====================================================================
//                   Манифест, каталоги и карточки
// =====================================================================
const kpOn = () => !!TOKEN || !TMDB_KEY; // если не задан ни один ключ, показываем каталоги Кинопоиска
const tmOn = () => !!TMDB_KEY;
const activeCatalogs = () => [...(kpOn() ? KP_CATALOGS : []), ...(tmOn() ? TM_CATALOGS : [])];

function manifest() {
  return {
    id: 'community.catalogs.kp.tmdb',
    version: '2.0.1',
    name: 'Каталоги: Кинопоиск + TMDB',
    description: 'Каталоги фильмов, сериалов, аниме и мультфильмов. Работает без VPN. Только списки и описания, без потоков.',
    resources: ['catalog', 'meta'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: activeCatalogs().map((c) => ({
      type: c.type,
      id: c.id,
      name: c.name,
      extra: c.search
        ? [{ name: 'search', isRequired: true }, { name: 'skip' }]
        : [
            ...(c.genres ? [{ name: 'genre', isRequired: false, options: c.genreList, optionsLimit: 1 }] : []),
            { name: 'skip' },
          ],
    })),
    behaviorHints: { configurable: false },
  };
}

const getCatalog = (def, extra) => (def.src === 'tm' ? tmCatalog(def, extra) : kpCatalog(def, extra));

async function getMeta(type, imdb) {
  return cached(`m:${type}:${imdb}`, DAY, async () => {
    let meta = null;
    let firstError = null;
    if (tmOn()) {
      try {
        // не ждём TMDB дольше 6,5 с: у приложения свой таймаут чтения
        meta = await Promise.race([
          tmMeta(type, imdb),
          new Promise((_, reject) => setTimeout(() => reject(new Error('tmdb meta timeout')), 6500)),
        ]);
      } catch (e) { firstError = e; }
    }
    if (!meta && TOKEN) {
      try { meta = await kpMeta(type, imdb); } catch (e) { firstError = firstError || e; }
    }
    if (!meta && firstError) throw firstError;
    return meta;
  });
}

// ---------- HTTP ----------
const CACHE_OK = 'public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400';

function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.|192\.168\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`.replace(/[<>"&\s]/g, '');
}

function send(res, status, body, type, cacheControl, origin) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (body === null) return res.end();
  res.setHeader('Content-Type', type || 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheControl || 'no-store');
  let out = typeof body === 'string' ? body : JSON.stringify(body);
  if (origin) out = out.split(IMG).join(origin);
  res.end(out);
}

function landing(req) {
  const url = `${originOf(req)}/manifest.json`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Каталоги для Nuvio</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.5">
<h2>Каталоги Кинопоиск + TMDB для Nuvio</h2>
<p>Ссылка для установки (вставь в Nuvio → Аддоны):</p>
<p><code style="word-break:break-all">${url}</code></p>
<p>Кинопоиск (KP_TOKEN): <b>${TOKEN ? 'ключ задан' : 'не задан'}</b><br>TMDB (TMDB_KEY): <b>${TMDB_KEY ? 'ключ задан' : 'не задан'}</b></p>
<p>Проверка связи: <a href="/health">/health</a></p>`;
}

async function fetchImage(size, file) {
  const r = await fetch(`https://image.tmdb.org/t/p/${size}/${file}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { status: r.status };
  return { status: 200, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
}

async function proxyImage(res, size, file) {
  const img = await imgPool(() => fetchImage(size, file));
  if (img.status !== 200) return send(res, 404, { err: 'no image' });
  const r = { headers: { get: () => img.type } };
  const buf = img.buf;
  res.statusCode = 200;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
  res.end(buf);
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, null);
  const path = (new URL(req.url, 'http://x').pathname.replace(/\/+$/, '')) || '/';
  const origin = originOf(req);
  try {
    if (path === '/') return send(res, 200, landing(req), 'text/html; charset=utf-8');
    if (path === '/manifest.json') return send(res, 200, manifest(), null, 'public, max-age=3600');

    if (path === '/health' && new URL(req.url, 'http://x').searchParams.get('deep')) {
      const out = {};
      const timed = async (name, fn) => {
        const t = Date.now();
        try { const v = await fn(); out[name] = { ok: true, ms: Date.now() - t, ...(v || {}) }; }
        catch (e) { out[name] = { ok: false, ms: Date.now() - t, error: e.message }; }
      };
      await timed('tmdbApi', () => tmdb('/configuration'));
      await timed('tmdbMeta', async () => { const m = await tmMeta('movie', 'tt0068646'); return { name: m && m.name }; });
      await timed('tmdbImage', async () => { const i = await fetchImage('w92', 'wwemzKWzjKYJFfCeiB57q3r4Bcm.png'); return { status: i.status }; });
      await timed('catalogPage', async () => { const c = await tmCatalog(TM_CATALOGS[0], {}); return { items: c.length, partial: !!c.partial }; });
      return send(res, 200, out);
    }

    if (path === '/health') {
      const out = {};
      if (TOKEN) {
        try { await kp('/movie', [['limit', 1]]); out.kinopoisk = { ok: true }; }
        catch (e) { out.kinopoisk = { ok: false, error: e.message }; }
      } else out.kinopoisk = { ok: false, error: 'KP_TOKEN не задан (нужен только если нужны каталоги Кинопоиска)' };
      if (TMDB_KEY) {
        try { await tmdb('/configuration'); out.tmdb = { ok: true }; }
        catch (e) { out.tmdb = { ok: false, error: e.message }; }
      } else out.tmdb = { ok: false, error: 'TMDB_KEY не задан (нужен только если нужны каталоги TMDB)' };
      return send(res, 200, out);
    }

    let m = path.match(/^\/img\/(w92|w154|w185|w300|w342|w500|w780|w1280|original)\/([A-Za-z0-9_-]+\.(?:jpg|jpeg|png))$/);
    if (m) {
      try { return await proxyImage(res, m[1], m[2]); }
      catch (e) { return send(res, 502, { err: 'image error' }); }
    }

    m = path.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/);
    if (m) {
      const [type, id] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
      const def = activeCatalogs().find((c) => c.id === id && c.type === type);
      if (!def) return send(res, 404, { err: 'unknown catalog' });
      const extra = Object.fromEntries(new URLSearchParams(m[3] || ''));
      try {
        const metas = await getCatalog(def, extra);
        const good = metas.length > 0 && !metas.partial;
        return send(res, 200, { metas }, null, good ? CACHE_OK : 'no-store', origin);
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
        return send(res, 200, { meta }, null, CACHE_OK, origin);
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

if (require.main === module) {
  const port = process.env.PORT || 7000;
  http.createServer(handler).listen(port, () => {
    console.log(`Аддон запущен: http://localhost:${port}/manifest.json`);
    if (!TOKEN && !TMDB_KEY) console.warn('ВНИМАНИЕ: не задан ни KP_TOKEN, ни TMDB_KEY');
  });
}
