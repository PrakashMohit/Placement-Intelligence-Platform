// ── Auth Page JS ──────────────────────────────────────────────────────────────

function switchTab(tab) {
  ['login', 'register'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`panel-${t}`).classList.toggle('active', t === tab);
  });
  const badge = document.getElementById('auth-badge');
  const heading = document.getElementById('heading-sub');
  const subtitle = document.getElementById('auth-subtitle');
  if (tab === 'register') {
    badge && (badge.textContent = '✦ Your placement journey starts here');
    heading && (heading.textContent = 'Here.');
    subtitle && (subtitle.textContent = 'Create your account and start preparing smarter.');
  } else {
    badge && (badge.textContent = '✦ Welcome back!');
    heading && (heading.textContent = 'Back.');
    subtitle && (subtitle.textContent = 'Access interview experiences, placement analytics and company insights.');
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function handleLogin(event) {
  event.preventDefault();
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errorEl.textContent = '';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed.');
    location.href = data.redirect || '/dashboard';
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Sign In →';
  }
}

// ── Register ──────────────────────────────────────────────────────────────────
async function handleRegister(event) {
  event.preventDefault();
  const btn = document.getElementById('register-btn');
  const errorEl = document.getElementById('register-error');
  const successEl = document.getElementById('register-success');
  btn.disabled = true;
  btn.textContent = 'Creating account…';
  errorEl.textContent = '';
  successEl.textContent = '';

  const password = document.getElementById('reg-password').value;
  if (password.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    btn.disabled = false;
    btn.textContent = 'Create Account →';
    return;
  }

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: document.getElementById('reg-name').value,
        roll_number: document.getElementById('reg-roll').value,
        department: document.getElementById('reg-department').value,
        graduation_year: document.getElementById('reg-year').value || null,
        email: document.getElementById('reg-email').value,
        password: password,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed.');
    successEl.textContent = '✓ Account created! Redirecting…';
    setTimeout(() => { location.href = data.redirect || '/dashboard'; }, 800);
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Create Account →';
  }
}

// ── Google OAuth ──────────────────────────────────────────────────────────────
async function handleGoogleLogin() {
  try {
    const res = await fetch('/api/auth/google-url');
    const data = await res.json();
    if (data.url) {
      location.href = data.url;
    } else {
      alert('Google sign-in is not configured yet. Please use email/password login.');
    }
  } catch {
    alert('Google sign-in is not available right now. Please use email/password login.');
  }
}
