import axios from 'axios';

// Configured at build time (see .env / .env.example). Falls back to a same-origin
// relative path, which works behind the nginx reverse proxy without hardcoding a host.
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor — attach JWT token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// --- Single-flight token refresh ---
//
// Refresh tokens are rotated server-side: the first use revokes the old token. So when
// several requests 401 at once and each fires its own refresh, the first succeeds and
// every other one presents a token that has just been revoked — failing, and logging the
// user out mid-session.
//
// Instead: the first 401 starts a refresh and every concurrent 401 waits on that same
// promise, then replays with the new token.
let refreshPromise = null;

function clearSessionAndRedirect() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  // Avoid a redirect loop if we are already on the login page.
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login';
  }
}

function refreshAccessToken() {
  // Reuse the in-flight refresh if there is one.
  if (refreshPromise) return refreshPromise;

  const refreshToken = localStorage.getItem('refreshToken');
  if (!refreshToken) return Promise.reject(new Error('No refresh token'));

  refreshPromise = axios
    // Bare axios, not `api` — going through the instance would re-enter this
    // interceptor and recurse if the refresh itself 401s.
    .post(`${API_BASE_URL}/auth/refresh`, { refreshToken })
    .then(({ data }) => {
      const accessToken = data.data.accessToken;
      localStorage.setItem('accessToken', accessToken);
      // Store the rotated refresh token, or the next refresh replays a revoked one.
      if (data.data.refreshToken) {
        localStorage.setItem('refreshToken', data.data.refreshToken);
      }
      return accessToken;
    })
    .finally(() => {
      refreshPromise = null;
    });

  return refreshPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Only retry once per request, and never try to refresh a failed refresh.
    if (
      error.response?.status !== 401 ||
      !originalRequest ||
      originalRequest._retry ||
      originalRequest.url?.includes('/auth/refresh')
    ) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;

    try {
      const accessToken = await refreshAccessToken();
      originalRequest.headers.Authorization = `Bearer ${accessToken}`;
      return api(originalRequest);
    } catch {
      clearSessionAndRedirect();
      return Promise.reject(error);
    }
  }
);

export default api;
