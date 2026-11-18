// 网页视频嗅探：本地起一个页面，验证能挖出 video/og:video/m3u8
const http = require('http');
const { sniffPage } = require('../src/net/sniff');

const html = `<!doctype html><html><head>
<meta property="og:video" content="https://cdn.test/movie.m3u8">
</head><body>
<video src="/media/clip.mp4"></video>
<script>window.__DATA__ = {"src":"https://cdn.test/stream.mpd"}</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(0, '127.0.0.1', async () => {
  const page = `http://127.0.0.1:${server.address().port}/watch/123`;
  const r = await sniffPage(page);
  const urls = r.items.map((x) => x.url);
  const kinds = r.items.map((x) => x.kind);
  console.log('ITEMS', urls.length, JSON.stringify(kinds));
  const ok = urls.some((u) => u.endsWith('/media/clip.mp4'))
    && urls.some((u) => u.includes('movie.m3u8'))
    && urls.some((u) => u.includes('stream.mpd'))
    && kinds.includes('hls') && kinds.includes('dash');
  console.log(ok ? 'UNIT_SNIFF_PASS' : 'UNIT_SNIFF_FAIL ' + JSON.stringify(urls));
  server.close(); process.exit(0);
});
