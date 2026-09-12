import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authAPI } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const applyUserPreferences = useCallback((u) => {
    if (u) {
      window.dispatchEvent(new CustomEvent('user-preferences', {
        detail: { theme: u.theme, locale: u.locale }
      }));
    }
  }, []);

  // On mount: check if we have a stored token and fetch user profile
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      authAPI.me()
        .then(({ data }) => {
          setUser(data.data);
          applyUserPreferences(data.data);
        })
        .catch(() => {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('refreshToken');
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [applyUserPreferences]);

  const login = async (username, password) => {
    const { data } = await authAPI.login(username, password);
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('refreshToken', data.data.refreshToken);
    setUser(data.data.user);
    applyUserPreferences(data.data.user);
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
  /**
   * The branches this user may actually work in.
   *
   * The union of their `user_stores` rows and their older `users.store_id` home
   * branch — deliberately the same rule as the server's `resolveStoreScope`, because
   * the two disagreeing is worse than either being wrong. It used to fall back to
   * "no assignments = every store", which meant somebody with no branch was offered
   * all of them in the picker and then got nothing back from any of them: a full
   * dropdown and an empty screen, with no way to tell that the account was the problem.
   */
  const filterStores = (stores) => {
    if (!user) return [];
    if (user.role_name === 'admin' || user.permissions?.all_stores) return stores;
    const assigned = [...new Set([
      ...(user.assigned_stores || []),
      ...(user.store_id ? [user.store_id] : []),
    ])];
    if (assigned.length === 0) return [];
    return stores.filter(s => assigned.includes(s.id));
  };

  /**
   * Has this person been told not to be shown this screen?
   *
   * A convenience, NOT a guard. The data behind every page is protected by the
   * permission on its API routes; this only keeps a menu tidy. An admin is never
   * hidden from anything, because the person configuring this must be able to see
   * what they are configuring.
   */
  const isPageHidden = (path) => {
    if (!user || user.role_name === 'admin') return false;
    return (user.hidden_pages || []).includes(path);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasPermission, filterStores, applyUserPreferences, isPageHidden }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
