/* MyTube – YouTube-powered feed, search, and playback */

const API_BASE = window.location.origin;
const YOUTUBE_STUDIO_UPLOAD = 'https://www.youtube.com/upload';
const YOUTUBE_STUDIO_LIVE = 'https://studio.youtube.com/video/livestreaming';

let notifications = [];
let readNotificationIds = JSON.parse(localStorage.getItem('mytube_read_notifications') || '[]');
let sidebarOpen = false;
let speechRecognition = null;
let isListening = false;

let feedMode = 'recommended';
let activeCategory = 'All';
let currentQuery = '';
let nextPageToken = null;
let isLoading = false;
let loadedVideoIds = new Set();
let scrollObserver = null;
let currentPlayingVideo = null;
let downloadPollTimer = null;
let activeDownloadJobId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const menuBtn = $('#menuBtn');
const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebarOverlay');
const searchForm = $('#searchForm');
const searchInput = $('#searchInput');
const voiceBtn = $('#voiceBtn');
const voiceIndicator = $('#voiceIndicator');
const createBtn = $('#createBtn');
const createModal = $('#createModal');
const createModalClose = $('#createModalClose');
const uploadVideoBtn = $('#uploadVideoBtn');
const goLiveBtn = $('#goLiveBtn');
const createPostBtn = $('#createPostBtn');
const notificationBtn = $('#notificationBtn');
const notificationDropdown = $('#notificationDropdown');
const notificationList = $('#notificationList');
const notificationBadge = $('#notificationBadge');
const markAllRead = $('#markAllRead');
const profileBtn = $('#profileBtn');
const profileDropdown = $('#profileDropdown');
const videoGrid = $('#videoGrid');
const contentTitle = $('#contentTitle');
const searchResultsInfo = $('#searchResultsInfo');
const noResults = $('#noResults');
const errorMessage = $('#errorMessage');
const apiBanner = $('#apiBanner');
const loadSpinner = $('#loadSpinner');
const loadStatus = $('#loadStatus');
const scrollSentinel = $('#scrollSentinel');
const playerModal = $('#playerModal');
const playerClose = $('#playerClose');
const ytPlayer = $('#ytPlayer');
const playerTitle = $('#playerTitle');
const playerMeta = $('#playerMeta');
const playerLiveBadge = $('#playerLiveBadge');
const playerWatchYtBtn = $('#playerWatchYtBtn');
const downloadToggleBtn = $('#downloadToggleBtn');
const downloadPanel = $('#downloadPanel');
const downloadFormats = $('#downloadFormats');
const downloadProgressModal = $('#downloadProgressModal');
const downloadProgressTitle = $('#downloadProgressTitle');
const downloadProgressSubtitle = $('#downloadProgressSubtitle');
const downloadProgressBar = $('#downloadProgressBar');
const downloadProgressPercent = $('#downloadProgressPercent');
const downloadCancelBtn = $('#downloadCancelBtn');
const updateYtDlpBtn = $('#updateYtDlpBtn');

/* Category Chips & Channel Modal Selectors */
const categoriesBar = $('#categoriesBar');
const channelModal = $('#channelModal');
const channelModalClose = $('#channelModalClose');
const channelBannerWrap = $('#channelBannerWrap');
const channelAvatar = $('#channelAvatar');
const channelTitle = $('#channelTitle');
const channelMeta = $('#channelMeta');
const channelDesc = $('#channelDesc');
const channelSubscribeBtn = $('#channelSubscribeBtn');
const channelVideoGrid = $('#channelVideoGrid');
const channelError = $('#channelError');
const channelLoadSpinner = $('#channelLoadSpinner');

/* Multi-Language Selectors */
const playerAudioLangSelect = $('#playerAudioLangSelect');
const playerSubLangSelect = $('#playerSubLangSelect');
const dlAudioLangSelect = $('#dlAudioLangSelect');
const dlSubLangSelect = $('#dlSubLangSelect');
const dlEmbedSubCheck = $('#dlEmbedSubCheck');

let currentPlaylistInfo = null;
let currentView = 'home';

const storage = {
  getWatchLater() {
    try { return JSON.parse(localStorage.getItem('mytube_watch_later') || '[]'); }
    catch { return []; }
  },
  saveWatchLater(list) {
    localStorage.setItem('mytube_watch_later', JSON.stringify(list));
  },
  isWatchLater(videoId) {
    return this.getWatchLater().some((v) => v.id === videoId);
  },
  toggleWatchLater(video) {
    let list = this.getWatchLater();
    const idx = list.findIndex((v) => v.id === video.id);
    let added = false;
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.unshift(video);
      added = true;
    }
    this.saveWatchLater(list);
    return added;
  },
  getLiked() {
    try { return JSON.parse(localStorage.getItem('mytube_liked_videos') || '[]'); }
    catch { return []; }
  },
  saveLiked(list) {
    localStorage.setItem('mytube_liked_videos', JSON.stringify(list));
  },
  isLiked(videoId) {
    return this.getLiked().some((v) => v.id === videoId);
  },
  toggleLiked(video) {
    let list = this.getLiked();
    const idx = list.findIndex((v) => v.id === video.id);
    let added = false;
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.unshift(video);
      added = true;
    }
    this.saveLiked(list);
    return added;
  },
  getCustomPlaylists() {
    try { return JSON.parse(localStorage.getItem('mytube_user_playlists') || '[]'); }
    catch { return []; }
  },
  saveCustomPlaylists(playlists) {
    localStorage.setItem('mytube_user_playlists', JSON.stringify(playlists));
  },
  createPlaylist(title) {
    const list = this.getCustomPlaylists();
    const newPl = {
      id: 'pl_' + Date.now(),
      title: title.trim(),
      videos: []
    };
    list.push(newPl);
    this.saveCustomPlaylists(list);
    return newPl;
  },
  toggleVideoInPlaylist(playlistId, video) {
    const playlists = this.getCustomPlaylists();
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return false;

    const idx = pl.videos.findIndex((v) => v.id === video.id);
    let inPl = false;
    if (idx >= 0) {
      pl.videos.splice(idx, 1);
    } else {
      pl.videos.unshift(video);
      inPl = true;
    }
    this.saveCustomPlaylists(playlists);
    return inPl;
  },
  deletePlaylist(playlistId) {
    const playlists = this.getCustomPlaylists().filter((p) => p.id !== playlistId);
    this.saveCustomPlaylists(playlists);
  }
};

async function init() {
  setupSidebar();
  setupSearch();
  setupVoiceSearch();
  setupCategoryChips();
  setupChannelModal();
  setupPlaylistModal();
  setupSavePlaylistModal();
  setupCreateModal();
  setupDropdowns();
  setupPlayer();
  setupPlayerLangControls();
  setupDownload();
  setupInfiniteScroll();
  fetchNotifications();
  setInterval(fetchNotifications, 30000);

  const configured = await checkYouTubeStatus();
  if (configured) {
    await loadVideos({ reset: true });
  }
}

function setupPlaylistModal() {
  const playlistModalBtn = $('#playlistModalBtn');
  const playlistModal = $('#playlistModal');
  const playlistModalClose = $('#playlistModalClose');
  const playlistUrlInput = $('#playlistUrlInput');
  const playlistFetchBtn = $('#playlistFetchBtn');
  const playlistPreviewCard = $('#playlistPreviewCard');
  const playlistPreviewTitle = $('#playlistPreviewTitle');
  const playlistPreviewCount = $('#playlistPreviewCount');
  const playlistStartDownloadBtn = $('#playlistStartDownloadBtn');
  const playlistError = $('#playlistError');

  playlistModalBtn.addEventListener('click', () => {
    playlistModal.hidden = false;
    closeSidebar();
  });

  playlistModalClose.addEventListener('click', () => {
    playlistModal.hidden = true;
  });

  playlistModal.addEventListener('click', (e) => {
    if (e.target === playlistModal) playlistModal.hidden = true;
  });

  $$('.quality-radio-label').forEach((label) => {
    label.addEventListener('click', () => {
      $$('.quality-radio-label').forEach((l) => l.classList.remove('active'));
      label.classList.add('active');
    });
  });

  const doFetch = async () => {
    const url = (playlistUrlInput.value || '').trim();
    if (!url) return;

    playlistFetchBtn.disabled = true;
    playlistFetchBtn.textContent = 'Fetching...';
    playlistError.hidden = true;

    try {
      const res = await fetch(`${API_BASE}/api/youtube/playlist/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch playlist');

      currentPlaylistInfo = data.playlist;
      playlistPreviewTitle.textContent = data.playlist.title || 'YouTube Playlist';
      playlistPreviewCount.textContent = `${data.playlist.videoCount} video${data.playlist.videoCount !== 1 ? 's' : ''} found`;
      playlistPreviewCard.hidden = false;
    } catch (err) {
      playlistPreviewCard.hidden = true;
      currentPlaylistInfo = null;
      playlistError.textContent = err.message || 'Could not load playlist info';
      playlistError.hidden = false;
    } finally {
      playlistFetchBtn.disabled = false;
      playlistFetchBtn.textContent = 'Fetch';
    }
  };

  playlistFetchBtn.addEventListener('click', doFetch);
  playlistUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doFetch();
    }
  });

  playlistStartDownloadBtn.addEventListener('click', async () => {
    const url = (playlistUrlInput.value || '').trim();
    if (!url) {
      playlistError.textContent = 'Please enter a playlist URL or ID';
      playlistError.hidden = false;
      return;
    }

    const selectedQuality = $('input[name="playlistQuality"]:checked')?.value || 'best';
    const title = currentPlaylistInfo?.title || 'playlist';

    playlistModal.hidden = true;
    downloadProgressModal.hidden = false;
    updateDownloadProgress(0, 'queued', 'Preparing playlist download...', 'Playlist ZIP');

    try {
      const res = await fetch(`${API_BASE}/api/youtube/playlist/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formatId: selectedQuality, title })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start playlist download');

      activeDownloadJobId = data.jobId;
      pollDownloadStatus('Playlist ZIP');
    } catch (err) {
      updateDownloadProgress(0, 'error', err.message, 'Playlist ZIP');
    }
  });
}

async function checkYouTubeStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/youtube/status`);
    const data = await res.json();
    if (!data.configured) {
      apiBanner.hidden = false;
      showError('YouTube API key is not configured on the server.');
      return false;
    }
    apiBanner.hidden = true;
    return true;
  } catch {
    showError('Could not connect to the MyTube server.');
    return false;
  }
}

function setupInfiniteScroll() {
  scrollObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && !isLoading && nextPageToken) {
        loadVideos({ reset: false });
      }
    },
    { rootMargin: '400px' }
  );
  scrollObserver.observe(scrollSentinel);
}

async function loadVideos({ reset = false } = {}) {
  if (isLoading) return;
  isLoading = true;
  setLoading(true);
  hideError();

  if (reset) {
    nextPageToken = null;
    loadedVideoIds.clear();
    videoGrid.innerHTML = '';
    noResults.hidden = true;
  }

  try {
    let endpoint;
    if (feedMode === 'search') {
      endpoint = `/api/youtube/search?q=${encodeURIComponent(currentQuery)}${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
    } else {
      const categoryParam = activeCategory !== 'All' ? `&category=${encodeURIComponent(activeCategory)}` : '';
      endpoint = `/api/youtube/feed?${nextPageToken ? `pageToken=${nextPageToken}` : ''}${categoryParam}`;
    }

    const res = await fetch(`${API_BASE}${endpoint}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to load videos');
    }

    const newVideos = (data.videos || []).filter((v) => !loadedVideoIds.has(v.id));
    newVideos.forEach((v) => loadedVideoIds.add(v.id));

    if (reset && !newVideos.length) {
      noResults.hidden = false;
    }

    appendVideos(newVideos);
    nextPageToken = data.nextPageToken || null;

    if (reset && feedMode === 'recommended') {
      if (activeCategory !== 'All') {
        contentTitle.textContent = activeCategory;
      } else if (data.liveCount > 0) {
        contentTitle.textContent = 'Live & Recommended';
      } else {
        contentTitle.textContent = 'Recommended';
      }
    }

    if (feedMode === 'search') {
      searchResultsInfo.hidden = false;
      searchResultsInfo.textContent = `${loadedVideoIds.size} result${loadedVideoIds.size !== 1 ? 's' : ''} from YouTube`;
      noResults.hidden = loadedVideoIds.size > 0;
    }
  } catch (err) {
    if (reset) showError(err.message);
  } finally {
    isLoading = false;
    setLoading(false);
  }
}

function renderThumbnailBadge(video) {
  if (video.isLive) {
    return '<span class="live-badge thumbnail-live-badge">LIVE</span>';
  }
  if (video.isUpcoming) {
    return '<span class="upcoming-badge">UPCOMING</span>';
  }
  if (video.duration) {
    return `<span class="video-duration">${escapeHtml(video.duration)}</span>`;
  }
  return '';
}

function setupCategoryChips() {
  const chips = $$('.chip');
  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      chips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      activeCategory = chip.dataset.category || 'All';
      feedMode = 'recommended';
      searchResultsInfo.hidden = true;
      loadVideos({ reset: true });
    });
  });
}

function setupChannelModal() {
  channelModalClose.addEventListener('click', closeChannelModal);
  channelModal.addEventListener('click', (e) => {
    if (e.target === channelModal) closeChannelModal();
  });
  channelSubscribeBtn.addEventListener('click', () => {
    const isSub = channelSubscribeBtn.classList.toggle('subscribed');
    channelSubscribeBtn.textContent = isSub ? 'Subscribed' : 'Subscribe';
  });
}

function closeChannelModal() {
  channelModal.hidden = true;
}

async function openChannelModal(channelId) {
  if (!channelId) return;

  channelModal.hidden = false;
  channelTitle.textContent = 'Loading channel...';
  channelMeta.textContent = '';
  channelDesc.textContent = '';
  channelAvatar.src = 'https://api.dicebear.com/7.x/identicon/svg?seed=' + encodeURIComponent(channelId);
  channelBannerWrap.innerHTML = '<div class="channel-banner-placeholder"></div>';
  channelVideoGrid.innerHTML = '';
  channelError.hidden = true;
  channelLoadSpinner.hidden = false;
  channelSubscribeBtn.classList.remove('subscribed');
  channelSubscribeBtn.textContent = 'Subscribe';

  try {
    const [channelRes, videosRes] = await Promise.all([
      fetch(`${API_BASE}/api/youtube/channel/${channelId}`),
      fetch(`${API_BASE}/api/youtube/channel/${channelId}/videos`)
    ]);

    const channelData = await channelRes.json();
    const videosData = await videosRes.json();

    if (channelRes.ok && channelData.channel) {
      const ch = channelData.channel;
      channelTitle.textContent = ch.title;
      channelMeta.textContent = `${ch.handle} • ${ch.subscriberCount} • ${ch.videoCount} videos`;
      channelDesc.textContent = ch.description;
      if (ch.avatar) channelAvatar.src = ch.avatar;
      if (ch.bannerUrl) {
        channelBannerWrap.innerHTML = `<img src="${escapeAttr(ch.bannerUrl)}" alt="${escapeAttr(ch.title)} banner">`;
      }
    } else {
      channelTitle.textContent = 'Channel Details';
    }

    channelLoadSpinner.hidden = true;

    if (videosRes.ok && videosData.videos?.length) {
      renderChannelVideos(videosData.videos);
    } else {
      channelVideoGrid.innerHTML = '<p class="no-results">No recent videos found for this channel.</p>';
    }
  } catch (err) {
    channelLoadSpinner.hidden = true;
    channelError.textContent = err.message || 'Failed to load channel details';
    channelError.hidden = false;
  }
}

function renderChannelVideos(videos) {
  const fragment = document.createDocumentFragment();
  videos.forEach((video) => {
    const card = document.createElement('article');
    card.className = 'video-card' + (video.isLive ? ' is-live' : '');
    card.dataset.id = video.id;
    card.innerHTML = `
      <div class="thumbnail-wrap">
        <img class="video-thumbnail" src="${escapeAttr(video.thumbnail)}" alt="${escapeAttr(video.title)}" loading="lazy">
        ${renderThumbnailBadge(video)}
      </div>
      <div class="video-info">
        <div class="video-details">
          <h3>${escapeHtml(video.title)}</h3>
          <p class="video-meta">${escapeHtml(video.views)} · ${escapeHtml(video.age)}</p>
        </div>
      </div>
    `;
    card.addEventListener('click', () => {
      closeChannelModal();
      playVideo(video);
    });
    fragment.appendChild(card);
  });
  channelVideoGrid.appendChild(fragment);
}

function appendVideos(videos) {
  const fragment = document.createDocumentFragment();

  videos.forEach((video) => {
    const isWl = storage.isWatchLater(video.id);
    const card = document.createElement('article');
    card.className = 'video-card' + (video.isLive ? ' is-live' : '');
    card.dataset.id = video.id;
    card.innerHTML = `
      <div class="thumbnail-wrap">
        <img class="video-thumbnail" src="${escapeAttr(video.thumbnail)}" alt="${escapeAttr(video.title)}" loading="lazy">
        ${renderThumbnailBadge(video)}
        <button class="watch-later-btn ${isWl ? 'saved' : ''}" type="button" title="${isWl ? 'Remove from Watch Later' : 'Watch Later'}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
        </button>
      </div>
      <div class="video-info">
        <img class="video-channel-avatar" src="${escapeAttr(video.avatar)}" alt="${escapeAttr(video.channel)}" title="View channel">
        <div class="video-details">
          <h3>${escapeHtml(video.title)}</h3>
          <p class="video-meta">
            <span class="channel-link" title="View channel">${escapeHtml(video.channel)}</span><br>
            ${escapeHtml(video.views)} · ${escapeHtml(video.age)}
          </p>
        </div>
      </div>
    `;

    const wlBtn = card.querySelector('.watch-later-btn');
    wlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const added = storage.toggleWatchLater(video);
      wlBtn.classList.toggle('saved', added);
      wlBtn.title = added ? 'Remove from Watch Later' : 'Watch Later';
    });

    const avatarImg = card.querySelector('.video-channel-avatar');
    const channelLink = card.querySelector('.channel-link');

    if (video.channelId) {
      avatarImg.style.cursor = 'pointer';
      avatarImg.addEventListener('click', (e) => {
        e.stopPropagation();
        openChannelModal(video.channelId);
      });

      channelLink.style.cursor = 'pointer';
      channelLink.addEventListener('click', (e) => {
        e.stopPropagation();
        openChannelModal(video.channelId);
      });
    }

    card.addEventListener('click', () => playVideo(video));
    fragment.appendChild(card);
  });

  videoGrid.appendChild(fragment);
}

function buildEmbedUrl(video, options = {}) {
  const { subLang = 'none', audioLang = 'default' } = options;
  const params = new URLSearchParams({
    autoplay: '1',
    rel: '0',
    modestbranding: '1',
    playsinline: '1'
  });

  if (subLang && subLang !== 'none') {
    params.set('cc_load_policy', '1');
    params.set('cc_lang_pref', subLang);
  }

  if (subLang !== 'none' || audioLang !== 'default') {
    const prefLang = subLang !== 'none' ? subLang : audioLang;
    params.set('hl', prefLang);
  }

  if (video.isLive) {
    params.set('live', '1');
  }

  return `https://www.youtube-nocookie.com/embed/${video.id}?${params.toString()}`;
}

function setupPlayerLangControls() {
  const updatePlayerFrame = () => {
    if (!currentPlayingVideo) return;
    const subLang = playerSubLangSelect ? playerSubLangSelect.value : 'none';
    const audioLang = playerAudioLangSelect ? playerAudioLangSelect.value : 'default';
    ytPlayer.src = buildEmbedUrl(currentPlayingVideo, { subLang, audioLang });
  };

  playerAudioLangSelect?.addEventListener('change', updatePlayerFrame);
  playerSubLangSelect?.addEventListener('change', updatePlayerFrame);
}

async function playVideo(video) {
  try {
    const res = await fetch(`${API_BASE}/api/youtube/video/${video.id}`);
    if (res.ok) {
      const data = await res.json();
      video = data.video;
    }
  } catch {
    /* use cached card data */
  }

  currentPlayingVideo = video;
  playerTitle.textContent = video.title;
  if (playerWatchYtBtn) {
    playerWatchYtBtn.href = `https://www.youtube.com/watch?v=${video.id}`;
  }
  playerMeta.innerHTML = `<span class="channel-link" style="cursor:pointer;text-decoration:underline;">${escapeHtml(video.channel)}</span> · ${escapeHtml(video.views)} · ${escapeHtml(video.age)}`;

  if (video.channelId) {
    const channelSpan = playerMeta.querySelector('.channel-link');
    channelSpan.addEventListener('click', () => {
      closePlayer();
      openChannelModal(video.channelId);
    });
  }

  playerLiveBadge.hidden = !video.isLive;
  downloadToggleBtn.hidden = video.isLive;
  downloadPanel.hidden = true;
  downloadToggleBtn.classList.remove('active');

  const subLang = playerSubLangSelect ? playerSubLangSelect.value : 'none';
  const audioLang = playerAudioLangSelect ? playerAudioLangSelect.value : 'default';
  ytPlayer.src = buildEmbedUrl(video, { subLang, audioLang });
  playerModal.hidden = false;
  document.body.style.overflow = 'hidden';
  closeAllDropdowns();
  closeSidebar();
}

function closePlayer() {
  ytPlayer.src = '';
  playerLiveBadge.hidden = true;
  downloadToggleBtn.hidden = true;
  downloadPanel.hidden = true;
  downloadToggleBtn.classList.remove('active');
  currentPlayingVideo = null;
  stopDownloadPolling();
  playerModal.hidden = true;
  document.body.style.overflow = '';
}

function setupDownload() {
  downloadToggleBtn.addEventListener('click', async () => {
    if (!currentPlayingVideo || currentPlayingVideo.isLive) return;

    const willOpen = downloadPanel.hidden;
    downloadPanel.hidden = !willOpen;
    downloadToggleBtn.classList.toggle('active', willOpen);

    if (willOpen) {
      await loadDownloadFormats();
    }
  });

  downloadCancelBtn.addEventListener('click', () => {
    stopDownloadPolling();
    activeDownloadJobId = null;
    downloadProgressModal.hidden = true;
  });

  updateYtDlpBtn?.addEventListener('click', async () => {
    if (!updateYtDlpBtn) return;
    updateYtDlpBtn.disabled = true;
    const oldText = updateYtDlpBtn.textContent;
    updateYtDlpBtn.textContent = 'Updating...';
    downloadProgressSubtitle.textContent = 'Updating yt-dlp to the latest release...';

    try {
      const res = await fetch(`${API_BASE}/api/youtube/yt-dlp/update`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Update failed');

      updateYtDlpBtn.textContent = 'Updated!';
      downloadProgressSubtitle.textContent = `yt-dlp updated successfully (${data.version || 'latest'})!`;
      setTimeout(() => {
        updateYtDlpBtn.disabled = false;
        updateYtDlpBtn.textContent = oldText;
      }, 3000);
    } catch (err) {
      updateYtDlpBtn.disabled = false;
      updateYtDlpBtn.textContent = oldText;
      downloadProgressSubtitle.textContent = `Update failed: ${err.message}`;
    }
  });
}

async function loadDownloadFormats() {
  if (!currentPlayingVideo) return;

  downloadFormats.innerHTML = `
    <div class="download-formats-loading">
      <div class="spinner"></div>
      <span>Loading available qualities...</span>
    </div>
  `;

  try {
    const res = await fetch(`${API_BASE}/api/youtube/download/formats/${currentPlayingVideo.id}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Could not load qualities');
    }

    if (data.audioLanguages?.length && dlAudioLangSelect) {
      dlAudioLangSelect.innerHTML = `
        <option value="default">Default Audio Track</option>
        ${data.audioLanguages.map((l) => `<option value="${escapeAttr(l.code)}">${escapeHtml(l.name)}</option>`).join('')}
      `;
    }

    if (data.subtitles?.length && dlSubLangSelect) {
      dlSubLangSelect.innerHTML = data.subtitles.map((s) => `
        <option value="${escapeAttr(s.code)}">${escapeHtml(s.name)}</option>
      `).join('');
    }

    if (!data.options?.length) {
      downloadFormats.innerHTML = '<p class="download-empty">No MP4 download options found for this video.</p>';
      return;
    }

    downloadFormats.innerHTML = data.options.map((option) => {
      const isAudio = option.type === 'audio';
      return `
        <button class="download-format-option ${isAudio ? 'audio-option' : ''}" type="button" data-format-id="${escapeAttr(option.formatId)}" data-label="${escapeAttr(option.label)}">
          <div class="download-format-main">
            <span class="download-format-quality">
              ${escapeHtml(option.label)}
              ${isAudio ? '<span class="download-option-badge">Audio</span>' : ''}
            </span>
            <span class="download-format-type">${escapeHtml(option.sublabel)}</span>
          </div>
          <div class="download-format-meta">
            ${option.sizeLabel ? `<span class="download-format-size">${escapeHtml(option.sizeLabel)}</span>` : '<span class="download-format-size">Est. size varies</span>'}
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          </div>
        </button>
      `;
    }).join('');

    $$('.download-format-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        startVideoDownload(btn.dataset.formatId, btn.dataset.label);
      });
    });
  } catch (error) {
    downloadFormats.innerHTML = `<p class="download-empty error">${escapeHtml(error.message)}</p>`;
  }
}

async function startVideoDownload(formatId, qualityLabel) {
  if (!currentPlayingVideo) return;

  const audioLang = dlAudioLangSelect ? dlAudioLangSelect.value : 'default';
  const subLang = dlSubLangSelect ? dlSubLangSelect.value : 'none';
  const embedSubs = dlEmbedSubCheck ? dlEmbedSubCheck.checked : true;

  downloadPanel.hidden = true;
  downloadToggleBtn.classList.remove('active');
  downloadProgressModal.hidden = false;
  updateDownloadProgress(0, 'queued', 'Starting download...', qualityLabel);

  try {
    const res = await fetch(`${API_BASE}/api/youtube/download/${currentPlayingVideo.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formatId,
        title: currentPlayingVideo.title,
        audioLang,
        subLang,
        embedSubs
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not start download');
    }

    activeDownloadJobId = data.jobId;
    pollDownloadStatus(qualityLabel);
  } catch (error) {
    updateDownloadProgress(0, 'error', error.message, qualityLabel);
  }
}

function pollDownloadStatus(qualityLabel) {
  stopDownloadPolling();

  downloadPollTimer = setInterval(async () => {
    if (!activeDownloadJobId) return;

    try {
      const res = await fetch(`${API_BASE}/api/youtube/download/status/${activeDownloadJobId}`);
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Download status unavailable');
      }

      updateDownloadProgress(data.progress, data.status, data.message, qualityLabel);

      if (data.status === 'done') {
        stopDownloadPolling();
        const jobId = activeDownloadJobId;
        activeDownloadJobId = null;
        try {
          await saveDownloadedFile(jobId, data.filename);
          setTimeout(() => {
            downloadProgressModal.hidden = true;
          }, 1200);
        } catch (error) {
          updateDownloadProgress(0, 'error', error.message, qualityLabel);
        }
        return;
      }

      if (data.status === 'error') {
        stopDownloadPolling();
        activeDownloadJobId = null;
      }
    } catch (error) {
      stopDownloadPolling();
      updateDownloadProgress(0, 'error', error.message, qualityLabel);
      activeDownloadJobId = null;
    }
  }, 700);
}

async function saveDownloadedFile(jobId, filename) {
  updateDownloadProgress(100, 'done', 'Saving file to your device...', '');

  const res = await fetch(`${API_BASE}/api/youtube/download/file/${jobId}`);
  if (!res.ok) {
    throw new Error('Could not save downloaded file');
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || 'video.mp4';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  updateDownloadProgress(100, 'done', 'Download complete!', '');
}

function updateDownloadProgress(progress, status, message, qualityLabel) {
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  downloadProgressBar.style.width = `${safeProgress}%`;
  downloadProgressPercent.textContent = `${Math.round(safeProgress)}%`;

  if (status === 'merging') {
    downloadProgressTitle.textContent = 'Merging video & audio';
  } else if (status === 'done') {
    downloadProgressTitle.textContent = 'Download ready';
  } else if (status === 'error') {
    downloadProgressTitle.textContent = 'Download failed';
  } else {
    downloadProgressTitle.textContent = qualityLabel
      ? `Downloading ${qualityLabel}`
      : 'Downloading video';
  }

  downloadProgressSubtitle.textContent = message || 'Please wait...';
  downloadProgressModal.dataset.status = status;
}

function stopDownloadPolling() {
  if (downloadPollTimer) {
    clearInterval(downloadPollTimer);
    downloadPollTimer = null;
  }
}

function setupPlayer() {
  playerClose.addEventListener('click', closePlayer);
  playerModal.addEventListener('click', (e) => {
    if (e.target === playerModal) closePlayer();
  });
}

function setLoading(active) {
  loadSpinner.hidden = !active;
  loadStatus.hidden = !active;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function hideError() {
  errorMessage.hidden = true;
  errorMessage.textContent = '';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;');
}

function switchView(viewName, params = {}) {
  currentView = viewName;
  hideError();
  noResults.hidden = true;
  searchResultsInfo.hidden = true;

  if (viewName === 'home') {
    categoriesBar.hidden = false;
    feedMode = 'recommended';
    loadVideos({ reset: true });
    return;
  }

  categoriesBar.hidden = true;
  videoGrid.innerHTML = '';
  loadSpinner.hidden = true;
  loadStatus.hidden = true;

  if (viewName === 'watch-later') {
    const videos = storage.getWatchLater();
    contentTitle.textContent = `Watch later (${videos.length})`;
    if (!videos.length) {
      videoGrid.innerHTML = `
        <div class="empty-view-state">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          <h3>Your Watch Later list is empty</h3>
          <p>Click the clock icon on any video thumbnail or player to save it for later.</p>
        </div>
      `;
    } else {
      appendVideos(videos);
    }
  } else if (viewName === 'liked-videos') {
    const videos = storage.getLiked();
    contentTitle.textContent = `Liked videos (${videos.length})`;
    if (!videos.length) {
      videoGrid.innerHTML = `
        <div class="empty-view-state">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/></svg>
          <h3>No liked videos yet</h3>
          <p>Save your favorite videos to your Liked Videos list.</p>
        </div>
      `;
    } else {
      appendVideos(videos);
    }
  } else if (viewName === 'subscriptions') {
    contentTitle.textContent = 'Subscriptions';
    const videos = storage.getLiked();
    if (!videos.length) {
      videoGrid.innerHTML = `
        <div class="empty-view-state">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/></svg>
          <h3>Your subscription feed</h3>
          <p>Videos from channels you subscribe to will appear here.</p>
        </div>
      `;
    } else {
      appendVideos(videos);
    }
  } else if (viewName === 'library') {
    contentTitle.textContent = 'Library & Playlists';
    renderLibraryView();
  } else if (viewName === 'playlist-view') {
    const playlists = storage.getCustomPlaylists();
    const pl = playlists.find((p) => p.id === params.playlistId);
    if (pl) {
      contentTitle.textContent = `${pl.title} (${pl.videos.length})`;
      if (!pl.videos.length) {
        videoGrid.innerHTML = '<div class="empty-view-state"><h3>This playlist is empty</h3><p>Add videos using the Save button in the video player.</p></div>';
      } else {
        appendVideos(pl.videos);
      }
    }
  }
}

function renderLibraryView() {
  const watchLater = storage.getWatchLater();
  const liked = storage.getLiked();
  const custom = storage.getCustomPlaylists();

  videoGrid.innerHTML = `
    <div class="library-grid">
      <div class="playlist-card" id="libWatchLater">
        <div class="playlist-card-cover">
          ${watchLater[0] ? `<img src="${escapeAttr(watchLater[0].thumbnail)}" alt="">` : '<svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;color:#aaa;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>'}
          <div class="playlist-card-badge">${watchLater.length} videos</div>
        </div>
        <div class="playlist-card-info">
          <div class="playlist-card-title">Watch later</div>
          <div class="playlist-card-count">Auto playlist</div>
        </div>
      </div>

      <div class="playlist-card" id="libLiked">
        <div class="playlist-card-cover">
          ${liked[0] ? `<img src="${escapeAttr(liked[0].thumbnail)}" alt="">` : '<svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;color:#ff4e45;"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3z"/></svg>'}
          <div class="playlist-card-badge">${liked.length} videos</div>
        </div>
        <div class="playlist-card-info">
          <div class="playlist-card-title">Liked videos</div>
          <div class="playlist-card-count">Auto playlist</div>
        </div>
      </div>

      ${custom.map((pl) => `
        <div class="playlist-card custom-pl-card" data-pl-id="${escapeAttr(pl.id)}">
          <div class="playlist-card-cover">
            ${pl.videos[0] ? `<img src="${escapeAttr(pl.videos[0].thumbnail)}" alt="">` : '<svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;color:#aaa;"><path d="M4 10h12v2H4zm0-4h12v2H4zm0 8h8v2H4zm10 0v6l5-3z"/></svg>'}
            <div class="playlist-card-badge">${pl.videos.length} videos</div>
          </div>
          <div class="playlist-card-info">
            <div class="playlist-card-title">${escapeHtml(pl.title)}</div>
            <div class="playlist-card-count">Custom playlist</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  $('#libWatchLater')?.addEventListener('click', () => switchView('watch-later'));
  $('#libLiked')?.addEventListener('click', () => switchView('liked-videos'));
  $$('.custom-pl-card').forEach((card) => {
    card.addEventListener('click', () => {
      switchView('playlist-view', { playlistId: card.dataset.plId });
    });
  });
}

function setupSavePlaylistModal() {
  const savePlaylistModal = $('#savePlaylistModal');
  const savePlaylistModalClose = $('#savePlaylistModalClose');
  const playerSaveBtn = $('#playerSaveBtn');
  const createPlaylistForm = $('#createPlaylistForm');
  const newPlaylistTitleInput = $('#newPlaylistTitleInput');

  playerSaveBtn?.addEventListener('click', () => {
    if (!currentPlayingVideo) return;
    openSavePlaylistModal(currentPlayingVideo);
  });

  savePlaylistModalClose?.addEventListener('click', () => {
    savePlaylistModal.hidden = true;
  });

  savePlaylistModal?.addEventListener('click', (e) => {
    if (e.target === savePlaylistModal) savePlaylistModal.hidden = true;
  });

  createPlaylistForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = newPlaylistTitleInput.value.trim();
    if (!title || !currentPlayingVideo) return;

    const newPl = storage.createPlaylist(title);
    storage.toggleVideoInPlaylist(newPl.id, currentPlayingVideo);
    newPlaylistTitleInput.value = '';
    openSavePlaylistModal(currentPlayingVideo);
  });
}

function openSavePlaylistModal(video) {
  const savePlaylistModal = $('#savePlaylistModal');
  const playlistChecklist = $('#playlistChecklist');

  const isWl = storage.isWatchLater(video.id);
  const isLk = storage.isLiked(video.id);
  const customPlaylists = storage.getCustomPlaylists();

  playlistChecklist.innerHTML = `
    <label class="playlist-check-item">
      <input type="checkbox" id="chkWatchLater" ${isWl ? 'checked' : ''}>
      <span>Watch Later</span>
    </label>
    <label class="playlist-check-item">
      <input type="checkbox" id="chkLiked" ${isLk ? 'checked' : ''}>
      <span>Liked Videos</span>
    </label>
    ${customPlaylists.map((pl) => {
      const inPl = pl.videos.some((v) => v.id === video.id);
      return `
        <label class="playlist-check-item">
          <input type="checkbox" class="chk-custom-pl" data-pl-id="${escapeAttr(pl.id)}" ${inPl ? 'checked' : ''}>
          <span>${escapeHtml(pl.title)}</span>
        </label>
      `;
    }).join('')}
  `;

  $('#chkWatchLater')?.addEventListener('change', () => {
    storage.toggleWatchLater(video);
  });

  $('#chkLiked')?.addEventListener('change', () => {
    storage.toggleLiked(video);
  });

  $$('.chk-custom-pl').forEach((chk) => {
    chk.addEventListener('change', () => {
      storage.toggleVideoInPlaylist(chk.dataset.plId, video);
    });
  });

  savePlaylistModal.hidden = false;
}

function setupSidebar() {
  menuBtn.addEventListener('click', toggleSidebar);
  sidebarOverlay.addEventListener('click', closeSidebar);

  $$('.sidebar-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      $$('.sidebar-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      closeSidebar();

      const view = item.dataset.view || 'home';
      switchView(view);
    });
  });
}

function toggleSidebar() {
  sidebarOpen ? closeSidebar() : openSidebar();
}

function openSidebar() {
  sidebarOpen = true;
  sidebar.classList.add('open');
  sidebarOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeSidebar() {
  sidebarOpen = false;
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('active');
  if (playerModal.hidden) {
    document.body.style.overflow = '';
  }
}

function setupSearch() {
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    performSearch(searchInput.value.trim());
  });

  searchInput.addEventListener('input', () => {
    if (!searchInput.value.trim()) {
      clearSearch();
    }
  });
}

async function performSearch(query) {
  const q = query.trim();
  if (!q) {
    clearSearch();
    return;
  }

  feedMode = 'search';
  currentQuery = q;
  contentTitle.textContent = `Search results for "${q}"`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  await loadVideos({ reset: true });
}

async function clearSearch() {
  if (feedMode === 'recommended' && !currentQuery) return;

  feedMode = 'recommended';
  currentQuery = '';
  searchInput.value = '';
  contentTitle.textContent = 'Recommended';
  searchResultsInfo.hidden = true;
  noResults.hidden = true;
  await loadVideos({ reset: true });
}

function setupVoiceSearch() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    voiceBtn.addEventListener('click', () => {
      alert('Voice search is not supported in this browser. Try Chrome or Edge.');
    });
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-IN';

  speechRecognition.onstart = () => {
    isListening = true;
    voiceBtn.classList.add('listening');
    voiceIndicator.hidden = false;
  };

  speechRecognition.onend = () => {
    isListening = false;
    voiceBtn.classList.remove('listening');
    voiceIndicator.hidden = true;
  };

  speechRecognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    searchInput.value = transcript;
    if (event.results[event.results.length - 1].isFinal) {
      performSearch(transcript.trim());
    }
  };

  speechRecognition.onerror = (event) => {
    isListening = false;
    voiceBtn.classList.remove('listening');
    voiceIndicator.hidden = true;
    if (event.error !== 'aborted') {
      alert('Voice search error: ' + event.error);
    }
  };

  voiceBtn.addEventListener('click', () => {
    if (isListening) {
      speechRecognition.stop();
    } else {
      searchInput.focus();
      speechRecognition.start();
    }
  });
}

function setupCreateModal() {
  createBtn.addEventListener('click', () => {
    createModal.hidden = false;
    closeAllDropdowns();
  });

  createModalClose.addEventListener('click', () => {
    createModal.hidden = true;
  });

  createModal.addEventListener('click', (e) => {
    if (e.target === createModal) createModal.hidden = true;
  });

  uploadVideoBtn.addEventListener('click', () => {
    createModal.hidden = true;
    window.open(YOUTUBE_STUDIO_UPLOAD, '_blank', 'noopener,noreferrer');
  });

  goLiveBtn.addEventListener('click', () => {
    createModal.hidden = true;
    window.open(YOUTUBE_STUDIO_LIVE, '_blank', 'noopener,noreferrer');
  });

  createPostBtn.addEventListener('click', () => {
    createModal.hidden = true;
    window.open('https://studio.youtube.com/', '_blank', 'noopener,noreferrer');
  });
}

function setupDropdowns() {
  notificationBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !notificationDropdown.hidden;
    closeAllDropdowns();
    if (!isOpen) {
      notificationDropdown.hidden = false;
      renderNotifications();
    }
  });

  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !profileDropdown.hidden;
    closeAllDropdowns();
    if (!isOpen) profileDropdown.hidden = false;
  });

  markAllRead.addEventListener('click', () => {
    notifications.forEach((n) => {
      if (!readNotificationIds.includes(n.id)) {
        readNotificationIds.push(n.id);
      }
    });
    localStorage.setItem('mytube_read_notifications', JSON.stringify(readNotificationIds));
    updateNotificationBadge();
    renderNotifications();
  });

  document.addEventListener('click', closeAllDropdowns);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSidebar();
      closeAllDropdowns();
      createModal.hidden = true;
      closePlayer();
      stopDownloadPolling();
      downloadProgressModal.hidden = true;
      if (isListening && speechRecognition) speechRecognition.stop();
    }
  });
}

function closeAllDropdowns() {
  notificationDropdown.hidden = true;
  profileDropdown.hidden = true;
}

async function fetchNotifications() {
  try {
    const res = await fetch(`${API_BASE}/api/notifications`);
    if (!res.ok) throw new Error('Server unavailable');
    const data = await res.json();
    notifications = data.notifications || [];
  } catch {
    notifications = getFallbackNotifications();
  }
  updateNotificationBadge();
  if (!notificationDropdown.hidden) renderNotifications();
}

function getFallbackNotifications() {
  return [
    {
      id: 'n1',
      title: 'New trending videos loaded from YouTube',
      time: 'Just now',
      thumbnail: 'https://picsum.photos/seed/n1/160/90',
      unread: true
    },
    {
      id: 'n2',
      title: 'Search YouTube directly from the MyTube search bar',
      time: '5 hours ago',
      thumbnail: 'https://picsum.photos/seed/n2/160/90',
      unread: true
    }
  ];
}

function updateNotificationBadge() {
  const unreadCount = notifications.filter(
    (n) => n.unread && !readNotificationIds.includes(n.id)
  ).length;

  if (unreadCount > 0) {
    notificationBadge.hidden = false;
    notificationBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
  } else {
    notificationBadge.hidden = true;
  }
}

function renderNotifications() {
  if (!notifications.length) {
    notificationList.innerHTML = '<p class="notification-empty">No notifications yet</p>';
    return;
  }

  notificationList.innerHTML = notifications.map((n) => {
    const isUnread = n.unread && !readNotificationIds.includes(n.id);
    return `
      <div class="notification-item ${isUnread ? 'unread' : ''}" data-id="${n.id}">
        <img class="notification-thumb" src="${escapeAttr(n.thumbnail)}" alt="">
        <div class="notification-content">
          <p class="notification-title">${escapeHtml(n.title)}</p>
          <p class="notification-time">${escapeHtml(n.time)}</p>
        </div>
      </div>
    `;
  }).join('');

  $$('.notification-item').forEach((item) => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      if (!readNotificationIds.includes(id)) {
        readNotificationIds.push(id);
        localStorage.setItem('mytube_read_notifications', JSON.stringify(readNotificationIds));
      }
      item.classList.remove('unread');
      updateNotificationBadge();
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
