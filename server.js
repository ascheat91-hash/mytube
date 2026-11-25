const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const downloadService = require('./downloadService');

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const REGION = process.env.YOUTUBE_REGION || 'IN';

const LIVE_DISCOVERY_QUERIES = ['live', 'news', 'gaming', 'music', 'sports'];

let notifications = [
  {
    id: 'n1',
    title: 'CodeMaster uploaded: Advanced React Patterns',
    time: '2 hours ago',
    thumbnail: 'https://picsum.photos/seed/n1/160/90',
    unread: true
  },
  {
    id: 'n2',
    title: 'Wanderlust India: New video from your subscription',
    time: '5 hours ago',
    thumbnail: 'https://picsum.photos/seed/n2/160/90',
    unread: true
  },
  {
    id: 'n3',
    title: 'Your video "Morning Yoga" reached 2M views!',
    time: '1 day ago',
    thumbnail: 'https://picsum.photos/seed/n3/160/90',
    unread: false
  },
  {
    id: 'n4',
    title: 'Dev Academy posted: New Python tutorial series',
    time: '2 days ago',
    thumbnail: 'https://picsum.photos/seed/n4/160/90',
    unread: false
  }
];

app.use(express.json());
app.use(express.static(path.join(__dirname)));

function formatViews(count) {
  const n = Number(count) || 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B views`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K views`;
  return `${n} views`;
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function parseDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const h = Number(match[1] || 0);
  const m = Number(match[2] || 0);
  const s = Number(match[3] || 0);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatWatching(count) {
  const n = Number(count) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M watching`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K watching`;
  return `${n.toLocaleString()} watching`;
}

function mapVideoItem(item) {
  const id = item.id?.videoId || item.id;
  const snippet = item.snippet || {};
  const liveStatus = snippet.liveBroadcastContent || 'none';
  const isLive = liveStatus === 'live';
  const isUpcoming = liveStatus === 'upcoming';
  const concurrent = item.liveStreamingDetails?.concurrentViewers;

  let views;
  if (isLive && concurrent) {
    views = formatWatching(concurrent);
  } else {
    views = formatViews(item.statistics?.viewCount);
  }

  let age;
  if (isLive) age = 'Live now';
  else if (isUpcoming) age = 'Upcoming live';
  else age = timeAgo(snippet.publishedAt);

  return {
    id,
    title: snippet.title,
    channel: snippet.channelTitle,
    channelId: snippet.channelId,
    thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url,
    avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(snippet.channelId || id)}`,
    views,
    age,
    duration: isLive || isUpcoming ? '' : parseDuration(item.contentDetails?.duration),
    liveStatus,
    isLive,
    isUpcoming,
    concurrentViewers: concurrent ? Number(concurrent) : null,
    publishedAt: snippet.publishedAt
  };
}

async function youtubeFetch(endpoint, params) {
  if (!YOUTUBE_API_KEY) {
    const error = new Error('YouTube API key is not configured. Add YOUTUBE_API_KEY to your .env file.');
    error.status = 503;
    throw error;
  }

  const url = new URL(`${YOUTUBE_API}/${endpoint}`);
  Object.entries({ ...params, key: YOUTUBE_API_KEY }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.error?.message || 'YouTube API request failed');
    error.status = response.status;
    throw error;
  }

  return data;
}

async function enrichVideos(items) {
  const ids = items
    .map((item) => item.id?.videoId || item.id)
    .filter(Boolean);

  if (!ids.length) return [];

  const details = await youtubeFetch('videos', {
    part: 'snippet,statistics,contentDetails,liveStreamingDetails',
    id: ids.join(',')
  });

  const detailMap = new Map((details.items || []).map((item) => [item.id, item]));

  return ids
    .map((id) => detailMap.get(id))
    .filter(Boolean)
    .map(mapVideoItem);
}

async function fetchLiveVideos({ maxResults = 12, pageToken = '', query = 'live' } = {}) {
  const data = await youtubeFetch('search', {
    part: 'snippet',
    type: 'video',
    eventType: 'live',
    q: query,
    regionCode: REGION,
    maxResults,
    pageToken
  });

  const videos = (await enrichVideos(data.items || [])).filter((v) => v.isLive);
  return {
    videos,
    nextPageToken: data.nextPageToken || null
  };
}

async function fetchHomeLiveVideos() {
  const results = await Promise.all(
    LIVE_DISCOVERY_QUERIES.map((query) =>
      fetchLiveVideos({ maxResults: 4, query }).catch(() => ({ videos: [] }))
    )
  );

  const seen = new Set();
  const videos = [];

  results.forEach((result) => {
    result.videos.forEach((video) => {
      if (!seen.has(video.id)) {
        seen.add(video.id);
        videos.push(video);
      }
    });
  });

  return videos.slice(0, 12);
}

app.get('/api/youtube/status', (_req, res) => {
  res.json({ configured: Boolean(YOUTUBE_API_KEY) });
});

app.get('/api/youtube/feed', async (req, res) => {
  try {
    const pageToken = req.query.pageToken || '';
    const category = (req.query.category || '').trim();

    if (category && category.toLowerCase() !== 'all') {
      const searchParams = {
        part: 'snippet',
        type: 'video',
        q: category,
        maxResults: 20,
        pageToken,
        regionCode: REGION,
        relevanceLanguage: 'en'
      };
      const searchData = await youtubeFetch('search', searchParams);
      const videos = await enrichVideos(searchData.items || []);

      return res.json({
        videos,
        nextPageToken: searchData.nextPageToken || null,
        totalResults: searchData.pageInfo?.totalResults || videos.length,
        category
      });
    }

    if (!pageToken) {
      const [liveVideos, trendingData] = await Promise.all([
        fetchHomeLiveVideos().catch(() => []),
        youtubeFetch('videos', {
          part: 'snippet,statistics,contentDetails,liveStreamingDetails',
          chart: 'mostPopular',
          regionCode: REGION,
          maxResults: 20
        })
      ]);

      const trendingVideos = (trendingData.items || []).map(mapVideoItem);
      const liveIds = new Set(liveVideos.map((v) => v.id));
      const merged = [
        ...liveVideos,
        ...trendingVideos.filter((v) => !liveIds.has(v.id))
      ];

      return res.json({
        videos: merged,
        nextPageToken: trendingData.nextPageToken || null,
        totalResults: merged.length,
        liveCount: liveVideos.length
      });
    }

    const data = await youtubeFetch('videos', {
      part: 'snippet,statistics,contentDetails,liveStreamingDetails',
      chart: 'mostPopular',
      regionCode: REGION,
      maxResults: 20,
      pageToken
    });

    const videos = (data.items || []).map(mapVideoItem);

    res.json({
      videos,
      nextPageToken: data.nextPageToken || null,
      totalResults: data.pageInfo?.totalResults || videos.length
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/youtube/channel/:id', async (req, res) => {
  try {
    const data = await youtubeFetch('channels', {
      part: 'snippet,statistics,brandingSettings',
      id: req.params.id
    });

    if (!data.items?.length) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const item = data.items[0];
    const snippet = item.snippet || {};
    const stats = item.statistics || {};
    const branding = item.brandingSettings || {};

    const bannerUrl = branding.image?.bannerExternalUrl
      ? `${branding.image.bannerExternalUrl}=w1707-fcrop64=1,00005a57ffffa5a8-k-no-nd-mv`
      : null;

    res.json({
      channel: {
        id: item.id,
        title: snippet.title,
        handle: snippet.customUrl || `@${snippet.title.replace(/\s+/g, '').toLowerCase()}`,
        description: snippet.description || '',
        avatar: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url,
        bannerUrl,
        subscriberCount: formatViews(stats.subscriberCount).replace('views', 'subscribers'),
        subscriberCountRaw: Number(stats.subscriberCount) || 0,
        videoCount: Number(stats.videoCount) || 0,
        viewCount: formatViews(stats.viewCount),
        publishedAt: snippet.publishedAt
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/youtube/channel/:id/videos', async (req, res) => {
  try {
    const pageToken = req.query.pageToken || '';
    const data = await youtubeFetch('search', {
      part: 'snippet',
      channelId: req.params.id,
      type: 'video',
      order: 'date',
      maxResults: 20,
      pageToken
    });

    const videos = await enrichVideos(data.items || []);

    res.json({
      videos,
      nextPageToken: data.nextPageToken || null,
      totalResults: data.pageInfo?.totalResults || videos.length
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/youtube/live', async (req, res) => {
  try {
    const pageToken = req.query.pageToken || '';
    const query = (req.query.q || 'live').trim();
    const result = await fetchLiveVideos({ maxResults: 20, pageToken, query });
    res.json({
      videos: result.videos,
      nextPageToken: result.nextPageToken,
      totalResults: result.videos.length,
      query
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/youtube/video/:id', async (req, res) => {
  try {
    const data = await youtubeFetch('videos', {
      part: 'snippet,statistics,contentDetails,liveStreamingDetails',
      id: req.params.id
    });

    if (!data.items?.length) {
      return res.status(404).json({ error: 'Video not found' });
    }

    res.json({ video: mapVideoItem(data.items[0]) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.get('/api/youtube/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const pageToken = req.query.pageToken || '';
    const includeLive = req.query.live !== '0';

    const searchParams = {
      part: 'snippet',
      type: 'video',
      q: query,
      maxResults: 20,
      pageToken,
      regionCode: REGION,
      relevanceLanguage: 'en'
    };

    const [searchData, liveData] = await Promise.all([
      youtubeFetch('search', searchParams),
      !pageToken && includeLive
        ? youtubeFetch('search', {
            part: 'snippet',
            type: 'video',
            eventType: 'live',
            q: query,
            maxResults: 8,
            regionCode: REGION
          }).catch(() => ({ items: [] }))
        : Promise.resolve({ items: [] })
    ]);

    const searchVideos = await enrichVideos(searchData.items || []);
    const liveVideos = (await enrichVideos(liveData.items || [])).filter((v) => v.isLive);
    const seenIds = new Set();
    const videos = [];

    [...liveVideos, ...searchVideos].forEach((video) => {
      if (!seenIds.has(video.id)) {
        seenIds.add(video.id);
        videos.push(video);
      }
    });

    res.json({
      videos,
      nextPageToken: searchData.nextPageToken || null,
      totalResults: searchData.pageInfo?.totalResults || videos.length,
      query
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

app.post('/api/youtube/playlist/info', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'Playlist URL or ID is required' });
    }

    const playlist = await downloadService.fetchPlaylistInfo(url);
    res.json({ playlist });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not fetch playlist info' });
  }
});

app.post('/api/youtube/playlist/download', (req, res) => {
  try {
    const { url, formatId, title } = req.body || {};
    if (!url || !formatId) {
      return res.status(400).json({ error: 'url and formatId are required' });
    }

    const jobId = downloadService.startPlaylistDownload(url, formatId, title || 'playlist');
    res.status(202).json({ jobId });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not start playlist download' });
  }
});

app.get('/api/youtube/download/formats/:id', async (req, res) => {
  try {
    const meta = await downloadService.fetchVideoFormats(req.params.id);
    res.json(meta);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not fetch download formats' });
  }
});

app.post('/api/youtube/download/:id', (req, res) => {
  try {
    const { formatId, title, audioLang, subLang, embedSubs } = req.body || {};
    if (!formatId) {
      return res.status(400).json({ error: 'formatId is required' });
    }

    const jobId = downloadService.startDownload(
      req.params.id,
      formatId,
      title || 'video',
      { audioLang, subLang, embedSubs }
    );
    res.status(202).json({ jobId });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not start download' });
  }
});

app.get('/api/youtube/download/status/:jobId', (req, res) => {
  const job = downloadService.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Download job not found' });
  }

  res.json({
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    filename: job.filename
  });
});

app.get('/api/youtube/download/file/:jobId', (req, res) => {
  const job = downloadService.getJob(req.params.jobId);
  if (!job || job.status !== 'done' || !job.filePath) {
    return res.status(404).json({ error: 'File not ready' });
  }

  res.download(job.filePath, job.filename, (err) => {
    downloadService.cleanupJob(req.params.jobId);
    if (err) {
      console.error('Download send error:', err.message);
    }
  });
});

app.post('/api/youtube/yt-dlp/update', async (_req, res) => {
  try {
    const result = await downloadService.updateYtDlp();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to update yt-dlp' });
  }
});

app.get('/api/youtube/yt-dlp/version', async (_req, res) => {
  try {
    const version = await downloadService.getYtDlpVersion();
    const binaryPath = downloadService.getYtDlpPath();
    res.json({ version, binaryPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/youtube/yt-dlp/debug', async (_req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const { spawn } = require('child_process');
    const binaryPath = downloadService.getYtDlpPath();
    const version = await downloadService.getYtDlpVersion();

    const child = spawn(binaryPath, [
      '--dump-single-json',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificates',
      '--no-playlist',
      '--skip-download',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    ], { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });

    await new Promise((resolve) => child.on('close', resolve));

    res.json({
      binaryPath,
      binaryExists: fs.existsSync(binaryPath),
      version,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
      stderrOutput: stderr,
      hasStdoutJson: stdout.trim().startsWith('{')
    });
  } catch (error) {
    res.status(500).json({ error: error.stack || error.message });
  }
});

app.get('/api/notifications', (_req, res) => {
  res.json({ notifications });
});

app.post('/api/notifications', (req, res) => {
  const { title, thumbnail } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  const notification = {
    id: 'n' + Date.now(),
    title,
    time: 'Just now',
    thumbnail: thumbnail || 'https://picsum.photos/seed/new/160/90',
    unread: true
  };

  notifications.unshift(notification);
  res.status(201).json(notification);
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`MyTube server running on port ${PORT}`);
  downloadService.ensureYtDlp().catch((err) => {
    console.warn('yt-dlp startup check warning:', err.message);
  });
  if (!YOUTUBE_API_KEY) {
    console.warn('Warning: YOUTUBE_API_KEY is not set. Add it to .env to load YouTube videos.');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server first:`);
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT} | Select OwningProcess -Unique`);
    console.error('Or set a different PORT in your .env file.');
    process.exit(1);
  }
  throw err;
});
