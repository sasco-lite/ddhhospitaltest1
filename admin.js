const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const cookies = {};
  header.split(';').forEach((cookie) => {
    const parts = cookie.trim().split('=');
    if (parts.length >= 2) {
      const key = parts[0];
      const val = parts.slice(1).join('=');
      cookies[key] = decodeURIComponent(val);
    }
  });
  return cookies;
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function getKolkataDateString(date = new Date()) {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const kolkata = new Date(utc + 330 * 60000);
  const year = kolkata.getFullYear();
  const month = String(kolkata.getMonth() + 1).padStart(2, '0');
  const day = String(kolkata.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = function createAdminRouter({ Service, Dentist, Appointment, Settings }) {
  const router = express.Router();

  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ddh-admin-pass';
  const ADMIN_SESSION_SECRET =
    process.env.ADMIN_SESSION_SECRET || 'ddh-secret-session-key-at-least-64-characters-random-string-fallback-secret';

  // Helper to create and sign session cookie
  function signSession(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function verifySession(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    if (!safeCompare(signature, expectedSig)) return null;

    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data.exp || data.exp < Date.now()) return null;
      return data;
    } catch {
      return null;
    }
  }

  // Rate limiter for login: 5 attempts per 15 minutes
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: (req, res) => {
      res.status(429).send(renderLoginPage({ error: 'Too many failed login attempts. Please try again after 15 minutes.' }));
    },
  });

  // Middleware to attach session and protect routes
  router.use((req, res, next) => {
    const cookies = parseCookies(req);
    const sessionToken = cookies.ddh_admin_session;
    const session = verifySession(sessionToken);
    req.adminSession = session;

    // Allowed public paths in admin
    if (req.path === '/login' || req.path === '/login/') {
      return next();
    }

    // Protect all other routes
    if (!session) {
      return res.redirect('/admin/login');
    }

    // CSRF check on all POST requests in admin
    if (req.method === 'POST') {
      const submittedCsrf = req.body?._csrf || req.headers['x-csrf-token'];
      if (!submittedCsrf || !session.csrf || !safeCompare(submittedCsrf, session.csrf)) {
        return res.status(403).send('<h1>403 Forbidden</h1><p>Invalid or expired CSRF token. Please return and retry.</p>');
      }
    }

    next();
  });

  // Base admin layout template
  function renderAdminLayout({ title, activeTab, content, csrf, flash = '' }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - DDH Admin</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --mint: #A8E6CF;
      --peach: #FFD3B6;
      --lavender: #C7B8F5;
      --sky: #BDE0FE;
      --butter: #FFF1B5;
      --rose: #FFC6D9;
      --text: #2D3A4A;
      --bg: #F7F4FF;
      --clay-shadow: 10px 10px 22px rgba(60,50,90,0.10), -8px -8px 20px rgba(255,255,255,0.9), inset 4px 4px 8px rgba(255,255,255,0.7), inset -4px -4px 8px rgba(60,50,90,0.06);
      --clay-btn: 6px 6px 14px rgba(60,50,90,0.12), -5px -5px 12px rgba(255,255,255,0.9), inset 2px 2px 4px rgba(255,255,255,0.8), inset -2px -2px 4px rgba(60,50,90,0.08);
      --glass-bg: rgba(255,255,255,0.55);
      --glass-border: 1px solid rgba(255,255,255,0.7);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Nunito', sans-serif;
      background: linear-gradient(135deg, #F7F4FF 0%, #EEF9FF 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    h1, h2, h3, h4, .brand-font {
      font-family: 'Baloo 2', cursive, sans-serif;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 50;
      background: var(--glass-bg);
      backdrop-filter: blur(16px) saturate(160%);
      -webkit-backdrop-filter: blur(16px) saturate(160%);
      border-bottom: var(--glass-border);
      padding: 0.75rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .badge-brand {
      background: linear-gradient(135deg, var(--mint), var(--sky));
      color: var(--text);
      font-weight: 800;
      padding: 0.4rem 0.9rem;
      border-radius: 18px;
      box-shadow: var(--clay-btn);
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      text-decoration: none;
      font-size: 1.15rem;
    }
    .nav-links {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .nav-link {
      padding: 0.45rem 0.9rem;
      border-radius: 20px;
      text-decoration: none;
      color: var(--text);
      font-weight: 700;
      font-size: 0.95rem;
      transition: all 0.2s;
    }
    .nav-link:hover {
      background: rgba(255,255,255,0.7);
      transform: translateY(-2px);
    }
    .nav-link.active {
      background: var(--lavender);
      box-shadow: var(--clay-btn);
    }
    .logout-btn {
      background: var(--rose);
      padding: 0.45rem 1rem;
      border-radius: 20px;
      text-decoration: none;
      color: var(--text);
      font-weight: 700;
      font-size: 0.9rem;
      box-shadow: var(--clay-btn);
      transition: all 0.2s;
    }
    .logout-btn:hover {
      transform: translateY(-2px);
    }
    .container {
      max-width: 1240px;
      width: 100%;
      margin: 1.5rem auto;
      padding: 0 1rem;
      flex: 1;
    }
    .clay-card {
      background: rgba(255,255,255,0.75);
      border-radius: 28px;
      padding: 1.5rem;
      box-shadow: var(--clay-shadow);
      border: var(--glass-border);
      margin-bottom: 1.5rem;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.25rem;
      margin-bottom: 1.5rem;
    }
    .stat-box {
      border-radius: 24px;
      padding: 1.25rem;
      box-shadow: var(--clay-shadow);
      border: var(--glass-border);
    }
    .stat-box.mint { background: linear-gradient(135deg, rgba(168,230,207,0.4), rgba(255,255,255,0.8)); }
    .stat-box.sky { background: linear-gradient(135deg, rgba(189,224,254,0.4), rgba(255,255,255,0.8)); }
    .stat-box.butter { background: linear-gradient(135deg, rgba(255,241,181,0.4), rgba(255,255,255,0.8)); }
    .stat-box.lavender { background: linear-gradient(135deg, rgba(199,184,245,0.4), rgba(255,255,255,0.8)); }
    .stat-num {
      font-size: 2.2rem;
      font-weight: 800;
      line-height: 1;
      margin-top: 0.35rem;
    }
    .table-container {
      width: 100%;
      overflow-x: auto;
      border-radius: 20px;
      background: rgba(255,255,255,0.6);
      box-shadow: inset 2px 2px 6px rgba(60,50,90,0.05);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.92rem;
      min-width: 650px;
    }
    th, td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid rgba(60,50,90,0.08);
      vertical-align: middle;
    }
    th {
      background: rgba(199,184,245,0.25);
      font-family: 'Baloo 2', cursive;
      font-size: 1.05rem;
      font-weight: 700;
    }
    tr:hover td {
      background: rgba(255,255,255,0.4);
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.65rem;
      border-radius: 14px;
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: capitalize;
    }
    .badge.pending { background: #FFF1B5; color: #7B6200; }
    .badge.confirmed { background: #A8E6CF; color: #0C6B45; }
    .badge.completed { background: #BDE0FE; color: #154B78; }
    .badge.cancelled { background: #FFC6D9; color: #8F173B; }
    .badge.no-show { background: #E0E0E0; color: #555555; }
    .clay-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      border-radius: 20px;
      border: none;
      font-family: 'Nunito', sans-serif;
      font-weight: 700;
      font-size: 0.9rem;
      cursor: pointer;
      text-decoration: none;
      box-shadow: var(--clay-btn);
      transition: all 0.2s;
    }
    .clay-btn:hover {
      transform: translateY(-2px);
    }
    .clay-btn:active {
      transform: scale(0.97);
    }
    .clay-btn.primary { background: var(--lavender); color: var(--text); }
    .clay-btn.secondary { background: rgba(255,255,255,0.8); color: var(--text); }
    .clay-btn.danger { background: var(--rose); color: var(--text); }
    .clay-btn.success { background: var(--mint); color: var(--text); }
    .form-group {
      margin-bottom: 1rem;
    }
    .form-label {
      display: block;
      font-weight: 700;
      margin-bottom: 0.35rem;
      font-size: 0.9rem;
    }
    .form-control {
      width: 100%;
      padding: 0.65rem 1rem;
      border-radius: 16px;
      border: 1px solid rgba(60,50,90,0.15);
      background: rgba(255,255,255,0.9);
      font-family: inherit;
      font-size: 0.95rem;
      color: var(--text);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .form-control:focus {
      border-color: #A8B8F5;
      box-shadow: 0 0 0 3px rgba(199,184,245,0.4);
    }
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 1rem;
    }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
    }
    .flash-msg {
      background: #A8E6CF;
      color: #0C6B45;
      padding: 0.75rem 1.25rem;
      border-radius: 18px;
      font-weight: 700;
      margin-bottom: 1rem;
      box-shadow: var(--clay-btn);
    }
    .action-row {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    @media (max-width: 768px) {
      .topbar { padding: 0.6rem 1rem; }
      .container { padding: 0 0.5rem; margin: 1rem auto; }
      .clay-card { padding: 1rem; border-radius: 20px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <a href="/admin" class="badge-brand">
      <span>DDH Dental Staff</span>
    </a>
    <nav class="nav-links">
      <a href="/admin" class="nav-link ${activeTab === 'dashboard' ? 'active' : ''}">Dashboard</a>
      <a href="/admin/appointments" class="nav-link ${activeTab === 'appointments' ? 'active' : ''}">Appointments</a>
      <a href="/admin/services" class="nav-link ${activeTab === 'services' ? 'active' : ''}">Services</a>
      <a href="/admin/dentists" class="nav-link ${activeTab === 'dentists' ? 'active' : ''}">Dentists</a>
      <a href="/admin/settings" class="nav-link ${activeTab === 'settings' ? 'active' : ''}">Clinic Settings</a>
    </nav>
    <div style="display:flex; align-items:center; gap:0.5rem;">
      <a href="/" target="_blank" class="nav-link" style="font-size:0.85rem;">View Live Site ↗</a>
      <a href="/admin/logout" class="logout-btn">Log out</a>
    </div>
  </header>

  <main class="container">
    ${flash ? `<div class="flash-msg">${escapeHtml(flash)}</div>` : ''}
    ${content}
  </main>
</body>
</html>`;
  }

  function renderLoginPage({ error = '' } = {}) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Staff Login - DDH Dental Booking</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --mint: #A8E6CF;
      --lavender: #C7B8F5;
      --text: #2D3A4A;
      --clay-shadow: 14px 14px 28px rgba(60,50,90,0.12), -10px -10px 24px rgba(255,255,255,0.9), inset 6px 6px 12px rgba(255,255,255,0.7), inset -6px -6px 12px rgba(60,50,90,0.08);
      --clay-btn: 6px 6px 14px rgba(60,50,90,0.14), -5px -5px 12px rgba(255,255,255,0.95), inset 2px 2px 4px rgba(255,255,255,0.8), inset -2px -2px 4px rgba(60,50,90,0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Nunito', sans-serif;
      background: linear-gradient(135deg, #F7F4FF 0%, #EEF9FF 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .login-card {
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(12px);
      border-radius: 32px;
      padding: 2.5rem;
      max-width: 440px;
      width: 100%;
      box-shadow: var(--clay-shadow);
      border: 1px solid rgba(255,255,255,0.8);
      text-align: center;
    }
    h1 {
      font-family: 'Baloo 2', cursive;
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }
    .badge-pill {
      display: inline-block;
      background: linear-gradient(135deg, var(--mint), var(--lavender));
      padding: 0.35rem 1rem;
      border-radius: 20px;
      font-weight: 800;
      margin-bottom: 1.25rem;
      box-shadow: var(--clay-btn);
    }
    .form-group {
      text-align: left;
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-weight: 700;
      margin-bottom: 0.4rem;
      font-size: 0.95rem;
    }
    input {
      width: 100%;
      padding: 0.75rem 1rem;
      border-radius: 18px;
      border: 1px solid rgba(60,50,90,0.15);
      background: white;
      font-family: inherit;
      font-size: 1rem;
      color: var(--text);
      outline: none;
    }
    input:focus {
      border-color: var(--lavender);
      box-shadow: 0 0 0 3px rgba(199,184,245,0.5);
    }
    .btn-login {
      width: 100%;
      padding: 0.85rem;
      border-radius: 22px;
      border: none;
      background: var(--lavender);
      color: var(--text);
      font-family: 'Baloo 2', cursive;
      font-size: 1.25rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: var(--clay-btn);
      transition: all 0.2s;
      margin-top: 0.5rem;
    }
    .btn-login:hover {
      transform: translateY(-2px);
    }
    .btn-login:active {
      transform: scale(0.98);
    }
    .error-box {
      background: #FFC6D9;
      color: #8F173B;
      padding: 0.65rem 1rem;
      border-radius: 16px;
      margin-bottom: 1.25rem;
      font-weight: 700;
      font-size: 0.92rem;
    }
    .back-link {
      display: inline-block;
      margin-top: 1.5rem;
      color: #6B7280;
      text-decoration: none;
      font-weight: 700;
      font-size: 0.9rem;
    }
    .back-link:hover {
      color: var(--text);
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="badge-pill">DDH Healthcare</div>
    <h1>Staff Portal</h1>
    <p style="color:#6B7280; margin-bottom:1.5rem; font-size:0.95rem;">Enter clinic credentials to manage dental appointments</p>

    ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ''}

    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label for="username">Username</label>
        <input type="text" id="username" name="username" required autocomplete="username" autofocus>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn-login">Sign In</button>
    </form>

    <a href="/" class="back-link">← Return to Public Booking Site</a>
  </div>
</body>
</html>`;
  }

  // --- Authentication Routes ---

  router.get('/login', (req, res) => {
    if (req.adminSession) {
      return res.redirect('/admin');
    }
    res.send(renderLoginPage());
  });

  router.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body || {};

    const isUserValid = safeCompare(String(username || ''), ADMIN_USERNAME);
    const isPassValid = safeCompare(String(password || ''), ADMIN_PASSWORD);

    if (isUserValid && isPassValid) {
      const csrfToken = crypto.randomBytes(24).toString('hex');
      const sessionData = {
        username: ADMIN_USERNAME,
        csrf: csrfToken,
        exp: Date.now() + 8 * 3600 * 1000, // 8 hours
      };
      const signedCookie = signSession(sessionData);

      const isSecure = process.env.VERCEL || req.secure || req.headers['x-forwarded-proto'] === 'https';
      const cookieHeader = `ddh_admin_session=${encodeURIComponent(signedCookie)}; Path=/admin; Max-Age=28800; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`;
      res.setHeader('Set-Cookie', cookieHeader);
      return res.redirect('/admin');
    }

    res.status(401).send(renderLoginPage({ error: 'Invalid staff username or password.' }));
  });

  router.get('/logout', (req, res) => {
    const isSecure = process.env.VERCEL || req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `ddh_admin_session=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Strict${isSecure ? '; Secure' : ''}`);
    res.redirect('/admin/login');
  });

  // --- Dashboard ---

  router.get('/', async (req, res) => {
    try {
      const todayStr = getKolkataDateString();

      // Start & end of current week (Monday to Sunday)
      const now = new Date();
      const currentDay = now.getDay(); // 0 is Sunday
      const diffToMonday = currentDay === 0 ? -6 : 1 - currentDay;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diffToMonday);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const weekStartStr = getKolkataDateString(monday);
      const weekEndStr = getKolkataDateString(sunday);

      const [todayCount, weekCount, pendingCount, totalCount, upcoming] = await Promise.all([
        Appointment.countDocuments({ date: todayStr, status: { $ne: 'cancelled' } }),
        Appointment.countDocuments({ date: { $gte: weekStartStr, $lte: weekEndStr }, status: { $ne: 'cancelled' } }),
        Appointment.countDocuments({ status: 'pending' }),
        Appointment.countDocuments(),
        Appointment.find({ date: { $gte: todayStr }, status: { $ne: 'cancelled' } })
          .sort({ date: 1, startTime: 1 })
          .limit(10)
          .populate('serviceId')
          .populate('dentistId')
          .lean(),
      ]);

      const content = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:1rem;">
          <div>
            <h1>Staff Dashboard</h1>
            <p style="color:#6B7280;">Overview for Dhuliyan Diagnostic & Health Care (DDH) Dental Clinic</p>
          </div>
          <div>
            <a href="/admin/appointments" class="clay-btn primary">Manage All Appointments</a>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-box mint">
            <div style="font-weight:700; color:#0C6B45;">Today's Bookings</div>
            <div class="stat-num">${todayCount}</div>
            <div style="font-size:0.85rem; color:#0C6B45; margin-top:0.25rem;">Date: ${todayStr}</div>
          </div>
          <div class="stat-box sky">
            <div style="font-weight:700; color:#154B78;">This Week</div>
            <div class="stat-num">${weekCount}</div>
            <div style="font-size:0.85rem; color:#154B78; margin-top:0.25rem;">${weekStartStr} to ${weekEndStr}</div>
          </div>
          <div class="stat-box butter">
            <div style="font-weight:700; color:#7B6200;">Pending Action</div>
            <div class="stat-num">${pendingCount}</div>
            <div style="font-size:0.85rem; color:#7B6200; margin-top:0.25rem;">Require confirmation</div>
          </div>
          <div class="stat-box lavender">
            <div style="font-weight:700; color:#4B3F72;">All-Time Bookings</div>
            <div class="stat-num">${totalCount}</div>
            <div style="font-size:0.85rem; color:#4B3F72; margin-top:0.25rem;">Total recorded</div>
          </div>
        </div>

        <div class="clay-card">
          <h2 style="font-size:1.4rem; margin-bottom:1rem;">Next 10 Upcoming Appointments</h2>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Patient</th>
                  <th>Phone</th>
                  <th>Date & Time</th>
                  <th>Service</th>
                  <th>Dentist</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${
                  upcoming.length === 0
                    ? `<tr><td colspan="8" style="text-align:center; padding:2rem; color:#6B7280;">No upcoming appointments found.</td></tr>`
                    : upcoming
                        .map(
                          (a) => `
                  <tr>
                    <td><strong>${escapeHtml(a.reference)}</strong></td>
                    <td>${escapeHtml(a.patientName)}</td>
                    <td><a href="tel:${escapeHtml(a.phone)}" style="color:inherit; font-weight:700;">${escapeHtml(a.phone)}</a></td>
                    <td>${escapeHtml(a.date)} at <strong>${escapeHtml(a.startTime)}</strong></td>
                    <td>${escapeHtml(a.serviceId?.name || 'Standard Care')}</td>
                    <td>${escapeHtml(a.dentistId?.name || 'On-duty Dentist')}</td>
                    <td><span class="badge ${escapeHtml(a.status)}">${escapeHtml(a.status)}</span></td>
                    <td>
                      <a href="/admin/appointments?q=${encodeURIComponent(a.reference)}" class="clay-btn secondary" style="padding:0.25rem 0.65rem; font-size:0.8rem;">Details</a>
                    </td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;

      res.send(renderAdminLayout({ title: 'Dashboard', activeTab: 'dashboard', content, csrf: req.adminSession.csrf }));
    } catch (err) {
      res.status(500).send(`Server Error: ${escapeHtml(err.message)}`);
    }
  });

  // --- Appointments Management & CSV Export ---

  router.get('/appointments/export.csv', async (req, res) => {
    try {
      const { date, dentistId, status, q } = req.query;
      const filter = {};

      if (date) filter.date = date;
      if (dentistId) filter.dentistId = dentistId;
      if (status) filter.status = status;
      if (q) {
        const regex = new RegExp(q.trim(), 'i');
        filter.$or = [{ patientName: regex }, { phone: regex }, { reference: regex }];
      }

      const list = await Appointment.find(filter)
        .sort({ date: -1, startTime: -1 })
        .populate('serviceId')
        .populate('dentistId')
        .lean();

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ddh-appointments-export.csv"');

      const headers = [
        'Reference',
        'Patient Name',
        'Phone',
        'Email',
        'Age',
        'Service',
        'Dentist',
        'Date',
        'Start Time',
        'Duration Minutes',
        'Status',
        'Notes',
        'Consent Given',
        'Created At',
      ];

      function csvSafe(val) {
        if (val == null) return '""';
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      }

      const rows = list.map((a) => [
        csvSafe(a.reference),
        csvSafe(a.patientName),
        csvSafe(a.phone),
        csvSafe(a.email),
        csvSafe(a.age),
        csvSafe(a.serviceId?.name),
        csvSafe(a.dentistId?.name),
        csvSafe(a.date),
        csvSafe(a.startTime),
        csvSafe(a.durationMinutes),
        csvSafe(a.status),
        csvSafe(a.notes),
        csvSafe(a.consentGiven),
        csvSafe(a.createdAt ? new Date(a.createdAt).toISOString() : ''),
      ]);

      const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
      res.send(csvContent);
    } catch (err) {
      res.status(500).send(`CSV Export Failed: ${escapeHtml(err.message)}`);
    }
  });

  router.get('/appointments', async (req, res) => {
    try {
      const { date, dentistId, status, q, flash } = req.query;
      const filter = {};

      if (date) filter.date = date;
      if (dentistId) filter.dentistId = dentistId;
      if (status) filter.status = status;
      if (q) {
        const regex = new RegExp(q.trim(), 'i');
        filter.$or = [{ patientName: regex }, { phone: regex }, { reference: regex }];
      }

      const [appointments, dentists] = await Promise.all([
        Appointment.find(filter)
          .sort({ date: -1, startTime: -1 })
          .populate('serviceId')
          .populate('dentistId')
          .lean(),
        Dentist.find().sort({ name: 1 }).lean(),
      ]);

      const content = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:1rem;">
          <div>
            <h1>Dental Appointments</h1>
            <p style="color:#6B7280;">Search, update statuses, edit internal notes, or export records</p>
          </div>
          <div>
            <a href="/admin/appointments/export.csv?${new URLSearchParams(req.query).toString()}" class="clay-btn secondary">📥 Export CSV</a>
          </div>
        </div>

        <div class="clay-card">
          <form method="GET" action="/admin/appointments" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)) auto; gap:0.75rem; align-items:flex-end;">
            <div>
              <label class="form-label">Search (Name / Phone / Ref)</label>
              <input type="text" name="q" class="form-control" value="${escapeHtml(q || '')}" placeholder="Search patient...">
            </div>
            <div>
              <label class="form-label">Date</label>
              <input type="date" name="date" class="form-control" value="${escapeHtml(date || '')}">
            </div>
            <div>
              <label class="form-label">Dentist</label>
              <select name="dentistId" class="form-control">
                <option value="">All Dentists</option>
                ${dentists
                  .map(
                    (d) =>
                      `<option value="${d._id}" ${dentistId === String(d._id) ? 'selected' : ''}>${escapeHtml(d.name)}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div>
              <label class="form-label">Status</label>
              <select name="status" class="form-control">
                <option value="">All Statuses</option>
                <option value="pending" ${status === 'pending' ? 'selected' : ''}>Pending</option>
                <option value="confirmed" ${status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
                <option value="completed" ${status === 'completed' ? 'selected' : ''}>Completed</option>
                <option value="cancelled" ${status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
                <option value="no-show" ${status === 'no-show' ? 'selected' : ''}>No-Show</option>
              </select>
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button type="submit" class="clay-btn primary" style="height:42px;">Filter</button>
              <a href="/admin/appointments" class="clay-btn secondary" style="height:42px;">Reset</a>
            </div>
          </form>
        </div>

        <div class="clay-card">
          <div style="margin-bottom:0.75rem; font-weight:700; color:#6B7280;">Showing ${appointments.length} appointment(s)</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Ref & Date</th>
                  <th>Patient Details</th>
                  <th>Service & Doctor</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Manage</th>
                </tr>
              </thead>
              <tbody>
                ${
                  appointments.length === 0
                    ? `<tr><td colspan="6" style="text-align:center; padding:2.5rem; color:#6B7280;">No appointments matched your search or filters.</td></tr>`
                    : appointments
                        .map(
                          (a) => `
                  <tr>
                    <td>
                      <div style="font-weight:800; font-size:1.05rem;">${escapeHtml(a.reference)}</div>
                      <div style="font-size:0.85rem; color:#4B3F72;">${escapeHtml(a.date)}</div>
                      <div style="font-size:0.85rem; font-weight:700;">${escapeHtml(a.startTime)} (${a.durationMinutes}m)</div>
                    </td>
                    <td>
                      <div style="font-weight:700;">${escapeHtml(a.patientName)} ${a.age ? `(${a.age} yrs)` : ''}</div>
                      <div><a href="tel:${escapeHtml(a.phone)}" style="color:inherit; font-weight:700;">${escapeHtml(a.phone)}</a></div>
                      ${a.email ? `<div style="font-size:0.8rem; color:#6B7280;">${escapeHtml(a.email)}</div>` : ''}
                    </td>
                    <td>
                      <div style="font-weight:700;">${escapeHtml(a.serviceId?.name || 'Dental Service')}</div>
                      <div style="font-size:0.85rem; color:#6B7280;">${escapeHtml(a.dentistId?.name || 'Dentist')}</div>
                    </td>
                    <td>
                      <form method="POST" action="/admin/appointments/${a._id}/status" style="display:flex; flex-direction:column; gap:0.35rem;">
                        <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
                        <select name="status" class="form-control" style="padding:0.3rem 0.5rem; font-size:0.85rem; font-weight:700;" onchange="this.form.submit()">
                          <option value="pending" ${a.status === 'pending' ? 'selected' : ''}>Pending</option>
                          <option value="confirmed" ${a.status === 'confirmed' ? 'selected' : ''}>Confirmed</option>
                          <option value="completed" ${a.status === 'completed' ? 'selected' : ''}>Completed</option>
                          <option value="cancelled" ${a.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
                          <option value="no-show" ${a.status === 'no-show' ? 'selected' : ''}>No-Show</option>
                        </select>
                      </form>
                    </td>
                    <td style="max-width:240px;">
                      <form method="POST" action="/admin/appointments/${a._id}/notes">
                        <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
                        <textarea name="notes" rows="2" class="form-control" style="font-size:0.85rem; resize:vertical; padding:0.4rem;" placeholder="Staff notes...">${escapeHtml(a.notes || '')}</textarea>
                        <button type="submit" class="clay-btn secondary" style="padding:0.2rem 0.6rem; font-size:0.75rem; margin-top:0.25rem;">Save Notes</button>
                      </form>
                    </td>
                    <td>
                      <form method="POST" action="/admin/appointments/${a._id}/delete" onsubmit="return confirm('Are you sure you want to permanently delete appointment ${escapeHtml(a.reference)}?');">
                        <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
                        <button type="submit" class="clay-btn danger" style="padding:0.35rem 0.75rem; font-size:0.8rem;">Delete</button>
                      </form>
                    </td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;

      res.send(renderAdminLayout({ title: 'Appointments', activeTab: 'appointments', content, csrf: req.adminSession.csrf, flash }));
    } catch (err) {
      res.status(500).send(`Server Error: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/appointments/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled', 'no-show'];
      if (!validStatuses.includes(status)) {
        return res.status(400).send('Invalid status');
      }
      await Appointment.findByIdAndUpdate(req.params.id, { status });
      res.redirect('/admin/appointments?flash=' + encodeURIComponent('Appointment status updated successfully.'));
    } catch (err) {
      res.status(500).send(`Failed to update status: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/appointments/:id/notes', async (req, res) => {
    try {
      const notes = String(req.body.notes || '').slice(0, 500);
      await Appointment.findByIdAndUpdate(req.params.id, { notes });
      res.redirect('/admin/appointments?flash=' + encodeURIComponent('Notes updated successfully.'));
    } catch (err) {
      res.status(500).send(`Failed to update notes: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/appointments/:id/delete', async (req, res) => {
    try {
      await Appointment.findByIdAndDelete(req.params.id);
      res.redirect('/admin/appointments?flash=' + encodeURIComponent('Appointment deleted successfully.'));
    } catch (err) {
      res.status(500).send(`Failed to delete appointment: ${escapeHtml(err.message)}`);
    }
  });

  // --- Services Management ---

  router.get('/services', async (req, res) => {
    try {
      const { flash } = req.query;
      const services = await Service.find().sort({ sortOrder: 1, name: 1 }).lean();

      const content = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:1rem;">
          <div>
            <h1>Dental Services</h1>
            <p style="color:#6B7280;">Manage catalog offerings, durations, display prices, and ordering</p>
          </div>
        </div>

        <div class="clay-card">
          <h2 style="font-size:1.3rem; margin-bottom:1rem;">Add New Dental Service</h2>
          <form method="POST" action="/admin/services/new" class="grid-2">
            <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
            <div>
              <label class="form-label">Service Name *</label>
              <input type="text" name="name" class="form-control" placeholder="e.g. Tooth Extraction" required>
            </div>
            <div>
              <label class="form-label">Duration (Minutes) *</label>
              <input type="number" name="durationMinutes" class="form-control" value="30" min="10" max="240" step="5" required>
            </div>
            <div>
              <label class="form-label">Price Text (Display only)</label>
              <input type="text" name="priceText" class="form-control" placeholder="Optional display text">
            </div>
            <div>
              <label class="form-label">Sort Order</label>
              <input type="number" name="sortOrder" class="form-control" value="0">
            </div>
            <div style="grid-column: 1 / -1;">
              <label class="form-label">Description</label>
              <textarea name="description" class="form-control" rows="2" placeholder="Brief service details..."></textarea>
            </div>
            <div style="grid-column: 1 / -1;">
              <button type="submit" class="clay-btn success">+ Add Service</button>
            </div>
          </form>
        </div>

        <div class="clay-card">
          <h2 style="font-size:1.3rem; margin-bottom:1rem;">Existing Services (${services.length})</h2>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Service Name & Description</th>
                  <th>Duration</th>
                  <th>Price Text</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${
                  services.length === 0
                    ? `<tr><td colspan="6" style="text-align:center; padding:2rem; color:#6B7280;">No services found.</td></tr>`
                    : services
                        .map(
                          (s) => `
                  <tr>
                    <td><strong>#${s.sortOrder}</strong></td>
                    <td>
                      <div style="font-weight:700;">${escapeHtml(s.name)}</div>
                      <div style="font-size:0.85rem; color:#6B7280;">${escapeHtml(s.description || 'No description')}</div>
                    </td>
                    <td>${s.durationMinutes} mins</td>
                    <td>${escapeHtml(s.priceText || '—')}</td>
                    <td>
                      <span class="badge ${s.isActive ? 'confirmed' : 'cancelled'}">${s.isActive ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td>
                      <div class="action-row">
                        <form method="POST" action="/admin/services/${s._id}/toggle">
                          <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
                          <button type="submit" class="clay-btn secondary" style="padding:0.25rem 0.65rem; font-size:0.8rem;">
                            ${s.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </form>
                        <form method="POST" action="/admin/services/${s._id}/delete" onsubmit="return confirm('Permanently delete ${escapeHtml(s.name)}?');">
                          <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
                          <button type="submit" class="clay-btn danger" style="padding:0.25rem 0.65rem; font-size:0.8rem;">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;

      res.send(renderAdminLayout({ title: 'Dental Services', activeTab: 'services', content, csrf: req.adminSession.csrf, flash }));
    } catch (err) {
      res.status(500).send(`Server Error: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/services/new', async (req, res) => {
    try {
      const { name, durationMinutes, priceText, sortOrder, description } = req.body;
      await Service.create({
        name: String(name || '').trim(),
        durationMinutes: Number(durationMinutes) || 30,
        priceText: String(priceText || '').trim(),
        sortOrder: Number(sortOrder) || 0,
        description: String(description || '').trim(),
        isActive: true,
      });
      res.redirect('/admin/services?flash=' + encodeURIComponent('Service added successfully.'));
    } catch (err) {
      res.status(500).send(`Failed to create service: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/services/:id/toggle', async (req, res) => {
    try {
      const service = await Service.findById(req.params.id);
      if (service) {
        service.isActive = !service.isActive;
        await service.save();
      }
      res.redirect('/admin/services?flash=' + encodeURIComponent('Service status toggled.'));
    } catch (err) {
      res.status(500).send(`Failed to update service: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/services/:id/delete', async (req, res) => {
    try {
      await Service.findByIdAndDelete(req.params.id);
      res.redirect('/admin/services?flash=' + encodeURIComponent('Service deleted.'));
    } catch (err) {
      res.status(500).send(`Failed to delete service: ${escapeHtml(err.message)}`);
    }
  });

  // --- Dentists Management ---

  router.get('/dentists', async (req, res) => {
    try {
      const { flash } = req.query;
      const dentists = await Dentist.find().sort({ name: 1 }).lean();

      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

      const content = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:1rem;">
          <div>
            <h1>Dental Practitioners</h1>
            <p style="color:#6B7280;">Manage dentist profiles, credentials, photo URLs, and weekly shift schedules</p>
          </div>
        </div>

        <div class="clay-card">
          <h2 style="font-size:1.3rem; margin-bottom:1rem;">Add New Dentist</h2>
          <form method="POST" action="/admin/dentists/new">
            <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
            <div class="grid-2">
              <div>
                <label class="form-label">Dentist Name *</label>
                <input type="text" name="name" class="form-control" placeholder="e.g. Dr. Jane Doe" required>
              </div>
              <div>
                <label class="form-label">Qualification</label>
                <input type="text" name="qualification" class="form-control" placeholder="e.g. BDS, MDS (Orthodontics)">
              </div>
              <div>
                <label class="form-label">Specialty</label>
                <input type="text" name="specialty" class="form-control" placeholder="e.g. Endodontist">
              </div>
              <div>
                <label class="form-label">Photo URL (Optional)</label>
                <input type="url" name="photoUrl" class="form-control" placeholder="https://...">
              </div>
            </div>

            <div style="margin-top:1rem;">
              <label class="form-label">Working Days</label>
              <div style="display:flex; gap:1rem; flex-wrap:wrap;">
                ${dayNames
                  .map(
                    (name, idx) => `
                  <label style="display:flex; align-items:center; gap:0.35rem; font-size:0.9rem;">
                    <input type="checkbox" name="workingDays" value="${idx}" ${idx !== 0 ? 'checked' : ''}>
                    ${name}
                  </label>
                `
                  )
                  .join('')}
              </div>
            </div>

            <div style="margin-top:1.25rem;">
              <button type="submit" class="clay-btn success">+ Add Dentist</button>
            </div>
          </form>
        </div>

        <div class="clay-card">
          <h2 style="font-size:1.3rem; margin-bottom:1rem;">Dentist Roster (${dentists.length})</h2>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Dentist</th>
                  <th>Qualification</th>
                  <th>Specialty</th>
                  <th>Working Days</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${
                  dentists.length === 0
                    ? `<tr><td colspan="6" style="text-align:center; padding:2rem; color:#6B7280;">No dentists in database.</td></tr>`
                    : dentists
                        .map(
                          (d) => `
                  <tr>
                    <td>
                      <div style="font-weight:700;">${escapeHtml(d.name)}</div>
                    </td>
                    <td>${escapeHtml(d.qualification || '—')}</td>
                    <td>${escapeHtml(d.specialty || '—')}</td>
                    <td>
                      <span style="font-size:0.85rem;">
                        ${(d.workingDays || []).map((dayIdx) => dayNames[dayIdx]?.slice(0, 3)).join(', ') || 'None'}
                      </span>
                    </td>
                    <td>
                      <span class="badge ${d.isActive ? 'confirmed' : 'cancelled'}">${d.isActive ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td>
                      <div class="action-row">
                        <form method="POST" action="/admin/dentists/${d._id}/toggle">
                          <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">
                          <button type="submit" class="clay-btn secondary" style="padding:0.25rem 0.65rem; font-size:0.8rem;">
                            ${d.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;

      res.send(renderAdminLayout({ title: 'Dentists', activeTab: 'dentists', content, csrf: req.adminSession.csrf, flash }));
    } catch (err) {
      res.status(500).send(`Server Error: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/dentists/new', async (req, res) => {
    try {
      const { name, qualification, specialty, photoUrl } = req.body;
      let workingDays = req.body.workingDays;
      if (!Array.isArray(workingDays)) {
        workingDays = workingDays ? [workingDays] : [];
      }
      const days = workingDays.map(Number).filter((n) => !isNaN(n) && n >= 0 && n <= 6);

      await Dentist.create({
        name: String(name || '').trim(),
        qualification: String(qualification || '').trim(),
        specialty: String(specialty || '').trim(),
        photoUrl: String(photoUrl || '').trim(),
        workingDays: days.length > 0 ? days : [1, 2, 3, 4, 5, 6],
        isActive: true,
      });
      res.redirect('/admin/dentists?flash=' + encodeURIComponent('Dentist added successfully.'));
    } catch (err) {
      res.status(500).send(`Failed to add dentist: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/dentists/:id/toggle', async (req, res) => {
    try {
      const dentist = await Dentist.findById(req.params.id);
      if (dentist) {
        dentist.isActive = !dentist.isActive;
        await dentist.save();
      }
      res.redirect('/admin/dentists?flash=' + encodeURIComponent('Dentist status toggled.'));
    } catch (err) {
      res.status(500).send(`Failed to toggle dentist: ${escapeHtml(err.message)}`);
    }
  });

  // --- Clinic Settings ---

  router.get('/settings', async (req, res) => {
    try {
      const { flash } = req.query;
      let settings = await Settings.findOne().lean();
      if (!settings) {
        settings = {};
      }

      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const hours = settings.hours || [];

      const content = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; gap:1rem;">
          <div>
            <h1>Clinic Settings</h1>
            <p style="color:#6B7280;">Updates take effect on the live site instantly without redeployment</p>
          </div>
        </div>

        <form method="POST" action="/admin/settings">
          <input type="hidden" name="_csrf" value="${escapeHtml(req.adminSession.csrf)}">

          <div class="clay-card">
            <h2 style="font-size:1.3rem; margin-bottom:1rem;">Clinic Information & Contact</h2>
            <div class="grid-2">
              <div class="form-group">
                <label class="form-label">Display Clinic Name</label>
                <input type="text" name="clinicName" class="form-control" value="${escapeHtml(settings.clinicName || '')}" required>
              </div>
              <div class="form-group">
                <label class="form-label">Legal Name (Footer)</label>
                <input type="text" name="legalName" class="form-control" value="${escapeHtml(settings.legalName || '')}" required>
              </div>
              <div class="form-group">
                <label class="form-label">Tagline (Optional)</label>
                <input type="text" name="tagline" class="form-control" value="${escapeHtml(settings.tagline || '')}">
              </div>
              <div class="form-group">
                <label class="form-label">Phone Number *</label>
                <input type="text" name="phone" class="form-control" value="${escapeHtml(settings.phone || '')}" required>
              </div>
              <div class="form-group">
                <label class="form-label">Email (Optional - will be hidden if blank)</label>
                <input type="email" name="email" class="form-control" value="${escapeHtml(settings.email || '')}" placeholder="Leave blank if none published">
              </div>
              <div class="form-group">
                <label class="form-label">WhatsApp Number (Optional)</label>
                <input type="text" name="whatsapp" class="form-control" value="${escapeHtml(settings.whatsapp || '')}">
              </div>
              <div class="form-group" style="grid-column: 1 / -1;">
                <label class="form-label">Address</label>
                <textarea name="address" class="form-control" rows="2">${escapeHtml(settings.address || '')}</textarea>
              </div>
              <div class="form-group">
                <label class="form-label">Latitude</label>
                <input type="number" step="any" name="latitude" class="form-control" value="${settings.latitude != null ? settings.latitude : 24.660543}">
              </div>
              <div class="form-group">
                <label class="form-label">Longitude</label>
                <input type="number" step="any" name="longitude" class="form-control" value="${settings.longitude != null ? settings.longitude : 87.947218}">
              </div>
              <div class="form-group" style="grid-column: 1 / -1;">
                <label class="form-label">Google Maps Directions Link</label>
                <input type="url" name="mapsLink" class="form-control" value="${escapeHtml(settings.mapsLink || '')}">
              </div>
            </div>
          </div>

          <div class="clay-card">
            <h2 style="font-size:1.3rem; margin-bottom:0.35rem;">Weekly Clinic Hours</h2>
            <p style="color:#B45309; font-weight:700; font-size:0.9rem; margin-bottom:1rem;">
              ⚠️ Note: Public listings disagree; these operating hours are labeled provisional.
            </p>
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Open Time</th>
                    <th>Close Time</th>
                    <th>Closed Flag</th>
                  </tr>
                </thead>
                <tbody>
                  ${dayNames
                    .map((name, dayIdx) => {
                      const dayHour = hours.find((h) => h.day === dayIdx) || {
                        open: '10:00',
                        close: '20:00',
                        isClosed: dayIdx === 0,
                      };
                      return `
                      <tr>
                        <td><strong>${name}</strong></td>
                        <td>
                          <input type="time" name="hour_open_${dayIdx}" class="form-control" value="${escapeHtml(dayHour.open || '10:00')}" style="width:140px;">
                        </td>
                        <td>
                          <input type="time" name="hour_close_${dayIdx}" class="form-control" value="${escapeHtml(dayHour.close || '20:00')}" style="width:140px;">
                        </td>
                        <td>
                          <label style="display:flex; align-items:center; gap:0.4rem; cursor:pointer;">
                            <input type="checkbox" name="hour_closed_${dayIdx}" value="true" ${dayHour.isClosed ? 'checked' : ''}>
                            Closed on this day
                          </label>
                        </td>
                      </tr>
                    `;
                    })
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>

          <div class="clay-card">
            <h2 style="font-size:1.3rem; margin-bottom:1rem;">Booking Engine Rules & Constraints</h2>
            <div class="grid-3">
              <div class="form-group">
                <label class="form-label">Slot Interval (Minutes)</label>
                <input type="number" name="slotMinutes" class="form-control" value="${settings.slotMinutes || 30}" min="10" max="120" step="5" required>
              </div>
              <div class="form-group">
                <label class="form-label">Minimum Notice (Hours)</label>
                <input type="number" name="minNoticeHours" class="form-control" value="${settings.minNoticeHours != null ? settings.minNoticeHours : 2}" min="0" max="48" required>
              </div>
              <div class="form-group">
                <label class="form-label">Booking Window (Days)</label>
                <input type="number" name="bookingWindowDays" class="form-control" value="${settings.bookingWindowDays || 30}" min="1" max="180" required>
              </div>
            </div>

            <div class="form-group" style="margin-top:1rem;">
              <label class="form-label">Holidays (YYYY-MM-DD, comma or line separated)</label>
              <textarea name="holidays" class="form-control" rows="3" placeholder="2026-10-24, 2026-12-25">${escapeHtml((settings.holidays || []).join('\n'))}</textarea>
              <small style="color:#6B7280;">Appointments cannot be booked on dates listed as holidays.</small>
            </div>

            <div style="margin-top:1.5rem;">
              <button type="submit" class="clay-btn primary" style="padding:0.75rem 2rem; font-size:1.1rem;">Save All Settings</button>
            </div>
          </div>
        </form>
      `;

      res.send(renderAdminLayout({ title: 'Clinic Settings', activeTab: 'settings', content, csrf: req.adminSession.csrf, flash }));
    } catch (err) {
      res.status(500).send(`Server Error: ${escapeHtml(err.message)}`);
    }
  });

  router.post('/settings', async (req, res) => {
    try {
      const {
        clinicName,
        legalName,
        tagline,
        phone,
        email,
        whatsapp,
        address,
        latitude,
        longitude,
        mapsLink,
        slotMinutes,
        minNoticeHours,
        bookingWindowDays,
        holidays,
      } = req.body;

      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const hours = dayNames.map((dayName, dayIdx) => {
        const open = String(req.body[`hour_open_${dayIdx}`] || '10:00');
        const close = String(req.body[`hour_close_${dayIdx}`] || '20:00');
        const isClosed = req.body[`hour_closed_${dayIdx}`] === 'true';
        return { day: dayIdx, dayName, open, close, isClosed };
      });

      const holidayList = String(holidays || '')
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));

      await Settings.findOneAndUpdate(
        {},
        {
          clinicName: String(clinicName || 'Dhuliyan Diagnostic & Health Care (DDH)').trim(),
          legalName: String(legalName || 'Dhuliyan Diagnostic & Health Care Private Limited').trim(),
          tagline: String(tagline || '').trim(),
          phone: String(phone || '+91 77973 49196').trim(),
          email: String(email || '').trim(),
          whatsapp: String(whatsapp || '').trim(),
          address: String(address || '').trim(),
          latitude: Number(latitude) || 24.660543,
          longitude: Number(longitude) || 87.947218,
          mapsLink: String(mapsLink || '').trim(),
          hours,
          slotMinutes: Number(slotMinutes) || 30,
          minNoticeHours: Number(minNoticeHours) != null ? Number(minNoticeHours) : 2,
          bookingWindowDays: Number(bookingWindowDays) || 30,
          holidays: holidayList,
        },
        { upsert: true, new: true }
      );

      res.redirect('/admin/settings?flash=' + encodeURIComponent('Clinic settings successfully updated and live!'));
    } catch (err) {
      res.status(500).send(`Failed to save settings: ${escapeHtml(err.message)}`);
    }
  });

  return router;
};
