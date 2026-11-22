(function () {
  'use strict';

  function getNetflixPlayer() {
    try {
      const videoPlayer =
        window.netflix &&
        window.netflix.appContext &&
        window.netflix.appContext.state &&
        window.netflix.appContext.state.playerApp &&
        typeof window.netflix.appContext.state.playerApp.getAPI === 'function'
          ? window.netflix.appContext.state.playerApp.getAPI().videoPlayer
          : null;

      if (!videoPlayer || typeof videoPlayer.getAllPlayerSessionIds !== 'function') {
        return null;
      }

      const sessionIds = videoPlayer.getAllPlayerSessionIds();
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return null;
      }

      // Prefer active watch session if multiple exist
      const watchSession = sessionIds.find((id) => String(id).includes('watch')) || sessionIds[0];
      return videoPlayer.getVideoPlayerBySessionId(watchSession) || null;
    } catch (_) {
      return null;
    }
  }

  window.addEventListener('subclick:netflix-control', (event) => {
    const detail = event && event.detail;
    const action = typeof detail === 'string' ? detail : (detail && detail.action);
    if (action !== 'pause' && action !== 'play') return;

    const nfPlayer = getNetflixPlayer();
    if (nfPlayer && typeof nfPlayer[action] === 'function') {
      try {
        nfPlayer[action]();
        return;
      } catch (_) {
        // Fall back to HTML5 video element below
      }
    }

    const video = document.querySelector('video');
    if (video && typeof video[action] === 'function') {
      try {
        video[action]();
      } catch (_) {
        // Ignore autoplay/gesture rejection
      }
    }
  });
})();
