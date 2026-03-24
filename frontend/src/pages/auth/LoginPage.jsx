import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTranslation } from '../../i18n/i18nContext';
import toast from 'react-hot-toast';
import './Login.css';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      toast.error(t('validation.field_required'));
      return;
    }

    setLoading(true);
    try {
      await login(username, password);
      toast.success(t('auth.welcome_back'));
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.message || t('auth.login_failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-glow" />
        <div className="login-card glass">
          <div className="login-header">
            <h1 className="login-title">Shoe ERP</h1>
            <p className="login-subtitle">{t('auth.sign_in_subtitle')}</p>
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label" htmlFor="username">{t('auth.username')}</label>
              <input
                id="username"
                className="form-input"
                type="text"
                placeholder={t('auth.username')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="password">{t('auth.password')}</label>
              <input
                id="password"
                className="form-input"
                type="password"
                placeholder={t('auth.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            <button type="submit" className="btn btn-primary btn-lg login-btn" disabled={loading}>
              {loading ? <span className="spinner" /> : t('auth.sign_in')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
