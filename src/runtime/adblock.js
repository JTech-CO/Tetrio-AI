// Ad blocking for TETR.IO desktop via CDP Network.setBlockedURLs.
// The whole ad stack (Freestar/prebid + Google Ad Manager + Primis video) boots from
// main-frame loader scripts; blocking these domains prevents every ad iframe from spawning.
// NOTE: www.google.com is NOT blocked (reCAPTCHA is needed for login).

const BLOCKED_URL_PATTERNS = [
  // Google ads (NOT google.com itself)
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googletagservices.com/*',
  '*://*.googleadservices.com/*',
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  // Freestar (tetr.io's ad mediator) + its prebid server
  '*://*.pub.network/*',
  '*://*.fsrv.io/*',
  '*://*.t13.io/*',
  '*://*.btloader.com/*',
  '*://*.blockthrough.com/*',
  // Primis / Sekindo video player
  '*://*.primis.tech/*',
  '*://*.sekindo.com/*',
  // Header-bidding / SSP partners observed live in the app
  '*://*.pubmatic.com/*',
  '*://*.openx.net/*',
  '*://*.criteo.com/*',
  '*://*.rubiconproject.com/*',
  '*://*.amazon-adsystem.com/*',
  '*://*.3lift.com/*',
  '*://*.media.net/*',
  '*://*.smartadserver.com/*',
  '*://*.pm-serv.co/*',
  '*://*.gumgum.com/*',
  '*://*.indexww.com/*',
  '*://*.adnxs.com/*',
  '*://*.adnxs-simple.com/*',
  '*://*.yellowblue.io/*',
  '*://*.presage.io/*',
  '*://*.ogury.com/*',
  '*://*.a-mo.net/*',
  '*://*.undertone.com/*',
  '*://*.yieldmo.com/*',
  '*://*.sharethrough.com/*',
  '*://*.casalemedia.com/*',
  '*://*.33across.com/*',
  '*://*.adsrvr.org/*',
  '*://*.bidswitch.net/*',
  '*://*.everesttech.net/*',
  '*://*.demdex.net/*',
  '*://*.agkn.com/*',
  '*://*.crwdcntrl.net/*',
  '*://*.quantserve.com/*',
  '*://*.scorecardresearch.com/*',
  '*://*.amplitude.com/*',
  '*://*.sentry.io/*',
  '*://*.adinplay.com/*',
  '*://*.aiptag.com/*',
];

// Cosmetic cleanup: hide leftover empty ad containers.
const COSMETIC_CSS = `
  [id^="google_ads_iframe"], [id*="SekindoSPlayer"], #primisPlayerContainerDiv,
  [id^="primis_container"], #videoContainerDiv, #adContainerDiv, #adVpaid, #adIma,
  #adDisplayBanner, .fs-sticky-footer, .fs-slot-wrapper, .fs-video, #fs-sticky-footer,
  [id^="fs-slot"], [class*="siderail"], [id*="siderail" i] { display: none !important; }
`;

async function applyAdblock(tetrio) {
  await tetrio.client.Network.setBlockedURLs({ urls: BLOCKED_URL_PATTERNS });
}

async function applyCosmetics(tetrio) {
  await tetrio.eval(`(() => {
    if (document.getElementById('__adblock_css')) return 'already';
    const s = document.createElement('style');
    s.id = '__adblock_css';
    s.textContent = ${JSON.stringify(COSMETIC_CSS)};
    (document.head || document.documentElement).appendChild(s);
    return 'applied';
  })()`);
}

// Remove ad iframes/containers from the DOM. The page's ad code keeps CREATING iframe
// elements even when their network requests are blocked; left alone they accumulate over
// minutes and eventually crash the renderer (window shrinks to minimum + freezes). Sweeping
// them out periodically keeps the DOM small. TETR.IO itself renders to a <canvas>, so no
// same-origin/recaptcha iframe the game needs is touched.
const SWEEP_SCRIPT = `(() => {
  let removed = 0;
  const KEEP = /(^about:blank$)?/; // (unused placeholder)
  for (const f of Array.from(document.getElementsByTagName('iframe'))) {
    let src = '';
    try { src = f.src || ''; } catch (e) {}
    // Keep only same-origin tetr.io iframes and Google reCAPTCHA (needed for login).
    if (src.startsWith('https://tetr.io') || src.includes('recaptcha')) continue;
    try { f.remove(); removed++; } catch (e) {}
  }
  // Known ad container shells.
  const sel = '[id^="google_ads_iframe"],[id*="SekindoSPlayer"],#primisPlayerContainerDiv,'
    + '[id^="primis_container"],#videoContainerDiv,#adContainerDiv,#adVpaid,#adIma,'
    + '#adDisplayBanner,[id^="fs-slot"],[class*="fs-sticky"],[class*="fs-slot"],[class*="fs-video"]';
  for (const el of Array.from(document.querySelectorAll(sel))) { try { el.remove(); removed++; } catch (e) {} }
  return removed;
})()`;

async function sweepAds(tetrio) {
  try { return await tetrio.eval(SWEEP_SCRIPT); } catch (e) { return -1; }
}

module.exports = { BLOCKED_URL_PATTERNS, applyAdblock, applyCosmetics, sweepAds, COSMETIC_CSS };
