const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');

function getYtDlpPath() {
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const customBin = path.join(__dirname, 'bin', binaryName);
  if (fs.existsSync(customBin)) {
    return customBin;
  }
  const moduleBin = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', binaryName);
  if (fs.existsSync(moduleBin)) {
    return moduleBin;
  }
  return customBin;
}

const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;
let isUpdatingYtDlp = false;
let updatePromise = null;

function getYtDlpCommonArgs() {
  return [
    ...getYtDlpCookieArgs(),
    '--extractor-args', 'youtube:player_client=android,web'
  ];
}

function getYtDlpCookieArgs() {
  const base64 = process.env.YOUTUBE_COOKIES_BASE64;
  const text = process.env.YOUTUBE_COOKIES_TEXT;
  const configuredFile = process.env.YOUTUBE_COOKIES_FILE;

  let cookieFile = configuredFile;
  if (!cookieFile && (base64 || text)) {
    cookieFile = path.join(os.tmpdir(), 'mytube-youtube-cookies.txt');
    try {
      const cookieText = base64
        ? Buffer.from(base64, 'base64').toString('utf8')
        : text;
      fs.writeFileSync(cookieFile, cookieText, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn('[downloadService] Could not prepare YouTube cookies:', err.message);
      return [];
    }
  }

  if (!cookieFile || !fs.existsSync(cookieFile)) return [];
  return ['--cookies', cookieFile];
}

function sanitizeFilename(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseDownloadProgress(line) {
  const percentMatch = String(line).match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (percentMatch) return { progress: Math.min(99, parseFloat(percentMatch[1])) };

  const mergeMatch = String(line).match(/\[Merger\]|Merging formats/i);
  if (mergeMatch) return { progress: 99, status: 'merging' };

  return null;
}

function fetchFileWithRedirects(url, destPath, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Too many redirects while downloading yt-dlp'));
    }

    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchFileWithRedirects(res.headers.location, destPath, maxRedirects - 1)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download yt-dlp binary (HTTP ${res.statusCode})`));
      }

      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => resolve(destPath));
      });
      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const ytdlpPath = getYtDlpPath();
    const commonArgs = getYtDlpCommonArgs();
    const child = spawn(ytdlpPath, [...commonArgs, ...args], { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const lines = stderr.split('\n').map((s) => s.trim());
        const errorLines = lines.filter((s) => s.startsWith('ERROR:') || s.toLowerCase().includes('error'));
        const cleanErr = errorLines.pop() || lines.filter(Boolean).pop() || `yt-dlp exited with code ${code}`;
        reject(new Error(cleanErr));
      }
    });
  });
}

async function getYtDlpVersion() {
  try {
    const version = await runYtDlp(['--version']);
    return version.trim();
  } catch (err) {
    return 'unknown';
  }
}

async function updateYtDlp() {
  if (isUpdatingYtDlp && updatePromise) {
    return updatePromise;
  }

  isUpdatingYtDlp = true;
  updatePromise = (async () => {
    try {
      const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const binDir = path.join(__dirname, 'bin');
      if (!fs.existsSync(binDir)) {
        fs.mkdirSync(binDir, { recursive: true });
      }

      const targetPath = getYtDlpPath();

      if (fs.existsSync(targetPath)) {
        try {
          console.log('[downloadService] Running yt-dlp -U update...');
          const stdout = await runYtDlp(['-U']);
          console.log('[downloadService] yt-dlp update output:', stdout.trim());
          const version = await getYtDlpVersion();
          return { success: true, method: 'cli', version, message: stdout.trim() };
        } catch (cliErr) {
          console.warn('[downloadService] yt-dlp -U attempt failed, downloading latest binary from GitHub Releases:', cliErr.message);
        }
      }

      const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binaryName}`;
      const tempPath = path.join(binDir, `${binaryName}.tmp`);
      const finalPath = path.join(binDir, binaryName);

      console.log(`[downloadService] Downloading latest yt-dlp binary from ${downloadUrl}...`);
      await fetchFileWithRedirects(downloadUrl, tempPath);

      if (process.platform !== 'win32') {
        fs.chmodSync(tempPath, 0o755);
      }

      fs.renameSync(tempPath, finalPath);
      console.log('[downloadService] yt-dlp binary updated successfully!');

      const version = await getYtDlpVersion();
      return { success: true, method: 'download', version, message: `Updated to ${version}` };
    } finally {
      isUpdatingYtDlp = false;
      updatePromise = null;
    }
  })();

  return updatePromise;
}

async function ensureYtDlp() {
  const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const customBin = path.join(__dirname, 'bin', binaryName);

  if (!fs.existsSync(customBin)) {
    try {
      console.log('[downloadService] Initializing yt-dlp binary...');
      await updateYtDlp();
    } catch (err) {
      console.warn('[downloadService] Failed to initialize custom yt-dlp binary:', err.message);
    }
  }
}

function getFormatOptions(formats) {
  const list = formats || [];
  const options = [];
  const seenHeights = new Set();

  const combined = list
    .filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .filter((f) => ['mp4', 'webm', 'mkv'].includes((f.ext || '').toLowerCase()))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  combined.forEach((f) => {
    const height = f.height || 0;
    if (!height || seenHeights.has(height)) return;
    seenHeights.add(height);
    options.push({
      id: String(f.format_id),
      label: `${height}p`,
      sublabel: 'Video + Audio (MP4)',
      height,
      formatId: String(f.format_id),
      ext: 'mp4',
      size: f.filesize || f.filesize_approx || null,
      sizeLabel: formatBytes(f.filesize || f.filesize_approx),
      type: 'combined'
    });
  });

  const videoOnly = list
    .filter((f) => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'))
    .filter((f) => (f.ext || '').toLowerCase() === 'mp4' || (f.ext || '').toLowerCase() === 'webm')
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  videoOnly.forEach((f) => {
    const height = f.height || 0;
    if (!height || seenHeights.has(height)) return;
    seenHeights.add(height);
    options.push({
      id: `merge-${height}`,
      label: `${height}p`,
      sublabel: 'Video + Audio (merged MP4)',
      height,
      formatId: `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,
      ext: 'mp4',
      size: f.filesize || f.filesize_approx || null,
      sizeLabel: formatBytes(f.filesize || f.filesize_approx),
      type: 'merged'
    });
  });

  const maxHeight = Math.max(0, ...options.map((o) => o.height));

  options.unshift({
    id: 'best',
    label: 'Best quality',
    sublabel: maxHeight ? `Up to ${maxHeight}p · MP4` : 'Highest available · MP4',
    height: maxHeight || 9999,
    formatId: 'bestvideo+bestaudio/best',
    ext: 'mp4',
    size: null,
    sizeLabel: null,
    type: 'best'
  });

  options.push({
    id: 'audio-mp3',
    label: 'Audio only (MP3)',
    sublabel: 'High quality MP3 audio',
    height: -1,
    formatId: 'audio-mp3',
    ext: 'mp3',
    size: null,
    sizeLabel: 'Audio',
    type: 'audio'
  });

  options.push({
    id: 'audio-m4a',
    label: 'Audio only (M4A)',
    sublabel: 'AAC Audio container (M4A)',
    height: -2,
    formatId: 'audio-m4a',
    ext: 'm4a',
    size: null,
    sizeLabel: 'Audio',
    type: 'audio'
  });

  return options.sort((a, b) => b.height - a.height);
}

async function fetchVideoFormats(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  let output;
  try {
    output = await runYtDlp([
      '--dump-single-json',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificates',
      '--no-playlist',
      '--skip-download',
      url
    ]);
  } catch (err) {
    console.warn('[downloadService] Format fetch failed, updating yt-dlp and retrying...', err.message);
    await updateYtDlp();
    output = await runYtDlp([
      '--dump-single-json',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificates',
      '--no-playlist',
      '--skip-download',
      url
    ]);
  }

  const data = JSON.parse(output);

  const audioLangMap = new Map();
  (data.formats || []).forEach((f) => {
    if (f.acodec && f.acodec !== 'none' && f.language) {
      const code = f.language.toLowerCase();
      let name = code.toUpperCase();
      if (code === 'en' || code.startsWith('en')) name = 'English';
      else if (code === 'hi' || code.startsWith('hi')) name = 'Hindi';
      else if (code === 'hi-latn' || code.includes('latn')) name = 'Hinglish (Latin)';
      audioLangMap.set(code, { code, name });
    }
  });

  if (!audioLangMap.has('en')) audioLangMap.set('en', { code: 'en', name: 'English (Default)' });
  if (!audioLangMap.has('hi')) audioLangMap.set('hi', { code: 'hi', name: 'Hindi' });

  const subLangMap = new Map();
  subLangMap.set('none', { code: 'none', name: 'None / Off' });

  const allSubs = { ...(data.subtitles || {}), ...(data.automatic_captions || {}) };
  Object.keys(allSubs).forEach((langKey) => {
    const code = langKey.toLowerCase();
    let name = langKey;
    if (code === 'en' || code.startsWith('en')) name = 'English';
    else if (code === 'hi' || code.startsWith('hi')) name = 'Hindi';
    else if (code === 'hi-latn' || code.includes('latn')) name = 'Hinglish (Latin Hindi)';
    else return;

    if (!subLangMap.has(code)) {
      subLangMap.set(code, { code: langKey, name });
    }
  });

  if (!subLangMap.has('en')) subLangMap.set('en', { code: 'en', name: 'English' });
  if (!subLangMap.has('hi')) subLangMap.set('hi', { code: 'hi', name: 'Hindi' });
  if (!subLangMap.has('hi-Latn')) subLangMap.set('hi-Latn', { code: 'hi-Latn', name: 'Hinglish (Latin Hindi)' });

  return {
    title: data.title || 'video',
    duration: data.duration || 0,
    thumbnail: data.thumbnail || null,
    options: getFormatOptions(data.formats || []),
    audioLanguages: Array.from(audioLangMap.values()),
    subtitles: Array.from(subLangMap.values())
  };
}

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  if (job.filePath && fs.existsSync(job.filePath)) {
    fs.unlink(job.filePath, () => {});
  }

  jobs.delete(jobId);
}

function scheduleJobCleanup(jobId) {
  setTimeout(() => cleanupJob(jobId), JOB_TTL_MS);
}

async function runDownloadJob(jobId, videoId, formatId, title, options = {}) {
  const job = jobs.get(jobId);
  if (!job) return;

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const baseName = sanitizeFilename(title);
  const outputTemplate = path.join(os.tmpdir(), `mytube-${jobId}`);

  const { audioLang, subLang, embedSubs } = options;

  job.status = 'downloading';
  job.progress = 0;
  job.message = 'Starting download...';

  try {
    let args = [];
    const isAudioMp3 = formatId === 'audio-mp3';
    const isAudioM4a = formatId === 'audio-m4a';

    if (isAudioMp3) {
      let formatSpec = 'bestaudio';
      if (audioLang && audioLang !== 'default') {
        formatSpec = `bestaudio[language=${audioLang}]/bestaudio`;
      }
      args = [
        '--no-playlist',
        '--no-check-certificates',
        '-f', formatSpec,
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', `${outputTemplate}.%(ext)s`,
        '--ffmpeg-location', ffmpegStatic,
        '--no-warnings',
        '--no-call-home',
        '--newline',
        '--progress',
        url
      ];
    } else if (isAudioM4a) {
      let formatSpec = 'bestaudio[ext=m4a]/bestaudio';
      if (audioLang && audioLang !== 'default') {
        formatSpec = `bestaudio[language=${audioLang}][ext=m4a]/bestaudio[language=${audioLang}]/bestaudio[ext=m4a]/bestaudio`;
      }
      args = [
        '--no-playlist',
        '--no-check-certificates',
        '-f', formatSpec,
        '-x',
        '--audio-format', 'm4a',
        '-o', `${outputTemplate}.%(ext)s`,
        '--ffmpeg-location', ffmpegStatic,
        '--no-warnings',
        '--no-call-home',
        '--newline',
        '--progress',
        url
      ];
    } else {
      let formatSpec = formatId;
      if (audioLang && audioLang !== 'default' && formatId.includes('bestaudio')) {
        formatSpec = formatId.replace(/bestaudio\[ext=m4a\]|bestaudio/g, `bestaudio[language=${audioLang}]`);
      }

      args = [
        '--no-playlist',
        '--no-check-certificates',
        '-f', formatSpec,
        '-o', `${outputTemplate}.%(ext)s`,
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegStatic,
        '--no-warnings',
        '--no-call-home',
        '--newline',
        '--progress'
      ];

      if (subLang && subLang !== 'none') {
        const targetSubLangs = subLang === 'hi-Latn'
          ? 'hi-Latn,hi,en'
          : `${subLang},en,hi,hi-Latn`;

        args.push(
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs', targetSubLangs,
          '--no-abort-on-error'
        );

        if (embedSubs !== false) {
          args.push(
            '--embed-subs',
            '--compat-options', 'no-keep-subs'
          );
        }
      }

      args.push(url);
    }

    const ytdlpPath = getYtDlpPath();
    const commonArgs = getYtDlpCommonArgs();
    const child = spawn(ytdlpPath, [...commonArgs, ...args], { shell: false, windowsHide: true });
    let childStderr = '';

    child.stdout.on('data', (chunk) => {
      const lines = String(chunk).split('\n');
      lines.forEach((line) => {
        const parsed = parseDownloadProgress(line);
        if (!parsed) return;
        job.progress = parsed.progress;
        job.status = parsed.status === 'merging' ? 'merging' : 'downloading';
        job.message = parsed.status === 'merging'
          ? 'Merging audio/video...'
          : `Downloading... ${Math.round(parsed.progress)}%`;
      });
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      childStderr += text;
      const lines = text.split('\n');
      lines.forEach((line) => {
        const parsed = parseDownloadProgress(line);
        if (!parsed) return;
        job.progress = parsed.progress;
        job.status = parsed.status === 'merging' ? 'merging' : 'downloading';
        job.message = parsed.status === 'merging'
          ? 'Merging audio/video...'
          : `Downloading... ${Math.round(parsed.progress)}%`;
      });
    });

    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else {
          const lines = childStderr.split('\n').map((s) => s.trim());
          const errorLines = lines.filter((s) => s.startsWith('ERROR:') || s.toLowerCase().includes('error'));
          const cleanErr = errorLines.pop() || lines.filter(Boolean).pop() || `yt-dlp exited with code ${code}`;
          reject(new Error(cleanErr));
        }
      });
    });

    const candidates = fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(`mytube-${jobId}`))
      .map((name) => path.join(os.tmpdir(), name));

    const targetExt = isAudioMp3 ? '.mp3' : (isAudioM4a ? '.m4a' : '.mp4');
    const downloadedFile = candidates.find((file) => file.endsWith(targetExt)) || candidates[0];

    if (!downloadedFile || !fs.existsSync(downloadedFile)) {
      throw new Error(`Download finished but ${targetExt.slice(1).toUpperCase()} file was not created.`);
    }

    job.status = 'done';
    job.progress = 100;
    job.message = 'Ready to save';
    job.filePath = downloadedFile;
    job.filename = `${baseName}${targetExt}`;
    scheduleJobCleanup(jobId);
  } catch (error) {
    if (!options._isRetry) {
      console.warn('[downloadService] Download error caught. Auto-updating yt-dlp and retrying...', error.message);
      try {
        job.message = 'Updating yt-dlp downloader...';
        await updateYtDlp();
        job.message = 'Retrying download...';
        return await runDownloadJob(jobId, videoId, formatId, title, { ...options, _isRetry: true });
      } catch (updateErr) {
        console.error('[downloadService] Auto-update retry failed:', updateErr.message);
      }
    }

    job.status = 'error';
    job.progress = 0;
    job.message = error.message || 'Download failed';
    scheduleJobCleanup(jobId);
  }
}

function normalizePlaylistUrl(urlOrId) {
  const str = String(urlOrId || '').trim();
  if (str.startsWith('http://') || str.startsWith('https://')) {
    return str;
  }
  return `https://www.youtube.com/playlist?list=${str}`;
}

async function fetchPlaylistInfo(playlistUrlOrId) {
  const url = normalizePlaylistUrl(playlistUrlOrId);
  let output;
  try {
    output = await runYtDlp([
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificates',
      url
    ]);
  } catch (err) {
    console.warn('[downloadService] Playlist fetch failed, updating yt-dlp and retrying...', err.message);
    await updateYtDlp();
    output = await runYtDlp([
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--no-call-home',
      '--no-check-certificates',
      url
    ]);
  }

  const data = JSON.parse(output);
  const entries = (data.entries || []).map((e) => ({
    id: e.id,
    title: e.title || 'Untitled Video',
    duration: e.duration || 0,
    url: e.url || `https://www.youtube.com/watch?v=${e.id}`
  }));

  return {
    id: data.id || '',
    title: data.title || 'YouTube Playlist',
    videoCount: entries.length,
    entries: entries.slice(0, 100)
  };
}

async function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const cmd = `Compress-Archive -Path "${sourceDir}\\*" -DestinationPath "${zipPath}" -Force`;
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true });
    
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Failed to create zip archive (exit code ${code})`));
    });
  });
}

async function runPlaylistDownloadJob(jobId, playlistUrlOrId, formatId, playlistTitle, options = {}) {
  const job = jobs.get(jobId);
  if (!job) return;

  const url = normalizePlaylistUrl(playlistUrlOrId);
  const baseName = sanitizeFilename(playlistTitle || 'playlist');
  const tempDir = path.join(os.tmpdir(), `mytube-pl-dir-${jobId}`);
  const zipPath = path.join(os.tmpdir(), `mytube-pl-${jobId}.zip`);

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  job.status = 'downloading';
  job.progress = 0;
  job.message = 'Starting playlist download...';

  try {
    let args;
    if (formatId === 'audio-mp3') {
      args = [
        '--no-check-certificates',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-o', path.join(tempDir, '%(playlist_index)s - %(title)s.%(ext)s'),
        '--ffmpeg-location', ffmpegStatic,
        '--no-warnings',
        '--no-call-home',
        '--newline',
        '--progress',
        url
      ];
    } else if (formatId === '720p') {
      args = [
        '--no-check-certificates',
        '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]',
        '-o', path.join(tempDir, '%(playlist_index)s - %(title)s.%(ext)s'),
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegStatic,
        '--no-warnings',
        '--no-call-home',
        '--newline',
        '--progress',
        url
      ];
    } else {
      args = [
        '--no-check-certificates',
        '-f', 'bestvideo+bestaudio/best',
        '-o', path.join(tempDir, '%(playlist_index)s - %(title)s.%(ext)s'),
        '--merge-output-format', 'mp4',
        '--ffmpeg-location', ffmpegStatic,
        '--no-warnings',
        '--no-call-home',
        '--newline',
        '--progress',
        url
      ];
    }

    const ytdlpPath = getYtDlpPath();
    const commonArgs = getYtDlpCommonArgs();
    const child = spawn(ytdlpPath, [...commonArgs, ...args], { shell: false, windowsHide: true });
    let childStderr = '';

    let currentItem = 1;
    let totalItems = 1;
    let itemProgress = 0;

    const parseLine = (line) => {
      const itemMatch = String(line).match(/\[download\]\s+Downloading\s+item\s+(\d+)\s+of\s+(\d+)/i);
      if (itemMatch) {
        currentItem = parseInt(itemMatch[1], 10);
        totalItems = Math.max(1, parseInt(itemMatch[2], 10));
        job.currentItem = currentItem;
        job.totalItems = totalItems;
      }

      const percentMatch = String(line).match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (percentMatch) {
        itemProgress = parseFloat(percentMatch[1]);
        const overall = Math.min(95, (((currentItem - 1) + (itemProgress / 100)) / totalItems) * 100);
        job.progress = Math.round(overall);
        job.message = `Downloading item ${currentItem} of ${totalItems} (${Math.round(itemProgress)}%)`;
      }

      if (String(line).includes('[Merger]') || String(line).includes('Merging formats')) {
        job.message = `Merging video & audio for item ${currentItem} of ${totalItems}...`;
      }
    };

    child.stdout.on('data', (chunk) => String(chunk).split('\n').forEach(parseLine));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      childStderr += text;
      text.split('\n').forEach(parseLine);
    });

    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else {
          const lines = childStderr.split('\n').map((s) => s.trim());
          const errorLines = lines.filter((s) => s.startsWith('ERROR:') || s.toLowerCase().includes('error'));
          const cleanErr = errorLines.pop() || lines.filter(Boolean).pop() || `yt-dlp exited with code ${code}`;
          reject(new Error(cleanErr));
        }
      });
    });

    job.status = 'zipping';
    job.progress = 96;
    job.message = 'Bundling playlist videos into ZIP archive...';

    await zipDirectory(tempDir, zipPath);

    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}

    job.status = 'done';
    job.progress = 100;
    job.message = 'Playlist zip archive ready!';
    job.filePath = zipPath;
    job.filename = `${baseName}.zip`;
    scheduleJobCleanup(jobId);
  } catch (error) {
    if (!options._isRetry) {
      console.warn('[downloadService] Playlist download error caught. Auto-updating yt-dlp and retrying...', error.message);
      try {
        job.message = 'Updating yt-dlp downloader...';
        await updateYtDlp();
        job.message = 'Retrying playlist download...';
        return await runPlaylistDownloadJob(jobId, playlistUrlOrId, formatId, playlistTitle, { ...options, _isRetry: true });
      } catch (updateErr) {
        console.error('[downloadService] Playlist auto-update retry failed:', updateErr.message);
      }
    }

    job.status = 'error';
    job.progress = 0;
    job.message = error.message || 'Playlist download failed';
    scheduleJobCleanup(jobId);
  }
}

function startPlaylistDownload(playlistUrlOrId, formatId, playlistTitle) {
  const jobId = randomUUID();
  jobs.set(jobId, {
    jobId,
    type: 'playlist',
    playlistUrlOrId,
    formatId,
    status: 'queued',
    progress: 0,
    message: 'Preparing playlist download...',
    filePath: null,
    filename: `${sanitizeFilename(playlistTitle || 'playlist')}.zip`
  });

  runPlaylistDownloadJob(jobId, playlistUrlOrId, formatId, playlistTitle);
  return jobId;
}

function startDownload(videoId, formatId, title, options = {}) {
  const jobId = randomUUID();
  jobs.set(jobId, {
    jobId,
    videoId,
    formatId,
    options,
    status: 'queued',
    progress: 0,
    message: 'Preparing download...',
    filePath: null,
    filename: `${sanitizeFilename(title)}.mp4`
  });

  runDownloadJob(jobId, videoId, formatId, title, options);
  return jobId;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

module.exports = {
  getYtDlpPath,
  getYtDlpCookieArgs,
  getYtDlpCommonArgs,
  getYtDlpVersion,
  updateYtDlp,
  ensureYtDlp,
  fetchVideoFormats,
  fetchPlaylistInfo,
  startDownload,
  startPlaylistDownload,
  getJob,
  cleanupJob
};

