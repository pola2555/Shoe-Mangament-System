import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import './MainLayout.css';

export default function MainLayout() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="layout__main">
        <Outlet />
      </main>
    </div>
  );
}
