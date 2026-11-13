// Desktop mode on a phone. Chrome's "Desktop site" lays every page out at least 980 px wide
// and ignores the page's viewport tag (Chrome calls it forcing "the viewport to be 980px",
// https://developer.chrome.com/blog/desktop-mode), so on a narrow screen Wallacast shrinks to
// a fraction of its size, and no single Chrome zoom suits both screens of a foldable. When
// the page is laid out wider than the screen, this zooms the whole page (CSS zoom on <html>)
// until it is as wide as the screen again, so desktop mode looks like the phone layout at
// the user's own Chrome zoom. Normal phone mode and computers lay the page out exactly as
// wide as the screen, so the zoom stays off there.
//
// Under that zoom, App.css keeps working because its viewport units go through --vw, --vh
// and --dvh (set here in px), its width rules are container queries on #root (a media query
// would still see the 980 px), and pageZoom() lets code that mixes getBoundingClientRect()
// (zoomed) with scrollTop (not zoomed) convert between the two.

let zoom = 1;

/** The zoom this module put on the page, 1 when it is off */
export function pageZoom(): number {
  return zoom;
}

// ?fitdebug=1 in the address shows the measurements in a corner, for a screenshot from a
// device where the fit looks wrong
const debug = new URLSearchParams(window.location.search).has('fitdebug');
let debugBox: HTMLDivElement | null = null;

function fit() {
  const root = document.documentElement;
  // The layout viewport: a fixed box over the whole window. getBoundingClientRect() answers
  // in window px, so the zoom set here does not change the answer.
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const { width: layoutWidth, height: layoutHeight } = probe.getBoundingClientRect();
  probe.remove();
  // The screen width in px at the user's Chrome zoom: the visible width times the pinch
  // zoom, a product that stays the same however far the user pinches in
  const vv = window.visualViewport;
  let screenWidth = vv ? vv.width * vv.scale : window.innerWidth;
  // Development only: pretend to be a narrow phone screen in desktop mode
  if (import.meta.env.DEV) {
    const pretend = Number(localStorage.getItem('wallacast-fit-test-screen'));
    if (pretend > 0) screenWidth = pretend;
  }
  const next = layoutWidth > screenWidth * 1.05 ? layoutWidth / screenWidth : 1;

  if (debug) {
    debugBox ??= Object.assign(document.createElement('div'), {
      style: 'position:fixed;left:0;bottom:0;z-index:99999;background:#000;color:#0f0;font:11px monospace;padding:2px 4px;pointer-events:none',
    });
    if (!debugBox.isConnected) document.body.appendChild(debugBox);
    debugBox.textContent = `layout ${layoutWidth.toFixed(0)}x${layoutHeight.toFixed(0)} vv ${vv?.width.toFixed(0)}x${vv?.scale.toFixed(3)} screen ${screen.width} dpr ${devicePixelRatio.toFixed(2)} zoom ${next.toFixed(3)}`;
  }

  if (next === 1 && zoom === 1) return;
  zoom = next;
  if (zoom === 1) {
    root.style.removeProperty('zoom');
    for (const unit of ['--vw', '--vh', '--dvh']) root.style.removeProperty(unit);
    return;
  }
  root.style.zoom = String(zoom);
  // px lengths are zoomed too, so a hundredth of the window is divided by the zoom first
  root.style.setProperty('--vw', `${layoutWidth / 100 / zoom}px`);
  root.style.setProperty('--vh', `${layoutHeight / 100 / zoom}px`);
  root.style.setProperty('--dvh', `${layoutHeight / 100 / zoom}px`);
}

/** Fit now and again whenever the window changes (folding, turning, the address bar) */
export function startDesktopFit() {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fit);
  };
  fit();
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
}
