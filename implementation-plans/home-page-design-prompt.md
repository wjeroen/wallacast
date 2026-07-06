# Design brief: Wallacast home page (logged-out landing page)

> Hand this whole file to Claude Design. The deliverable is a static mockup, not production code. The Wallacast team will wire it up afterwards.

## What Wallacast is (context, keep this in mind while designing)

Wallacast is a self-hostable read-it-later app that turns saved articles into listenable audio. You save an article (or subscribe to a podcast), Wallacast fetches the content, an LLM rewrites it into a natural narration script, TTS reads it aloud, and Whisper timestamps make the text light up paragraph by paragraph while the audio plays (read-along). It also does AI summaries, comment narration for EA Forum and LessWrong, and two-way Wallabag sync. Users bring their own AI provider API keys, so the operator pays nothing for their usage. It is a PWA, most users will use it on their phone.

## The job of this page

Today, logged-out visitors see only a bare login card that explains nothing. This page replaces it. It must market the app very well with few words wasted: a visitor should understand what Wallacast does within seconds, see it (screenshots), and either register, log in, or try a demo. It is the landing page of a small hosted instance run by one person, not a corporate SaaS page. Keep it honest, compact, and personal.

## Hard constraints

1. **Match the in-app design exactly.** The page must look like the app it opens into. Design tokens (from the real App.css):
   - Dark theme (default): page background `#0f172a`, cards and header `#1e293b`, raised elements and borders `#334155`, hover `#475569`.
   - Dark text tones: headings `#f1f5f9`, body `#e2e8f0`, secondary `#cbd5e1`, muted `#94a3b8`, faint `#64748b`.
   - Light theme: page `#f1f5f9`, cards `#ffffff`, borders `#e2e8f0`, hover `#cbd5e1`, text tones inverted (`#0f172a` headings down to `#94a3b8` faint).
   - Primary action blue `#3b82f6`, hover `#2563eb`. The wordmark and link accents use `#60a5fa`. Podcast accent purple `#a855f7`.
   - Border radius 0.375rem for inputs and buttons, 0.5rem for cards. System font stack. Spacing in rem, roughly 1rem to 1.5rem paddings. Buttons look like the app's: solid blue primary, bordered ghost secondary.
   - Both themes must be designed. Theme is toggled via a `data-theme="light"` attribute on the root, CSS variables preferred.
2. **Header rule (important):** the page uses the same top header bar as the app (logo left, `wallacast` wordmark in `#60a5fa`). In the app, the top-right corner holds the user menu ("Hi, name" with a chevron dropdown). On this page, that exact position holds a **"Log in" button instead**. Clicking it opens a dropdown panel (same style as the app's user dropdown: `#1e293b` card, `#334155` border) containing the existing username + password form and a "create account" toggle. Login must NOT be the centerpiece of the page, it lives in that corner.
3. **Mobile first.** Design for a ~390px wide phone screen first, then a wider desktop layout. No horizontal scrolling ever.
4. **All copy is placeholder.** The owner rewrites every sentence himself. Write clearly-marked placeholder copy (short!) so the layout is realistic, but do not polish wording, and keep every text block short enough that the real copy can be one sentence.

## Suggested page structure (adapt freely, this is a starting point)

1. **Hero**: one-line what-it-is, one supporting line, primary button "Create account", secondary button "Try the demo" (opens a read-only demo of the app, feature exists separately). A phone screenshot beside or under it.
2. **See it work**: 2 or 3 phone screenshots in a row (library, read-along highlighting, player). Short caption each.
3. **How it works**: 3 tiny steps (save an article, generate audio with your own API key, listen with read-along). Icons in the app's style (lucide icons are what the app uses).
4. **Features**: compact grid of 4 to 6 items max (read-along highlighting, podcasts and transcripts, AI summaries, EA Forum and LessWrong comments, Wallabag sync, bring-your-own-keys pricing). One line each.
5. **Cost honesty block**: small card explaining you bring your own API keys and pay providers directly, cents per article. This is a selling point, make it visible but small.
6. **Footer**: GitHub link (the repo is public), a short vibe-coded-at-your-own-risk note, and a "contact me for help" line. All placeholder wording.

## Images: use placeholders, exact sizes

Use solid red `#ef4444` rectangles with white centered text stating the image name and pixel size (inline SVG or data URI, so the mockup is a single self-contained file). The real screenshots will be swapped in later by the owner. Manifest:

| Placeholder name | Display size (CSS px) | Asset size to request (2x) | Content when real |
| --- | --- | --- | --- |
| `shot-library` | 300 x 650 phone frame | 600 x 1300 | Library tab with a few items, dark theme |
| `shot-readalong` | 300 x 650 phone frame | 600 x 1300 | Fullscreen player, paragraph highlighted mid-audio |
| `shot-player` | 300 x 650 phone frame | 600 x 1300 | Mini player over the library, audio playing |
| `shot-desktop` | 960 x 600, desktop section only | 1920 x 1200 | Desktop-width library with fullscreen player open |

The existing real logo asset is `/logo-1e293b.png` (square app icon on a `#1e293b` tile), you may reference it by that path in the mockup.

## Deliverable

One self-contained HTML file with inline CSS (and minimal inline JS only for the login dropdown toggle and theme toggle). No external fonts, no CDN, no frameworks. Both themes working via the `data-theme` attribute. Phone layout and desktop layout via media queries.

## Do not

- Do not use em dashes or en dashes anywhere, not even in comments. No semicolons as sentence breaks in comments either.
- Do not invent features that were not listed above.
- Do not make the page long. One or two phone-screens of scrolling on mobile is the target.
- Do not center a big login form on the page, login lives in the top-right dropdown only.
- Do not add cookie banners, newsletters, testimonials, pricing tables, or any SaaS boilerplate.
