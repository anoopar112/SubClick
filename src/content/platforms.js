(function (root) {
  'use strict';

  function detectPlatform(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return 'youtube';
    }
    if (host === 'netflix.com' || host.endsWith('.netflix.com')) {
      return 'netflix';
    }
    return null;
  }

  /**
   * Walks a DOM subtree and extracts clean subtitle lines without relying on
   * layout-dependent `innerText` (so hidden/zero-opacity native containers still
   * preserve `<br>` line breaks accurately).
   */
  function extractLinesFromNode(node) {
    if (!node) return [];

    const chunks = [];

    function walk(current) {
      if (!current) return;

      // Text node
      if (current.nodeType === 3) {
        chunks.push(current.nodeValue || '');
        return;
      }

      // Element node
      if (current.nodeType !== 1) return;

      const tag = (current.tagName || '').toUpperCase();
      if (tag === 'BR') {
        chunks.push('\n');
        return;
      }

      const className = typeof current.className === 'string' ? current.className : '';
      const isLineBlock =
        tag === 'DIV' ||
        tag === 'P' ||
        className.includes('caption-visual-line');

      if (isLineBlock && chunks.length > 0 && chunks[chunks.length - 1] !== '\n') {
        chunks.push('\n');
      }

      const children = current.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }

      if (isLineBlock && chunks.length > 0 && chunks[chunks.length - 1] !== '\n') {
        chunks.push('\n');
      }
    }

    walk(node);

    return chunks
      .join('')
      .split(/\r?\n/)
      .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
      .filter(Boolean);
  }

  function getYouTubePlayer(doc) {
    const fs = doc.fullscreenElement;
    if (fs) {
      if (fs.classList && fs.classList.contains('html5-video-player')) return fs;
      if (typeof fs.querySelector === 'function') {
        const inner = fs.querySelector('#movie_player, .html5-video-player');
        if (inner) return inner;
      }
    }
    return (
      doc.querySelector('#movie_player') ||
      doc.querySelector('#shorts-player') ||
      doc.querySelector('.html5-video-player')
    );
  }

  function extractYouTubeSubtitle(doc) {
    const player = getYouTubePlayer(doc);
    if (!player) {
      return { text: '', container: null, player: null, hasImageSubtitles: false };
    }

    const container = player.querySelector('.ytp-caption-window-container');
    if (!container) {
      return { text: '', container: null, player, hasImageSubtitles: false };
    }

    const windows = container.querySelectorAll('.caption-window');
    const lines = [];

    if (windows.length > 0) {
      for (let i = 0; i < windows.length; i++) {
        const win = windows[i];
        const captionsText = win.querySelector('.captions-text') || win;
        lines.push(...extractLinesFromNode(captionsText));
      }
    } else {
      lines.push(...extractLinesFromNode(container));
    }

    return {
      text: lines.join('\n'),
      container,
      player,
      hasImageSubtitles: false
    };
  }

  function getNetflixPlayer(doc) {
    if (doc.fullscreenElement) {
      return doc.fullscreenElement;
    }
    return (
      doc.querySelector('.watch-video--player-view') ||
      doc.querySelector('[data-uia="player"]') ||
      doc.querySelector('.watch-video') ||
      (doc.querySelector('video') ? doc.querySelector('video').parentElement : null)
    );
  }

  function extractNetflixSubtitle(doc) {
    const player = getNetflixPlayer(doc);
    const container = doc.querySelector('.player-timedtext');
    if (!container) {
      return { text: '', container: null, player, hasImageSubtitles: false };
    }

    const textContainers = container.querySelectorAll('.player-timedtext-text-container');
    const lines = [];

    if (textContainers.length > 0) {
      for (let i = 0; i < textContainers.length; i++) {
        lines.push(...extractLinesFromNode(textContainers[i]));
      }
    } else {
      lines.push(...extractLinesFromNode(container));
    }

    const text = lines.join('\n');
    const hasImageSubtitles = !text && Boolean(container.querySelector('svg, image, img'));

    return {
      text,
      container,
      player,
      hasImageSubtitles
    };
  }

  function extractSubtitleState(platform, doc) {
    const rootDoc = doc || document;
    if (platform === 'youtube') {
      return extractYouTubeSubtitle(rootDoc);
    }
    if (platform === 'netflix') {
      return extractNetflixSubtitle(rootDoc);
    }
    return { text: '', container: null, player: null, hasImageSubtitles: false };
  }

  function getActiveVideo(player, doc) {
    const rootDoc = doc || document;
    if (player && typeof player.querySelector === 'function') {
      const vid = player.querySelector('video');
      if (vid) return vid;
    }
    return rootDoc.querySelector('video');
  }

  function isVideoPlaying(player, doc) {
    const video = getActiveVideo(player, doc);
    if (!video) return false;
    return !video.paused && !video.ended;
  }

  function pauseVideo(platform, player, doc) {
    if (platform === 'netflix' && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      // Pass a primitive string in `detail` so it crosses Firefox's Xray vision boundary cleanly
      window.dispatchEvent(new CustomEvent('subclick:netflix-control', { detail: 'pause' }));
      return;
    }
    const video = getActiveVideo(player, doc);
    if (video && !video.paused) {
      try {
        video.pause();
      } catch (_) {}
    }
  }

  function playVideo(platform, player, doc) {
    if (platform === 'netflix' && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('subclick:netflix-control', { detail: 'play' }));
      return;
    }
    const video = getActiveVideo(player, doc);
    if (video && video.paused) {
      try {
        const maybePromise = video.play();
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => {});
        }
      } catch (_) {}
    }
  }

  function getVideoTitle(platform, doc) {
    const rootDoc = doc || document;
    if (platform === 'youtube') {
      const heading = rootDoc.querySelector(
        'h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1'
      );
      if (heading && heading.textContent && heading.textContent.trim()) {
        return heading.textContent.trim();
      }
      return String(rootDoc.title || '').replace(/\s*-\s*YouTube$/i, '').trim();
    }

    if (platform === 'netflix') {
      const titleEl = rootDoc.querySelector('[data-uia="video-title"]');
      if (titleEl && titleEl.textContent && titleEl.textContent.trim()) {
        return titleEl.textContent.trim();
      }
      return String(rootDoc.title || '').replace(/\s*-\s*Netflix$/i, '').trim();
    }

    return String(rootDoc.title || '').trim();
  }

  const api = {
    detectPlatform,
    extractLinesFromNode,
    extractYouTubeSubtitle,
    extractNetflixSubtitle,
    extractSubtitleState,
    getActiveVideo,
    isVideoPlaying,
    pauseVideo,
    playVideo,
    getVideoTitle
  };

  root.SubClickPlatforms = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
