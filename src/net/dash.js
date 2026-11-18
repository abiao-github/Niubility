'use strict';

// DASH：用 videojs 的 mpd-parser 解析 MPD，产出视频/音频轨道分片列表。

const fs = require('fs');
const path = require('path');
const mpdParser = require('mpd-parser');
const { fetchBuffer } = require('./http');

async function readMpd(target, { signal } = {}) {
  if (/^https?:\/\//i.test(target)) {
    const { buffer, finalUrl } = await fetchBuffer(target, { signal });
    return { xml: buffer.toString('utf8'), baseUrl: finalUrl };
  }
  const filePath = target.replace(/^file:\/\//, '');
  return { xml: fs.readFileSync(filePath, 'utf8'), baseUrl: 'file://' + path.resolve(filePath) };
}

function playlistToParts(playlist, baseUrl) {
  const segments = playlist.segments || [];
  const parts = segments.map((s) => ({
    url: s.resolvedUri || new URL(s.uri, baseUrl).toString(),
    range: s.byterange || null,
    key: null,
    iv: null
  }));
  const first = segments[0];
  let init = null;
  if (first && first.map) {
    init = {
      url: first.map.resolvedUri || new URL(first.map.uri, baseUrl).toString(),
      range: first.map.byterange || null
    };
  }
  return { parts, init };
}

function pickAudio(manifest, baseUrl) {
  const groups = (manifest.mediaGroups && manifest.mediaGroups.AUDIO) || {};
  const candidates = [];
  for (const lang of Object.keys(groups)) {
    for (const name of Object.keys(groups[lang])) {
      const rendition = groups[lang][name];
      for (const pl of rendition.playlists || []) {
        candidates.push({
          playlist: pl,
          bandwidth: (pl.attributes && pl.attributes.BANDWIDTH) || 0,
          language: lang,
          autoselect: !!rendition.autoselect,
          isDefault: !!rendition.default
        });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.autoselect !== b.autoselect) return a.autoselect ? -1 : 1;
    return b.bandwidth - a.bandwidth;
  });
  const chosen = candidates[0];
  return { ...playlistToParts(chosen.playlist, baseUrl), info: chosen };
}

function pickVideo(manifest, baseUrl) {
  const lists = (manifest.playlists || []).slice();
  if (!lists.length) {
    const videoGroups = (manifest.mediaGroups && manifest.mediaGroups.VIDEO) || {};
    for (const lang of Object.keys(videoGroups)) {
      for (const name of Object.keys(videoGroups[lang])) {
        for (const pl of videoGroups[lang][name].playlists || []) lists.push(pl);
      }
    }
  }
  if (!lists.length) return null;
  lists.sort((a, b) => ((b.attributes && b.attributes.BANDWIDTH) || 0) - ((a.attributes && a.attributes.BANDWIDTH) || 0));
  const chosen = lists[0];
  return {
    ...playlistToParts(chosen, baseUrl),
    info: {
      bandwidth: (chosen.attributes && chosen.attributes.BANDWIDTH) || 0,
      codecs: chosen.attributes && chosen.attributes.CODECS,
      resolution: chosen.attributes && chosen.attributes.RESOLUTION
    }
  };
}

/**
 * 解析 MPD，返回轨道描述（video 必需，audio 可选，存在则需要 mux）。
 */
async function describe(target, { signal } = {}) {
  const { xml, baseUrl } = await readMpd(target, { signal });
  const manifest = mpdParser.parse(xml, { manifestUri: baseUrl });
  if (!manifest || (!manifest.playlists && !manifest.mediaGroups)) {
    throw new Error('MPD 解析失败');
  }

  const video = pickVideo(manifest, baseUrl);
  const audio = pickAudio(manifest, baseUrl);
  if (!video && !audio) throw new Error('MPD 里没有可用的轨道');
  if (video && !video.parts.length) throw new Error('视频轨道没有分片');

  const tracks = [];
  if (video) tracks.push({ name: 'video', ...video });
  if (audio && audio.parts.length) tracks.push({ name: 'audio', ...audio });

  return {
    kind: 'dash',
    ext: 'mp4',
    duration: manifest.duration || 0,
    isLive: manifest.type === 'dynamic' || !manifest.endList,
    variants: tracks.map((t) => ({ name: t.name, info: t.info })),
    tracks
  };
}

module.exports = { describe };
