// Adapted from user-authorized xinyuan330-main/modules/music-online-services.js.
// Mio owns UI/storage; this adapter owns only remote music requests.
// The browser talks directly to public HTTPS endpoints; no user-side server is required.
(function () {
  'use strict';

  const PLACEHOLDER_COVER = 'assets/icons/music-pixel.png';
  const REQUEST_TIMEOUT = 8000;
  const SESSION_KEY = 'mio_music_netease_session';
  let sessionRevision = 0;
  const NETEASE_LOGIN_NODE = 'https://ncm-api.vercel.app';
  const METING_NODES = {
    primary: 'https://api.kfjie.me/music',
    neteaseFallback: 'https://meting.mikus.ink/api'
  };

  function withHttps(value) {
    return typeof value === 'string' ? value.replace(/^http:\/\//i, 'https://') : value;
  }

  async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT, format = 'json') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(window.MusicCore.remoteUrl(url), { ...options, credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await (format === 'text' ? response.text() : response.json());
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJson(url, options) {
    return fetchWithTimeout(url, options);
  }

  async function fetchText(url) {
    return fetchWithTimeout(withHttps(url), {}, REQUEST_TIMEOUT, 'text');
  }

  function endpoint(base, params) {
    const url = new URL(base);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
    return url.toString();
  }

  function extractMetingId(value) {
    try {
      return new URL(value).searchParams.get('id') || '';
    } catch (_) {
      return '';
    }
  }

  function mapMetingSong(song, platform, provider) {
    const playUrl = withHttps(song.url || '');
    return {
      name: song.title || song.name || '未知歌曲',
      artist: song.author || song.artist || '未知歌手',
      id: String(song.id || extractMetingId(playUrl) || ''),
      cover: withHttps(song.pic || song.cover || PLACEHOLDER_COVER),
      source: platform,
      provider,
      playUrl,
      lyricUrl: withHttps(song.lrc || ''),
      duration: Number(song.duration || song.time || 0) || 0
    };
  }

  async function searchMeting(base, platform, query, provider, limit = 30) {
    const data = await fetchJson(endpoint(base, {
      server: platform,
      type: 'search',
      id: query,
      limit
    }));
    if (!Array.isArray(data)) return [];
    return data.slice(0, limit).map(song => mapMetingSong(song, platform, provider));
  }

  async function searchVKeysTencent(query, limit = 30) {
    const result = await fetchJson(endpoint('https://api.vkeys.cn/v2/music/tencent', { word: query }));
    if (result?.code !== 200 || !Array.isArray(result.data)) return [];
    return result.data.slice(0, limit).map(song => ({
      name: song.song || song.name || '未知歌曲',
      artist: song.singer || '未知歌手',
      id: String(song.id || song.mid || ''),
      mid: song.mid || '',
      cover: withHttps(song.cover || PLACEHOLDER_COVER),
      source: 'tencent',
      provider: 'vkeys',
      duration: song.interval || 0
    }));
  }

  function normalizeText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[\s·・._\-—–()[\]（）【】《》<>]/g, '')
      .replace(/feat(?:uring)?\.?|ft\.?/g, '');
  }

  function trackKey(track) {
    return `${track.source}|${normalizeText(track.name)}|${normalizeText(track.artist)}`;
  }

  function dedupeTracks(tracks) {
    const seen = new Set();
    return tracks.filter(track => {
      const key = trackKey(track);
      if (!track.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function searchPlatform(platform, query, limit = 30) {
    if (platform === 'tencent') return searchVKeysTencent(query, limit);
    if (platform === 'kugou') {
      return searchMeting(METING_NODES.primary, 'kugou', query, 'kfjie', limit);
    }
    try {
      const results = await searchMeting(METING_NODES.primary, 'netease', query, 'kfjie', limit);
      if (results.length) return results;
    } catch (error) {
      // Try the reference project's secondary node without logging request details.
    }
    return searchMeting(METING_NODES.neteaseFallback, 'netease', query, 'mikus', limit);
  }

  async function searchAll(query, limitPerPlatform = 20) {
    const requests = ['netease', 'tencent', 'kugou'].map(async platform => {
      try {
        return await searchPlatform(platform, query, limitPerPlatform);
      } catch (error) {
        // Failure is summarized by the caller; never log request credentials.
        return [];
      }
    });
    const results = dedupeTracks((await Promise.all(requests)).flat());
    if (!results.length) throw new Error('未找到歌曲或在线服务暂不可用，可切换平台重试');
    return results;
  }

  async function getMetingCollection(type, id) {
    const data = await fetchJson(endpoint(METING_NODES.primary, {
      server: 'netease',
      type,
      id
    }));
    if (!Array.isArray(data)) return [];
    return data.map(song => mapMetingSong(song, 'netease', 'kfjie'));
  }

  function similarityScore(candidate, target) {
    const candidateName = normalizeText(candidate.name);
    const targetName = normalizeText(target.name);
    const candidateArtist = normalizeText(candidate.artist);
    const targetArtist = normalizeText(target.artist);
    let score = 0;
    if (candidateName === targetName) score += 70;
    else if (candidateName.includes(targetName) || targetName.includes(candidateName)) score += 42;
    if (candidateArtist === targetArtist) score += 30;
    else if (candidateArtist.includes(targetArtist) || targetArtist.includes(candidateArtist)) score += 18;
    return score;
  }

  function bestMatch(candidates, target, minimumScore = 55) {
    return candidates
      .map(candidate => ({ candidate, score: similarityScore(candidate, target) }))
      .filter(item => item.score >= minimumScore)
      .sort((a, b) => b.score - a.score)[0]?.candidate || null;
  }

  async function resolveTencent(track) {
    const result = await fetchJson(endpoint('https://api.vkeys.cn/v2/music/tencent', { id: track.id }));
    return withHttps(result?.data?.url || '');
  }

  async function resolveLegacyNetease(track) {
    try {
      const result = await fetchJson(endpoint('https://api.vkeys.cn/v2/music/netease', { id: track.id }));
      if (result?.data?.url) return withHttps(result.data.url);
    } catch (_) {
      // Continue to Meting search fallback.
    }
    return '';
  }

  async function refreshIdentity(track, allowCrossPlatform = true) {
    const source = track.source || track.onlineSource?.platform || 'netease';
    const query = `${track.name || ''} ${track.artist || ''}`.trim();
    let candidates = [];
    try {
      candidates = await searchPlatform(source, query, 20);
    } catch (_) {
      candidates = [];
    }
    let match = bestMatch(candidates, track);
    if (!match && allowCrossPlatform) {
      const all = await searchAll(query, 15);
      match = bestMatch(all, track, 70);
    }
    return match;
  }

  async function findAlternativeIdentity(track) {
    const source = track.source || track.platform || track.onlineSource?.platform || '';
    const query = `${track.name || ''} ${track.artist || ''}`.trim();
    const candidates = (await searchAll(query, 15)).filter(candidate => candidate.source !== source);
    return bestMatch(candidates, track, 70);
  }

  function identityFromTrack(track) {
    if (track.onlineSource) {
      return {
        ...track.onlineSource,
        name: track.name,
        artist: track.artist,
        cover: track.cover
      };
    }
    return track;
  }

  async function resolveSong(track, options = {}) {
    const sourceTrack = identityFromTrack(track);
    let resolvedTrack = sourceTrack;
    let url = '';

    if (options.preferAlternative) {
      const alternative = await findAlternativeIdentity(sourceTrack);
      if (!alternative) return null;
      resolvedTrack = alternative;
      url = alternative.source === 'tencent'
        ? await resolveTencent(alternative).catch(() => '')
        : withHttps(alternative.playUrl || '');
      return url ? { url: withHttps(url), identity: resolvedTrack } : null;
    }

    if (sourceTrack.source === 'tencent' || sourceTrack.platform === 'tencent') {
      url = await resolveTencent(sourceTrack).catch(() => '');
    } else if (sourceTrack.playUrl) {
      url = withHttps(sourceTrack.playUrl);
    } else if ((sourceTrack.source || sourceTrack.platform) === 'netease' && sourceTrack.id) {
      url = await resolveLegacyNetease(sourceTrack);
    }

    if (!url || options.forceRefresh) {
      const refreshed = await refreshIdentity(sourceTrack, options.allowCrossPlatform !== false);
      if (refreshed) {
        resolvedTrack = refreshed;
        url = refreshed.source === 'tencent'
          ? await resolveTencent(refreshed).catch(() => '')
          : withHttps(refreshed.playUrl || '');
      }
    }

    if (!url) return null;
    return { url: withHttps(url), identity: resolvedTrack };
  }

  async function loadLyrics(track) {
    const sourceTrack = identityFromTrack(track);
    if (sourceTrack.lyricUrl) {
      try { return await fetchText(sourceTrack.lyricUrl); } catch (_) { /* use API fallback */ }
    }
    const platform = sourceTrack.source || sourceTrack.platform;
    if (!sourceTrack.id || !['netease', 'tencent'].includes(platform)) return '';
    try {
      const result = await fetchJson(endpoint(`https://api.vkeys.cn/v2/music/${platform}/lyric`, { id: sourceTrack.id }));
      const data = result?.data || {};
      return [data.lrc || data.lyric || '', data.trans || data.tlyric || ''].filter(Boolean).join('\n');
    } catch (_) {
      return '';
    }
  }

  function toPlaylistTrack(song, resolvedUrl = '') {
    return {
      name: song.name,
      artist: song.artist || '未知歌手',
      src: withHttps(resolvedUrl),
      cover: withHttps(song.cover || PLACEHOLDER_COVER),
      isLocal: false,
      lrcContent: '',
      onlineSource: {
        platform: song.source || song.platform || 'netease',
        source: song.source || song.platform || 'netease',
        provider: song.provider || '',
        id: String(song.id || ''),
        mid: song.mid || '',
        playUrl: withHttps(song.playUrl || ''),
        lyricUrl: withHttps(song.lyricUrl || ''),
        duration: song.duration || 0
      },
      onlineResolvedAt: resolvedUrl ? Date.now() : 0
    };
  }

  function loadSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (!session?.cookie || session.node !== NETEASE_LOGIN_NODE) return null;
      return session;
    } catch (_) {
      return null;
    }
  }

  function saveSession(cookie, profile) {
    const session = { node: NETEASE_LOGIN_NODE, cookie, profile, savedAt: Date.now() };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  function clearSession() {
    sessionRevision++;
    sessionStorage.removeItem(SESSION_KEY);
  }

  async function neteaseRequest(path, params = {}, session = loadSession()) {
    const values = { ...params, timestamp: Date.now() };
    if (session?.cookie) values.cookie = session.cookie;
    // Cookie is sent only to the explicitly selected account service, never in URL/logs/backups.
    return fetchJson(`${NETEASE_LOGIN_NODE}${path}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(values)});
  }

  async function getLoginStatus(session = loadSession()) {
    if (!session) return null;
    const revision = sessionRevision;
    const result = await neteaseRequest('/login/status', {}, session);
    if (revision !== sessionRevision) return null;
    const profile = result?.data?.profile || result?.profile || null;
    if (!profile) return null;
    saveSession(session.cookie, profile);
    return profile;
  }

  async function createQrLogin() {
    const keyResult = await neteaseRequest('/login/qr/key', {}, null);
    const key = keyResult?.data?.unikey;
    if (!key) throw new Error('无法创建登录二维码');
    const qrResult = await neteaseRequest('/login/qr/create', { key, qrimg: true }, null);
    if (!qrResult?.data?.qrimg) throw new Error('无法生成登录二维码');
    return { key, qrimg: qrResult.data.qrimg, qrurl: qrResult.data.qrurl };
  }

  async function checkQrLogin(key) {
    const revision = sessionRevision;
    const result = await neteaseRequest('/login/qr/check', { key, noCookie: true }, null);
    if (revision !== sessionRevision) return {code:800};
    if (result?.code === 803 && result.cookie) {
      const session = saveSession(result.cookie, null);
      const profile = await getLoginStatus(session);
      return { code:result.code, profile };
    }
    return result;
  }

  async function getUserPlaylists() {
    const session = loadSession();
    const profile = await getLoginStatus(session);
    if (!profile?.userId) throw new Error('登录已失效，请重新扫码');
    const result = await neteaseRequest('/user/playlist', { uid: profile.userId, limit: 1000 }, session);
    return Array.isArray(result?.playlist) ? result.playlist : [];
  }

  async function getUserPlaylistTracks(playlistId) {
    const session = loadSession();
    if (!session) throw new Error('请先登录网易云音乐');
    let result = await neteaseRequest('/playlist/track/all', { id: playlistId, limit: 1000 }, session);
    let songs = result?.songs;
    if (!Array.isArray(songs)) {
      result = await neteaseRequest('/playlist/detail', { id: playlistId }, session);
      songs = result?.playlist?.tracks;
    }
    if (!Array.isArray(songs)) return [];
    return songs.map(song => ({
      name: song.name || '未知歌曲',
      artist: Array.isArray(song.ar) ? song.ar.map(artist => artist.name).filter(Boolean).join('/') : '未知歌手',
      id: String(song.id || ''),
      cover: withHttps(song.al?.picUrl || PLACEHOLDER_COVER),
      source: 'netease',
      provider: 'netease-account',
      duration: song.dt || 0
    }));
  }

  window.MioMusicOnline = {
    PLACEHOLDER_COVER,
    searchAll,
    searchPlatform,
    getPlaylist: id => getMetingCollection('playlist', id),
    getAlbum: id => getMetingCollection('album', id),
    resolveSong,
    loadLyrics,
    toPlaylistTrack,
    refreshIdentity,
    account: {
      node: NETEASE_LOGIN_NODE,
      loadSession,
      clearSession,
      getLoginStatus,
      createQrLogin,
      checkQrLogin,
      getUserPlaylists,
      getUserPlaylistTracks
    }
  };
})();
