const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const downloadService = require('./downloadService');

const logFile = path.join(__dirname, 'debug.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  console.log(msg);
}

fs.writeFileSync(logFile, '--- DEBUG START ---\n');

async function runDebug() {
  log(`Platform: ${process.platform}, Node: ${process.version}`);
  
  const ytdlpPath = downloadService.getYtDlpPath();
  log(`YTDLP_PATH resolved: ${ytdlpPath}`);
  log(`YTDLP_PATH exists: ${fs.existsSync(ytdlpPath)}`);

  try {
    const version = await downloadService.getYtDlpVersion();
    log(`Current yt-dlp version: ${version}`);
  } catch (err) {
    log(`Failed to get version: ${err.message}`);
  }

  log('Attempting updateYtDlp()...');
  try {
    const updateRes = await downloadService.updateYtDlp();
    log(`updateYtDlp result: ${JSON.stringify(updateRes)}`);
  } catch (err) {
    log(`updateYtDlp error: ${err.stack || err.message}`);
  }

  const updatedPath = downloadService.getYtDlpPath();
  log(`Post-update YTDLP_PATH: ${updatedPath}`);
  try {
    const newVersion = await downloadService.getYtDlpVersion();
    log(`Post-update yt-dlp version: ${newVersion}`);
  } catch (err) {
    log(`Failed to get post-update version: ${err.message}`);
  }

  const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  log(`Testing format fetch on ${testUrl}...`);

  const child = spawn(updatedPath, [
    '--dump-single-json',
    '--no-warnings',
    '--no-call-home',
    '--no-check-certificates',
    '--no-playlist',
    '--skip-download',
    testUrl
  ], { shell: false, windowsHide: true });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });

  child.on('error', (err) => {
    log(`Child error spawn: ${err.stack || err.message}`);
  });

  child.on('close', (code) => {
    log(`Child exited with code ${code}`);
    log(`STDOUT length: ${stdout.length}`);
    log(`STDERR length: ${stderr.length}`);
    log(`STDERR content:\n${stderr}`);
    log('--- DEBUG END ---');
  });
}

runDebug().catch((err) => {
  log(`Fatal debug script error: ${err.stack || err.message}`);
});
