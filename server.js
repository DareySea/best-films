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
const DATA_FILE = path.join(__dirname, 'data', 'films.json');
const PUBLIC = path.join(__dirname, 'public');
// На Render диск стирается при перезапуске, поэтому там список хранится в GitHub Gist
const GIST_ID = process.env.GIST_ID, GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GH_API = process.env.GH_API || 'https://api.github.com';

// shortcut: сессии живут в памяти, после перезапуска (и засыпания на Render) нужно войти заново
const sessions = new Set();
let films = [];

async function gist(method, body) {
  const r = await fetch(`${GH_API}/gists/${GIST_ID}`, {
    method, body: body && JSON.stringify(body),
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'best-films' },
  });
  if (!r.ok) throw new Error('GitHub Gist ответил ' + r.status);
  return r.json();
}

async function load() {
  if (GIST_ID) {
    const file = (await gist('GET')).files['films.json'];
    if (!file) throw new Error('В gist нет файла films.json');
    films = JSON.parse(file.content || '[]');
  } else if (fs.existsSync(DATA_FILE)) {
    films = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
}

let saving = Promise.resolve();
function save() {
  // Записи идут строго по очереди, чтобы старая версия списка не перезаписала новую
  saving = saving.catch(() => {}).then(async () => {
    const json = JSON.stringify(films, null, 2);
    if (GIST_ID) return gist('PATCH', { files: { 'films.json': { content: json } } });
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', json);
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); // атомарная замена, чтобы не побить файл при сбое
  });
  return saving;
}

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

let newsCache = { at: 0, items: [] };
async function news() {
  if (Date.now() - newsCache.at > 30 * 60 * 1000) {
    const d = await kp('/api/v1/media_posts?page=1');
    newsCache = { at: Date.now(), items: (d.items || []).slice(0, 12) };
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

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20000) { reject(new Error('Слишком большой запрос')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Плохой JSON')); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
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

  if (!admin) return send(res, 403, { error: 'Только для админа' });

  if (p === '/api/kp/search') {
    const d = await kp('/api/v2.1/films/search-by-keyword?page=1&keyword=' + encodeURIComponent(url.searchParams.get('q') || ''));
    return send(res, 200, (d.films || []).map(f => ({
      id: f.filmId, title: f.nameRu || f.nameEn, year: f.year, poster: f.posterUrlPreview,
      added: films.some(x => x.id === f.filmId),
    })));
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
    films = films.filter(f => f.id !== +one[1]);
    await save();
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
  () => server.listen(PORT, () => console.log(`Лучший список фильмов: http://localhost:${PORT} (хранилище: ${GIST_ID ? 'GitHub Gist' : 'data/films.json'})`)),
  e => { console.error('Не удалось загрузить список фильмов:', e.message); process.exit(1); },
);
