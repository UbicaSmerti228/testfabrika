'use strict';
(() => {
  // ---------------------------------------------------------------------------
  // Настройки картинки: координаты окон под аватарки и подписи (в пикселях шаблона)
  // ---------------------------------------------------------------------------
  const POSTER = {
    width: 1254,
    height: 1254,
    template: 'assets/template.webp',
    slots: [
      { place: 1, cx: 626.9, cy: 603.9, r: 155.2, nameX: 630, nameY: 829.5, nameMaxW: 290 },
      { place: 2, cx: 301.2, cy: 625.2, r: 132.6, nameX: 304, nameY: 829.5, nameMaxW: 290 },
      { place: 3, cx: 963.0, cy: 633.4, r: 131.4, nameX: 972, nameY: 829.5, nameMaxW: 290 },
    ],
    name: { capHeight: 39.5, color: '#0a0704', font: '"Roboto Condensed", "Arial Narrow", sans-serif' },
  };
  const API_VERSION = '5.199';
  // Встроенный сервисный ключ: сайтом можно пользоваться без настройки.
  // Свой ключ, сохранённый в браузере, имеет приоритет.
  const DEFAULT_TOKEN = '614f4d75614f4d75614f4d7531620b3bdd6614f614f4d750b839c6908bce35e0e58b9e1';
  const getToken = () => store.get('vk_token') || DEFAULT_TOKEN;
  const MIN_GAP_MS = 360; // ВК разрешает ~3 запроса в секунду
  const BATCH = 300;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* хранилище недоступно */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* хранилище недоступно */ } },
  };

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  // ---------------------------------------------------------------------------
  // ВКонтакте API через JSONP (сайт статический, без сервера)
  // ---------------------------------------------------------------------------
  class VkError extends Error {
    constructor(code, msg) { super(msg); this.code = code; }
  }
  let lastCall = 0;
  let cbSeq = 0;

  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const name = '__vkcb' + (++cbSeq) + '_' + Date.now();
      const s = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new VkError(-1, 'ВКонтакте не ответил за 20 секунд. Проверьте интернет и попробуйте ещё раз.')); }, 20000);
      function cleanup() { clearTimeout(timer); try { delete window[name]; } catch (e) { window[name] = undefined; } s.remove(); }
      window[name] = (data) => { cleanup(); resolve(data); };
      s.onerror = () => { cleanup(); reject(new VkError(-1, 'Не получилось связаться с ВКонтакте. Проверьте интернет или отключите блокировщик рекламы для этого сайта.')); };
      s.src = url + '&callback=' + name;
      document.head.appendChild(s);
    });
  }

  async function vkCall(method, params) {
    const token = getToken();
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = lastCall + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const q = new URLSearchParams({ ...params, access_token: token, v: API_VERSION, lang: 'ru' });
      const data = await jsonp('https://api.vk.com/method/' + method + '?' + q.toString());
      if (data && data.error) {
        const c = data.error.error_code;
        if (c === 6 || c === 9 || c === 10) { await sleep(800 * (attempt + 1)); continue; }
        throw new VkError(c, data.error.error_msg || 'Неизвестная ошибка');
      }
      return data.response;
    }
    throw new VkError(6, 'ВКонтакте временно ограничил частоту запросов');
  }

  function humanError(e) {
    if (!(e instanceof VkError)) return 'Что-то пошло не так: ' + (e && e.message ? e.message : e);
    switch (e.code) {
      case -1: return e.message;
      case 5: return 'Ключ доступа не подошёл. Вставьте сервисный ключ приложения ВК заново.';
      case 6: return 'ВКонтакте ограничил частоту запросов. Подождите минуту и нажмите «Проверить участников» ещё раз.';
      case 15: case 18: case 30: case 203: return 'ВКонтакте закрыл доступ к этим данным (' + e.message + '). Проверьте, что пост и сообщество открытые.';
      case 100: case 113: return 'ВКонтакте не принял запрос: ' + e.message + '. Проверьте ссылку на пост и список исключений.';
      case 212: case 232: return 'Не нашёл такой пост. Проверьте ссылку.';
      default: return 'Ошибка ВКонтакте ' + e.code + ': ' + e.message;
    }
  }

  function chunks(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  const USER_FIELDS = 'photo_100,photo_200,has_photo,is_closed,can_access_closed,crop_photo,screen_name';

  const vkSource = {
    demo: false,
    async postInfo(ownerId, postId) {
      const info = { name: '', photo: '', date: 0, likes: null, reposts: null };
      try {
        const r = await vkCall('wall.getById', { posts: ownerId + '_' + postId });
        const items = Array.isArray(r) ? r : (r && r.items) || [];
        if (items[0]) {
          info.date = items[0].date;
          info.likes = items[0].likes ? items[0].likes.count : null;
          info.reposts = items[0].reposts ? items[0].reposts.count : null;
          info.wallReposts = items[0].reposts && items[0].reposts.wall_count != null ? items[0].reposts.wall_count : null;
        }
      } catch (e) { if (e.code === 5) throw e; }
      try {
        if (ownerId < 0) {
          const r = await vkCall('groups.getById', { group_id: String(-ownerId), fields: 'photo_100' });
          const g = Array.isArray(r) ? r[0] : ((r && (r.groups || r.items)) || [])[0];
          if (g) { info.name = g.name; info.photo = g.photo_100; }
        } else {
          const r = await vkCall('users.get', { user_ids: String(ownerId), fields: 'photo_100' });
          if (r && r[0]) { info.name = r[0].first_name + ' ' + r[0].last_name; info.photo = r[0].photo_100; }
        }
      } catch (e) { if (e.code === 5) throw e; }
      return info;
    },
    async likers(ownerId, postId, filter, onProgress) {
      const ids = [];
      let offset = 0, total = Infinity;
      while (offset < total && offset < 100000) {
        const r = await vkCall('likes.getList', { type: 'post', owner_id: ownerId, item_id: postId, filter, count: 1000, offset });
        total = r.count;
        const items = r.items || [];
        if (!items.length) break;
        for (const it of items) ids.push(typeof it === 'object' ? it.id : it);
        offset += items.length;
        if (onProgress) onProgress(ids.length, total);
      }
      return ids;
    },
    // Кто сделал репост: список likes.getList(copies) + wall.getReposts
    async reposters(ownerId, postId, onProgress) {
      const ids = new Set();
      const listed = (await vkSource.likers(ownerId, postId, 'copies', (d) => onProgress && onProgress('список: ' + d))).filter((id) => id > 0);
      listed.forEach((id) => ids.add(id));
      let extra = 0;
      try {
        let offset = 0;
        for (let page = 0; page < 30; page++) {
          const r = await vkCall('wall.getReposts', { owner_id: ownerId, post_id: postId, offset, count: 1000 });
          const items = (r && r.items) || [];
          if (!items.length) break;
          for (const it of items) {
            const id = it.owner_id > 0 ? it.owner_id : it.from_id;
            if (id > 0 && !ids.has(id)) { ids.add(id); extra++; }
          }
          offset += items.length;
          if (onProgress) onProgress('репосты: ' + ids.size);
        }
      } catch (e) { if (e.code === 5) throw e; }
      return { ids, listed: listed.length, extra };
    },
    // Есть ли репост поста на стене человека. 'yes' | 'no' | 'closed'
    async wallReposted(userId, ownerId, postId, since) {
      let offset = 0;
      for (let page = 0; page < 8; page++) {
        let r = null;
        for (let attempt = 0; attempt < 2 && !r; attempt++) {
          try { r = await vkCall('wall.get', { owner_id: userId, count: 20, offset, filter: 'owner' }); }
          catch (e) {
            if (e.code === 5) throw e;
            if (e.code === -1 && attempt === 0) continue;
            if (e.code === -1) throw e;
            return 'closed';
          }
        }
        const items = (r && r.items) || [];
        let oldest = Infinity;
        for (const it of items) {
          if ((it.copy_history || []).some((c) => c.owner_id === ownerId && c.id === postId)) return 'yes';
          if (!it.is_pinned && it.date < oldest) oldest = it.date;
        }
        if (items.length < 20 || (since && oldest < since)) return 'no';
        offset += 20;
      }
      return 'no';
    },
    async members(groupId, ids, onProgress) {
      const res = new Set();
      let done = 0;
      for (const part of chunks(ids, BATCH)) {
        const r = await vkCall('groups.isMember', { group_id: String(groupId), user_ids: part.join(',') });
        for (const it of r || []) if (it.member) res.add(it.user_id);
        done += part.length;
        if (onProgress) onProgress(done, ids.length);
      }
      return res;
    },
    async users(ids, onProgress) {
      const res = [];
      for (const part of chunks(ids, BATCH)) {
        const r = await vkCall('users.get', { user_ids: part.join(','), fields: USER_FIELDS });
        res.push(...(r || []));
        if (onProgress) onProgress(res.length, ids.length);
      }
      return res;
    },
    async resolveUsers(tokens) {
      if (!tokens.length) return [];
      const ids = [];
      for (const part of chunks(tokens, 100)) {
        try {
          const r = await vkCall('users.get', { user_ids: part.join(',') });
          for (const u of r || []) ids.push(u.id);
        } catch (e) {
          if (e.code === 5) throw e;
          for (const one of part) {
            try { const r = await vkCall('users.get', { user_ids: one }); if (r && r[0]) ids.push(r[0].id); } catch (e2) { if (e2.code === 5) throw e2; }
          }
        }
      }
      return ids;
    },
    async resolveGroup(str) {
      const r = await vkCall('groups.getById', { group_id: str });
      const g = Array.isArray(r) ? r[0] : ((r && (r.groups || r.items)) || [])[0];
      if (!g) throw new VkError(100, 'сообщество не найдено');
      return g.id;
    },
  };

  // ---------------------------------------------------------------------------
  // Тестовые данные
  // ---------------------------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const avatarCache = new Map();
  function demoAvatar(user) {
    const key = user.id + (user.has_photo ? '' : 'x');
    if (avatarCache.has(key)) return avatarCache.get(key);
    const c = document.createElement('canvas');
    c.width = c.height = 240;
    const g = c.getContext('2d');
    if (!user.has_photo) {
      g.fillStyle = '#E3E8EE'; g.fillRect(0, 0, 240, 240);
      g.fillStyle = '#B8C3CF';
      g.beginPath(); g.arc(120, 96, 42, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(120, 230, 82, 72, 0, 0, Math.PI * 2); g.fill();
    } else {
      const h = user.hue;
      const grd = g.createLinearGradient(0, 0, 240, 240);
      grd.addColorStop(0, `hsl(${h} 70% 62%)`);
      grd.addColorStop(1, `hsl(${(h + 40) % 360} 65% 42%)`);
      g.fillStyle = grd; g.fillRect(0, 0, 240, 240);
      g.fillStyle = 'rgba(255,255,255,.14)';
      g.beginPath(); g.arc(200, 40, 90, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.font = '700 96px "Roboto Condensed", "Arial Narrow", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText((user.first_name[0] || '') + (user.last_name[0] || ''), 120, 128);
    }
    const url = c.toDataURL('image/png');
    avatarCache.set(key, url);
    return url;
  }

  const demoSource = (() => {
    const rnd = mulberry32(20261012);
    const fem = ['Айгуль', 'Гульназ', 'Алсу', 'Динара', 'Зарина', 'Лилия', 'Эльвира', 'Регина', 'Гузель', 'Ралина', 'Зинира', 'Альфия', 'Резеда', 'Лейсан', 'Миляуша', 'Ильмира', 'Анастасия', 'Екатерина', 'Дарья', 'Юлия', 'Светлана', 'Ксения'];
    const mal = ['Ильдар', 'Рустам', 'Ринат', 'Тимур', 'Айдар', 'Азат', 'Булат', 'Артур', 'Марат', 'Радик', 'Ильнур', 'Салават', 'Дмитрий', 'Алексей', 'Иван', 'Максим'];
    const surM = ['Хасанов', 'Галиев', 'Ахметов', 'Сафин', 'Валиев', 'Шарипов', 'Мухаметов', 'Гарипов', 'Нуриев', 'Ибрагимов', 'Иванов', 'Петров', 'Смирнов', 'Кузнецов'];
    const users = [];
    for (let i = 0; i < 260; i++) {
      const f = rnd() < 0.68;
      const fn = f ? fem[Math.floor(rnd() * fem.length)] : mal[Math.floor(rnd() * mal.length)];
      const sn = surM[Math.floor(rnd() * surM.length)] + (f ? 'а' : '');
      const id = 100000 + Math.floor(rnd() * 800000000);
      const r = rnd();
      users.push({
        id, first_name: fn, last_name: sn, hue: Math.floor(rnd() * 360),
        liked: rnd() < 0.86, reposted: rnd() < 0.47, member: rnd() < 0.8,
        deactivated: r < 0.04 ? 'deleted' : (r < 0.06 ? 'banned' : undefined),
        has_photo: rnd() < 0.9 ? 1 : 0, is_closed: rnd() < 0.25,
      });
    }
    const byId = new Map(users.map((u) => [u.id, u]));
    const lag = () => sleep(180 + Math.random() * 260);
    const pub = (u) => {
      const o = { id: u.id, first_name: u.first_name, last_name: u.last_name, has_photo: u.has_photo, is_closed: u.is_closed, can_access_closed: !u.is_closed };
      if (u.deactivated) { o.deactivated = u.deactivated; o.first_name = u.deactivated === 'deleted' ? 'DELETED' : u.first_name; }
      o.photo_100 = o.photo_200 = demoAvatar(u);
      o.screen_name = 'id' + u.id;
      return o;
    };
    return {
      demo: true,
      async postInfo() { await lag(); return { name: 'Фабрика суши. Яркеево (тестовые данные)', photo: '', date: Date.now() / 1000 - 86400 * 3, likes: users.filter((u) => u.liked).length, reposts: users.filter((u) => u.reposted).length + 2, wallReposts: users.filter((u) => u.reposted).length }; },
      async likers(o, p, filter, onProgress) {
        await lag(); await lag();
        const ids = users.filter((u) => (filter === 'copies' ? u.reposted : u.liked)).map((u) => u.id);
        if (filter === 'copies') ids.push(-215596190, -1);
        if (onProgress) onProgress(ids.length, ids.length);
        return ids;
      },
      async reposters() {
        await lag(); await lag();
        const visible = users.filter((u) => u.reposted).filter((u, i) => i % 3 === 0).map((u) => u.id);
        return { ids: new Set(visible), listed: visible.length, extra: 0 };
      },
      async wallReposted(uid) {
        await sleep(30);
        const u = byId.get(uid);
        if (!u) return 'no';
        if (u.is_closed) return 'closed';
        return u.reposted ? 'yes' : 'no';
      },
      async members(g, ids, onProgress) {
        await lag(); await lag();
        if (onProgress) onProgress(ids.length, ids.length);
        return new Set(ids.filter((id) => byId.get(id) && byId.get(id).member));
      },
      async users(ids, onProgress) {
        await lag();
        const out = ids.map((id) => byId.get(id)).filter(Boolean).map(pub);
        if (onProgress) onProgress(out.length, ids.length);
        return out;
      },
      async resolveUsers(tokens) {
        await lag();
        return tokens.map((t) => Number(String(t).replace(/^id/, ''))).filter((n) => byId.has(n));
      },
      async resolveGroup() { await lag(); return 215596190; },
    };
  })();

  // ---------------------------------------------------------------------------
  // Разбор ввода
  // ---------------------------------------------------------------------------
  function parsePost(s) {
    const m = String(s || '').match(/wall(-?\d+)_(\d+)/);
    return m ? { ownerId: Number(m[1]), postId: Number(m[2]) } : null;
  }
  function parseExclusions(s) {
    return String(s || '')
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.replace(/^https?:\/\/(m\.)?vk\.(com|ru)\//i, '').replace(/^@/, '').replace(/[/?#].*$/, ''))
      .map((t) => t.replace(/^id(\d+)$/i, '$1'))
      .filter((t) => /^[A-Za-z0-9_.]+$/.test(t));
  }
  function parseGroup(s) {
    const t = String(s || '').trim().replace(/^https?:\/\/(m\.)?vk\.(com|ru)\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
    if (!t) return '';
    const m = t.match(/^(club|public|event)(\d+)$/i);
    return m ? m[2] : t;
  }

  // ---------------------------------------------------------------------------
  // Состояние
  // ---------------------------------------------------------------------------
  const state = {
    source: null,
    post: null,
    postUrl: '',
    conds: [],
    stages: [],
    participants: [],
    winners: [], // { place, user, index, pool }
    used: new Set(),
    log: [],
    checkedAt: null,
    listHash: '',
    count: 3,
    busy: false,
  };

  // ---------------------------------------------------------------------------
  // Ключ доступа
  // ---------------------------------------------------------------------------
  function refreshTokenUi() {
    const own = !!store.get('vk_token');
    $('tokenDot').classList.toggle('ok', own || !!DEFAULT_TOKEN);
    $('tokenBtnText').textContent = own ? 'Свой ключ ВК' : (DEFAULT_TOKEN ? 'Ключ ВК встроен' : 'Ключ ВК');
  }
  function openTokenPanel(open) {
    const p = $('tokenPanel');
    p.hidden = !open;
    $('tokenBtn').setAttribute('aria-expanded', String(open));
    if (open) { $('token').value = store.get('vk_token') || ''; $('token').focus(); }
  }
  $('tokenBtn').addEventListener('click', () => openTokenPanel($('tokenPanel').hidden));
  $('tokenShow').addEventListener('click', () => {
    const i = $('token');
    i.type = i.type === 'password' ? 'text' : 'password';
    $('tokenShow').textContent = i.type === 'password' ? 'Показать' : 'Скрыть';
  });
  $('tokenSave').addEventListener('click', () => {
    const v = $('token').value.trim();
    if (!v) { toast('Вставьте ключ, потом сохраните'); return; }
    store.set('vk_token', v);
    refreshTokenUi();
    openTokenPanel(false);
    toast('Ключ сохранён в этом браузере');
  });
  $('tokenClear').addEventListener('click', () => {
    store.del('vk_token');
    $('token').value = '';
    refreshTokenUi();
    toast('Ключ удалён');
  });
  refreshTokenUi();

  // ---------------------------------------------------------------------------
  // Количество победителей
  // ---------------------------------------------------------------------------
  function setCount(n) {
    state.count = Math.max(1, Math.min(10, n));
    $('countOut').textContent = state.count;
    $('countMinus').disabled = state.count <= 1;
    $('countPlus').disabled = state.count >= 10;
  }
  $('countMinus').addEventListener('click', () => setCount(state.count - 1));
  $('countPlus').addEventListener('click', () => setCount(state.count + 1));
  setCount(3);

  // ---------------------------------------------------------------------------
  // Воронка проверки
  // ---------------------------------------------------------------------------
  function buildFunnel(list) {
    const ol = $('funnel');
    ol.innerHTML = '';
    state.stages = list.map((s) => ({ ...s, value: null }));
    for (const s of state.stages) {
      const li = document.createElement('li');
      li.className = 'wait';
      li.innerHTML = '<span class="f-name"></span><span class="f-num"></span><span class="f-bar"><i></i></span><span class="f-note" hidden></span>';
      li.querySelector('.f-name').textContent = s.label;
      s.el = li;
      ol.appendChild(li);
    }
  }
  function stage(key) { return state.stages.find((s) => s.key === key); }
  function stageRun(key, text) {
    const s = stage(key); if (!s) return;
    s.el.className = 'run';
    s.el.querySelector('.f-num').textContent = text || '';
  }
  function stageDone(key, value, note) {
    const s = stage(key); if (!s) return;
    s.value = value;
    s.el.className = 'done';
    s.el.querySelector('.f-num').textContent = value.toLocaleString('ru-RU');
    const base = state.stages.find((x) => x.value != null);
    const max = Math.max(1, base ? base.value : value);
    s.el.querySelector('.f-bar i').style.width = Math.max(1.5, (100 * value) / max) + '%';
    const n = s.el.querySelector('.f-note');
    if (note) { n.textContent = note; n.hidden = false; } else { n.hidden = true; }
  }
  function setStatus(text, isErr) {
    const el = $('checkStatus');
    el.textContent = text || '';
    el.classList.toggle('err', !!isErr);
  }

  // ---------------------------------------------------------------------------
  // Проверка участников
  // ---------------------------------------------------------------------------
  async function runCheck(source) {
    if (state.busy) return;
    const post = parsePost($('postUrl').value);
    $('postErr').hidden = true;
    if (!post && !source.demo) {
      $('postErr').textContent = 'Не вижу в ссылке номер поста. Нужна ссылка вида vk.com/wall-215596190_1837.';
      $('postErr').hidden = false;
      $('postUrl').focus();
      return;
    }
    if (!source.demo && !getToken()) {
      openTokenPanel(true);
      toast('Сначала добавьте ключ ВК или попробуйте тестовые данные');
      return;
    }
    const p = post || { ownerId: -215596190, postId: 1837 };
    const opts = {
      like: $('cLike').checked,
      repost: $('cRepost').checked,
      member: $('cMember').checked,
      active: $('cActive').checked,
      noPhoto: $('fNoPhoto').checked,
      closed: $('fClosed').checked,
      group: parseGroup($('groupOverride').value),
      exclude: parseExclusions($('exclude').value),
    };

    state.busy = true;
    state.source = source;
    state.post = p;
    state.postUrl = 'https://vk.com/wall' + p.ownerId + '_' + p.postId;
    state.participants = [];
    state.winners = [];
    state.used = new Set();
    state.log = [];
    state.conds = [];
    if (opts.like) state.conds.push('лайк');
    if (opts.repost) state.conds.push('репост');
    if (opts.member) state.conds.push('подписка на сообщество');
    if (opts.active) state.conds.push('активная страница');
    if (opts.noPhoto) state.conds.push('есть аватарка');
    if (opts.closed) state.conds.push('открытый профиль');
    if (opts.exclude.length) state.conds.push('не в списке исключений');

    $('checkBtn').disabled = true;
    $('checkBtn').textContent = 'Проверяем…';
    $('drawPanel').hidden = true;
    $('posterPanel').hidden = true;
    $('checkPanel').hidden = false;
    $('totalBox').hidden = true;
    $('peopleBox').hidden = true;
    $('drawActions').hidden = true;
    $('postCard').hidden = true;
    setStatus(source.demo ? 'Тестовые данные: выдуманные участники, ВКонтакте не используется.' : 'Собираю данные из ВКонтакте…');

    const both = opts.like && opts.repost;
    const st = [];
    if (opts.like) st.push({ key: 'like', label: 'Поставили лайк' });
    if (opts.repost && !opts.like) st.push({ key: 'repost', label: 'Сделали репост' });
    if (!opts.like && !opts.repost) st.push({ key: 'any', label: 'Лайкнули или сделали репост' });
    if (opts.exclude.length) st.push({ key: 'excl', label: 'Не в списке исключений' });
    if (opts.member) st.push({ key: 'member', label: 'Подписаны на сообщество' });
    if (opts.active) st.push({ key: 'active', label: 'Страница не удалена и не заблокирована' });
    if (opts.noPhoto) st.push({ key: 'photo', label: 'Есть аватарка' });
    if (opts.closed) st.push({ key: 'closed', label: 'Профиль открыт' });
    if (both) st.push({ key: 'repost', label: 'И сделали репост' });
    buildFunnel(st);
    $('checkPanel').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });

    try {
      const info = (await source.postInfo(p.ownerId, p.postId)) || {};
      if (info.name) {
        $('postName').textContent = info.name;
        const bits = [];
        if (info.date) bits.push(new Date(info.date * 1000).toLocaleDateString('ru-RU'));
        if (info.likes != null) bits.push(info.likes.toLocaleString('ru-RU') + ' ' + plural(info.likes, 'лайк', 'лайка', 'лайков'));
        if (info.reposts != null) bits.push(info.reposts.toLocaleString('ru-RU') + ' ' + plural(info.reposts, 'репост', 'репоста', 'репостов'));
        $('postMeta').textContent = bits.join(', ');
        if (info.photo) { $('postAva').src = info.photo; $('postAva').hidden = false; } else { $('postAva').hidden = true; }
        $('postCard').hidden = false;
      }
      const expectedReposts = info.wallReposts != null ? info.wallReposts : info.reposts;

      let pool = null;
      let reposts = null;
      if (opts.like || !opts.repost) {
        const key = opts.like ? 'like' : 'any';
        stageRun(key);
        const likers = await source.likers(p.ownerId, p.postId, 'likes', (d, t) => stageRun(key, d + ' из ' + t));
        pool = new Set(likers.filter((id) => id > 0));
        if (opts.like) stageDone('like', pool.size);
      }
      if (opts.repost || !opts.like) {
        const key = opts.repost ? 'repost' : 'any';
        stageRun(key);
        reposts = await source.reposters(p.ownerId, p.postId, (t) => stageRun(key, t));
        if (opts.repost && !opts.like) {
          pool = new Set(reposts.ids);
          let note = 'ВК не показывает репосты в закрытые профили и в личные сообщения.';
          if (!pool.size && expectedReposts) note = 'ВКонтакте не отдал список репостов. Включите условие «Лайк»: тогда репосты проверятся по стенам тех, кто лайкнул.';
          stageDone('repost', pool.size, note);
        } else if (!opts.repost) {
          for (const id of reposts.ids) pool.add(id);
          stageDone('any', pool.size);
        } else {
          const s = stage('repost');
          s.el.className = 'wait';
          s.el.querySelector('.f-num').textContent = '';
        }
      }

      if (opts.exclude.length) {
        stageRun('excl');
        const ex = new Set(await source.resolveUsers(opts.exclude));
        const before = pool.size;
        pool = new Set([...pool].filter((id) => !ex.has(id)));
        const unresolved = opts.exclude.length - ex.size;
        stageDone('excl', pool.size, (before - pool.size) + ' убрано' + (unresolved > 0 ? ', ' + unresolved + ' не найдено в ВК' : ''));
      }

      if (opts.member) {
        let groupId = p.ownerId < 0 ? -p.ownerId : 0;
        if (opts.group) groupId = await source.resolveGroup(opts.group);
        if (!groupId) {
          stageDone('member', pool.size, 'Пост опубликован на личной странице. Укажите сообщество в дополнительных фильтрах, чтобы проверить подписку.');
        } else {
          stageRun('member');
          pool = await source.members(groupId, [...pool], (d, t) => stageRun('member', d + ' из ' + t));
          stageDone('member', pool.size);
        }
      }

      let users = [];
      if (pool.size) users = await source.users([...pool], (d, t) => setStatus('Загружаю профили: ' + d + ' из ' + t));
      if (opts.active) {
        users = users.filter((u) => !u.deactivated);
        stageDone('active', users.length);
      }
      if (opts.noPhoto) {
        users = users.filter((u) => u.has_photo !== 0 && !u.deactivated);
        stageDone('photo', users.length);
      }
      if (opts.closed) {
        users = users.filter((u) => !u.is_closed || u.can_access_closed);
        stageDone('closed', users.length);
      }

      if (both) {
        stageRun('repost');
        const confirmed = users.filter((u) => reposts.ids.has(u.id));
        const fromList = confirmed.length;
        const rest = users.filter((u) => !reposts.ids.has(u.id));
        let found = 0, unverifiable = 0, checked = 0;
        const needWalls = rest.length > 0 && (expectedReposts == null || reposts.ids.size < expectedReposts);
        if (needWalls) {
          const t0 = Date.now();
          for (const u of rest) {
            checked++;
            if (u.deactivated || (u.is_closed && !u.can_access_closed)) { unverifiable++; continue; }
            const r = await source.wallReposted(u.id, p.ownerId, p.postId, info.date || 0);
            if (r === 'yes') { confirmed.push(u); found++; } else if (r === 'closed') unverifiable++;
            stageRun('repost', checked + ' из ' + rest.length);
            const left = Math.ceil((((Date.now() - t0) / checked) * (rest.length - checked)) / 60000);
            setStatus('Проверяю репосты на стенах участников: ' + checked + ' из ' + rest.length + (rest.length - checked > 20 ? ', осталось около ' + left + ' мин.' : ''));
          }
          setStatus('');
        }
        users = confirmed;
        const parts = [];
        if (needWalls) {
          parts.push('По списку ВК: ' + fromList + ', найдено на стенах: ' + found);
          if (unverifiable) parts.push(unverifiable + ' ' + plural(unverifiable, 'страницу', 'страницы', 'страниц') + ' не проверить: профиль или стена закрыты');
        } else {
          parts.push('ВК не показывает репосты в закрытые профили и в личные сообщения');
        }
        stageDone('repost', users.length, parts.join('. '));
      }

      users.sort((a, b) => a.id - b.id);
      state.participants = users;
      state.checkedAt = new Date();
      state.listHash = await sha256(users.map((u) => u.id).join(','));

      $('totalNum').textContent = users.length.toLocaleString('ru-RU');
      $('totalTxt').textContent = plural(users.length, 'участник прошёл', 'участника прошли', 'участников прошли') + ' проверку';
      $('totalBox').hidden = false;
      renderPeople(users);
      if (!users.length) {
        setStatus('Никто не выполнил все условия. Уберите часть условий и проверьте снова.', true);
      } else {
        setStatus(source.demo ? 'Тестовые данные: выдуманные участники.' : '');
        $('drawActions').hidden = false;
        const n = Math.min(state.count, users.length);
        $('drawBtn').textContent = 'Разыграть ' + n + ' ' + plural(n, 'место', 'места', 'мест');
      }
    } catch (e) {
      console.error(e);
      setStatus(humanError(e), true);
      for (const s of state.stages) if (s.el.className === 'run') s.el.className = 'wait';
      if (e && e.code === 5) openTokenPanel(true);
    } finally {
      state.busy = false;
      $('checkBtn').disabled = false;
      $('checkBtn').textContent = 'Проверить участников';
    }
  }

  function fullName(u) { return (u.first_name + ' ' + u.last_name).trim(); }
  function profileUrl(u) { return 'https://vk.com/' + (u.screen_name || 'id' + u.id); }
  function smallPhoto(u) { return u.photo_100 || u.photo_200 || ''; }

  function renderPeople(users) {
    const ul = $('peopleList');
    ul.innerHTML = '';
    const frag = document.createDocumentFragment();
    users.slice(0, 2000).forEach((u) => {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.loading = 'lazy'; img.alt = ''; img.src = smallPhoto(u);
      const a = document.createElement('a');
      a.href = state.source.demo ? '#' : profileUrl(u);
      a.target = '_blank'; a.rel = 'noopener';
      a.textContent = fullName(u);
      li.append(img, a);
      frag.appendChild(li);
    });
    ul.appendChild(frag);
    $('peopleBox').hidden = users.length === 0;
  }

  async function sha256(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { return 'недоступна в этом браузере'; }
  }

  // ---------------------------------------------------------------------------
  // Честный выбор: криптографический генератор, без перекоса по модулю
  // ---------------------------------------------------------------------------
  function randInt(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }
  function pickOne() {
    const pool = state.participants.filter((u) => !state.used.has(u.id));
    if (!pool.length) return null;
    const index = randInt(pool.length);
    const user = pool[index];
    state.used.add(user.id);
    return { user, index, pool: pool.length };
  }

  // ---------------------------------------------------------------------------
  // Барабан
  // ---------------------------------------------------------------------------
  const STEP = 96; // 84 px аватарка + 12 px отступ
  async function spinTo(winner) {
    const track = $('reelTrack');
    const reel = $('reel');
    const n = 44, target = 38;
    track.innerHTML = '';
    const people = state.participants;
    for (let i = 0; i < n; i++) {
      const u = i === target ? winner : people[Math.floor(Math.random() * people.length)];
      const img = document.createElement('img');
      img.alt = ''; img.src = smallPhoto(u);
      track.appendChild(img);
    }
    const w = reel.clientWidth;
    const xAt = (i) => w / 2 - (i * STEP + 42);
    const from = xAt(3), to = xAt(target);
    if (reduceMotion) { track.style.transform = 'translateX(' + to + 'px)'; await sleep(250); return; }
    const dur = 2300;
    const t0 = performance.now();
    await new Promise((resolve) => {
      function frame(now) {
        const k = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - k, 4);
        track.style.transform = 'translateX(' + (from + (to - from) * e) + 'px)';
        if (k < 1) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
    await sleep(350);
  }

  function renderWinners(highlightPlace) {
    const ol = $('winners');
    ol.innerHTML = '';
    const sorted = [...state.winners].sort((a, b) => a.place - b.place);
    for (const w of sorted) {
      const li = document.createElement('li');
      li.className = 'winner' + (w.place === highlightPlace ? ' new' : '');
      li.dataset.place = w.place;
      const badge = document.createElement('span');
      badge.className = 'winner__place';
      badge.textContent = w.place;
      badge.setAttribute('aria-label', w.place + ' место');
      const img = document.createElement('img');
      img.alt = ''; img.src = w.user.photo_200 || smallPhoto(w.user);
      const box = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'winner__name';
      if (state.source.demo) name.textContent = fullName(w.user);
      else {
        const a = document.createElement('a');
        a.href = profileUrl(w.user); a.target = '_blank'; a.rel = 'noopener';
        a.textContent = fullName(w.user);
        name.appendChild(a);
      }
      const meta = document.createElement('div');
      meta.className = 'winner__meta';
      meta.textContent = w.place + ' место, номер ' + (w.index + 1) + ' из ' + w.pool;
      box.append(name, meta);
      const re = document.createElement('button');
      re.type = 'button'; re.className = 'link-btn'; re.textContent = 'Перевыбрать';
      re.addEventListener('click', () => reroll(w.place));
      li.append(badge, img, box, re);
      ol.appendChild(li);
    }
  }

  async function drawAll() {
    if (state.busy || !state.participants.length) return;
    state.busy = true;
    state.winners = [];
    state.used = new Set();
    state.log = [];
    $('drawBtn').disabled = true;
    $('drawPanel').hidden = false;
    $('posterPanel').hidden = true;
    $('reel').hidden = false;
    $('winners').innerHTML = '';
    $('drawPanel').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    const n = Math.min(state.count, state.participants.length);
    try {
      for (let place = n; place >= 1; place--) {
        $('drawTitle').textContent = place + ' место';
        const pick = pickOne();
        if (!pick) break;
        await spinTo(pick.user);
        state.winners.push({ place, ...pick });
        state.log.push({ time: new Date(), action: 'Выбор', place, user: pick.user, index: pick.index, pool: pick.pool });
        renderWinners(place);
      }
      $('drawTitle').textContent = n === 1 ? 'Победитель' : 'Победители';
      $('reel').hidden = true;
      await showPoster();
    } finally {
      state.busy = false;
      $('drawBtn').disabled = false;
      $('drawBtn').textContent = 'Разыграть заново';
    }
  }

  async function reroll(place) {
    if (state.busy) return;
    const w = state.winners.find((x) => x.place === place);
    if (!w) return;
    const pick = pickOne();
    if (!pick) { toast('Больше некого выбрать: все участники уже разыграны'); return; }
    state.busy = true;
    try {
      $('reel').hidden = false;
      $('drawTitle').textContent = 'Перевыбор: ' + place + ' место';
      $('reel').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      await spinTo(pick.user);
      state.log.push({ time: new Date(), action: 'Перевыбор', place, user: pick.user, index: pick.index, pool: pick.pool, replaced: w.user });
      Object.assign(w, pick);
      renderWinners(place);
      $('drawTitle').textContent = state.winners.length === 1 ? 'Победитель' : 'Победители';
      $('reel').hidden = true;
      await renderPoster();
      toast(place + ' место перевыбрано');
    } finally { state.busy = false; }
  }

  // ---------------------------------------------------------------------------
  // Картинка
  // ---------------------------------------------------------------------------
  let templateImg = null;
  let tainted = false;
  function loadImg(src, cors) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      if (cors) i.crossOrigin = 'anonymous';
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('img'));
      i.src = src;
    });
  }
  async function loadPhoto(url) {
    if (!url) return null;
    if (url.startsWith('data:')) return loadImg(url, false);
    try { return await loadImg(url, true); } catch (e) { /* пробуем через прокси */ }
    try { return await loadImg('https://images.weserv.nl/?url=' + encodeURIComponent(url) + '&w=640&h=640&fit=inside', true); } catch (e) { /* дальше без CORS */ }
    try { const i = await loadImg(url, false); tainted = true; return i; } catch (e) { return null; }
  }

  // Квадрат для картинки: та же обрезка, что у аватарки ВК (crop_photo), в долях от оригинала
  function posterPhotoSource(u) {
    const cp = u.crop_photo;
    if (cp && cp.photo && cp.photo.sizes && cp.photo.sizes.length) {
      const best = cp.photo.sizes.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      if (best && best.url && cp.crop && cp.rect) {
        const cw = cp.crop.x2 - cp.crop.x, ch = cp.crop.y2 - cp.crop.y;
        const x0 = cp.crop.x + (cw * cp.rect.x) / 100, x1 = cp.crop.x + (cw * cp.rect.x2) / 100;
        const y0 = cp.crop.y + (ch * cp.rect.y) / 100, y1 = cp.crop.y + (ch * cp.rect.y2) / 100;
        return { url: best.url, frac: { x0: x0 / 100, y0: y0 / 100, x1: x1 / 100, y1: y1 / 100 } };
      }
    }
    return { url: u.photo_200 || u.photo_100, frac: null };
  }

  const photoCache = new Map();
  async function photoFor(u) {
    if (photoCache.has(u.id)) return photoCache.get(u.id);
    const src = posterPhotoSource(u);
    let img = await loadPhoto(src.url);
    let frac = src.frac;
    if (!img && src.url !== u.photo_200) { img = await loadPhoto(u.photo_200); frac = null; }
    const res = img ? { img, frac } : null;
    photoCache.set(u.id, res);
    return res;
  }

  function drawPlaceholder(ctx, s) {
    ctx.fillStyle = '#C1CAD6';
    ctx.fillRect(s.cx - s.r, s.cy - s.r, s.r * 2, s.r * 2);
    ctx.fillStyle = '#F4F6F9';
    ctx.beginPath(); ctx.arc(s.cx, s.cy - s.r * 0.2, s.r * 0.27, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(s.cx, s.cy + s.r * 0.52, s.r * 0.5, s.r * 0.34, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(s.cx - s.r * 0.5, s.cy + s.r * 0.5, s.r, s.r * 0.12);
  }

  function drawPhoto(ctx, s, p) {
    const iw = p.img.naturalWidth || p.img.width, ih = p.img.naturalHeight || p.img.height;
    let sx, sy, sw, sh;
    if (p.frac) {
      sx = p.frac.x0 * iw; sy = p.frac.y0 * ih;
      sw = (p.frac.x1 - p.frac.x0) * iw; sh = (p.frac.y1 - p.frac.y0) * ih;
      const side = Math.min(sw, sh);
      sx += (sw - side) / 2; sy += (sh - side) / 2; sw = sh = side;
    } else {
      const side = Math.min(iw, ih);
      sx = (iw - side) / 2; sy = (ih - side) / 2; sw = sh = side;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(p.img, sx, sy, sw, sh, s.cx - s.r, s.cy - s.r, s.r * 2, s.r * 2);
  }

  function drawName(ctx, text, s) {
    const fam = POSTER.name.font;
    ctx.font = '700 100px ' + fam;
    const m = ctx.measureText('Н');
    const asc = m.actualBoundingBoxAscent || 71;
    let size = (100 * POSTER.name.capHeight) / asc;
    ctx.font = '700 ' + size + 'px ' + fam;
    let w = ctx.measureText(text).width;
    let sx = 1;
    if (w > s.nameMaxW) {
      sx = Math.max(0.84, s.nameMaxW / w);
      if (w * sx > s.nameMaxW) {
        size *= s.nameMaxW / (w * sx);
        ctx.font = '700 ' + size + 'px ' + fam;
      }
    }
    ctx.save();
    ctx.translate(s.nameX, s.nameY);
    ctx.scale(sx, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = POSTER.name.color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  async function renderPoster() {
    const canvas = $('poster');
    const ctx = canvas.getContext('2d');
    if (!templateImg) templateImg = await loadImg(POSTER.template, false);
    const nameText = state.winners.map((w) => fullName(w.user)).join(' ') + ' НАБВ';
    try { await document.fonts.load('700 56px "Roboto Condensed"', nameText); } catch (e) { /* шрифт по умолчанию */ }
    const photos = await Promise.all(POSTER.slots.map((s) => {
      const w = state.winners.find((x) => x.place === s.place);
      return w ? photoFor(w.user) : null;
    }));
    ctx.clearRect(0, 0, POSTER.width, POSTER.height);
    POSTER.slots.forEach((s, i) => {
      ctx.save();
      ctx.beginPath(); ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2); ctx.clip();
      if (photos[i]) drawPhoto(ctx, s, photos[i]); else drawPlaceholder(ctx, s);
      ctx.restore();
    });
    ctx.drawImage(templateImg, 0, 0, POSTER.width, POSTER.height);
    const withSurname = $('surname') && $('surname').checked;
    POSTER.slots.forEach((s) => {
      const w = state.winners.find((x) => x.place === s.place);
      if (w) drawName(ctx, withSurname ? fullName(w.user) : w.user.first_name, s);
    });
    const notes = [];
    if (state.winners.length > 3) notes.push('На картинке три первых места. Полный список копируется кнопкой «Скопировать список».');
    if (tainted) notes.push('ВКонтакте не дал браузеру сохранить фото в файл. Если кнопка «Скачать картинку» не сработает, сделайте скриншот картинки.');
    $('posterNote').textContent = notes.join(' ');
    $('posterNote').hidden = !notes.length;
  }

  async function showPoster() {
    $('posterPanel').hidden = false;
    await renderPoster();
    $('posterPanel').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function canvasBlob() {
    return new Promise((resolve, reject) => {
      try { $('poster').toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png'); } catch (e) { reject(e); }
    });
  }
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  $('downloadBtn').addEventListener('click', async () => {
    try { saveBlob(await canvasBlob(), 'pobediteli.png'); }
    catch (e) { toast('Браузер не дал сохранить картинку. Сделайте скриншот.'); }
  });
  if (navigator.canShare) {
    $('shareBtn').hidden = false;
    $('shareBtn').addEventListener('click', async () => {
      try {
        const file = new File([await canvasBlob()], 'pobediteli.png', { type: 'image/png' });
        if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Победители розыгрыша' });
        else toast('Этот браузер не умеет делиться картинкой. Скачайте её.');
      } catch (e) { if (e && e.name !== 'AbortError') toast('Не получилось поделиться. Скачайте картинку.'); }
    });
  }

  function winnersText() {
    const lines = ['Победители розыгрыша'];
    for (const w of [...state.winners].sort((a, b) => a.place - b.place)) {
      lines.push(w.place + ' место: ' + fullName(w.user) + (state.source.demo ? '' : ', ' + profileUrl(w.user)));
    }
    return lines.join('\n');
  }
  $('copyBtn').addEventListener('click', async () => {
    const text = winnersText();
    try { await navigator.clipboard.writeText(text); toast('Список скопирован'); }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Список скопирован'); } catch (e2) { toast('Не получилось скопировать'); }
      ta.remove();
    }
  });

  function fmtTime(d) { return d.toLocaleString('ru-RU'); }
  $('protocolBtn').addEventListener('click', () => {
    const L = [];
    L.push('Протокол розыгрыша');
    if (state.source.demo) L.push('ТЕСТОВЫЕ ДАННЫЕ, участники выдуманы');
    L.push('Пост: ' + state.postUrl);
    L.push('Проверка участников: ' + fmtTime(state.checkedAt));
    L.push('Условия: ' + (state.conds.join(', ') || 'без условий'));
    L.push('');
    L.push('Этапы проверки:');
    for (const s of state.stages) if (s.value != null) L.push('  ' + s.label + ': ' + s.value);
    L.push('Прошли проверку: ' + state.participants.length);
    L.push('SHA-256 списка id участников (по возрастанию, через запятую): ' + state.listHash);
    L.push('');
    L.push('Выбор победителей: crypto.getRandomValues, равномерный выбор из оставшихся участников');
    for (const e of state.log) {
      let line = '  ' + fmtTime(e.time) + '  ' + e.action + ', ' + e.place + ' место: ' + fullName(e.user) + ' (id' + e.user.id + '), номер ' + (e.index + 1) + ' из ' + e.pool;
      if (e.replaced) line += ', вместо ' + fullName(e.replaced) + ' (id' + e.replaced.id + ')';
      L.push(line);
    }
    L.push('');
    L.push('Итог:');
    for (const w of [...state.winners].sort((a, b) => a.place - b.place)) L.push('  ' + w.place + ' место: ' + fullName(w.user) + ', ' + profileUrl(w.user));
    L.push('');
    L.push('Участники, прошедшие проверку (' + state.participants.length + '):');
    state.participants.forEach((u, i) => L.push('  ' + (i + 1) + '. ' + fullName(u) + ', id' + u.id));
    saveBlob(new Blob([L.join('\n')], { type: 'text/plain;charset=utf-8' }), 'protokol-rozygrysha.txt');
  });

  // Фамилия на картинке
  (function addSurnameToggle() {
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = '<input type="checkbox" id="surname"> Писать на картинке имя и фамилию';
    $('posterNote').before(label);
    label.querySelector('input').addEventListener('change', () => { if (state.winners.length) renderPoster(); });
  })();

  // ---------------------------------------------------------------------------
  // Кнопки
  // ---------------------------------------------------------------------------
  $('setup').addEventListener('submit', (e) => { e.preventDefault(); runCheck(vkSource); });
  $('demoBtn').addEventListener('click', () => {
    openTokenPanel(false);
    if (!$('postUrl').value.trim()) $('postUrl').value = 'https://vk.com/wall-215596190_1837';
    runCheck(demoSource);
  });
  $('drawBtn').addEventListener('click', drawAll);
  $('postUrl').addEventListener('input', () => { $('postErr').hidden = true; });

  // Ссылку на пост можно передать в адресе: ?post=https://vk.com/wall-1_2
  const qp = new URLSearchParams(location.search).get('post');
  if (qp) $('postUrl').value = qp;
})();
