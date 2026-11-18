const { app } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

require('../src/main.js');

function request(method, route, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: 8977,
      method,
      path: route,
      headers
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('local API timeout')));
    req.end(body);
  });
}

app.whenReady().then(async () => {
  const origin = 'safari-web-extension://e0b5d7c7-c079-484b-8825-44d261383cb6';
  const tokenPath = path.join(app.getPath('userData'), 'api-token.txt');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const preflight = await request('OPTIONS', '/add', {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-api-token'
  });
  const untrusted = await request('OPTIONS', '/add', {
    Origin: 'https://example.com',
    'Access-Control-Request-Method': 'POST'
  });
  const unauthorized = await request('POST', '/add', {
    Origin: origin,
    'Content-Type': 'application/json',
    'X-Api-Token': 'wrong-token'
  }, '{"links":[]}');
  const authorized = await request('POST', '/add', {
    Origin: origin,
    'Content-Type': 'application/json',
    'X-Api-Token': token
  }, '{"links":[]}');
  const pass = preflight.status === 204
    && preflight.headers['access-control-allow-origin'] === origin
    && untrusted.status === 403
    && !untrusted.headers['access-control-allow-origin']
    && unauthorized.status === 401
    && unauthorized.headers['access-control-allow-origin'] === origin
    && authorized.status === 200;
  console.log(pass ? 'SAFARI_CORS_PASS' : 'SAFARI_CORS_FAIL', JSON.stringify({
    preflight: preflight.status,
    untrusted: untrusted.status,
    unauthorized: unauthorized.status,
    authorized: authorized.status
  }));
  app.exit(pass ? 0 : 1);
}).catch((error) => {
  console.error('FATAL', error && error.stack || error);
  app.exit(1);
});
