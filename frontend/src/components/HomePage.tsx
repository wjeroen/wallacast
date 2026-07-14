import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, BookOpen, ChevronDown, ChevronLeft, ChevronRight, FileText, Github,
  KeyRound, LogIn, MessageCircle, Mic, Moon, Play, Plus, RefreshCw, Sun, UserPlus, Volume2,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { authAPI } from '../api';

// Landing-page screenshot carousel. The SVGs in public/landing are red placeholders,
// swap each for a real 600x1300 screenshot PNG and update the src here.
const SHOTS = [
  { src: '/landing/shot-library.svg', caption: 'Your library' },
  { src: '/landing/shot-readalong.svg', caption: 'Read along highlighting' },
  { src: '/landing/shot-player.svg', caption: 'The player' },
  { src: '/landing/shot-feed.svg', caption: 'Podcast feeds' },
  { src: '/landing/shot-summary.svg', caption: 'AI summaries' },
];

// Same initial-theme rules as index.html and App.tsx: stored 'light' wins, 'system'
// follows the OS, anything else is dark.
function initialIsLight(): boolean {
  try {
    const stored = localStorage.getItem('wallacast-theme');
    if (stored === 'light') return true;
    if (stored === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch { /* default dark */ }
  return false;
}

export function HomePage() {
  const { login, register, demoLogin, isLoading, error, clearError } = useAuthStore();

  // Login dropdown (lives top-right, where the user menu sits once logged in)
  const [loginOpen, setLoginOpen] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  // Whether this instance gates registration behind an invite code (public config).
  const [inviteRequired, setInviteRequired] = useState(false);
  // Password reset flow: forgotMode asks for a username, a ?reset= token from an emailed
  // link shows the choose-new-password form. notice/localError belong to these direct calls.
  const [forgotMode, setForgotMode] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const loginRef = useRef<HTMLDivElement>(null);

  const [isLight, setIsLight] = useState(initialIsLight);

  // Screenshot carousel
  const [shot, setShot] = useState(1);
  const [trackW, setTrackW] = useState(0);
  const trackWrapRef = useRef<HTMLDivElement>(null);
  const pointerX = useRef<number | null>(null);
  const skipClick = useRef(false);

  useEffect(() => {
    const measure = () => {
      if (trackWrapRef.current) setTrackW(trackWrapRef.current.clientWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    // The invite-code field only renders on instances that actually require one.
    authAPI.getConfig()
      .then((res) => setInviteRequired(!!res.data.inviteRequired))
      .catch(() => { /* leave false, the backend still enforces it */ });
  }, []);

  useEffect(() => {
    // An emailed reset link lands on /?reset=<token>. Open the dropdown in reset mode and
    // scrub the token from the address bar so it does not linger in the browser history.
    try {
      const token = new URLSearchParams(window.location.search).get('reset');
      if (token) {
        setResetToken(token);
        setLoginOpen(true);
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch { /* fine, the user can use the forgot flow instead */ }
  }, []);

  // Close the login dropdown on outside click
  useEffect(() => {
    if (!loginOpen) return;
    const onDown = (e: MouseEvent) => {
      if (loginRef.current && !loginRef.current.contains(e.target as Node)) setLoginOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [loginOpen]);

  const toggleTheme = () => {
    const next = !isLight;
    setIsLight(next);
    const t = next ? 'light' : 'dark';
    try { localStorage.setItem('wallacast-theme', t); } catch { /* fine */ }
    document.documentElement.setAttribute('data-theme', t);
  };

  const openAccountForm = (registerMode: boolean) => {
    setIsRegister(registerMode);
    setLoginOpen(true);
    clearError();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isRegister) {
      await register(username, password, displayName || undefined, email || undefined, inviteCode || undefined);
    } else {
      await login(username, password);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setWorking(true);
    setLocalError(null);
    setNotice(null);
    try {
      const res = await authAPI.forgotPassword(username);
      setNotice(res.data.message);
    } catch (err: any) {
      setLocalError(err.response?.data?.error || 'Something went wrong, try again later');
    } finally {
      setWorking(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setLocalError('The passwords do not match');
      return;
    }
    if (!resetToken) return;
    setWorking(true);
    setLocalError(null);
    try {
      const res = await authAPI.resetPassword(resetToken, newPassword);
      setResetToken(null);
      setNewPassword('');
      setConfirmPassword('');
      setNotice(res.data.message || 'Password changed. You can now sign in.');
      setIsRegister(false);
    } catch (err: any) {
      setLocalError(err.response?.data?.error || 'Could not reset the password');
    } finally {
      setWorking(false);
    }
  };

  const goTo = (i: number) => setShot(Math.max(0, Math.min(SHOTS.length - 1, i)));

  // Carousel geometry, mirrors the approved mockup: the active slide is centered,
  // slide width scales with the container, neighbors shrink and fade.
  const cw = trackW || 358;
  const slideW = Math.round(Math.min(260, Math.max(176, cw * 0.56)));
  const gap = 16;
  const trackX = Math.round(cw / 2 - (shot * (slideW + gap) + slideW / 2));

  return (
    <div className="home-page">
      <header className="app-header">
        <div className="app-logo-container">
          <img src="/logo-transparent.png?v=2" alt="wallacast logo" className="app-logo" />
          <h1>wallacast</h1>
        </div>
        <div className="header-right">
          <button className="home-icon-btn" onClick={toggleTheme} title="Toggle theme">
            {isLight ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <div className="user-menu-container" ref={loginRef}>
            <button
              className="home-login-trigger"
              onClick={() => { setLoginOpen(v => !v); clearError(); }}
            >
              <span>Log in</span>
              <ChevronDown size={16} className={loginOpen ? 'rotated' : ''} />
            </button>

            {loginOpen && (
              <div className="home-login-dropdown">
                <div className="home-login-title">
                  {resetToken ? 'Choose a new password'
                    : forgotMode ? 'Reset your password'
                    : isRegister ? 'Create your account' : 'Sign in to your account'}
                </div>

                {(localError || error) && (
                  <div className="login-error">
                    <AlertCircle size={18} />
                    <span>{localError || error}</span>
                  </div>
                )}
                {notice && !localError && <div className="login-notice">{notice}</div>}

                {resetToken ? (
                  <form onSubmit={handleReset} className="home-login-form">
                    <div className="form-group">
                      <label htmlFor="home-newpw">New password</label>
                      <input
                        id="home-newpw"
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Enter new password"
                        required
                        minLength={6}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="home-confirmpw">Confirm password</label>
                      <input
                        id="home-confirmpw"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Repeat new password"
                        required
                        minLength={6}
                        autoComplete="new-password"
                      />
                    </div>
                    <button type="submit" className="home-btn-primary home-login-submit" disabled={working}>
                      <span>{working ? 'Saving...' : 'Set new password'}</span>
                    </button>
                  </form>
                ) : forgotMode ? (
                  <form onSubmit={handleForgot} className="home-login-form">
                    <div className="form-group">
                      <label htmlFor="home-forgot-username">Username</label>
                      <input
                        id="home-forgot-username"
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Enter username"
                        required
                        minLength={3}
                        autoComplete="username"
                      />
                    </div>
                    <button type="submit" className="home-btn-primary home-login-submit" disabled={working}>
                      <span>{working ? 'Sending...' : 'Email me a reset link'}</span>
                    </button>
                    <button
                      type="button"
                      className="home-login-toggle"
                      onClick={() => { setForgotMode(false); setNotice(null); setLocalError(null); }}
                    >
                      Back to sign in
                    </button>
                  </form>
                ) : (
                <form onSubmit={handleSubmit} className="home-login-form">
                  <div className="form-group">
                    <label htmlFor="home-username">Username</label>
                    <input
                      id="home-username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Enter username"
                      required
                      minLength={3}
                      autoComplete="username"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="home-password">Password</label>
                    <input
                      id="home-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password"
                      required
                      minLength={6}
                      autoComplete={isRegister ? 'new-password' : 'current-password'}
                    />
                  </div>
                  {isRegister && inviteRequired && (
                    <div className="form-group">
                      <label htmlFor="home-invite">Invite code</label>
                      <input
                        id="home-invite"
                        type="text"
                        value={inviteCode}
                        onChange={(e) => setInviteCode(e.target.value)}
                        placeholder="Enter invite code"
                        required
                      />
                    </div>
                  )}
                  {isRegister && (
                    <>
                      <div className="form-group">
                        <label htmlFor="home-displayname">Display Name (optional)</label>
                        <input
                          id="home-displayname"
                          type="text"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Your display name"
                          autoComplete="name"
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="home-email">Email (optional)</label>
                        <input
                          id="home-email"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="your@email.com"
                          autoComplete="email"
                        />
                      </div>
                    </>
                  )}
                  <button type="submit" className="home-btn-primary home-login-submit" disabled={isLoading}>
                    {isLoading ? (
                      <span>Loading...</span>
                    ) : isRegister ? (
                      <><UserPlus size={18} /><span>Create Account</span></>
                    ) : (
                      <><LogIn size={18} /><span>Sign In</span></>
                    )}
                  </button>
                  {!isRegister && (
                    <button
                      type="button"
                      className="home-login-toggle"
                      onClick={() => { setForgotMode(true); clearError(); setNotice(null); setLocalError(null); }}
                    >
                      Forgot password?
                    </button>
                  )}
                  <button
                    type="button"
                    className="home-login-toggle"
                    onClick={() => { setIsRegister(v => !v); clearError(); }}
                  >
                    {isRegister ? 'Already have an account? Sign in' : "Don't have an account? Create one"}
                  </button>
                </form>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <h2 className="home-hero-title">Turn saved articles into a podcast.</h2>
          <p className="home-hero-sub">Wallacast reads them aloud and highlights each paragraph as it plays.</p>
          <div className="home-hero-actions">
            <button className="home-btn-primary" onClick={() => demoLogin()} disabled={isLoading}>
              <Play size={17} />
              <span>Try the demo</span>
            </button>
            <button className="home-btn-secondary" onClick={() => openAccountForm(true)}>
              <span>Create account</span>
            </button>
          </div>
          <p className="home-hero-note">The demo is read only, no signup needed.</p>
          {!loginOpen && error && (
            <div className="login-error home-hero-error">
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
          )}
        </section>

        <section className="home-section">
          <h3 className="home-section-title">How it works</h3>
          <div className="home-steps">
            <div className="home-step">
              <div className="home-step-icon"><Plus size={16} /></div>
              <div>
                <div className="home-step-name">Save an article</div>
                <div className="home-step-desc">Paste a link or sync your Wallabag.</div>
              </div>
            </div>
            <div className="home-step">
              <div className="home-step-icon"><Volume2 size={16} /></div>
              <div>
                <div className="home-step-name">Generate audio</div>
                <div className="home-step-desc">Your own API key does the work.</div>
              </div>
            </div>
            <div className="home-step">
              <div className="home-step-icon"><BookOpen size={16} /></div>
              <div>
                <div className="home-step-name">Listen along</div>
                <div className="home-step-desc">Text highlights in sync with the audio.</div>
              </div>
            </div>
          </div>
        </section>

        <section className="home-shots">
          <div
            className="home-shots-viewport"
            ref={trackWrapRef}
            onPointerDown={(e) => { pointerX.current = e.clientX; }}
            onPointerUp={(e) => {
              if (pointerX.current == null) return;
              const dx = e.clientX - pointerX.current;
              pointerX.current = null;
              if (Math.abs(dx) > 40) {
                skipClick.current = true;
                setTimeout(() => { skipClick.current = false; }, 200);
                goTo(shot + (dx < 0 ? 1 : -1));
              }
            }}
          >
            <div className="home-shots-track" style={{ transform: `translateX(${trackX}px)` }}>
              {SHOTS.map((s, k) => {
                const off = Math.abs(k - shot);
                return (
                  <div
                    key={s.src}
                    className="home-shot"
                    style={{
                      width: slideW,
                      transform: `scale(${off === 0 ? 1 : 0.9})`,
                      opacity: off === 0 ? 1 : off === 1 ? 0.75 : 0.45,
                    }}
                    onClick={() => { if (!skipClick.current) goTo(k); }}
                  >
                    <div className="home-shot-frame">
                      <img src={s.src} alt={s.caption} draggable={false} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="home-shots-nav">
            <button className="home-icon-btn" onClick={() => goTo(shot - 1)} title="Previous screen" style={{ opacity: shot === 0 ? 0.4 : 1 }}>
              <ChevronLeft size={16} />
            </button>
            <div className="home-shots-caption">{SHOTS[shot].caption}</div>
            <button className="home-icon-btn" onClick={() => goTo(shot + 1)} title="Next screen" style={{ opacity: shot === SHOTS.length - 1 ? 0.4 : 1 }}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="home-shots-dots">
            {SHOTS.map((s, k) => (
              <button key={s.src} onClick={() => goTo(k)} title={s.caption} className="home-dot-btn">
                <span className="home-dot" style={{ background: k === shot ? '#3b82f6' : 'var(--bg-raised)' }} />
              </button>
            ))}
          </div>
          <p className="home-shots-note">Red boxes stand in for real screenshots, cropped from the top.</p>
        </section>

        <section className="home-section home-narrow">
          <h3 className="home-section-title">What you get</h3>
          <div className="home-features">
            <div className="home-feature">
              <div className="home-feature-head" style={{ color: '#60a5fa' }}><BookOpen size={16} /><span>Read along</span></div>
              <div className="home-feature-desc">Text lights up in sync with the audio.</div>
            </div>
            <div className="home-feature">
              <div className="home-feature-head" style={{ color: '#a855f7' }}><Mic size={16} /><span>Podcasts</span></div>
              <div className="home-feature-desc">Subscribe to shows and get transcripts.</div>
            </div>
            <div className="home-feature">
              <div className="home-feature-head" style={{ color: '#60a5fa' }}><FileText size={16} /><span>AI summaries</span></div>
              <div className="home-feature-desc">Short summaries of long reads.</div>
            </div>
            <div className="home-feature">
              <div className="home-feature-head" style={{ color: '#60a5fa' }}><MessageCircle size={16} /><span>Comments too</span></div>
              <div className="home-feature-desc">Support for Substack, LessWrong and EA Forum.</div>
            </div>
            <div className="home-feature">
              <div className="home-feature-head" style={{ color: '#60a5fa' }}><RefreshCw size={16} /><span>Wallabag sync</span></div>
              <div className="home-feature-desc">Two way sync with your Wallabag library.</div>
            </div>
            <div className="home-feature">
              <div className="home-feature-head" style={{ color: '#60a5fa' }}><KeyRound size={16} /><span>Your own keys</span></div>
              <div className="home-feature-desc">Bring API keys from OpenAI and friends.</div>
            </div>
          </div>
        </section>

        <section className="home-cost home-narrow">
          <div className="home-cost-head">
            <KeyRound size={18} />
            <span>What it costs</span>
          </div>
          <p className="home-cost-text">
            You bring API keys from OpenAI or DeepInfra and pay them directly, cents per article.
            OpenRouter, Gemini, and Anthropic are also supported but offer limited functionality.
          </p>
        </section>
      </main>

      <footer className="home-footer">
        <a href="https://github.com/wjeroen/wallacast" target="_blank" rel="noopener noreferrer" className="home-footer-link">
          <Github size={15} />
          <span>Open source on GitHub</span>
        </a>
        <p>Fair warning: Vibe coded and run by one person. It works, but use it at your own risk. Questions? Contact me.</p>
      </footer>
    </div>
  );
}
