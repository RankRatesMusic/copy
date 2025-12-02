/* script.js - Supabase-powered music client
   - Uses Supabase Auth, Storage, and Database (songs, albums, likes, recently_played, playlists)
   - Streams audio from Supabase Storage public URLs
   - Keeps original UI & modal IDs so index.html required no changes
*/

/* ---------------------------
   Supabase init (YOUR CREDENTIALS)
   --------------------------- */
const SUPABASE_URL = "https://iznszelaskspyodibcyv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml6bnN6ZWxhc2tzcHlvZGliY3l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ2NTAwNjIsImV4cCI6MjA4MDIyNjA2Mn0.m0T5nZZbqpFKRB5uM7f-4nvXGeurAcEg0-37d_SODRM";

const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------------------------
   Utilities
   --------------------------- */
function $(sel, root=document) { return root.querySelector(sel); }
function $all(sel, root=document) { return Array.from(root.querySelectorAll(sel)); }
function uid(prefix='id') { return prefix + '_' + Math.random().toString(36).slice(2,9); }
function toast(msg, t=2500) { const el = $('#toast'); if (!el) return; el.textContent = msg; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'), t); }
function escapeHtml(s) { return (s||'').replace(/[&<>"']/g, (m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ---------------------------
   App state
   --------------------------- */
const state = {
  user: null, // supabase auth user object
  songs: [],  // fetched from DB
  albums: [], // fetched from DB
  playlists: [],
  likesMap: {}, // songId -> boolean (for current user)
  recentlyPlayed: [], // array of song ids for current user
  player: {
    audioEl: null,
    queue: [],
    index: 0,
    playing: false,
    currentSongId: null,
    seekUpdating: false
  },
  route: 'home',
  routeParam: null
};

/* ---------------------------
   Helpers: DB fetchers
   --------------------------- */
async function fetchAlbums() {
  const { data, error } = await supabase.from('albums').select('*').order('title', { ascending: true });
  if (error) { console.error('fetchAlbums', error); return []; }
  return data || [];
}

async function fetchSongs() {
  const { data, error } = await supabase.from('songs').select('*').order('created_at', { ascending: false });
  if (error) { console.error('fetchSongs', error); return []; }
  return data || [];
}

async function fetchLikesForUser() {
  if (!state.user) return {};
  const { data, error } = await supabase.from('likes').select('song_id').eq('user_id', state.user.id);
  if (error) { console.error('fetchLikes', error); return {}; }
  const map = {};
  (data||[]).forEach(r => map[r.song_id] = true);
  return map;
}

async function fetchRecentlyPlayedForUser() {
  if (!state.user) return [];
  const { data, error } = await supabase.from('recently_played').select('song_id').eq('user_id', state.user.id).order('played_at', { ascending: false }).limit(50);
  if (error) { console.error('fetchRecentlyPlayed', error); return []; }
  return (data||[]).map(r=>r.song_id);
}

/* ---------------------------
   Storage upload helpers
   --------------------------- */
async function uploadToStorage(bucket, file) {
  const filePath = `${Date.now()}_${file.name.replace(/\s+/g,'_')}`;
  const { error } = await supabase.storage.from(bucket).upload(filePath, file, { cacheControl: '3600', upsert: false });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data.publicUrl;
}

/* ---------------------------
   Insert album & song rows
   --------------------------- */
async function ensureAlbumRow(title, artist, coverUrl) {
  // find album by title+artist
  const { data: found } = await supabase.from('albums').select('*').eq('title', title).eq('artist', artist).limit(1);
  if (found && found.length > 0) return found[0].id;
  const { data: inserted, error } = await supabase.from('albums').insert({ title, artist, year: (new Date()).getFullYear(), cover_url: coverUrl }).select().single();
  if (error) throw error;
  return inserted.id;
}

async function insertSongRow({ title, artist, albumId, duration, audioUrl, coverUrl, genre, language, explicit }) {
  const { data, error } = await supabase.from('songs').insert({
    title, artist, album_id: albumId, duration, audio_url: audioUrl, cover_url: coverUrl, genre, language, explicit
  }).select().single();
  if (error) throw error;
  return data;
}

/* ---------------------------
   Like / Unlike
   --------------------------- */
async function toggleLike(songId) {
  if (!state.user) { toast('Sign in to like'); return; }
  const liked = !!state.likesMap[songId];
  if (liked) {
    const { error } = await supabase.from('likes').delete().match({ user_id: state.user.id, song_id: songId });
    if (error) console.error('unlike', error);
    delete state.likesMap[songId];
    $('#likeBtn').textContent = '♡';
  } else {
    const { error } = await supabase.from('likes').insert({ user_id: state.user.id, song_id: songId });
    if (error) console.error('like', error);
    state.likesMap[songId] = true;
    $('#likeBtn').textContent = '♥';
  }
}

/* ---------------------------
   Recently played recording
   --------------------------- */
async function recordRecentlyPlayed(songId) {
  if (!state.user) return;
  try {
    await supabase.from('recently_played').insert({ user_id: state.user.id, song_id: songId });
  } catch(e) { console.error('recordRecentlyPlayed', e); }
}

/* ---------------------------
   Player engine (keeps your UI controls)
   --------------------------- */
function initPlayer() {
  const audio = $('#audio');
  if (!audio) return;
  state.player.audioEl = audio;

  audio.addEventListener('timeupdate', ()=> {
    try {
      const s = state.player;
      if (!s.currentSongId) return;
      const ct = audio.currentTime || 0;
      const dur = audio.duration || 0;
      const p = $('#seek'); if (p && !s.seekUpdating) p.value = dur ? (ct/dur*100) : 0;
      const cur = $('#currentTime'); const durEl = $('#duration');
      if (cur) cur.textContent = formatTime(ct);
      if (durEl) durEl.textContent = formatTime(dur);
      const fsSeek = $('#fsSeek'); if (fsSeek && !s.seekUpdating) fsSeek.value = dur ? (ct/dur*100) : 0;
    } catch(e) { console.error(e); }
  });

  audio.addEventListener('ended', ()=> playNext());

  $('#playPauseBtn')?.addEventListener('click', togglePlay);
  $('#prevBtn')?.addEventListener('click', playPrev);
  $('#nextBtn')?.addEventListener('click', playNext);
  $('#seek')?.addEventListener('input', (e)=> {
    state.player.seekUpdating = true;
    const v = Number(e.target.value);
    const audio = state.player.audioEl;
    if (audio.duration) audio.currentTime = audio.duration * v / 100;
    setTimeout(()=> state.player.seekUpdating = false, 300);
  });
  $('#volume')?.addEventListener('input', (e)=> { audio.volume = Number(e.target.value); });

  $('#expandBtn')?.addEventListener('click', ()=> $('#fullscreenModal').classList.remove('hidden'));
  $('#fsClose')?.addEventListener('click', ()=> $('#fullscreenModal').classList.add('hidden'));
  $('#fsPlay')?.addEventListener('click', togglePlay);
  $('#fsPrev')?.addEventListener('click', playPrev);
  $('#fsNext')?.addEventListener('click', playNext);
  $('#fsSeek')?.addEventListener('input', (e)=> {
    const v = Number(e.target.value);
    if (audio.duration) audio.currentTime = audio.duration * v / 100;
  });

  $('#queueBtn')?.addEventListener('click', ()=> openQueuePanel());
  $('#likeBtn')?.addEventListener('click', ()=> {
    const sid = state.player.currentSongId;
    if (!sid) return;
    toggleLike(sid);
  });
}

/* Playback controls using DB records */
async function playSong(songId, contextQueue=null) {
  const audio = state.player.audioEl;
  const song = state.songs.find(s=>s.id===songId);
  if (!song) { toast('Song not found'); return; }
  try {
    if (!song.audio_url) { toast('No audio URL'); return; }
    audio.src = song.audio_url;
    await audio.play();
    state.player.playing = true;
    state.player.currentSongId = songId;
    if (contextQueue && Array.isArray(contextQueue)) state.player.queue = contextQueue;
    state.player.index = state.player.queue.indexOf(songId) >= 0 ? state.player.queue.indexOf(songId) : 0;
    updatePlayerUI(song);
    // record recently played
    if (state.user) {
      await recordRecentlyPlayed(songId);
      state.recentlyPlayed = await fetchRecentlyPlayedForUser();
    }
  } catch (e) { console.error(e); toast('Playback error'); }
}

function updatePlayerUI(song) {
  const coverEl = $('#playerCover'); const title = $('#playerTitle'); const artist = $('#playerArtist');
  const fsCover = $('#fsCover'); const fsTitle = $('#fsTitle'); const fsArtist = $('#fsArtist'); const fsAlbum = $('#fsAlbum');
  const fsExplicit = $('#fsExplicit'); const fsLang = $('#fsLanguage'); const fsGenre = $('#fsGenre');
  if (coverEl) coverEl.src = song.cover_url || '';
  if (title) title.textContent = song.title;
  if (artist) artist.textContent = song.artist;
  if (fsCover) fsCover.src = song.cover_url || '';
  if (fsTitle) fsTitle.textContent = song.title;
  if (fsArtist) fsArtist.textContent = song.artist;
  if (fsAlbum) fsAlbum.textContent = state.albums.find(a=>a.id===song.album_id)?.title || '';
  if (fsExplicit) { if (song.explicit) fsExplicit.classList.remove('hidden'); else fsExplicit.classList.add('hidden'); }
  if (fsLang) { fsLang.textContent = song.language || ''; fsLang.classList.toggle('hidden', !song.language); }
  if (fsGenre) { fsGenre.textContent = song.genre || ''; fsGenre.classList.toggle('hidden', !song.genre); }
  $('#playPauseBtn').textContent = '⏸';
  $('#fsPlay').textContent = '⏸';
}

function togglePlay() {
  const a = state.player.audioEl; if (!a) return;
  if (a.paused) { a.play(); state.player.playing = true; $('#playPauseBtn').textContent='⏸'; $('#fsPlay').textContent='⏸'; }
  else { a.pause(); state.player.playing = false; $('#playPauseBtn').textContent='▶'; $('#fsPlay').textContent='▶'; }
}

function playNext() {
  const q = state.player.queue || [];
  let idx = state.player.index;
  if (q.length === 0) return;
  idx = (idx + 1) % q.length;
  state.player.index = idx;
  playSong(q[idx], q);
}

function playPrev() {
  const q = state.player.queue || [];
  let idx = state.player.index;
  if (q.length === 0) return;
  idx = (idx - 1 + q.length) % q.length;
  state.player.index = idx;
  playSong(q[idx], q);
}

/* ---------------------------
   Queue panel simple UI
   --------------------------- */
function openQueuePanel() {
  const q = state.player.queue || [];
  const root = document.createElement('div');
  root.style.position='fixed'; root.style.right='12px'; root.style.bottom='120px'; root.style.background='#111';
  root.style.padding='12px'; root.style.borderRadius='8px'; root.style.maxHeight='300px'; root.style.overflow='auto'; root.style.zIndex=999;
  root.innerHTML = `<b>Queue</b><div></div><button id="closeQueue">Close</button>`;
  const listEl = root.querySelector('div');
  q.forEach((sid, i)=> {
    const s = state.songs.find(x=>x.id===sid);
    const el = document.createElement('div');
    el.textContent = `${i+1}. ${s ? s.title : sid}`;
    el.style.padding='6px';
    el.addEventListener('click', ()=> { state.player.index=i; playSong(sid,q); document.body.removeChild(root); });
    listEl.appendChild(el);
  });
  root.querySelector('#closeQueue').addEventListener('click', ()=> document.body.removeChild(root));
  document.body.appendChild(root);
}

/* ---------------------------
   Format time
   --------------------------- */
function formatTime(sec) {
  if (!isFinite(sec) || sec<=0) return '0:00';
  const s = Math.floor(sec%60); const m = Math.floor(sec/60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}

/* ---------------------------
   Upload flow (uses your upload modal & form)
   --------------------------- */
function wireUploadModal() {
  const form = $('#uploadForm');
  if (!form) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const audioFile = $('#audioFile')?.files[0];
    const coverFile = $('#coverFile')?.files[0];
    if (!audioFile || !coverFile) { toast('Select files'); return; }

    // validate cover size
    const img = await fileToImage(coverFile);
    if (img.width < 1000 || img.height < 1000) { toast('Cover too small (min 1000x1000)'); return; }

    const title = $('#metaTitle').value.trim() || audioFile.name;
    // artist selection: prefer signed-in user's profile username if present
    let artist = $('#metaArtist').value;
    if (state.user) {
      // try profile
      try {
        const { data: profile } = await supabase.from('profiles').select('username, display_name').eq('id', state.user.id).single();
        if (profile && profile.username) artist = profile.username;
      } catch(e) { /* ignore */ }
      // fallback to email
      if (!artist && state.user.email) artist = state.user.email;
    }
    if (!artist) artist = $('#metaArtist').value || 'Unknown';

    const albumName = $('#metaAlbum').value.trim() || 'Single';
    const genre = $('#metaGenre').value;
    const lang = $('#metaLang').value;
    const explicit = !!$('#metaExplicit').checked;

    try {
      toast('Uploading files...');

      // upload files to storage
      const audioUrl = await uploadToStorage('audio', audioFile);
      const coverUrl = await uploadToStorage('covers', coverFile);

      // ensure album row
      const albumId = await ensureAlbumRow(albumName, artist, coverUrl);

      // insert song
      const duration = Math.round(audioFile.size / 100000) || 120;
      const song = await insertSongRow({
        title, artist, albumId, duration, audioUrl, coverUrl, genre, language: lang, explicit
      });

      // refresh state
      await refreshAllData();

      toast('Upload completed');
      $('#uploadModal').classList.add('hidden');
      renderMainRoute();
    } catch (err) {
      console.error(err);
      toast('Upload failed');
    }
  };
}

/* small helper: file -> Image object */
function fileToImage(file) {
  return new Promise((res, rej)=> {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = ()=> { URL.revokeObjectURL(url); res(img); };
    img.onerror = (e)=> rej(e);
    img.src = url;
  });
}

/* ---------------------------
   Rendering & Navigation (keeps your original UI)
   --------------------------- */
function render() {
  // attach global nav
  $all('.nav-btn').forEach(btn=>{
    if (btn.dataset._nav) return;
    btn.dataset._nav = '1';
    btn.addEventListener('click', ()=> {
      const route = btn.getAttribute('data-route');
      navigate(route);
    });
  });
  $('#globalSearchInput')?.addEventListener('input', (e)=> { navigate('search', e.target.value); });

  renderAuthArea();
  renderUserMini();
  renderMainRoute();
}

function navigate(route, param=null) {
  state.route = route;
  state.routeParam = param;
  renderMainRoute();
}

function renderMainRoute() {
  const area = $('#contentArea'); if (!area) return;
  try {
    if (state.route === 'home') renderHome();
    else if (state.route === 'search') renderSearchPage(state.routeParam || '');
    else if (state.route === 'library') renderLibrary();
    else if (state.route === 'playlists') renderPlaylists();
    else if (state.route === 'liked') renderLiked();
    else if (state.route === 'upload') $('#uploadModal').classList.remove('hidden');
    else renderHome();
  } catch (e) { console.error(e); area.innerHTML = '<p>Error rendering</p>'; }
  $('#breadcrumbs').textContent = state.route.charAt(0).toUpperCase() + state.route.slice(1);
}

/* Home */
function renderHome() {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = '';
  const section = document.createElement('div');
  section.innerHTML = `<h2>Recently Played</h2>`;
  const recentDiv = document.createElement('div'); recentDiv.className='grid';
  (state.recentlyPlayed || []).slice(0,8).forEach(sid=>{
    const s = state.songs.find(x=>x.id===sid);
    if (!s) return;
    const card = createSongCard(s);
    recentDiv.appendChild(card);
  });
  section.appendChild(recentDiv);

  // daily mixes - use first songs
  const mixes = document.createElement('div'); mixes.innerHTML = `<h2>Daily Mixes</h2>`;
  const mixGrid = document.createElement('div'); mixGrid.className='grid';
  for (let i=0;i<4;i++){
    const card = document.createElement('div'); card.className='card';
    const img = document.createElement('img'); img.alt='mix';
    const someSong = state.songs[i % Math.max(1, state.songs.length)];
    if (someSong) img.src = someSong.cover_url || '';
    const t = document.createElement('div'); t.textContent = `Daily Mix ${i+1}`;
    card.appendChild(img); card.appendChild(t);
    card.addEventListener('click', ()=> {
      const q = state.songs.map(s=>s.id);
      if (q.length) playSong(q[i%q.length], q);
    });
    mixGrid.appendChild(card);
  }
  mixes.appendChild(mixGrid);

  // recommended songs
  const rec = document.createElement('div'); rec.innerHTML = `<h2>Recommended</h2>`;
  const recGrid = document.createElement('div'); recGrid.className='grid';
  (state.songs.slice(0,8) || []).forEach(s=>{
    const c = createSongCard(s);
    recGrid.appendChild(c);
  });
  rec.appendChild(recGrid);

  area.appendChild(section); area.appendChild(mixes); area.appendChild(rec);
}

/* Search */
function renderSearchPage(query='') {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = `<h2>Search</h2>`;
  const input = document.createElement('input'); input.placeholder='Search...'; input.value = query || '';
  input.style.width='100%'; input.style.marginBottom='12px';
  input.addEventListener('input', ()=> renderSearchResults(input.value));
  area.appendChild(input);
  const results = document.createElement('div'); results.id='searchResults'; area.appendChild(results);
  renderSearchResults(query);
}
function renderSearchResults(q) {
  const root = $('#searchResults'); if (!root) return;
  const qq = (q||'').toLowerCase();
  root.innerHTML = '';
  const songs = state.songs.filter(s=> (s.title||'').toLowerCase().includes(qq) || (s.artist||'').toLowerCase().includes(qq) || (s.genre||'').toLowerCase().includes(qq));
  if (songs.length === 0) { root.innerHTML = '<p>No results</p>'; return; }
  const grid = document.createElement('div'); grid.className='grid';
  songs.forEach(s=> grid.appendChild(createSongCard(s)));
  root.appendChild(grid);
}

/* Library */
function renderLibrary() {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = '<h2>Your Library</h2>';
  const grid = document.createElement('div'); grid.className='grid';
  (state.albums || []).forEach(a=>{
    const card = document.createElement('div'); card.className='card';
    const img = document.createElement('img'); img.alt='album';
    img.src = a.cover_url || '';
    const t = document.createElement('div'); t.textContent = a.title;
    card.appendChild(img); card.appendChild(t);
    card.addEventListener('click', ()=> renderAlbum(a.id));
    grid.appendChild(card);
  });
  area.appendChild(grid);
}

/* Playlists view (simple local view stored in DB optional) */
function renderPlaylists() {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = '<h2>Playlists</h2>';
  const newBtn = document.createElement('button'); newBtn.textContent='New Playlist';
  newBtn.addEventListener('click', ()=> {
    if (!state.user) { toast('Login to create'); return; }
    const name = prompt('Playlist name'); if (!name) return;
    createPlaylistDB(name);
  });
  area.appendChild(newBtn);
  // For simplicity, show user's playlists if implemented
  const list = document.createElement('div');
  area.appendChild(list);
  list.innerHTML = '<p>Playlists will appear here (coming soon)</p>';
}

/* Liked songs */
function renderLiked() {
  const area = $('#contentArea'); if (!area) return;
  if (!state.user) { area.innerHTML = '<p>Login to see liked songs</p>'; return; }
  // fetch liked songs for user
  (async ()=> {
    const { data } = await supabase
      .from('likes')
      .select('song_id')
      .eq('user_id', state.user.id);
    const likedIds = (data||[]).map(r=>r.song_id);
    const likedSongs = state.songs.filter(s=> likedIds.includes(s.id));
    area.innerHTML = '<h2>Liked Songs</h2>';
    const g = document.createElement('div'); g.className='grid';
    likedSongs.forEach(s=> g.appendChild(createSongCard(s)));
    area.appendChild(g);
  })();
}

/* Artist page */
function renderArtist(username) {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = `<h2>${escapeHtml(username)}</h2>`;
  const top = state.songs.filter(s=>s.artist===username).slice(0,8);
  const g = document.createElement('div'); g.className='grid';
  top.forEach(s=> g.appendChild(createSongCard(s)));
  area.appendChild(document.createElement('h3')).textContent = 'Top tracks';
  area.appendChild(g);
}

/* Album page */
function renderAlbum(id) {
  const a = state.albums.find(x=>x.id===id);
  const area = $('#contentArea'); if (!area) return;
  if (!a) { area.innerHTML = '<p>Album missing</p>'; return; }
  area.innerHTML = `<h2>${escapeHtml(a.title)}</h2>`;
  const img = document.createElement('img'); img.style.width='240px'; img.style.height='240px';
  img.src = a.cover_url || '';
  area.appendChild(img);
  const t = document.createElement('div'); t.textContent = `By ${a.artist} — ${a.year}`; area.appendChild(t);
  const list = document.createElement('div');
  const albumSongs = state.songs.filter(s=>s.album_id === a.id);
  albumSongs.forEach(s=>{
    const row = document.createElement('div'); row.style.display='flex'; row.style.gap='12px';
    row.innerHTML = `<div style="flex:1">${s.title}</div><div><button>Play</button></div>`;
    row.querySelector('button').addEventListener('click', ()=> playSong(s.id, albumSongs.map(x=>x.id)));
    list.appendChild(row);
  });
  area.appendChild(list);
}

/* Profile */
function renderProfile(username) {
  const area = $('#contentArea'); if (!area) return;
  area.innerHTML = `<h2>${escapeHtml(username)}</h2><p>Profile page coming soon.</p>`;
}

/* Small UI helpers */
function createSongCard(s) {
  const card = document.createElement('div'); card.className='card';
  const img = document.createElement('img'); img.alt='cover'; img.className='card-cover';
  img.src = s.cover_url || '';
  const t = document.createElement('div'); t.textContent = s.title;
  const a = document.createElement('small'); a.textContent = s.artist;
  card.appendChild(img); card.appendChild(t); card.appendChild(a);
  card.addEventListener('dblclick', ()=> {
    const q = state.songs.map(x=>x.id);
    playSong(s.id, q);
  });
  return card;
}

/* ---------------------------
   Auth UI & flows (Supabase)
   --------------------------- */
function renderAuthArea() {
  const area = $('#authArea'); if (!area) return;
  area.innerHTML = '';
  if (!state.user) {
    const loginBtn = document.createElement('button'); loginBtn.textContent='Sign in';
    const signupBtn = document.createElement('button'); signupBtn.textContent='Sign up';
    loginBtn.addEventListener('click', ()=> openAuthModal('in'));
    signupBtn.addEventListener('click', ()=> openAuthModal('up'));
    area.appendChild(loginBtn); area.appendChild(signupBtn);
  } else {
    const el = document.createElement('div'); el.textContent = state.user.email || state.user.id;
    const logout = document.createElement('button'); logout.textContent='Logout';
    logout.addEventListener('click', async ()=> { await supabase.auth.signOut(); toast('Signed out'); /* session listener handles rest */ });
    el.style.display='inline-block'; el.style.marginRight='8px';
    area.appendChild(el); area.appendChild(logout);
  }
}

function renderUserMini() {
  const el = $('#userMini'); if (!el) return;
  if (!state.user) el.textContent = 'Not signed in';
  else el.textContent = state.user.email || state.user.id;
}

function openAuthModal(mode='in') {
  const modal = document.createElement('div'); modal.className='modal';
  modal.innerHTML = `<div class="modal-inner"><h3>${mode==='in'?'Sign in':'Sign up'}</h3>
    <label>Email: <input id="authEmail" /></label>
    <label>Password: <input id="authPass" type="password"/></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button id="authCancel">Cancel</button><button id="authSubmit">${mode==='in'?'Sign in':'Create'}</button></div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('#authCancel').addEventListener('click', ()=> document.body.removeChild(modal));
  modal.querySelector('#authSubmit').addEventListener('click', async ()=> {
    const email = modal.querySelector('#authEmail').value;
    const pass = modal.querySelector('#authPass').value;
    try {
      if (mode === 'in') {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        toast('Signed in');
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password: pass });
        if (error) throw error;
        toast('Signup successful — check your email if confirmation required');
      }
      document.body.removeChild(modal);
    } catch (e) {
      console.error(e);
      alert(e.message || 'Auth error');
    }
  });
}

async function handleAuthChange() {
  const { data: { user } } = await supabase.auth.getUser();
  state.user = user;
  // load user-related data
  state.likesMap = await fetchLikesForUser();
  state.recentlyPlayed = await fetchRecentlyPlayedForUser();
  renderAuthArea();
  renderUserMini();
  // repopulate artist select (upload modal)
  populateArtistSelect();
}

/* ---------------------------
   Upload modal helpers (artist select)
   --------------------------- */
function populateArtistSelect() {
  const sel = $('#metaArtist');
  if (!sel) return;
  sel.innerHTML = '';
  // populate with distinct artists from songs and albums
  const artists = new Set();
  state.songs.forEach(s=> { if (s.artist) artists.add(s.artist); });
  state.albums.forEach(a=> { if (a.artist) artists.add(a.artist); });
  // if user signed in, prefer their email or profile username
  if (state.user) {
    // try profile username
    (async ()=> {
      try {
        const { data } = await supabase.from('profiles').select('username, display_name').eq('id', state.user.id).limit(1);
        if (data && data.length>0) {
          const p = data[0];
          if (p.username) artists.add(p.username);
          sel.prepend(Object.assign(document.createElement('option'), { value: p.username, textContent: p.display_name || p.username }));
        } else if (state.user.email) {
          artists.add(state.user.email);
          sel.prepend(Object.assign(document.createElement('option'), { value: state.user.email, textContent: state.user.email }));
        }
      } catch(e) { console.warn('populateArtistSelect profile', e); }
    })();
  }
  Array.from(artists).forEach(a=> {
    const opt = document.createElement('option'); opt.value = a; opt.textContent = a;
    sel.appendChild(opt);
  });
}

/* ---------------------------
   Misc helpers (playlists placeholder)
   --------------------------- */
async function createPlaylistDB(name) {
  if (!state.user) { toast('Sign in'); return; }
  const { error } = await supabase.from('playlists').insert({ owner_id: state.user.id, name });
  if (error) { console.error('createPlaylist', error); toast('Failed'); return; }
  toast('Playlist created');
}

/* ---------------------------
   Init & bootstrap
   --------------------------- */
async function refreshAllData() {
  state.albums = await fetchAlbums();
  state.songs = await fetchSongs();
  state.likesMap = await fetchLikesForUser();
  state.recentlyPlayed = await fetchRecentlyPlayedForUser();
  populateArtistSelect();
}

async function bootstrap() {
  try {
    // auth listener
    supabase.auth.onAuthStateChange((event, session) => {
      (async ()=> {
        const { data: { user } } = await supabase.auth.getUser();
        state.user = user;
        state.likesMap = await fetchLikesForUser();
        state.recentlyPlayed = await fetchRecentlyPlayedForUser();
        renderAuthArea(); renderUserMini(); populateArtistSelect();
      })();
    });

    initPlayer();
    wireUploadModal();

    // wire upload/Open controls
    $('#uploadClose')?.addEventListener('click', ()=> $('#uploadModal').classList.add('hidden'));
    $('#uploadModal')?.addEventListener('click', (e)=> { if (e.target === $('#uploadModal')) $('#uploadModal').classList.add('hidden'); });
    $('#uploadModal') && $('#uploadModal').classList.add('hidden');
    $all('.nav-btn').forEach(b=> { if (b.dataset.route==='upload') b.addEventListener('click', ()=> $('#uploadModal').classList.remove('hidden')); });

    // fetch data from Supabase
    await refreshAllData();

    // initial auth state
    const { data: { user } } = await supabase.auth.getUser();
    state.user = user;
    if (state.user) {
      state.likesMap = await fetchLikesForUser();
      state.recentlyPlayed = await fetchRecentlyPlayedForUser();
    }

    render();
  } catch (e) {
    console.error('Bootstrap failed', e);
  }
}

bootstrap();
