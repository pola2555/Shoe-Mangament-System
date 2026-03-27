import { useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { useTranslation } from '../../i18n/i18nContext';
import { useAuth } from '../../context/AuthContext';
import { authAPI } from '../../api';
import toast from 'react-hot-toast';
import {
  HiOutlineLanguage,
  HiOutlineSun,
  HiOutlineMoon,
  HiOutlineCircleStack,
  HiOutlineArrowDownTray,
} from 'react-icons/hi2';

export default function SettingsPage() {
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale, t } = useTranslation();
  const { user } = useAuth();
  const isAdmin = user?.role_name === 'admin' || user?.role_name === 'System Administrator';
  const [downloading, setDownloading] = useState(false);

  const handleDownloadBackup = async () => {
    setDownloading(true);
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch('/api/backup/download', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Backup failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().split('T')[0];
      a.download = `shoe_erp_backup_${date}.sql`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast.success(t('settings.backup_success'));
    } catch {
      toast.error(t('settings.backup_failed'));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t('settings.title')}</h1>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-lg)', maxWidth: 640 }}>
        {/* Language */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-sm)' }}>
            <HiOutlineLanguage size={22} style={{ color: 'var(--color-accent)' }} />
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>{t('settings.language')}</h3>
          </div>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-md)' }}>
            {t('settings.language_desc')}
          </p>
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
            <button
              className={`btn ${locale === 'en' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setLocale('en'); authAPI.updatePreferences({ locale: 'en' }).catch(() => {}); }}
            >
              {t('settings.english')}
            </button>
            <button
              className={`btn ${locale === 'ar' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setLocale('ar'); authAPI.updatePreferences({ locale: 'ar' }).catch(() => {}); }}
              style={{ fontFamily: "'Noto Sans Arabic', 'Segoe UI', sans-serif" }}
            >
              {t('settings.arabic')}
            </button>
          </div>
        </div>

        {/* Theme */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-sm)' }}>
            {theme === 'dark' ? (
              <HiOutlineMoon size={22} style={{ color: 'var(--color-accent)' }} />
            ) : (
              <HiOutlineSun size={22} style={{ color: 'var(--color-accent)' }} />
            )}
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>{t('settings.theme')}</h3>
          </div>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-md)' }}>
            {t('settings.theme_desc')}
          </p>
          <div style={{ display: 'flex', gap: 'var(--spacing-sm)' }}>
            <button
              className={`btn ${theme === 'dark' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { if (theme !== 'dark') { toggleTheme(); authAPI.updatePreferences({ theme: 'dark' }).catch(() => {}); } }}
            >
              <HiOutlineMoon size={18} />
              {t('settings.dark_mode')}
            </button>
            <button
              className={`btn ${theme === 'light' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { if (theme !== 'light') { toggleTheme(); authAPI.updatePreferences({ theme: 'light' }).catch(() => {}); } }}
            >
              <HiOutlineSun size={18} />
              {t('settings.light_mode')}
            </button>
          </div>
        </div>

        {/* Database Backup — Admin only */}
        {isAdmin && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-sm)' }}>
              <HiOutlineCircleStack size={22} style={{ color: 'var(--color-accent)' }} />
              <h3 style={{ margin: 0, fontSize: 'var(--font-size-lg)' }}>{t('settings.backup')}</h3>
            </div>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-md)' }}>
              {t('settings.backup_desc')}
            </p>
            <button
              className="btn btn-primary"
              onClick={handleDownloadBackup}
              disabled={downloading}
            >
              <HiOutlineArrowDownTray size={18} />
              {downloading ? t('settings.downloading') : t('settings.download_backup')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
