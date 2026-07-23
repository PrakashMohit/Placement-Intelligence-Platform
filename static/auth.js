function switchTab(tab) {
  ['login', 'register'].forEach((t) => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`panel-${t}`).classList.toggle('active', t === tab);
  });

  const badge = document.getElementById('auth-badge');
  const heading = document.getElementById('heading-sub');
  const subtitle = document.getElementById('auth-subtitle');

  if (tab === 'register') {
    if (badge) badge.textContent = 'Your placement journey starts here';
    if (heading) heading.textContent = 'Here.';
    if (subtitle) subtitle.textContent = 'Create your account and start preparing smarter.';
  } else {
    if (badge) badge.textContent = 'Welcome back!';
    if (heading) heading.textContent = 'Back.';
    if (subtitle) subtitle.textContent = 'Access interview experiences, placement analytics and company insights.';
  }
}

document.querySelectorAll('.toggle-password').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.textContent = showing ? 'Show' : 'Hide';
    button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
});

async function handleLogin(event) {
  event.preventDefault();
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');
  btn.disabled = true;
  btn.textContent = 'Signing in...';
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
    btn.textContent = 'Sign In ->';
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const btn = document.getElementById('register-btn');
  const errorEl = document.getElementById('register-error');
  const successEl = document.getElementById('register-success');
  btn.disabled = true;
  btn.textContent = 'Creating account...';
  errorEl.textContent = '';
  successEl.textContent = '';

  const password = document.getElementById('reg-password').value;
  const graduationYear = document.getElementById('reg-year').value;

  if (password.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    btn.disabled = false;
    btn.textContent = 'Create Account ->';
    return;
  }

  if (graduationYear && !/^(202[4-9]|2030)$/.test(graduationYear)) {
    errorEl.textContent = 'Please select a graduation year between 2024 and 2030.';
    btn.disabled = false;
    btn.textContent = 'Create Account ->';
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
        graduation_year: graduationYear || null,
        email: document.getElementById('reg-email').value,
        password,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed.');
    successEl.textContent = 'Account created! Redirecting...';
    setTimeout(() => { location.href = data.redirect || '/dashboard'; }, 800);
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Create Account ->';
  }
}

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
