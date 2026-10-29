const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^(https?:\/\/|\/api\/poster\/\d+$)/.test(u || '') ? esc(u) : '#'); // данные с Кинопоиска не должны подсунуть javascript:
const params = new URLSearchParams(location.search);
let admin = false, films = [];

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Ошибка ' + r.status);
  return d;
}

// --- общая шапка, вход и жанры ---
document.body.insertAdjacentHTML('afterbegin', `
<header class="top">
  <button id="loginBtn" class="login">Войти как админ</button>
  <h1><a href="/">Лучший список фильмов</a></h1>
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

$('#loginBtn').onclick = async () => {
  if (!admin) return $('#loginDlg').showModal();
  await api('/api/logout', { method: 'POST' });
  location.reload();
};
$('#loginForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
    location.reload();
  } catch (err) { $('#pwErr').textContent = err.message; }
});

// --- ручное добавление фильма, которого нет на Кинопоиске ---
// Уменьшаем обложку в браузере: она хранится в Gist как текст, и большие файлы замедлят сайт
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
  const form = e.target;
  if (!manualPoster) return ($('#manualErr').textContent = 'Загрузите обложку');
  e.submitter.disabled = true;
  try {
    const film = await api('/api/films/manual', { method: 'POST', body: {
      title: form.elements.title.value, year: form.elements.year.value, synopsis: form.elements.synopsis.value, poster: manualPoster,
      genres: form.elements.genres.value.split(','),
    } });
    location.href = '/film?id=' + film.id;
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
    `<a href="/${g ? '?genre=' + encodeURIComponent(g) : ''}" class="${cur === g ? 'active' : ''}">${esc(label)} <span>${n}</span></a>`).join('');
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
  box.innerHTML = '<h4>В списке</h4>' + (local.map(f => resRow(f, `<a href="/film?id=${f.id}">Открыть</a>`)).join('') || '<p class="muted">Не найдено</p>');
  box.hidden = false;
  if (!admin) return;
  box.insertAdjacentHTML('beforeend', '<h4>Кинопоиск</h4><div id="kp"><p class="muted">Ищу…</p></div>');
  try {
    const found = await api('/api/kp/search?q=' + encodeURIComponent(q));
    if ($('#q').value.trim() !== q) return; // пока ждали, запрос уже поменялся
    $('#kp').innerHTML = found.map(f => resRow(f, f.added
      ? `<a href="/film?id=${f.id}">Уже в списке</a>`
      : `<button class="primary" data-add="${f.id}">Добавить</button>`)).join('') || '<p class="muted">Ничего не найдено</p>';
  } catch (err) { $('#kp').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
}

$('#results').addEventListener('click', async e => {
  const id = e.target.dataset.add;
  if (!id) return;
  e.target.disabled = true;
  e.target.textContent = 'Добавляю…';
  try {
    await api('/api/films', { method: 'POST', body: { id: +id } });
    location.href = '/film?id=' + id;
  } catch (err) { e.target.textContent = err.message; }
});

// --- стартовая страница ---
function scoreBadges(f) {
  return `${f.him.rating ? `<i class="him" title="Оценка от него">♂ ${f.him.rating}/5</i>` : ''}${f.her.rating ? `<i class="her" title="Оценка от неё">♀ ${f.her.rating}/10</i>` : ''}`;
}

function renderHome() {
  const g = params.get('genre');
  const list = g ? films.filter(f => f.genres.includes(g)) : films;
  $('#empty').hidden = list.length > 0;
  $('#showcase').innerHTML = list.map(f =>
    `<a class="card" href="/film?id=${f.id}"><img src="${safeUrl(f.poster)}" alt="" loading="lazy"><span>${esc(f.title)}</span><b>${scoreBadges(f)}</b></a>`).join('');
  shuffleShowcase();
  setInterval(shuffleShowcase, 5000);

  api('/api/news').then(items => {
    $('#news').innerHTML = items.map(n => `<a class="news-card" href="${safeUrl(n.url)}" target="_blank" rel="noopener">
      <img src="${safeUrl(n.imageUrl)}" alt="" loading="lazy"><b>${esc(n.title)}</b>
      <small>${esc(n.source)}${n.publishedAt ? ' · ' + new Date(n.publishedAt).toLocaleDateString('ru-RU') : ''}</small></a>`).join('') || '<p class="muted">Новостей нет</p>';
  }).catch(err => { $('#news').innerHTML = `<p class="muted">Новости недоступны: ${esc(err.message)}</p>`; });
}

// Витрина: перемешиваем карточки и плавно перевозим каждую со старого места на новое (FLIP)
function shuffleShowcase() {
  const box = $('#showcase');
  const cards = [...box.children];
  if (cards.length < 2 || box.matches(':hover') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const before = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  box.append(...cards);
  cards.forEach(c => {
    const a = before.get(c), b = c.getBoundingClientRect();
    c.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 900, easing: 'ease-in-out' });
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

async function renderFilm() {
  let f;
  try { f = await api('/api/films/' + encodeURIComponent(params.get('id') || '')); }
  catch (err) { $('#film').innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  document.title = `${f.title} — Лучший список фильмов`;
  $('#film').innerHTML = `
    <div class="film-top">
      <img class="poster" src="${safeUrl(f.poster)}" alt="Постер: ${esc(f.title)}">
      <div class="about">
        <h2>${esc(f.title)} <small>${f.year || ''}</small></h2>
        ${f.original && f.original !== f.title ? `<p class="muted">${esc(f.original)}</p>` : ''}
        <div class="tags">${f.genres.map(g => `<a href="/?genre=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}</div>
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
        f = await api('/api/films/' + f.id, { method: 'PATCH', body: { [who]: { rating: +t.dataset.n } } });
        const draft = $('#c-' + who).value; // не теряем недописанный комментарий
        $('#r-' + who).outerHTML = ratingBlock(f, who);
        $('#c-' + who).value = draft;
        $('#c-' + who).focus();
      } else if (t.dataset.save) {
        const who = t.dataset.save;
        f = await api('/api/films/' + f.id, { method: 'PATCH', body: { [who]: { comment: $('#c-' + who).value } } });
        t.textContent = 'Сохранено ✓';
      } else if (t.id === 'del' && confirm(`Удалить «${f.title}» из списка?`)) {
        await api('/api/films/' + f.id, { method: 'DELETE' });
        location.href = '/';
      }
    } catch (err) { alert(err.message); }
  });
}

(async () => {
  try {
    [{ admin }, films] = await Promise.all([api('/api/me'), api('/api/films')]);
  } catch (err) { main.innerHTML = `<p class="err">Сервер недоступен: ${esc(err.message)}</p>`; return; }
  $('#loginBtn').textContent = admin ? 'Выйти (админ)' : 'Войти как админ';
  $('#q').placeholder = admin ? 'Найти фильм в списке или на Кинопоиске…' : 'Поиск фильма…';
  $('#manualBtn').hidden = !admin;
  renderGenres();
  document.body.dataset.page === 'home' ? renderHome() : renderFilm();
})();
