import { createContext, useContext, useState, useEffect } from 'react';
import { authAPI } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount: check if we have a stored token and fetch user profile
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      authAPI.me()
        .then(({ data }) => setUser(data.data))
        .catch(() => {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (username, password) => {
    const { data } = await authAPI.login(username, password);
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('refreshToken', data.data.refreshToken);
    setUser(data.data.user);
    return data.data.user;
  };

  const logout = async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (refreshToken) {
      try { await authAPI.logout(refreshToken); } catch { /* ignore */ }
    }
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    setUser(null);
  };

  /**
   * Check if user has a specific permission at a specific level.
   * @param {string} code - Permission code (e.g., 'inventory')
   * @param {string} level - 'read' or 'write'
   */
  const hasPermission = (code, level = 'read') => {
    if (!user) return false;
    if (user.role_name === 'admin') return true;
    const userLevel = user.permissions?.[code];
    if (!userLevel) return false;
    if (level === 'read') return true; // Any level grants read
    return userLevel === 'write';
  };

  /**
   * Filter a list of stores to only those the user is assigned to.
   * Admins and users with all_stores permission see all stores.
   */
  const filterStores = (stores) => {
    if (!user) return [];
    if (user.role_name === 'admin' || user.permissions?.all_stores) return stores;
    const assigned = user.assigned_stores || [];
    if (assigned.length === 0) return stores; // no assignments = all stores (backwards compat)
    return stores.filter(s => assigned.includes(s.id));
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasPermission, filterStores }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
