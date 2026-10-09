// Email + password auth screen (log in / sign up / forgot / set new password).
// Rendered by the shell in place of the tab frame while signed out, so it never
// touches the router or the in-memory store.

import { supabase } from '../supabase-client.js';
import { esc } from '../ui.js';

const MODES = {
  login: { title: 'Welcome back', cta: 'Log in' },
  signup: { title: 'Create your account', cta: 'Sign up' },
  forgot: { title: 'Reset password', cta: 'Send reset link' },
  recovery: { title: 'Set a new password', cta: 'Save password' },
};

const MIN_PASSWORD = 8;

// Pure validation so the rules are testable without a DOM.
export function validateAuthInput(mode, { email, password }) {
  const needsEmail = mode !== 'recovery';
  const needsPassword = mode !== 'forgot';
  if (needsEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
  if (needsPassword && password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  return null;
}

// Supabase error -> sentence a player can act on.
export function authErrorMessage(error) {
  const msg = String((error && error.message) || '');
  if (/invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Log in instead.';
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  if (/fetch|network/i.test(msg)) return 'Could not reach the server. Check your connection.';
  return msg || 'Something went wrong. Try again.';
}

function redirectUrl() {
  return location.origin + location.pathname;
}

export function AuthScreen(root, { mode: initialMode = 'login' } = {}) {
  let mode = initialMode;
  let busy = false;

  function render(notice = '', error = '') {
    const m = MODES[mode];
    const showEmail = mode !== 'recovery';
    const showPassword = mode !== 'forgot';
    root.innerHTML = `
      <div class="auth-screen">
        <div class="auth-brand">
          <div class="auth-logo" aria-hidden="true">27</div>
          <div class="auth-app">Poker Analytics 27</div>
        </div>
        <h1 class="auth-title">${esc(m.title)}</h1>
        ${mode === 'login' || mode === 'signup' ? `
          <div class="segmented auth-seg" role="tablist">
            <button role="tab" data-mode="login" class="${mode === 'login' ? 'active' : ''}" aria-selected="${mode === 'login'}">Log in</button>
            <button role="tab" data-mode="signup" class="${mode === 'signup' ? 'active' : ''}" aria-selected="${mode === 'signup'}">Sign up</button>
          </div>` : ''}
        <form class="auth-form" novalidate>
          ${showEmail ? `
            <label class="field"><span class="field-label">Email</span>
              <input class="input" name="email" type="email" autocomplete="email" inputmode="email" required></label>` : ''}
          ${showPassword ? `
            <label class="field"><span class="field-label">${mode === 'recovery' ? 'New password' : 'Password'}</span>
              <input class="input" name="password" type="password" minlength="${MIN_PASSWORD}"
                autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></label>` : ''}
          <div class="form-error" data-role="err" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</div>
          <div class="auth-notice" data-role="notice" role="status" ${notice ? '' : 'hidden'}>${esc(notice)}</div>
          <button class="btn-primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : esc(m.cta)}</button>
        </form>
        <div class="auth-links">
          ${mode === 'login' ? '<button class="link-btn" data-mode="forgot">Forgot password?</button>' : ''}
          ${mode === 'forgot' ? '<button class="link-btn" data-mode="login">Back to log in</button>' : ''}
        </div>
        <p class="auth-foot">Your sessions sync across all your devices.</p>
      </div>`;

    root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', e => {
      e.preventDefault();
      mode = b.dataset.mode;
      render();
    }));
    root.querySelector('form').addEventListener('submit', onSubmit);
    const first = root.querySelector('input');
    if (first) first.focus();
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const email = (form.email ? form.email.value : '').trim();
    const password = form.password ? form.password.value : '';
    const invalid = validateAuthInput(mode, { email, password });
    if (invalid) { showError(invalid); return; }

    busy = true;
    setBusy(true);
    let result;
    try {
      if (mode === 'login') result = await supabase.auth.signInWithPassword({ email, password });
      else if (mode === 'signup') result = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl() } });
      else if (mode === 'forgot') result = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
      else result = await supabase.auth.updateUser({ password });
    } catch (err) {
      result = { error: err };
    }
    busy = false;

    if (result.error) {
      console.error('auth: request failed', result.error);
      setBusy(false);
      showError(authErrorMessage(result.error));
      return;
    }
    if (mode === 'forgot') {
      mode = 'login';
      render('If that email has an account, a reset link is on its way.');
      return;
    }
    if (mode === 'signup' && !result.data.session) {
      mode = 'login';
      render('Check your inbox to confirm your email, then log in.');
      return;
    }
    // login / signup with session / recovery: the shell's onAuthStateChange takes over.
    setBusy(false);
  }

  function setBusy(on) {
    const btn = root.querySelector('button[type=submit]');
    if (!btn) return;
    btn.disabled = on;
    btn.textContent = on ? 'Please wait…' : MODES[mode].cta;
  }

  function showError(msg) {
    const el = root.querySelector('[data-role=err]');
    el.textContent = msg;
    el.hidden = false;
    const notice = root.querySelector('[data-role=notice]');
    if (notice) notice.hidden = true;
  }

  render();
}
