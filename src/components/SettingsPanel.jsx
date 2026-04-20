import React from "react";
import "./SettingsPanel.css";

export default function SettingsPanel({ socket, agentMode, onModeChange, onOpenOverlay }) {
  const handleModeChange = (mode) => { if (onModeChange) onModeChange(mode); };

  return (
    <div className="settings-panel">
      {/* Nav items — each opens a dedicated page */}
      <div className="settings-nav">
        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("skills")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          <span>Skills</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("connectors")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          <span>Connectors</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("tasks")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span>Tasks</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("memories")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
          </svg>
          <span>Memories</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("agents")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span>Agents</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("sessions")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span>Sessions</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("cronJobs")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          <span>Cron Jobs</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("sync")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          </svg>
          <span>Sync</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <button className="settings-nav-item" onClick={() => onOpenOverlay && onOpenOverlay("healthCheck")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <span>Health Check</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="settings-nav-arrow"><polyline points="9 18 15 12 9 6" /></svg>
        </button>
      </div>
    </div>
  );
}
