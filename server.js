// «Лучший список фильмов» — сервер без зависимостей (Node 18+).
// Запуск: KP_API_KEY=ваш_ключ node server.js  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '050100';
const KP_KEY = process.env.KP_API_KEY || '';
const KP_API = process.env.KP_API || 'https://kinopoiskapiunofficial.tech';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');
// На Render диск стирается при перезапуске, поэтому там список хранится в GitHub Gist
const GIST_ID = process.env.GIST_ID, GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = process.env.GH_API || 'https://api.github.com';

// shortcut: сессии живут в памяти, после перезапуска (и засыпания на Render) нужно войти заново
const sessions = new Set();
let films = [];
const posters = {}; // обложки фильмов, добавленных вручную: 'poster-<id>.txt' → data:image/...;base64,...

async function gist(method, body) {
  const r = await fetch(`${GH_API}/gists/${GIST_ID}`, {
    method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'best-films' },
  });
  if (!r.ok) throw new Error('GitHub Gist ответил ' + r.status);
  return r.json();
}

function keep(name, content) {
  if (name === 'films.json') films = JSON.parse(content || '[]');
  else if (name.startsWith('poster-')) posters[name] = content;
}

async function load() {
  if (GIST_ID) {
    // shortcut: GitHub отдаёт не больше 300 файлов gist'а, хватит примерно на 300 фильмов с ручной обложкой
    const files = (await gist('GET')).files;
    if (!files['films.json']) throw new Error('В gist нет файла films.json');
    for (const [name, f] of Object.entries(files)) {
      keep(name, f.truncated ? await (await fetch(f.raw_url)).text() : f.content); // файлы больше 1 МБ API обрезает
    }
  } else if (fs.existsSync(DATA_DIR)) {
    for (const name of fs.readdirSync(DATA_DIR)) keep(name, fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  }
}

// content === null удаляет файл
async function writeFile(name, content) {
  if (GIST_ID) return gist('PATCH', { files: { [name]: content === null ? null : { content } } });
  const file = path.join(DATA_DIR, name);
  if (content === null) return fs.rmSync(file, { force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file + '.tmp', content);
  fs.renameSync(file + '.tmp', file); // атомарная замена, чтобы не побить файл при сбое
}

// Записи идут строго по очереди, чтобы старая версия списка не перезаписала новую
let saving = Promise.resolve();
function enqueue(task) {
  saving = saving.catch(() => {}).then(task);
  return saving;
}
const save = () => enqueue(() => writeFile('films.json', JSON.stringify(films, null, 2)));

// Защита от перебора пароля: после 10 неудачных попыток вход закрыт на 15 минут для всех.
// Общий, а не по IP: адрес за прокси Render легко подделать.
const LOGIN_LIMIT = 10, LOGIN_WINDOW = 15 * 60 * 1000;
let failedLogins = [];

async function kp(apiPath) {
  if (!KP_KEY) throw new Error('Не задан KP_API_KEY');
  const r = await fetch(KP_API + apiPath, { headers: { 'X-API-KEY': KP_KEY } });
  if (!r.ok) throw new Error('Кинопоиск ответил ' + r.status);
  return r.json();
}

// Новости Кинопоиска в неофициальном API перестали обновляться в 2024, поэтому берём RSS-ленты
const NEWS_FEEDS = [
  { url: 'https://kg-portal.ru/rss/news.rss', source: 'КГ-Портал', take: 5 }, // кино и сериалы
  { url: 'https://rss.stopgame.ru/rss_news.xml', source: 'StopGame', take: 3 }, // игры
];
const decode = s => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// shortcut: разбор RSS регулярками, работает для этих двух лент; для других может понадобиться настоящий XML-парсер
function parseRss(xml, source) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const tag = t => (new RegExp(`<${t}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${t}>`).exec(it) || [])[1] || '';
    const date = new Date(tag('pubDate'));
    return {
      title: decode(tag('title')), url: tag('link'), source,
      imageUrl: (/<enclosure[^>]*url="([^"]+)"/.exec(it) || [])[1] || '',
      publishedAt: isNaN(date) ? null : date.toISOString(),
    };
  }).filter(n => n.title && n.url);
}

let newsCache = { at: 0, items: [] };
async function news() {
  if (Date.now() - newsCache.at > 30 * 60 * 1000) {
    const results = await Promise.allSettled(NEWS_FEEDS.map(async f => {
      // Без таймаута зависшая лента держит блок новостей в «Загрузка…» бесконечно
      const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (best-films)' }, signal: AbortSignal.timeout(10000) })
        .catch(e => { throw new Error(`${f.source}: ${e.name === 'TimeoutError' ? 'не ответил за 10 секунд' : e.cause?.code || e.cause?.message || e.message}`); });
      if (!r.ok) throw new Error(`${f.source} ответил ${r.status}`);
      const items = parseRss(await r.text(), f.source);
      if (!items.length) throw new Error(`${f.source}: в ответе нет новостей`);
      return items.slice(0, f.take);
    }));
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    if (errors.length) console.error('Новости:', errors.join('; ')); // видно во вкладке Logs на Render
    const items = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    if (!items.length) throw new Error(errors.join('; '));
    newsCache = { at: Date.now(), items: items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '')) };
  }
  return newsCache.items;
}

function isAdmin(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && sessions.has(m[1]);
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

function body(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Плохой JSON')); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, { error: 'Не найдено' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

function rating(v, max) {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`Оценка должна быть от 1 до ${max}`);
  return v;
}
function comment(v) {
  if (typeof v !== 'string') throw new Error('Комментарий должен быть строкой');
  return v.trim().slice(0, 1000);
}

async function api(req, res, url) {
  const p = url.pathname;
  const admin = isAdmin(req);

  if (p === '/api/me') return send(res, 200, { admin });
  if (p === '/api/login' && req.method === 'POST') {
    failedLogins = failedLogins.filter(t => Date.now() - t < LOGIN_WINDOW);
    if (failedLogins.length >= LOGIN_LIMIT) return send(res, 429, { error: 'Слишком много попыток. Попробуйте через 15 минут' });
    const { password } = await body(req);
    const a = Buffer.from(String(password || '')), b = Buffer.from(ADMIN_PASSWORD);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      failedLogins.push(Date.now());
      return send(res, 401, { error: 'Неверный пароль' });
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    return send(res, 200, { admin: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (m) sessions.delete(m[1]);
    return send(res, 200, { admin: false }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  }
  if (p === '/api/news') return send(res, 200, await news());
  if (p === '/api/films' && req.method === 'GET') return send(res, 200, films);

  const one = /^\/api\/films\/(\d+)$/.exec(p);
  if (one && req.method === 'GET') {
    const f = films.find(f => f.id === +one[1]);
    return f ? send(res, 200, f) : send(res, 404, { error: 'Фильм не найден' });
  }

  const pm = /^\/api\/poster\/(\d+)$/.exec(p);
  if (pm) {
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(posters[`poster-${pm[1]}.txt`] || '');
    if (!m) return send(res, 404, { error: 'Обложка не найдена' });
    res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' });
    return res.end(Buffer.from(m[2], 'base64'));
  }

  if (!admin) return send(res, 403, { error: 'Только для админа' });

  if (p === '/api/kp/search') {
    const d = await kp('/api/v2.1/films/search-by-keyword?page=1&keyword=' + encodeURIComponent(url.searchParams.get('q') || ''));
    return send(res, 200, (d.films || []).map(f => ({
      id: f.filmId, title: f.nameRu || f.nameEn, year: f.year, poster: f.posterUrlPreview,
      added: films.some(x => x.id === f.filmId),
    })));
  }
  if (p === '/api/films/manual' && req.method === 'POST') {
    const b = await body(req, 2000000);
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
    if (!title) return send(res, 400, { error: 'Укажите название' });
    const year = b.year ? Number(b.year) : null;
    if (year !== null && (!Number.isInteger(year) || year < 1880 || year > 2100)) return send(res, 400, { error: 'Год указан неверно' });
    if (typeof b.poster !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.poster)) {
      return send(res, 400, { error: 'Загрузите обложку (JPG, PNG или WebP)' });
    }
    const genres = (Array.isArray(b.genres) ? b.genres : []).map(g => String(g).trim().toLowerCase().slice(0, 40)).filter(Boolean);
    const id = Date.now(); // id Кинопоиска не больше нескольких миллионов, так что не пересечётся
    const name = `poster-${id}.txt`;
    await enqueue(() => writeFile(name, b.poster));
    posters[name] = b.poster;
    const film = {
      id, title, original: '', year, poster: `/api/poster/${id}`,
      synopsis: typeof b.synopsis === 'string' ? b.synopsis.trim().slice(0, 5000) : '',
      genres: [...new Set(genres)].slice(0, 10), manual: true,
      him: { rating: null, comment: '' }, her: { rating: null, comment: '' }, addedAt: id,
    };
    films.push(film);
    await save();
    return send(res, 201, film);
  }
  if (p === '/api/films' && req.method === 'POST') {
    const id = Number((await body(req)).id);
    if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: 'Некорректный id' });
    const existing = films.find(f => f.id === id);
    if (existing) return send(res, 200, existing);
    const d = await kp('/api/v2.2/films/' + id);
    const film = {
      id, title: d.nameRu || d.nameOriginal || d.nameEn, original: d.nameOriginal || '', year: d.year,
      poster: d.posterUrl, synopsis: d.description || d.shortDescription || '',
      genres: (d.genres || []).map(g => g.genre),
      him: { rating: null, comment: '' }, her: { rating: null, comment: '' }, addedAt: Date.now(),
    };
    films.push(film);
    await save();
    return send(res, 201, film);
  }
  if (one && req.method === 'PATCH') {
    const f = films.find(f => f.id === +one[1]);
    if (!f) return send(res, 404, { error: 'Фильм не найден' });
    const b = await body(req);
    for (const [who, max] of [['him', 5], ['her', 10]]) {
      if (!b[who]) continue;
      if ('rating' in b[who]) f[who].rating = rating(b[who].rating, max);
      if ('comment' in b[who]) f[who].comment = comment(b[who].comment);
    }
    await save();
    return send(res, 200, f);
  }
  if (one && req.method === 'DELETE') {
    const f = films.find(f => f.id === +one[1]);
    films = films.filter(f => f.id !== +one[1]);
    await save();
    if (f?.manual) {
      delete posters[`poster-${f.id}.txt`];
      await enqueue(() => writeFile(`poster-${f.id}.txt`, null)).catch(() => {}); // осиротевшая обложка безвредна
    }
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'Не найдено' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/') return serveStatic(res, 'index.html');
    if (url.pathname === '/film') return serveStatic(res, 'film.html');
    serveStatic(res, decodeURIComponent(url.pathname));
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

// Не стартуем с пустым списком, если хранилище недоступно, иначе первая же запись затрёт данные
load().then(
  () => server.listen(PORT, () => console.log(`Лучший список фильмов: http://localhost:${PORT} (хранилище: ${GIST_ID ? 'GitHub Gist' : 'папка data'})`)),
  e => { console.error('Не удалось загрузить список фильмов:', e.message); process.exit(1); },
);
