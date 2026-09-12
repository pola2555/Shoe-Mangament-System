import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { HiOutlineBell } from 'react-icons/hi2';
import toast from 'react-hot-toast';
import { notificationsAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import { useConfirm } from '../common/ConfirmDialog';
import { notificationRoute } from '../../utils/notificationRoutes';
import './NotificationsPanel.css';

export default function NotificationsPanel({ collapsed }) {
  const [unread, setUnread] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  // The bell shows what is unread; the history shows everything that ever happened,
  // which is what "I dismissed that by accident" needs.
  const [view, setView] = useState('unread');
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState({ from: '', to: '' });
  const [busy, setBusy] = useState(false);
  const panelRef = useRef(null);
  const navigate = useNavigate();
  const { t } = useTranslation();
  const confirm = useConfirm();

  const fetchUnread = async () => {
    try {
      const res = await notificationsAPI.getUnread();
      setUnread(res.data.data || []);
    } catch (error) {
      console.error('Failed to fetch notifications', error);
    }
  };

  useEffect(() => {
    fetchUnread();
    let interval = setInterval(fetchUnread, 30000);

    const onVisibility = () => {
      clearInterval(interval);
      if (!document.hidden) {
        fetchUnread();
        interval = setInterval(fetchUnread, 30000);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    // Close on click outside
    function handleClickOutside(event) {
      if (panelRef.current && !panelRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const fetchHistory = async (r = range) => {
    try {
      setBusy(true);
      const params = {};
      if (r.from) params.from = r.from;
      if (r.to) params.to = r.to;
      const res = await notificationsAPI.history({ ...params, limit: 100 });
      setHistory(res.data.data || []);
    } catch { toast.error(t('common.error')); }
    finally { setBusy(false); }
  };

  /** Empties the bell. Nothing is deleted — the history still has all of it. */
  const handleClear = async () => {
    try {
      setBusy(true);
      await notificationsAPI.clear();
      setUnread([]);
      toast.success(t('notifications.cleared'));
      if (view === 'history') fetchHistory();
    } catch { toast.error(t('common.error')); }
    finally { setBusy(false); }
  };

  /** The only action here that loses anything, so it asks first. */
  const handleDeleteRange = async () => {
    if (!range.from && !range.to) return;
    if (!await confirm({
      title: t('notifications.delete_range'),
      message: t('notifications.delete_confirm'),
      danger: true,
      confirmText: t('common.delete'),
    })) return;
    try {
      setBusy(true);
      await notificationsAPI.deleteRange(range);
      toast.success(t('notifications.deleted'));
      fetchHistory();
      fetchUnread();
    } catch (err) { toast.error(err.response?.data?.message || t('common.error')); }
    finally { setBusy(false); }
  };

  const showHistory = () => { setView('history'); fetchHistory(); };

  /**
   * Open the thing the notification is about.
   *
   * Navigation happens even if marking it read fails — being taken to the expense is
   * the point, and a failed PUT is no reason to strand somebody where they started.
   * A notification from the history panel navigates too, without re-marking it.
   */
  const handleNotificationClick = async (notif, { markRead = true } = {}) => {
    const to = notificationRoute(notif);
    if (markRead) {
      try {
        await notificationsAPI.markAsRead(notif.id);
        setUnread((prev) => prev.filter((n) => n.id !== notif.id));
      } catch (error) {
        console.error('Failed to mark notification as read', error);
      }
    }
    setIsOpen(false);
    if (to) navigate(to);
  };

  return (
    <div className="notifications-wrapper" ref={panelRef}>
      <button 
        className={`sidebar__bell ${isOpen ? 'active' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title={collapsed ? t('notifications.title') : undefined}
      >
        <HiOutlineBell size={22} />
        {unread.length > 0 && (
          <span className="notifications-badge">{unread.length > 9 ? '9+' : unread.length}</span>
        )}
        {!collapsed && <span>{t('notifications.title')}</span>}
      </button>

      {isOpen && (
        <div className="notifications-dropdown">
          <div className="notifications-header">
            <h4>{t('notifications.title')}</h4>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button className="btn btn-sm btn-secondary" data-testid="notif-tab-unread"
                style={{ opacity: view === 'unread' ? 1 : 0.6 }}
                onClick={() => setView('unread')}>{t('notifications.unread')}</button>
              <button className="btn btn-sm btn-secondary" data-testid="notif-tab-history"
                style={{ opacity: view === 'history' ? 1 : 0.6 }}
                onClick={showHistory}>{t('notifications.history')}</button>
            </div>
          </div>

          {view === 'unread' ? (
            <div className="notifications-actions">
              <span className="notif-count">{unread.length} {t('notifications.unread')}</span>
              <button className="btn btn-sm btn-secondary" data-testid="notif-clear"
                disabled={busy || unread.length === 0} onClick={handleClear}>
                {t('notifications.clear')}
              </button>
            </div>
          ) : (
            <div className="notifications-actions notifications-actions--range">
              <input type="date" className="form-input" value={range.from} data-testid="notif-from"
                onChange={(e) => { const r = { ...range, from: e.target.value }; setRange(r); fetchHistory(r); }} />
              <input type="date" className="form-input" value={range.to} data-testid="notif-to"
                onChange={(e) => { const r = { ...range, to: e.target.value }; setRange(r); fetchHistory(r); }} />
              <button className="btn btn-sm btn-danger" data-testid="notif-delete-range"
                disabled={busy || (!range.from && !range.to)} onClick={handleDeleteRange}>
                {t('notifications.delete_range')}
              </button>
            </div>
          )}

          <div className="notifications-list">
            {(view === 'unread' ? unread : history).length === 0 ? (
              <div className="notifications-empty">
                {view === 'unread' ? t('notifications.no_notifications') : t('notifications.none')}
              </div>
            ) : (
              (view === 'unread' ? unread : history).map(n => {
                const params = typeof n.params === 'string' ? JSON.parse(n.params) : (n.params || {});
                const displayTitle = n.title_key ? t(n.title_key, params) : n.title;
                const displayMessage = n.message_key ? t(n.message_key, params) : n.message;
                return (
                <div
                  key={n.id}
                  className={`notification-item type-${n.type}`}
                  data-testid={`notification-${n.id}`}
                  onClick={() => handleNotificationClick(n, { markRead: view === 'unread' })}
                  style={{
                    ...(n.archived_at ? { opacity: 0.65 } : {}),
                    cursor: notificationRoute(n) ? 'pointer' : 'default',
                  }}
                >
                  <div className="notif-indicator"></div>
                  <div className="notif-content">
                    <h5>{displayTitle}</h5>
                    <p>{displayMessage}</p>
                    <span className="notif-time">
                      {new Date(n.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
