// ===== DOM References =====
const display = document.getElementById('display');
const modes = [
    document.getElementById('mode-0'),
    document.getElementById('mode-1'),
    document.getElementById('mode-2'),
    document.getElementById('mode-3'),
];

// ===== Navigation =====
let currentMode = 0;

function setMode(n) {
    currentMode = n;
    modes.forEach((el, i) => {
        el.classList.toggle('hidden', i !== n);
    });
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', Number(btn.dataset.mode) === n);
    });
    if (n === 2) renderSongHome();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(Number(btn.dataset.mode)));
});

setMode(0);

// ===== Tools =====
const roundFile = document.getElementById('roundFile');
const convert   = document.getElementById('convert');
const maxSize   = document.getElementById('maxSize');
const inputFile = document.getElementById('input');
const ta        = document.getElementById('ta');

convert.addEventListener('click', () => {
    if (roundFile.files.length === 0) return;
    const fr = new FileReader();
    fr.addEventListener('load', () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([fr.result.replace(/(?<=stroke-linejoin=").*?(?=")/g, 'round')], { type: 'image/svg+xml' }));
        a.download = roundFile.files[0].name;
        a.click();
    });
    fr.readAsText(roundFile.files[0]);
});

const video = document.createElement('video');
const mycanvas = document.createElement('canvas');
inputFile.addEventListener('change', () => {
    video.src = URL.createObjectURL(new Blob([inputFile.files[0]], { type: 'video/mp4' }));
    video.addEventListener('loadeddata', () => {
        const size = Number(maxSize.value);
        if (video.videoHeight < video.videoWidth) {
            mycanvas.width = size;
            mycanvas.height = video.videoHeight * size / video.videoWidth;
        } else {
            mycanvas.width = video.videoWidth * size / video.videoHeight;
            mycanvas.height = size;
        }
        const ctx = mycanvas.getContext('2d');
        let text = `${mycanvas.width}/${mycanvas.height}/`;
        ta.value = '変換中...';
        const func = () => {
            ctx.drawImage(video, 0, 0, mycanvas.width, mycanvas.height);
            const imgData = ctx.getImageData(0, 0, mycanvas.width, mycanvas.height).data;
            for (let i = 0; i < imgData.length; i += 4) {
                text += imgData[i].toString(16).padStart(2, '0')
                      + imgData[i + 1].toString(16).padStart(2, '0')
                      + imgData[i + 2].toString(16).padStart(2, '0');
            }
            if (!video.paused) setTimeout(func, 1000 / 15);
            else ta.value = text;
        };
        video.play();
        func();
    }, { once: true });
});

// ===== Work Search (data.js) =====
const sInp = document.getElementById('sInp');
const searchContent = document.getElementById('searchContent');

function searchResult(word) {
    setMode(3);
    searchContent.textContent = '';
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const date  = String(today.getDate()).padStart(2, '0');
    const list  = [];
    for (let i = 0; i < data.length; i++) {
        if (
            word === '全て' ||
            (!word.endsWith('年前') && data[i].title.includes(word)) ||
            (word.endsWith('年前') && data[i].history?.shared?.includes(
                `${today.getFullYear() - Number(word[0])}-${month}-${date}`
            ))
        ) list.push(i);
    }
    list.sort((a, b) => (data[b].stats?.views || 0) - (data[a].stats?.views || 0));
    list.forEach(i => {
        const card = document.createElement('div');
        card.className = 'work-card';
        card.innerHTML = `
            <img src="https://uploads.scratch.mit.edu/get_image/project/${data[i].id}_408x306.png" alt="${data[i].title}" loading="lazy">
            <div class="work-card-title">${data[i].title}</div>
        `;
        card.addEventListener('click', () => window.open(`https://scratch.mit.edu/projects/${data[i].id}/`, '_blank'));
        searchContent.appendChild(card);
    });
    if (list.length === 0) {
        searchContent.innerHTML = '<p class="col-span-4 text-center text-gray-400 py-8">作品が見つかりませんでした</p>';
    }
}

sInp.addEventListener('keydown', e => { if (e.key === 'Enter' && sInp.value) searchResult(sInp.value); });

// ===== Songs (data2.js: songs / VOCALS) =====

// ===== Songs: State =====
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let previousSongView = 'home';

function showSongView(view) {
    document.getElementById('song-view-home').classList.toggle('hidden', view !== 'home');
    document.getElementById('song-view-detail').classList.toggle('hidden', view !== 'detail');
    document.getElementById('song-view-results').classList.toggle('hidden', view !== 'results');
    document.getElementById('song-view-vocal').classList.toggle('hidden', view !== 'vocal');
}

// ===== Song Search UI State =====
// Fix #5: デフォルトは全部OFF（ボーカル制約なし）+ 部分一致
let vocalFilterState = [false, false, false, false];
let matchMode = 'partial';

// ボーカルフィルターボタン初期化（全OFF）
document.querySelectorAll('.vocal-filter-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.addEventListener('click', () => {
        const i = Number(btn.dataset.vocal);
        vocalFilterState[i] = !vocalFilterState[i];
        btn.classList.toggle('active', vocalFilterState[i]);
    });
});

// マッチモード切替
document.querySelectorAll('.match-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        matchMode = btn.dataset.match;
        document.querySelectorAll('.match-btn').forEach(b =>
            b.classList.toggle('active', b.dataset.match === matchMode)
        );
    });
});

// 検索ボタン
document.getElementById('songSearchBtn').addEventListener('click', () => {
    const word     = document.getElementById('songSearch').value.trim();
    const cbTitle  = document.getElementById('cbTitle').checked;
    const cbLyrics = document.getElementById('cbLyrics').checked;
    doSongSearch(word, cbTitle, cbLyrics);
});
document.getElementById('songSearch').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('songSearchBtn').click();
});

// Fix #5: ボーカルマッチロジック
// - 全OFF → 制約なし（全曲）
// - 部分一致 → 選択ボーカルが少なくとも1人含まれる曲
// - 完全一致 → 曲のvocals配列が選択状態と完全に一致
function vocalMatchSong(song) {
    const anySelected = vocalFilterState.some(v => v);
    if (!anySelected) return true;

    if (matchMode === 'partial') {
        return vocalFilterState.some((selected, i) => selected && song.vocals[i]);
    } else {
        return vocalFilterState.every((selected, i) => selected === song.vocals[i]);
    }
}

function doSongSearch(word, cbTitle, cbLyrics) {
    const results = songs.filter(song => {
        if (!vocalMatchSong(song)) return false;
        if (!word) return true;
        let matched = false;
        if (cbTitle  && song.title  && song.title.includes(word))  matched = true;
        if (cbLyrics && song.lyrics && song.lyrics.includes(word)) matched = true;
        return matched;
    });

    renderSearchResults(results);
    showSongView('results');
    document.getElementById('resultCount').textContent = `${results.length} 曲ヒット`;
}

function renderSearchResults(results) {
    const container = document.getElementById('songResults');
    container.innerHTML = '';
    if (results.length === 0) {
        container.innerHTML = '<p class="col-span-3 text-center text-gray-400 py-12">曲が見つかりませんでした</p>';
        return;
    }
    results.forEach(song => container.appendChild(createSongCard(song)));
}

// ===== Song Home =====
function renderSongHome() {
    renderCalendar();
    renderSongList();
    showSongView('home');
}

// ===== Helpers =====
function getYoutubeVideoId(url) {
    if (!url) return null;
    const m = url.match(/embed\/([^?&]+)/);
    return m ? m[1] : null;
}

function youtubeThumbnail(url) {
    const id = getYoutubeVideoId(url);
    return id ? `https://img.youtube.com/vi/${id}/sddefault.jpg` : null;
}

// ===== Song List (Fix #4: サムネイル + 大きめボーカルアイコン) =====
function renderSongList() {
    const container = document.getElementById('songList');
    container.innerHTML = '';
    songs.forEach((song, idx) => {
        const item = document.createElement('div');
        item.className = 'song-list-item';
        const thumb = youtubeThumbnail(song.youtubeUrl);
        const vocalIcons = song.vocals.map((v, i) => v
            ? `<img src="${VOCALS[i].icon}" title="${VOCALS[i].name}" class="w-7 h-7 rounded-full object-cover border-2 border-white/70 shadow-sm">`
            : ''
        ).join('');
        item.innerHTML = `
            ${thumb
                ? `<img src="${thumb}" alt="${song.title}" class="w-14 h-10 rounded-lg object-cover flex-shrink-0 shadow-sm">`
                : `<div class="w-14 h-10 rounded-lg bg-gray-100/60 flex-shrink-0"></div>`
            }
            <div class="flex-1 min-w-0">
                <div class="font-bold text-gray-700 text-sm truncate">${song.title}</div>
                <div class="text-xs text-gray-400">${song.releaseDate ? song.releaseDate.replace(/-/g, '/') : ''}</div>
            </div>
            <div class="flex items-center gap-1 flex-shrink-0">${vocalIcons}</div>
        `;
        item.addEventListener('click', () => openSongDetail(idx));
        container.appendChild(item);
    });
}

// ===== Song Card (grid, Fix #4: サムネイル) =====
function createSongCard(song) {
    const idx = songs.indexOf(song);
    const card = document.createElement('div');
    card.className = 'song-card';
    const thumb = youtubeThumbnail(song.youtubeUrl);
    const vocalIcons = song.vocals.map((v, i) => v
        ? `<button class="vocal-icon-btn" data-vocal="${i}" onclick="event.stopPropagation(); openVocalDetail(${i}, ${idx})">
               <img src="${VOCALS[i].icon}" alt="${VOCALS[i].name}" class="w-5 h-5 rounded-full object-cover">
               <span>${VOCALS[i].name}</span>
           </button>`
        : ''
    ).join('');
    card.innerHTML = `
        ${thumb ? `<img src="${thumb}" alt="${song.title}" class="w-full h-24 object-cover rounded-xl mb-2 shadow-sm">` : ''}
        <div class="font-bold text-gray-700 text-base mb-1">${song.title}</div>
        <div class="text-xs text-gray-400 mb-2">${song.releaseDate ? song.releaseDate.replace(/-/g, '/') : ''}</div>
        ${vocalIcons ? `<div class="flex flex-wrap gap-1">${vocalIcons}</div>` : ''}
    `;
    card.addEventListener('click', () => openSongDetail(idx));
    return card;
}

// ===== Song Detail (Fix #3: comment非表示 / Fix #7: タブ切替 + 歌詞右カラム) =====
function openSongDetail(idx, fromView = null) {
    previousSongView = fromView || (
        document.getElementById('song-view-results').classList.contains('hidden') ? 'home' : 'results'
    );
    const song = songs[idx];
    const container = document.getElementById('songDetailContent');

    const vocalButtons = song.vocals.map((v, i) => v
        ? `<button class="vocal-icon-btn" onclick="openVocalDetail(${i}, ${idx})">
               <img src="${VOCALS[i].icon}" alt="${VOCALS[i].name}" class="w-6 h-6 rounded-full object-cover">
               <span>${VOCALS[i].name}</span>
           </button>`
        : ''
    ).join('');
    const hasVocals      = song.vocals.some(v => v);
    const hasInstrumental = !!song.instrumentalUrl;

    // タブHTML（インストURLがある場合のみ）
    const tabsHtml = hasInstrumental ? `
        <div class="toggle-group w-fit mb-4">
            <button class="toggle-btn active" id="tab-vocal">🎤 ボーカルあり</button>
            <button class="toggle-btn" id="tab-inst">🎼 インスト</button>
        </div>` : '';

    // メタ
    const metaItems = [
        song.bpm           ? `<div class="song-meta-item"><div class="song-meta-label">BPM</div><div class="song-meta-value">${song.bpm}</div></div>` : '',
        song.timeSignature ? `<div class="song-meta-item"><div class="song-meta-label">拍子</div><div class="song-meta-value">${song.timeSignature}</div></div>` : '',
        song.key           ? `<div class="song-meta-item"><div class="song-meta-label">キー</div><div class="song-meta-value">${song.key}</div></div>` : '',
    ].filter(Boolean).join('');

    container.innerHTML = `
        <div class="song-detail-card">
            <!-- Header -->
            <div class="flex items-start justify-between gap-4 mb-3">
                <div>
                    <h1 class="text-2xl font-bold text-gray-700">${song.title}</h1>
                    ${song.releaseDate ? `<p class="text-sm text-gray-400 mt-0.5">${song.releaseDate.replace(/-/g, '/')}</p>` : ''}
                </div>
                ${hasVocals ? `<div class="flex flex-wrap gap-2 flex-shrink-0">${vocalButtons}</div>` : ''}
            </div>

            ${song.basedOn ? `<div class="mb-3 p-3 bg-purple-50/60 rounded-xl border border-purple-100 text-sm text-purple-700">
                🎵 <strong>元になった曲:</strong> ${song.basedOn}
            </div>` : ''}

            ${tabsHtml}

            <!-- 2カラム: 左=動画+メタ / 右=歌詞 -->
            <div class="flex gap-5 items-start">
                <div class="flex-1 min-w-0">
                    <div id="video-vocal" class="${song.youtubeUrl ? '' : 'hidden'}">
                        <div class="aspect-video w-full rounded-2xl overflow-hidden mb-3 bg-black shadow-md">
                            <iframe class="w-full h-full" src="${song.youtubeUrl || ''}" frameborder="0"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
                        </div>
                    </div>
                    <div id="video-inst" class="hidden">
                        ${hasInstrumental ? `<div class="aspect-video w-full rounded-2xl overflow-hidden mb-3 bg-black shadow-md">
                            <iframe class="w-full h-full" src="${song.instrumentalUrl}" frameborder="0"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
                        </div>` : `<div class="aspect-video w-full rounded-2xl bg-gray-100/60 mb-3 flex items-center justify-center text-gray-400 text-sm">インスト版なし</div>`}
                    </div>
                    ${metaItems ? `<div class="song-detail-meta">${metaItems}</div>` : ''}
                </div>

                ${song.lyrics ? `<div class="w-72 flex-shrink-0">
                    <h3 class="text-sm font-bold text-gray-500 mb-2">📝 歌詞</h3>
                    <div class="lyrics-box">${song.lyrics}</div>
                </div>` : ''}
            </div>
        </div>
    `;

    if (hasInstrumental) {
        document.getElementById('tab-vocal').addEventListener('click', function() {
            this.classList.add('active');
            document.getElementById('tab-inst').classList.remove('active');
            document.getElementById('video-vocal').classList.remove('hidden');
            document.getElementById('video-inst').classList.add('hidden');
        });
        document.getElementById('tab-inst').addEventListener('click', function() {
            this.classList.add('active');
            document.getElementById('tab-vocal').classList.remove('active');
            document.getElementById('video-vocal').classList.add('hidden');
            document.getElementById('video-inst').classList.remove('hidden');
        });
    }

    document.querySelector('#song-view-detail .back-btn').onclick = () => showSongView(previousSongView);
    showSongView('detail');
}

// ===== Vocal Detail =====
function openVocalDetail(vocalIdx, fromSongIdx = null) {
    const vocal    = VOCALS[vocalIdx];
    const container = document.getElementById('vocalDetailContent');

    const soloSongs = songs.filter(s => s.vocals[vocalIdx] && s.vocals.filter(v => v).length === 1);
    const allSongs  = songs.filter(s => s.vocals[vocalIdx]);

    const renderList = (list) => {
        if (list.length === 0) return '<p class="text-center text-gray-400 py-4 text-sm">曲がありません</p>';
        return list.map(song => {
            const idx   = songs.indexOf(song);
            const thumb = youtubeThumbnail(song.youtubeUrl);
            return `<div class="song-list-item cursor-pointer" onclick="openSongDetail(${idx}, 'vocal')">
                ${thumb ? `<img src="${thumb}" alt="${song.title}" class="w-12 h-9 rounded-lg object-cover flex-shrink-0">` : ''}
                <div class="flex-1 min-w-0">
                    <div class="font-bold text-gray-700 text-sm truncate">${song.title}</div>
                    <div class="text-xs text-gray-400">${song.releaseDate ? song.releaseDate.replace(/-/g, '/') : ''}</div>
                </div>
                ${song.vocals.filter(v => v).length > 1 ? '<span class="text-xs text-purple-400 font-semibold flex-shrink-0">デュエット</span>' : ''}
            </div>`;
        }).join('');
    };

    container.innerHTML = `
        <div class="glass-panel rounded-3xl p-6 text-center mb-5">
            <img src="${vocal.icon}" alt="${vocal.name}" class="w-28 h-28 rounded-3xl object-cover mx-auto mb-3 border-4 border-white/70 shadow-xl">
            <h1 class="text-2xl font-bold text-gray-700">${vocal.name}</h1>
            <p class="text-gray-400 text-sm mt-1">楽曲: ${allSongs.length}曲 / ソロ: ${soloSongs.length}曲</p>
        </div>
        <div class="glass-item p-5">
            <div class="flex items-center justify-between mb-4">
                <h2 class="font-bold text-gray-700">楽曲リスト</h2>
                <div class="toggle-group">
                    <button class="toggle-btn active" id="vfAll">全て</button>
                    <button class="toggle-btn" id="vfSolo">ソロ</button>
                </div>
            </div>
            <div id="vocalSongList" class="space-y-2">${renderList(allSongs)}</div>
        </div>
    `;

    document.getElementById('vfAll').addEventListener('click', () => {
        document.getElementById('vfAll').classList.add('active');
        document.getElementById('vfSolo').classList.remove('active');
        document.getElementById('vocalSongList').innerHTML = renderList(allSongs);
    });
    document.getElementById('vfSolo').addEventListener('click', () => {
        document.getElementById('vfSolo').classList.add('active');
        document.getElementById('vfAll').classList.remove('active');
        document.getElementById('vocalSongList').innerHTML = renderList(soloSongs);
    });

    document.getElementById('vocalBackBtn').onclick = () => {
        if (fromSongIdx !== null) showSongView('detail');
        else showSongView('home');
    };

    showSongView('vocal');
}

// ===== Calendar (Fix #6: 縦幅自動) =====
function renderCalendar() {
    const today   = new Date();
    document.getElementById('calTitle').textContent = `${calYear}年 ${calMonth + 1}月`;

    const grid        = document.getElementById('calGrid');
    grid.innerHTML    = '';
    grid.style.gridAutoRows = 'auto'; // 各行の高さを内容に合わせる

    const firstDay    = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const daysInPrev  = new Date(calYear, calMonth, 0).getDate();

    const events = {};
    const addEvent = (key, ev) => { (events[key] = events[key] || []).push(ev); };

    songs.forEach((song, idx) => {
        if (!song.releaseDate) return;
        const d    = new Date(song.releaseDate);
        const key  = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const diff = calYear - d.getFullYear();
        if (diff === 0)      addEvent(key, { label: `${song.title} リリース`, type: 'release',     songIdx: idx });
        else if (diff > 0)   addEvent(key, { label: `${song.title} ${diff}周年`, type: 'anniversary', songIdx: idx });
    });

    let cellCount = 0;
    for (let i = 0; i < firstDay; i++) {
        grid.appendChild(makeCalCell(daysInPrev - firstDay + 1 + i, true, false, null, null));
        cellCount++;
    }
    for (let d = 1; d <= daysInMonth; d++) {
        const dow     = new Date(calYear, calMonth, d).getDay();
        const isToday = d === today.getDate() && calMonth === today.getMonth() && calYear === today.getFullYear();
        const key     = `${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        grid.appendChild(makeCalCell(d, false, isToday, dow, events[key] || []));
        cellCount++;
    }
    const remaining = (7 - (cellCount % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
        grid.appendChild(makeCalCell(i, true, false, null, null));
    }
}

function makeCalCell(day, otherMonth, isToday, dow, events) {
    const cell = document.createElement('div');
    cell.className = 'cal-cell'
        + (isToday    ? ' today'       : '')
        + (otherMonth ? ' other-month' : '');

    const numDiv = document.createElement('div');
    numDiv.className = 'cal-day-num'
        + (dow === 0 ? ' sunday' : dow === 6 ? ' saturday' : '');
    numDiv.textContent = day;
    cell.appendChild(numDiv);

    (events || []).forEach(ev => {
        const evEl = document.createElement('span');
        evEl.className = 'cal-event' + (ev.type === 'anniversary' ? ' anniversary' : '');
        evEl.textContent = ev.label;
        evEl.title = ev.label;
        evEl.addEventListener('click', e => { e.stopPropagation(); openSongDetail(ev.songIdx); });
        cell.appendChild(evEl);
    });

    return cell;
}

document.getElementById('calPrev').addEventListener('click', () => {
    if (--calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
});
document.getElementById('calNext').addEventListener('click', () => {
    if (++calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
});

// ===== Init =====
renderSongHome();