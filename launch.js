#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = 3456;
const APP_DIR = path.resolve(__dirname, 'app');
const CLEARING_DIR = path.join(os.homedir(), '.clearing');
const CONFIG_PATH = path.join(CLEARING_DIR, 'config.json');
const UNIS_PATH = path.join(CLEARING_DIR, 'universities.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // Serve config.js dynamically from ~/.clearing/config.json
  if (urlPath === '/config.js') {
    const config = loadConfig();
    const body = config
      ? `window.UCAS_CONFIG = ${JSON.stringify(config)};\n`
      : 'window.UCAS_CONFIG = null;\n';
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(body);
    return;
  }

  // Serve universities-data.js and universities.json from ~/.clearing/universities.json
  if (urlPath === '/universities-data.js' || urlPath === '/data/universities.json') {
    try {
      const raw = fs.readFileSync(UNIS_PATH, 'utf8');
      if (urlPath === '/universities-data.js') {
        const body = `window.UNIVERSITIES_DATA = ${raw};\n`;
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        res.end(body);
      } else {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(raw);
      }
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  const filePath = path.join(APP_DIR, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent path traversal outside app/
  if (!filePath.startsWith(APP_DIR + path.sep) && filePath !== APP_DIR) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nClearing Helper running at ${url}`);
  if (!loadConfig()) {
    console.log(`WARNING: No config found at ${CONFIG_PATH}`);
    console.log('         The app will prompt for API credentials on first use.');
  }
  if (!fs.existsSync(UNIS_PATH)) {
    console.log(`WARNING: No universities data found at ${UNIS_PATH}`);
    console.log('         The Universities tab will be empty.');
  }
  console.log('\nPress Ctrl+C to stop.\n');
  exec(`open "${url}"`);
});
