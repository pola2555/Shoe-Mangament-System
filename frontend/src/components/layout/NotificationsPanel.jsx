import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { HiOutlineBell } from 'react-icons/hi2';
import { notificationsAPI } from '../../api';
import { useTranslation } from '../../i18n/i18nContext';
import './NotificationsPanel.css';

export default function NotificationsPanel({ collapsed }) {
  const [unread, setUnread] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef(null);
  const navigate = useNavigate();
  const { t } = useTranslation();

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

  const handleNotificationClick = async (notif) => {
    try {
      await notificationsAPI.markAsRead(notif.id);
      setUnread(prev => prev.filter(n => n.id !== notif.id));
      setIsOpen(false);
      
      // Route if reference_id is provided
      if (notif.reference_id && notif.type === 'price_update') {
        navigate(`/products/${notif.reference_id}`);
      }
    } catch (error) {
      console.error('Failed to mark notification as read', error);
    }
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
            {unread.length > 0 && (
              <span className="notif-count">{unread.length} Unread</span>
            )}
          </div>
          
          <div className="notifications-list">
            {unread.length === 0 ? (
              <div className="notifications-empty">{t('notifications.no_notifications')}</div>
            ) : (
              unread.map(n => (
                <div 
                  key={n.id} 
                  className={`notification-item type-${n.type}`}
                  onClick={() => handleNotificationClick(n)}
                >
                  <div className="notif-indicator"></div>
                  <div className="notif-content">
                    <h5>{n.title}</h5>
                    <p>{n.message}</p>
                    <span className="notif-time">
                      {new Date(n.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
