import axios from 'axios';

const api = axios.create({
  baseURL: 'http://46.101.236.229/api',
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

// Response interceptor — auto-refresh on 401 (with retry limit)
let refreshFailCount = 0;
const MAX_REFRESH_RETRIES = 3;

api.interceptors.response.use(
  (response) => {
    refreshFailCount = 0; // Reset on successful response
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const refreshToken = localStorage.getItem('refreshToken');

      if (refreshToken && refreshFailCount < MAX_REFRESH_RETRIES) {
        try {
          const { data } = await axios.post('/api/auth/refresh', { refreshToken });
          localStorage.setItem('accessToken', data.data.accessToken);
          // Store rotated refresh token if provided
          if (data.data.refreshToken) {
            localStorage.setItem('refreshToken', data.data.refreshToken);
          }
          originalRequest.headers.Authorization = `Bearer ${data.data.accessToken}`;
          refreshFailCount = 0;
          return api(originalRequest);
        } catch {
          refreshFailCount++;
          if (refreshFailCount >= MAX_REFRESH_RETRIES) {
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            window.location.href = '/login';
          }
        }
      } else {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

export default api;
