export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  // Top frame only: DarkLens skips iframes entirely.
  allFrames: false,
  main() {
    console.log('[DarkLens] content script loaded');
  },
});
