// Сайт без сервера (GitHub Pages): список лежит в films.json рядом со страницами,
// админ сохраняет изменения прямо в репозиторий через API GitHub своим токеном.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^(https?:\/\/|posters\/\d+\.jpg$)/.test(u || '') ? esc(u) : '#'); // данные с Кинопоиска не должны подсунуть javascript:
const params = new URLSearchParams(location.search);

const store = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим: просто не запомним */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* нечего удалять */ } },
};
const REPO = 'DareySea/best-films', DATA = 'docs/films.json';
// Адреса API можно подменить в localStorage только для локальной проверки на подставных серверах
const GH_API = store.get('bf_api') || 'https://api.github.com';
const KP_API = store.get('bf_kp_api') || 'https://kinopoiskapiunofficial.tech';
// На сайте без сервера пароль лишь открывает режим админа; сохранить что-либо можно только с токеном GitHub
const ADMIN_PASSWORD = '050100';

let ghToken = store.get('bf_gh'), kpKey = store.get('bf_kp');
let admin = store.get('bf_admin') === '1' && !!ghToken;
let films = [], filmsSha = '';

const utf8ToB64 = s => { let bin = ''; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const b64ToUtf8 = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), c => c.charCodeAt(0)));

async function gh(path, opts = {}, token = ghToken) {
  const r = await fetch(`${GH_API}/repos/${REPO}/contents/${path}`, {
    ...opts, cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (r.ok) return r.json();
  throw new Error(r.status === 401 || r.status === 403 ? 'Токен GitHub не подходит или у него нет прав на запись'
    : r.status === 409 ? 'Список изменился в другом окне. Обновите страницу' : `GitHub ответил ${r.status}`);
}

async function kp(path) {
  if (!kpKey) throw new Error('Не задан ключ Кинопоиска');
  const r = await fetch(KP_API + path, { headers: { 'X-API-KEY': kpKey } });
  if (r.ok) return r.json();
  throw new Error(r.status === 401 ? 'Ключ Кинопоиска не подходит' : 'Кинопоиск ответил ' + r.status);
}
const directorOf = async id => (await kp('/api/v1/staff?filmId=' + id))
  .filter(s => s.professionKey === 'DIRECTOR').map(s => s.nameRu || s.nameEn).filter(Boolean).join(', ');

// Админ читает список прямо из репозитория: опубликованная копия обновляется с опозданием
async function loadFilms() {
  if (admin) {
    const d = await gh(DATA);
    filmsSha = d.sha;
    return JSON.parse(b64ToUtf8(d.content));
  }
  const r = await fetch('films.json?v=' + Date.now()); // мимо кэша, чтобы видеть свежие оценки
  if (!r.ok) throw new Error('films.json не загрузился (' + r.status + ')');
  return r.json();
}

// Записи идут строго по очереди: каждая опирается на версию файла после предыдущей
let saving = Promise.resolve();
function saveFilms(message) {
  saving = saving.catch(() => {}).then(async () => {
    const d = await gh(DATA, { method: 'PUT', body: JSON.stringify({ message, sha: filmsSha, content: utf8ToB64(JSON.stringify(films, null, 2) + '\n') }) });
    filmsSha = d.content.sha;
  });
  return saving;
}

// --- общая шапка, вход и жанры ---
document.body.insertAdjacentHTML('afterbegin', `
<header class="top">
  <button id="loginBtn" class="login">Войти как админ</button>
  <h1><a href="./">Лучший список фильмов</a></h1>
  <div class="search-row">
    <div class="search">
      <input id="q" type="search" placeholder="Поиск фильма…" autocomplete="off" aria-label="Поиск фильма">
      <div id="results" class="results" hidden></div>
    </div>
    <button id="manualBtn" hidden>Добавить самостоятельно</button>
  </div>
</header>
<dialog id="manualDlg">
  <form method="dialog" id="manualForm">
    <h3>Добавить фильм самостоятельно</h3>
    <label>Название *<input name="title" required maxlength="200"></label>
    <label>Год<input name="year" type="number" min="1880" max="2100"></label>
    <label>Обложка *<input name="poster" type="file" accept="image/jpeg,image/png,image/webp" required></label>
    <img id="manualPreview" class="preview" alt="" hidden>
    <label>Режиссёр<input name="director" maxlength="200"></label>
    <label>Синопсис<textarea name="synopsis" rows="4" maxlength="5000"></textarea></label>
    <label>Жанры через запятую<input name="genres" placeholder="драма, комедия"></label>
    <p id="genreHint" class="muted hint"></p>
    <p id="manualErr" class="err" role="alert"></p>
    <div class="row"><button value="cancel" formnovalidate>Отмена</button><button value="ok" class="primary">Добавить</button></div>
  </form>
</dialog>
<dialog id="loginDlg">
  <form method="dialog" id="loginForm">
    <h3>Вход для админа</h3>
    <input id="pw" type="password" inputmode="numeric" placeholder="Пароль" aria-label="Пароль" required>
    <div id="keys" hidden>
      <p class="muted hint">Один раз на этом устройстве. Ключи останутся только в этом браузере и сотрутся при выходе.</p>
      <input id="ghTokenIn" type="password" placeholder="Токен GitHub" aria-label="Токен GitHub" autocomplete="off">
      <input id="kpKeyIn" type="password" placeholder="Ключ Кинопоиска" aria-label="Ключ Кинопоиска" autocomplete="off">
    </div>
    <p id="pwErr" class="err" role="alert"></p>
    <div class="row"><button value="cancel" formnovalidate>Отмена</button><button value="ok" class="primary">Войти</button></div>
  </form>
</dialog>`);

const main = $('main');
const layout = document.createElement('div');
layout.className = 'layout';
layout.innerHTML = '<aside id="genres" class="genres" aria-label="Жанры"></aside>';
main.before(layout);
layout.append(main);

$('#loginBtn').onclick = () => {
  if (admin) {
    ['bf_admin', 'bf_gh', 'bf_kp'].forEach(store.del);
    return location.reload();
  }
  const needKeys = !(ghToken && kpKey);
  $('#keys').hidden = !needKeys;
  $('#ghTokenIn').required = $('#kpKeyIn').required = needKeys;
  $('#loginDlg').showModal();
};
$('#loginForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  if ($('#pw').value !== ADMIN_PASSWORD) return ($('#pwErr').textContent = 'Неверный пароль');
  const token = $('#ghTokenIn').value.trim() || ghToken, key = $('#kpKeyIn').value.trim() || kpKey;
  e.submitter.disabled = true;
  try {
    await gh(DATA, {}, token); // проверяем токен сразу, а не при первом сохранении
    store.set('bf_gh', token);
    store.set('bf_kp', key);
    store.set('bf_admin', '1');
    location.reload();
  } catch (err) {
    $('#pwErr').textContent = err.message;
    e.submitter.disabled = false;
  }
});

// --- ручное добавление фильма, которого нет на Кинопоиске ---
// Уменьшаем обложку в браузере: она ляжет в репозиторий, и большие файлы замедлят сайт
async function shrinkImage(file) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 500 / img.width, 750 / img.height);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

let manualPoster = '';
$('#manualBtn').onclick = () => {
  const all = [...new Set(films.flatMap(f => f.genres))].sort();
  $('#genreHint').textContent = all.length ? 'Уже есть: ' + all.join(', ') : '';
  $('#manualDlg').showModal();
};
$('#manualForm').elements.poster.addEventListener('change', async e => {
  manualPoster = '';
  $('#manualPreview').hidden = true;
  const file = e.target.files[0];
  if (!file) return;
  try {
    manualPoster = await shrinkImage(file);
    $('#manualPreview').src = manualPoster;
    $('#manualPreview').hidden = false;
    $('#manualErr').textContent = '';
  } catch { $('#manualErr').textContent = 'Не получилось открыть картинку'; }
});
$('#manualForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const el = e.target.elements;
  const title = el.title.value.trim().slice(0, 200);
  const year = el.year.value ? Number(el.year.value) : null;
  if (!title) return ($('#manualErr').textContent = 'Укажите название');
  if (year !== null && (!Number.isInteger(year) || year < 1880 || year > 2100)) return ($('#manualErr').textContent = 'Год указан неверно');
  if (!manualPoster) return ($('#manualErr').textContent = 'Загрузите обложку');
  e.submitter.disabled = true;
  try {
    const id = Date.now(); // id Кинопоиска не больше нескольких миллионов, так что не пересечётся
    await gh(`docs/posters/${id}.jpg`, { method: 'PUT', body: JSON.stringify({ message: `Обложка «${title}»`, content: manualPoster.split(',')[1] }) });
    films.push({
      id, title, original: '', year, poster: `posters/${id}.jpg`,
      synopsis: el.synopsis.value.trim().slice(0, 5000), director: el.director.value.trim().slice(0, 200),
      genres: [...new Set(el.genres.value.split(',').map(g => g.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 10),
      manual: true, him: { rating: null, comment: '' }, her: { rating: null, comment: '' }, addedAt: id,
    });
    await saveFilms(`Добавлен фильм «${title}»`);
    location.href = 'film.html?id=' + id;
  } catch (err) {
    $('#manualErr').textContent = err.message;
    e.submitter.disabled = false;
  }
});

function renderGenres() {
  const count = {};
  films.forEach(f => f.genres.forEach(g => (count[g] = (count[g] || 0) + 1)));
  const cur = params.get('genre') || '';
  const items = [['', 'Все фильмы', films.length], ...Object.entries(count).sort((a, b) => b[1] - a[1]).map(([g, n]) => [g, g, n])];
  $('#genres').innerHTML = '<h2>Жанры</h2>' + items.map(([g, label, n]) =>
    `<a href="./${g ? '?genre=' + encodeURIComponent(g) : ''}" class="${cur === g ? 'active' : ''}">${esc(label)} <span>${n}</span></a>`).join('');
}

// --- поиск: по своему списку, а для админа ещё и по Кинопоиску ---
let timer;
$('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
document.addEventListener('click', e => { if (!e.target.closest('.search')) $('#results').hidden = true; });

const resRow = (f, action) => `<div class="res"><img src="${safeUrl(f.poster)}" alt=""><span>${esc(f.title)} <small>${f.year || ''}</small></span>${action}</div>`;

async function search() {
  const q = $('#q').value.trim();
  const box = $('#results');
  if (!q) return (box.hidden = true);
  const local = films.filter(f => (f.title + ' ' + f.original).toLowerCase().includes(q.toLowerCase()));
  box.innerHTML = '<h4>В списке</h4>' + (local.map(f => resRow(f, `<a href="film.html?id=${f.id}">Открыть</a>`)).join('') || '<p class="muted">Не найдено</p>');
  box.hidden = false;
  if (!admin) return;
  box.insertAdjacentHTML('beforeend', '<h4>Кинопоиск</h4><div id="kp"><p class="muted">Ищу…</p></div>');
  try {
    const d = await kp('/api/v2.1/films/search-by-keyword?page=1&keyword=' + encodeURIComponent(q));
    if ($('#q').value.trim() !== q) return; // пока ждали, запрос уже поменялся
    $('#kp').innerHTML = (d.films || []).map(f => resRow({ title: f.nameRu || f.nameEn, year: f.year, poster: f.posterUrlPreview },
      films.some(x => x.id === f.filmId)
        ? `<a href="film.html?id=${f.filmId}">Уже в списке</a>`
        : `<button class="primary" data-add="${f.filmId}">Добавить</button>`)).join('') || '<p class="muted">Ничего не найдено</p>';
  } catch (err) { $('#kp').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}

$('#results').addEventListener('click', async e => {
  const id = Number(e.target.dataset.add);
  if (!id) return;
  e.target.disabled = true;
  e.target.textContent = 'Добавляю…';
  try {
    if (!films.some(f => f.id === id)) {
      const [d, director] = await Promise.all([kp('/api/v2.2/films/' + id), directorOf(id).catch(() => undefined)]);
      const film = {
        id, title: d.nameRu || d.nameOriginal || d.nameEn, original: d.nameOriginal || '', year: d.year,
        poster: d.posterUrl, synopsis: d.description || d.shortDescription || '', director,
        genres: (d.genres || []).map(g => g.genre),
        him: { rating: null, comment: '' }, her: { rating: null, comment: '' }, addedAt: Date.now(),
      };
      films.push(film);
      await saveFilms(`Добавлен фильм «${film.title}»`);
    }
    location.href = 'film.html?id=' + id;
  } catch (err) { e.target.textContent = err.message; }
});

// --- стартовая страница ---
function scoreBadges(f) {
  return `${f.him.rating ? `<i class="him" title="Оценка от него">♂ ${f.him.rating}/5</i>` : ''}${f.her.rating ? `<i class="her" title="Оценка от неё">♀ ${f.her.rating}/10</i>` : ''}`;
}

// Новости браузер посетителя берёт сам: эти ленты разрешают запросы со страниц других сайтов
const NEWS_FEEDS = [
  { url: 'https://www.kinopoisk.ru/news.rss', source: 'Кинопоиск', take: 5 },
  { url: 'https://kanobu.ru/rss/news.xml', source: 'Канобу', take: 3 }, // кино, сериалы и игры
];
async function loadNews() {
  const results = await Promise.allSettled(NEWS_FEEDS.map(async f => {
    const r = await fetch(f.url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${f.source} ответил ${r.status}`);
    const xml = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const text = (it, sel) => it.querySelector(sel)?.textContent.trim() || '';
    return [...xml.querySelectorAll('item')].map(it => ({
      title: text(it, 'title'), url: text(it, 'link'), source: f.source,
      imageUrl: it.querySelector('enclosure')?.getAttribute('url') || '', publishedAt: new Date(text(it, 'pubDate')),
    })).filter(n => n.title && n.url).slice(0, f.take);
  }));
  const items = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  if (!items.length) throw new Error(results.map(r => r.reason?.message).filter(Boolean).join('; ') || 'ленты не ответили');
  return items.sort((a, b) => (+b.publishedAt || 0) - (+a.publishedAt || 0));
}

const card = f => `<a class="card" href="film.html?id=${f.id}"><img src="${safeUrl(f.poster)}" alt="" loading="lazy"><span>${esc(f.title)}</span><b>${scoreBadges(f)}</b></a>`;

// У него оценка по пятибалльной шкале, у неё по десятибалльной: приводим к десяти и берём среднюю из выставленных
const ratingOf = f => {
  const v = [f.him.rating && f.him.rating * 2, f.her.rating].filter(Boolean);
  return v.length ? v.reduce((a, b) => a + b) / v.length : 0;
};
const byTitle = (a, b) => a.title.localeCompare(b.title, 'ru');
const SORTS = {
  alpha: ['По алфавиту', byTitle],
  rating: ['По рейтингу', (a, b) => ratingOf(b) - ratingOf(a) || byTitle(a, b)], // без оценок — в конце
};

// Страница жанра: плитки, которые листаются вниз, и кнопки сортировки; выбор хранится в адресе (?sort=)
function renderTiles(genre, list) {
  const box = $('#showcase');
  box.classList.add('as-page');
  let sort = Object.hasOwn(SORTS, params.get('sort')) ? params.get('sort') : 'alpha';
  const draw = () => {
    box.innerHTML = `<div class="toolbar"><h2>${esc(genre)} <span>${list.length}</span></h2>
      <div class="sort" role="group" aria-label="Сортировка">${Object.entries(SORTS).map(([k, [label]]) =>
        `<button data-sort="${k}" aria-pressed="${k === sort}">${label}</button>`).join('')}</div></div>
      <div class="tiles">${[...list].sort(SORTS[sort][1]).map(card).join('')}</div>`;
  };
  box.onclick = e => {
    const k = e.target.dataset.sort;
    if (!k || k === sort) return;
    sort = k;
    params.set('sort', k);
    history.replaceState(null, '', '?' + params);
    draw();
    box.querySelector(`[data-sort="${k}"]`).focus(); // фокус остаётся на кнопке, хотя блок перерисован
  };
  draw();
}

function renderHome() {
  const g = params.get('genre');
  const list = g ? films.filter(f => f.genres.includes(g)) : films;
  $('#empty').hidden = list.length > 0;
  if (g) {
    document.title = `${g} — Лучший список фильмов`;
    if (list.length) renderTiles(g, list);
    else $('#empty').textContent = 'В этом жанре пока нет фильмов.';
  } else {
    // Лента-киноплёнка только на главной; порядок случайный при каждом заходе
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    $('#showcase').innerHTML = '<div class="track">' + shuffled.map(card).join('') + '</div>';
    startCarousel();
  }

  loadNews().then(items => {
    $('#news').innerHTML = items.map(n => `<a class="news-card" href="${safeUrl(n.url)}" target="_blank" rel="noopener">
      <img src="${safeUrl(n.imageUrl)}" alt="" loading="lazy"><b>${esc(n.title)}</b>
      <small>${esc(n.source)}${isNaN(n.publishedAt) ? '' : ' · ' + n.publishedAt.toLocaleDateString('ru-RU')}</small></a>`).join('');
  }).catch(err => { $('#news').innerHTML = `<p class="muted">Новости недоступны: ${esc(err.message)}</p>`; });
}

// Витрина как закольцованная киноплёнка: видно 4 фильма (на телефоне 2), лента бесконечно
// и медленно плывёт, за последним фильмом сразу идёт первый. Пока мышь над витриной — стоит.
const FILM_SPEED = 30; // пикселей в секунду
function startCarousel() {
  const box = $('#showcase'), track = box.firstElementChild;
  const cards = [...track.children];
  if (cards.length <= +getComputedStyle(box).getPropertyValue('--per')) return; // все и так видны, крутить нечего
  // Вторая копия карточек нужна для бесшовного стыка; она только для глаз, не для клавиатуры и экранных дикторов
  for (const c of cards) {
    const copy = c.cloneNode(true);
    copy.setAttribute('aria-hidden', 'true');
    copy.tabIndex = -1;
    track.append(copy);
  }
  let offset = 0, last = performance.now();
  const loopWidth = () => track.children[cards.length].offsetLeft; // где начинается копия
  let width = loopWidth();
  addEventListener('resize', () => { width = loopWidth(); });
  const move = () => { track.style.transform = `translateX(${-offset}px)`; };
  requestAnimationFrame(function frame(now) {
    const dt = Math.min(now - last, 100) / 1000; // после неактивной вкладки не прыгаем
    last = now;
    if (!box.matches(':hover, :focus-within')) {
      offset = (offset + FILM_SPEED * dt) % width;
      move();
    }
    requestAnimationFrame(frame);
  });
  // Карточку, на которую перешли клавишей Tab, прокручиваем в видимую часть
  // Только для клавиатуры: при нажатии мышью или пальцем ссылка тоже получает фокус, и прыжок ленты
  // уводил карточку из-под курсора раньше, чем засчитывался клик
  track.addEventListener('focusin', e => {
    if (!e.target.matches(':focus-visible')) return;
    offset = e.target.closest('.card').offsetLeft % width;
    move();
  });
}

// --- страница фильма ---
function ratingBlock(f, who) {
  const max = who === 'him' ? 5 : 10;
  const r = f[who];
  const label = who === 'him' ? 'Оценка от него' : 'Оценка от неё';
  const mark = n => (max === 5 ? '★' : n);
  const scale = Array.from({ length: max }, (_, i) => i + 1).map(n => admin
    ? `<button class="pt ${r.rating >= n ? 'on' : ''}" data-who="${who}" data-n="${n}" aria-label="${n} из ${max}" aria-pressed="${r.rating === n}">${mark(n)}</button>`
    : `<span class="pt ${r.rating >= n ? 'on' : ''}" aria-hidden="true">${mark(n)}</span>`).join('');
  return `<section class="rating ${who}" id="r-${who}">
    <h3>${label}</h3>
    <div class="scale" role="group" aria-label="${label}">${scale}</div>
    <p class="score">${r.rating ? `${r.rating} / ${max}` : 'Ещё не оценено'}</p>
    ${admin
      ? `<div class="cbox" ${r.rating ? '' : 'hidden'}>
          <label for="c-${who}">Оставьте небольшой комментарий</label>
          <textarea id="c-${who}" maxlength="1000" rows="3">${esc(r.comment)}</textarea>
          <button class="primary" data-save="${who}">Сохранить комментарий</button></div>`
      : r.comment ? `<blockquote>${esc(r.comment)}</blockquote>` : ''}
  </section>`;
}

function renderFilm() {
  const f = films.find(x => x.id === Number(params.get('id')));
  if (!f) return void ($('#film').innerHTML = '<p class="muted">Фильм не найден</p>');
  document.title = `${f.title} — Лучший список фильмов`;
  $('#film').innerHTML = `
    <div class="film-top">
      <img class="poster" src="${safeUrl(f.poster)}" alt="Постер: ${esc(f.title)}">
      <div class="about">
        <h2>${esc(f.title)} <small>${f.year || ''}</small></h2>
        ${f.original && f.original !== f.title ? `<p class="muted">${esc(f.original)}</p>` : ''}
        ${f.director ? `<p class="director"><span class="muted">Режиссёр:</span> ${esc(f.director)}</p>` : ''}
        <div class="tags">${f.genres.map(g => `<a href="./?genre=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}</div>
        <p class="synopsis">${esc(f.synopsis) || '<span class="muted">Синопсиса нет</span>'}</p>
        ${admin ? '<button id="del" class="danger">Удалить из списка</button>' : ''}
      </div>
    </div>
    <div class="ratings">${ratingBlock(f, 'him')}${ratingBlock(f, 'her')}</div>`;

  if (!admin) return;
  $('#film').addEventListener('click', async e => {
    const t = e.target;
    try {
      if (t.dataset.n) {
        const who = t.dataset.who;
        const draft = $('#c-' + who).value; // не теряем недописанный комментарий
        f[who].rating = Number(t.dataset.n);
        $('#r-' + who).outerHTML = ratingBlock(f, who);
        $('#c-' + who).value = draft;
        $('#c-' + who).focus();
        await saveFilms(`Оценка ${who === 'him' ? 'от него' : 'от неё'}: «${f.title}» ${f[who].rating}`);
      } else if (t.dataset.save) {
        const who = t.dataset.save;
        f[who].comment = $('#c-' + who).value.trim().slice(0, 1000);
        t.textContent = 'Сохраняю…';
        await saveFilms(`Комментарий ${who === 'him' ? 'от него' : 'от неё'}: «${f.title}»`);
        t.textContent = 'Сохранено ✓';
      } else if (t.id === 'del' && confirm(`Удалить «${f.title}» из списка?`)) {
        films = films.filter(x => x !== f);
        await saveFilms(`Удалён фильм «${f.title}»`);
        if (f.manual) {
          const path = `docs/posters/${f.id}.jpg`;
          await gh(path).then(p => gh(path, { method: 'DELETE', body: JSON.stringify({ message: `Удалена обложка «${f.title}»`, sha: p.sha }) }))
            .catch(() => {}); // осиротевшая обложка безвредна
        }
        location.href = './';
      }
    } catch (err) { alert('Не сохранилось: ' + err.message); }
  });
}

(async () => {
  $('#loginBtn').textContent = admin ? 'Выйти (админ)' : 'Войти как админ';
  $('#q').placeholder = admin ? 'Найти фильм в списке или на Кинопоиске…' : 'Поиск фильма…';
  $('#manualBtn').hidden = !admin;
  try { films = await loadFilms(); } catch (err) {
    main.innerHTML = `<p class="err">Не удалось загрузить список: ${esc(err.message)}${admin ? '. Попробуйте выйти и войти заново.' : ''}</p>`;
    return;
  }
  renderGenres();
  document.body.dataset.page === 'home' ? renderHome() : renderFilm();
})();
