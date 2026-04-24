import React, { useState, useEffect, useRef } from "react";
import SettingsPanel from "./SettingsPanel.jsx";
import "./Sidebar.css";

const ALL_MODELS = [
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-opus-4-20250514", label: "Opus 4" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-sonnet-4-20250514", label: "Sonnet 4" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

const MODE_OPTIONS = [
  { value: "terminal-persistent", label: "Terminal", icon: "$_", desc: "Full interactive CLI", hasDir: true },
  { value: "process-persistent", label: "Process", icon: "[]", desc: "Chat UI, stays alive" },
  { value: "process-oneshot", label: "Process (1x)", icon: ">", desc: "Chat UI, one response" },
];

// Filters are now dynamic — built from agents list + "all" and "computer"

export default function Sidebar({
  appName,
  conversations,
  currentConvoId,
  queueCount,
  runningCount,
  activeSessions,
  onSelectConversation,
  onViewConversationMessages,
  onNewConversation,
  onNewConversationWithMode,
  onOpenMasterChat,
  onDeleteConversation,
  onRenameConversation,
  onChangeStatus,
  onChangeModel,
  currentModel,
  onChangeMode,
  modeByConvo,
  masterChatMode,
  onChangeMasterChatMode,
  localSessions,
  onImportSession,
  onViewLocalSession,
  onOpenTasks,
  onOpenOverlay,
  onViewMessages,
  agentMode,
  onModeChange,
  onToggleStar,
  onChangeAgent,
  onReorderStarred,
  onClose,
}) {
  const [sidebarTab, setSidebarTab] = useState("chats"); // "chats" | "settings"
  const [filter, setFilter] = useState("all");
  const [agents, setAgents] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null); // null = not searching, [] = no results
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimeout = useRef(null);
  const [modelMenu, setModelMenu] = useState(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [newConvoDir, setNewConvoDir] = useState("");
  const [defaultDir, setDefaultDir] = useState(() => localStorage.getItem("default_working_dir") || "");
  const [savedDirs, setSavedDirs] = useState([]);
  const [showAddDir, setShowAddDir] = useState(false);
  const [newDirName, setNewDirName] = useState("");
  const [newDirPath, setNewDirPath] = useState("");
  const [masterMenu, setMasterMenu] = useState(null);

  useEffect(() => {
    if (!modelMenu && !masterMenu) return;
    const handleClick = () => { setModelMenu(null); setMasterMenu(null); };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [modelMenu, masterMenu]);

  useEffect(() => {
    fetch("/api/agents").then(r => r.json()).then(setAgents).catch(() => {});
    fetch("/api/directories").then(r => r.json()).then(setSavedDirs).catch(() => {});
  }, []);

  const handleModelSelect = (model) => { if (onChangeModel) onChangeModel(model); setModelMenu(null); };

  // Search: filter titles locally + search message content on server
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(searchQuery.trim())}`);
        const data = await res.json();
        setSearchResults(data);
      } catch {
        setSearchResults([]);
      }
      setSearchLoading(false);
    }, 300);
    return () => clearTimeout(searchTimeout.current);
  }, [searchQuery]);

  const isMaster = (c) => c.metadata && c.metadata.master === true;
  const nonMaster = conversations.filter((c) => !isMaster(c));
  const masterChat = conversations.find((c) => isMaster(c));
  const isMasterActive = masterChat && masterChat.id === currentConvoId;
  const isMasterRunning = masterChat && (masterChat.status === "in_progress" || activeSessions?.includes(masterChat.id));

  // Apply filter — dynamic agent names + "computer" for terminal mode
  const filterConvo = (c) => {
    if (filter === "all") return true;
    const agent = c.agent || "coding";
    const meta = typeof c.metadata === "string" ? JSON.parse(c.metadata || "{}") : (c.metadata || {});
    const mode = meta.mode || modeByConvo?.[c.id] || "";
    if (filter === "computer") return mode.startsWith("terminal");
    return agent === filter;
  };

  const filtered = nonMaster.filter(filterConvo);
  const queueItems = filtered.filter((c) => c.status === "waiting_for_user");
  const starredUnsorted = filtered.filter((c) => c.metadata?.starred && c.status !== "waiting_for_user");
  const starredItems = [...starredUnsorted].sort((a, b) => (a.metadata?.sort_order ?? 999) - (b.metadata?.sort_order ?? 999));
  const starredIds = new Set(starredItems.map(c => c.id));

  // DnD state for starred items
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const handleDragStart = (e, convoId) => {
    setDragId(convoId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", convoId);
  };
  const handleDragOver = (e, convoId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (convoId !== dragOverId) setDragOverId(convoId);
  };
  const handleDragEnd = () => { setDragId(null); setDragOverId(null); };
  const handleDrop = async (e, targetId) => {
    e.preventDefault();
    setDragOverId(null);
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    // Reorder: move dragId to targetId's position
    const ids = starredItems.map(c => c.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) { setDragId(null); return; }
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragId);
    // Persist sort_order for each
    for (let i = 0; i < ids.length; i++) {
      fetch(`/api/conversations/${ids[i]}/metadata`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sort_order: i }) }).catch(() => {});
    }
    // Optimistic update
    if (typeof onReorderStarred === "function") onReorderStarred(ids);
    setDragId(null);
  };
  const sessionItems = filtered.filter((c) => c.claude_session_id && c.status === "active" && activeSessions?.includes(c.id) && !starredIds.has(c.id));
  const otherItems = filtered.filter((c) => c.status !== "waiting_for_user" && !starredIds.has(c.id) && !(c.claude_session_id && c.status === "active" && activeSessions?.includes(c.id)));

  return (
    <>
    {modelMenu && (
      <div className="model-context-menu" style={{ top: modelMenu.y, left: modelMenu.x }} onClick={(e) => e.stopPropagation()}>
        <div className="ctx-header">Select Model</div>
        {ALL_MODELS.map((m) => (
          <button key={m.value} className={`ctx-item ${currentModel === m.value ? "ctx-model-active" : ""}`} onClick={() => handleModelSelect(m.value)}>
            {currentModel === m.value && <span className="ctx-check">&#10003;</span>} {m.label}
          </button>
        ))}
      </div>
    )}
    {masterMenu && (
      <div className="model-context-menu" style={{ top: masterMenu.y, left: masterMenu.x }} onClick={(e) => e.stopPropagation()}>
        <div className="ctx-header">Master Chat Mode</div>
        <button className={`ctx-item ${(!masterChatMode || masterChatMode === "process-persistent") ? "ctx-model-active" : ""}`} onClick={() => { if (onChangeMasterChatMode) onChangeMasterChatMode("process-persistent"); setMasterMenu(null); }}>
          {(!masterChatMode || masterChatMode === "process-persistent") && <span className="ctx-check">&#10003;</span>} <span className="ctx-mode-icon">[]</span> Process Persistent
        </button>
        <button className={`ctx-item ${masterChatMode === "terminal-persistent" ? "ctx-model-active" : ""}`} onClick={() => { if (onChangeMasterChatMode) onChangeMasterChatMode("terminal-persistent"); setMasterMenu(null); }}>
          {masterChatMode === "terminal-persistent" && <span className="ctx-check">&#10003;</span>} <span className="ctx-mode-icon">$_</span> Terminal Persistent
        </button>
        <div className="ctx-divider" />
        <div className="ctx-header">Model</div>
        {ALL_MODELS.map((m) => (
          <button key={m.value} className={`ctx-item ${currentModel === m.value ? "ctx-model-active" : ""}`} onClick={() => { handleModelSelect(m.value); setMasterMenu(null); }}>
            {currentModel === m.value && <span className="ctx-check">&#10003;</span>} {m.label}
          </button>
        ))}
      </div>
    )}
    <aside className="sidebar">
      <div className="sidebar-header">
        <h3>{appName || "AI Assistant"}</h3>
        <button className="btn-icon" onClick={onClose} title="Close sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Sidebar Tabs */}
      <div className="sidebar-tabs">
        <button className={`sidebar-tab ${sidebarTab === "chats" ? "active" : ""}`} onClick={() => setSidebarTab("chats")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          Chats
        </button>
        <button className={`sidebar-tab ${sidebarTab === "settings" ? "active" : ""}`} onClick={() => setSidebarTab("settings")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          Settings
        </button>
      </div>

      {sidebarTab === "settings" ? (
        <SettingsPanel agentMode={agentMode} onModeChange={onModeChange} onOpenOverlay={onOpenOverlay} />
      ) : (
      <>
      {/* Agent / Filter Select */}
      <div className="sidebar-filters">
        <select className="sidebar-agent-select" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All Chats</option>
          {agents.map(a => (
            <option key={a.name} value={a.name}>{a.name.charAt(0).toUpperCase() + a.name.slice(1)}</option>
          ))}
        </select>
      </div>

      {/* Search Bar */}
      <div className="sidebar-search">
        <svg className="sidebar-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
        <input
          className="sidebar-search-input"
          type="text"
          placeholder="Search chats..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button className="sidebar-search-clear" onClick={() => setSearchQuery("")}>&times;</button>
        )}
      </div>

      <div className="sidebar-actions">
        <button className={`master-chat-btn ${isMasterActive ? "active" : ""} ${isMasterRunning ? "running" : ""}`} onClick={onOpenMasterChat}
          onContextMenu={(e) => { e.preventDefault(); setMasterMenu({ x: e.clientX, y: e.clientY }); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
          </svg>
          Master Chat
          <span className="model-badge">{ALL_MODELS.find(m => m.value === currentModel)?.label || "?"}</span>
          {masterChatMode && <span className={`model-badge ${masterChatMode.startsWith("terminal") ? "mode-terminal" : "mode-process"}`}>
            {masterChatMode === "terminal-persistent" ? "$_" : "[]"}
          </span>}
        </button>
        <div className="new-chat-wrapper">
          <button className="new-chat-btn" onClick={() => setShowModeMenu(!showModeMenu)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Conversation
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginLeft: 'auto'}}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showModeMenu && (
            <div className="mode-dropdown">
              {MODE_OPTIONS.map((m) => (
                <button key={m.value} className="mode-option" onClick={() => {
                  setShowModeMenu(false);
                  const dir = newConvoDir.trim() || defaultDir.trim() || undefined;
                  if (onNewConversationWithMode) onNewConversationWithMode(m.value, dir);
                  else onNewConversation();
                  setNewConvoDir("");
                }}>
                  <span className="mode-icon">{m.icon}</span>
                  <div className="mode-info">
                    <span className="mode-label">{m.label}</span>
                    <span className="mode-desc">{m.desc}</span>
                  </div>
                </button>
              ))}
              <div className="mode-dir-section">
                <label className="mode-dir-label">Directory</label>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <select className="mode-dir-select" style={{ flex: 1 }} value={newConvoDir} onChange={(e) => setNewConvoDir(e.target.value)} onClick={(e) => e.stopPropagation()}>
                    <option value="">{defaultDir ? `Default: ${defaultDir.split(/[/\\]/).pop()}` : "Home directory"}</option>
                    {savedDirs.map(d => <option key={d.id} value={d.path}>{d.name}</option>)}
                  </select>
                  {newConvoDir && savedDirs.some(d => d.path === newConvoDir) && (
                    <button className="mode-dir-add-btn" style={{ color: "var(--flame)", borderColor: "color-mix(in srgb, var(--flame) 40%, transparent)", padding: "2px 6px", fontSize: 9 }} title="Remove this saved directory" onClick={async (e) => {
                      e.stopPropagation();
                      const dir = savedDirs.find(d => d.path === newConvoDir);
                      if (!dir || !confirm(`Remove saved directory "${dir.name}"?`)) return;
                      await fetch(`/api/directories/${dir.id}`, { method: "DELETE" });
                      const res = await fetch("/api/directories"); setSavedDirs(await res.json());
                      setNewConvoDir("");
                    }}>×</button>
                  )}
                </div>
                <input className="mode-dir-input" placeholder="Or paste a path to override..." value={newConvoDir}
                  onChange={(e) => setNewConvoDir(e.target.value)}
                  onClick={(e) => e.stopPropagation()} />
                {!showAddDir ? (
                  <div className="mode-dir-actions">
                    <button className="mode-dir-add-btn" onClick={(e) => { e.stopPropagation(); setShowAddDir(true); setNewDirPath(newConvoDir); }}>+ Save directory</button>
                    <button className="mode-dir-add-btn" onClick={(e) => { e.stopPropagation();
                      const val = prompt("Set default directory (used when no override):", defaultDir);
                      if (val !== null) { setDefaultDir(val); localStorage.setItem("default_working_dir", val); }
                    }}>Set default</button>
                  </div>
                ) : (
                  <div className="mode-dir-add-form" onClick={(e) => e.stopPropagation()}>
                    <input className="mode-dir-input" placeholder="Name (e.g. CRM, Trading)" value={newDirName} onChange={(e) => setNewDirName(e.target.value)} autoFocus />
                    <input className="mode-dir-input" placeholder="Full path (e.g. C:\Projects\CRM)" value={newDirPath} onChange={(e) => setNewDirPath(e.target.value)} />
                    <div className="mode-dir-actions">
                      <button className="mode-dir-save-btn" onClick={async () => {
                        if (!newDirName.trim() || !newDirPath.trim()) return;
                        await fetch("/api/directories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newDirName.trim(), path: newDirPath.trim() }) });
                        const res = await fetch("/api/directories"); setSavedDirs(await res.json());
                        setShowAddDir(false); setNewDirName(""); setNewDirPath("");
                      }}>Save</button>
                      <button className="mode-dir-cancel-btn" onClick={() => { setShowAddDir(false); setNewDirName(""); setNewDirPath(""); }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {/* Search results mode */}
        {searchQuery.trim() ? (
          <div className="sidebar-section">
            <div className="section-header">
              <span>{searchLoading ? "Searching..." : searchResults ? `Results (${searchResults.length})` : "Search"}</span>
            </div>
            {searchResults && searchResults.length === 0 && !searchLoading && (
              <div className="empty-section">No matches found</div>
            )}
            {searchResults && searchResults.map((r) => {
              const isLocal = r.status === "local";
              if (isLocal) {
                const localSession = { sessionId: r.sessionId, projectPath: r.projectPath || "", sizeKb: r.sizeKb || 0, modified: r.modified || "" };
                return (
                  <React.Fragment key={r.id}>
                    <LocalSessionItem session={localSession} onImport={onImportSession} onViewMessages={onViewLocalSession} />
                    {r.snippet && <div className="search-snippet" style={{ padding: "0 12px 6px 26px" }}>{r.snippet}</div>}
                  </React.Fragment>
                );
              }
              const fullConvo = conversations.find(c => c.id === r.id);
              if (!fullConvo) return null;
              return (
                <React.Fragment key={r.id}>
                  <ConvoItem convo={fullConvo} isActive={fullConvo.id === currentConvoId}
                    onClick={() => onSelectConversation(fullConvo)} onDoubleClick={() => onViewConversationMessages && onViewConversationMessages(fullConvo)} onDelete={onDeleteConversation} onChangeStatus={onChangeStatus} onRename={onRenameConversation} onChangeModel={onChangeModel} currentModel={currentModel} onChangeMode={onChangeMode} convoMode={modeByConvo?.[fullConvo.id] || fullConvo.metadata?.mode} onViewMessages={onViewMessages} onToggleStar={onToggleStar} onChangeAgent={onChangeAgent} agentsList={agents} />
                  {r.snippet && <div className="search-snippet" style={{ padding: "0 12px 6px 26px" }}>{r.snippet}</div>}
                </React.Fragment>
              );
            })}
          </div>
        ) : (
        <>
        {queueItems.length > 0 && (
          <div className="sidebar-section">
            <div className="section-header">
              <span>Needs Attention</span>
              <span className="queue-badge">{queueItems.length}</span>
            </div>
            {queueItems.map((convo) => (
              <ConvoItem key={convo.id} convo={convo} isActive={convo.id === currentConvoId}
                onClick={() => onSelectConversation(convo)} onDoubleClick={() => onViewConversationMessages && onViewConversationMessages(convo)} onDelete={onDeleteConversation} onChangeStatus={onChangeStatus} onRename={onRenameConversation} onChangeModel={onChangeModel} currentModel={currentModel} onChangeMode={onChangeMode} convoMode={modeByConvo?.[convo.id] || convo.metadata?.mode} onViewMessages={onViewMessages} onToggleStar={onToggleStar} onChangeAgent={onChangeAgent} agentsList={agents} />
            ))}
          </div>
        )}

        {starredItems.length > 0 && (
          <div className="sidebar-section">
            <div className="section-header">
              <span>Starred</span>
              <span className="starred-count">{starredItems.length}</span>
            </div>
            {starredItems.map((convo) => (
              <div key={convo.id}
                draggable
                onDragStart={(e) => handleDragStart(e, convo.id)}
                onDragOver={(e) => handleDragOver(e, convo.id)}
                onDragEnd={handleDragEnd}
                onDrop={(e) => handleDrop(e, convo.id)}
                className={`dnd-wrapper${dragId === convo.id ? " dnd-dragging" : ""}${dragOverId === convo.id && dragId !== convo.id ? " dnd-over" : ""}`}
              >
                <ConvoItem convo={activeSessions?.includes(convo.id) ? { ...convo, status: "session_active" } : convo} isActive={convo.id === currentConvoId}
                  onClick={() => onSelectConversation(convo)} onDoubleClick={() => onViewConversationMessages && onViewConversationMessages(convo)} onDelete={onDeleteConversation} onChangeStatus={onChangeStatus} onRename={onRenameConversation} onChangeModel={onChangeModel} currentModel={currentModel} onChangeMode={onChangeMode} convoMode={modeByConvo?.[convo.id] || convo.metadata?.mode} onViewMessages={onViewMessages} onToggleStar={onToggleStar} onChangeAgent={onChangeAgent} agentsList={agents} />
              </div>
            ))}
          </div>
        )}

        {sessionItems.length > 0 && (
          <div className="sidebar-section">
            <div className="section-header">
              <span>Active Sessions</span>
              <span className="session-count">{sessionItems.length}</span>
            </div>
            {sessionItems.map((convo) => (
              <ConvoItem key={convo.id} convo={{ ...convo, status: "session_active" }} isActive={convo.id === currentConvoId}
                onClick={() => onSelectConversation(convo)} onDoubleClick={() => onViewConversationMessages && onViewConversationMessages(convo)} onDelete={onDeleteConversation} onChangeStatus={onChangeStatus} onRename={onRenameConversation} onChangeModel={onChangeModel} currentModel={currentModel} onChangeMode={onChangeMode} convoMode={modeByConvo?.[convo.id] || convo.metadata?.mode} onViewMessages={onViewMessages} onToggleStar={onToggleStar} onChangeAgent={onChangeAgent} agentsList={agents} />
            ))}
          </div>
        )}

        <div className="sidebar-section">
          <div className="section-header"><span>Recent Chats</span></div>
          {otherItems.length === 0 && queueItems.length === 0 && starredItems.length === 0 && (
            <div className="empty-section">No conversations yet</div>
          )}
          {otherItems.map((convo) => (
            <ConvoItem key={convo.id} convo={activeSessions?.includes(convo.id) ? { ...convo, status: "session_active" } : convo} isActive={convo.id === currentConvoId}
              onClick={() => onSelectConversation(convo)} onDoubleClick={() => onViewConversationMessages && onViewConversationMessages(convo)} onDelete={onDeleteConversation} onChangeStatus={onChangeStatus} onRename={onRenameConversation} onChangeModel={onChangeModel} currentModel={currentModel} onChangeMode={onChangeMode} convoMode={modeByConvo?.[convo.id] || convo.metadata?.mode} onViewMessages={onViewMessages} onToggleStar={onToggleStar} onChangeAgent={onChangeAgent} agentsList={agents} />
          ))}
        </div>

        {localSessions && localSessions.length > 0 && (
          <div className="sidebar-section">
            <div className="section-header">
              <span>Sessions on Computer</span>
              <span className="local-count">{localSessions.length}</span>
            </div>
            {localSessions.map((s) => (
              <LocalSessionItem key={s.sessionId} session={s} onImport={onImportSession} onViewMessages={onViewLocalSession} />
            ))}
          </div>
        )}
        </>
        )}
      </div>
      </>
      )}
    </aside>
    </>
  );
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function ConvoItem({ convo, isActive, onClick, onDoubleClick, onDelete, onChangeStatus, onRename, onChangeModel, currentModel, onChangeMode, convoMode, onViewMessages, onToggleStar, onChangeAgent, agentsList }) {
  const statusClass = convo.status || "active";
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(convo.title || "");
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSessionModal, setShowSessionModal] = useState(false);
  const [sessionHistory, setSessionHistory] = useState([]);
  const [newSessionId, setNewSessionId] = useState("");
  const menuRef = useRef(null);
  const inputRef = useRef(null);

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const setStatus = (status) => {
    if (onChangeStatus) onChangeStatus(convo.id, status);
    setMenuOpen(false);
  };

  const handleRename = () => {
    setMenuOpen(false);
    setEditTitle(convo.title || "");
    setEditing(true);
  };

  const submitRename = () => {
    setEditing(false);
    if (editTitle.trim() && editTitle.trim() !== convo.title && onRename) {
      onRename(convo.id, editTitle.trim());
    }
  };

  return (
    <>
      <div
        className={`convo-item ${statusClass} ${isActive ? "selected" : ""}`}
        onClick={editing ? undefined : onClick}
        onDoubleClick={editing ? undefined : onDoubleClick}
        onContextMenu={handleContextMenu}
      >
        <div className="convo-item-row">
          <span className={`status-indicator ${statusClass}`} />
          {editing ? (
            <input
              ref={inputRef}
              className="convo-title-input"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={submitRename}
              onKeyDown={(e) => { if (e.key === "Enter") submitRename(); if (e.key === "Escape") setEditing(false); }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="convo-title" onDoubleClick={(e) => { e.stopPropagation(); handleRename(); }}>
              {convo.title || "Untitled"}
            </span>
          )}
          {onDelete && !editing && (
            <button
              className="convo-delete-btn"
              onClick={(e) => { e.stopPropagation(); onDelete(convo.id); }}
              title="Delete conversation"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" /><path d="M14 11v6" />
              </svg>
            </button>
          )}
        </div>
        {convo.status_summary && convo.status === "waiting_for_user" && (
          <span className="convo-summary">{convo.status_summary}</span>
        )}
        {convo.last_message_text && (
          <span className="convo-last-msg">
            {convo.last_message_role === "user" ? "You" : "Christopher"}: {convo.last_message_text.slice(0, 80)}
          </span>
        )}
        <div className="convo-meta-tags">
          {convoMode && <span className={`convo-mode-badge ${convoMode.startsWith("terminal") ? "terminal" : "process"}`}>
            {convoMode === "terminal-persistent" ? "$_ Terminal" : convoMode === "terminal-oneshot" ? ">_ Terminal 1x" : convoMode === "process-persistent" ? "[] Process" : "> Process 1x"}
          </span>}
          {convo.claude_session_id && <span className="convo-session-id">session: {convo.claude_session_id.slice(0, 8)}</span>}
        </div>
        <div className="convo-meta">
          <span className="convo-meta-item">{convo.last_message_at ? `last msg ${formatTime(convo.last_message_at)}` : `modified ${formatTime(convo.updated_at)}`}</span>
          <span className="convo-meta-sep" />
          <span className="convo-meta-item">created {formatTime(convo.created_at)}</span>
        </div>
      </div>

      {menuOpen && (
        <div className="convo-context-menu" ref={menuRef}
          style={{ top: menuPos.y, left: menuPos.x }}>
          <button className="ctx-item" onClick={handleRename}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            Rename
          </button>
          {onToggleStar && (
            <button className="ctx-item" onClick={() => { onToggleStar(convo.id, !convo.metadata?.starred); setMenuOpen(false); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill={convo.metadata?.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
              {convo.metadata?.starred ? "Unstar" : "Star"}
            </button>
          )}
          <button className="ctx-item" onClick={() => { setMenuOpen(false); setShowSettingsModal(true); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09" /></svg>
            Settings
          </button>
          {convoMode?.startsWith("terminal") && onViewMessages && (
            <button className="ctx-item" onClick={() => { setMenuOpen(false); onViewMessages(convo.id); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              View Messages
            </button>
          )}
          <button className="ctx-item" onClick={async () => {
            setMenuOpen(false);
            setNewSessionId(convo.claude_session_id || "");
            try {
              const res = await fetch(`/api/conversations/${convo.id}/session-history`);
              const history = await res.json();
              // Add current session to top if not already there
              const current = convo.claude_session_id;
              if (current && !history.find(h => h.session_id === current)) {
                history.unshift({ session_id: current, source: "current", set_at: new Date().toISOString() });
              }
              setSessionHistory(history);
            } catch { setSessionHistory([]); }
            setShowSessionModal(true);
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
            Sessions
          </button>
          <div className="ctx-divider" />
          <div className="ctx-header">Status</div>
          {[
            { value: "active", label: "Active", color: "var(--success)" },
            { value: "completed", label: "Completed", color: "var(--text-muted)" },
          ].map((s) => (
            <button key={s.value} className={`ctx-item ${convo.status === s.value ? "ctx-model-active" : ""}`}
              onClick={() => { setStatus(s.value); }}>
              <span className="ctx-status-dot" style={{ background: s.color, width: 8, height: 8, borderRadius: "50%", display: "inline-block", flexShrink: 0 }} />
              {s.label}
            </button>
          ))}
          <div className="ctx-divider" />
          <button className="ctx-item ctx-delete" onClick={() => { onDelete(convo.id); setMenuOpen(false); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            Delete
          </button>
        </div>
      )}

      {showSettingsModal && (
        <div className="convo-settings-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="convo-settings-modal" onClick={e => e.stopPropagation()}>
            <div className="csm-header">
              <span className="csm-title">{convo.title || "Untitled"}</span>
              <button className="csm-close" onClick={() => setShowSettingsModal(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>

            <div className="csm-section">
              <div className="csm-label">Model</div>
              <div className="csm-options">
                {ALL_MODELS.map((m) => (
                  <button key={m.value} className={`csm-option ${currentModel === m.value ? "active" : ""}`}
                    onClick={() => { if (onChangeModel) onChangeModel(m.value); }}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="csm-section">
              <div className="csm-label">Mode</div>
              <div className="csm-options">
                {MODE_OPTIONS.map((m) => (
                  <button key={m.value} className={`csm-option ${convoMode === m.value ? "active" : ""}`}
                    onClick={() => { if (onChangeMode) onChangeMode(convo.id, m.value); }}>
                    <span className="csm-mode-icon">{m.icon}</span> {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="csm-section">
              <div className="csm-label">Status</div>
              <div className="csm-options">
                {[
                  { value: "active", label: "Active", color: "var(--success)" },
                  { value: "completed", label: "Completed", color: "var(--text-muted)" },
                  { value: "waiting_for_user", label: "Waiting", color: "var(--warning)" },
                  { value: "error", label: "Error", color: "var(--danger)" },
                ].map((s) => (
                  <button key={s.value} className={`csm-option ${convo.status === s.value ? "active" : ""}`}
                    onClick={() => { setStatus(s.value); }}>
                    <span className="csm-status-dot" style={{ background: s.color }} />
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {onChangeAgent && agentsList?.length > 0 && (
              <div className="csm-section">
                <div className="csm-label">Agent</div>
                <div className="csm-options">
                  {agentsList.map((a) => (
                    <button key={a.name} className={`csm-option ${convo.agent === a.name ? "active" : ""}`}
                      onClick={() => onChangeAgent(convo.id, a.name)}>
                      {a.name.charAt(0).toUpperCase() + a.name.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showSessionModal && (
        <div className="convo-settings-overlay" onClick={() => setShowSessionModal(false)}>
          <div className="convo-settings-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="csm-header">
              <span className="csm-title">Sessions — {convo.title || "Untitled"}</span>
              <button className="csm-close" onClick={() => setShowSessionModal(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>

            <div className="csm-section">
              <div className="csm-label">Set Session ID</div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={newSessionId}
                  onChange={e => setNewSessionId(e.target.value)}
                  placeholder="Paste session UUID..."
                  style={{ flex: 1, padding: "7px 10px", background: "var(--bg-tertiary)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", color: "var(--text-primary)", fontSize: 12, fontFamily: "var(--font-mono)", outline: "none" }}
                />
                <button
                  onClick={async () => {
                    const id = newSessionId.trim() || null;
                    await fetch(`/api/conversations/${convo.id}/session`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(() => {});
                    if (onChangeStatus) onChangeStatus(convo.id, convo.status);
                    setShowSessionModal(false);
                  }}
                  style={{ padding: "7px 14px", background: "var(--accent-muted)", border: "1px solid var(--accent)", borderRadius: "var(--radius-md)", color: "var(--accent-light)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)", whiteSpace: "nowrap" }}
                >Save</button>
              </div>
            </div>

            {sessionHistory.length > 0 && (
              <div className="csm-section">
                <div className="csm-label">History</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 250, overflowY: "auto" }}>
                  {sessionHistory.map((h, i) => (
                    <div key={i}
                      onClick={() => setNewSessionId(h.session_id)}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                        padding: "8px 10px", background: h.session_id === convo.claude_session_id ? "var(--accent-muted)" : "var(--bg-tertiary)",
                        border: h.session_id === convo.claude_session_id ? "1px solid var(--accent)" : "1px solid var(--border)",
                        borderRadius: "var(--radius-md)", cursor: "pointer", transition: "border-color 0.12s",
                      }}
                      onMouseEnter={e => { if (h.session_id !== convo.claude_session_id) e.currentTarget.style.borderColor = "var(--border-secondary)"; }}
                      onMouseLeave={e => { if (h.session_id !== convo.claude_session_id) e.currentTarget.style.borderColor = "var(--border)"; }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: h.session_id === convo.claude_session_id ? "var(--accent-light)" : "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {h.session_id.slice(0, 20)}...
                        </div>
                        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                          {h.source} — {new Date(h.set_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                      {h.session_id === convo.claude_session_id && (
                        <span style={{ fontSize: 9, padding: "2px 6px", background: "var(--accent)", color: "#fff", borderRadius: 8, flexShrink: 0 }}>current</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function LocalSessionItem({ session, onImport, onViewMessages }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const shortProject = (p) => {
    const parts = p.replace(/\\/g, "/").split("/");
    return parts.length <= 2 ? parts.join("/") : ".../" + parts.slice(-2).join("/");
  };

  return (
    <>
      <div className="convo-item local-session"
        onDoubleClick={() => { if (onViewMessages) onViewMessages(session.sessionId, `Session ${session.sessionId.slice(0, 8)} - ${shortProject(session.projectPath)}`); }}
        onContextMenu={(e) => { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); setMenuOpen(true); }}>
        <div className="convo-item-row">
          <span className="status-indicator local" />
          <span className="convo-title">{session.sessionId.slice(0, 12)}...</span>
        </div>
        <div className="convo-meta-tags">
          <span className="convo-session-id">{shortProject(session.projectPath)}</span>
          <span className="convo-session-id">{session.sizeKb}KB</span>
        </div>
        <div className="convo-meta">
          <span className="convo-meta-item">{new Date(session.modified).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        </div>
      </div>

      {menuOpen && (
        <div className="convo-context-menu" ref={menuRef} style={{ top: menuPos.y, left: menuPos.x }}>
          {onViewMessages && (
            <button className="ctx-item" onClick={() => { onViewMessages(session.sessionId, `Session ${session.sessionId.slice(0, 8)} - ${shortProject(session.projectPath)}`); setMenuOpen(false); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
              View Messages
            </button>
          )}
          <button className="ctx-item" onClick={() => { onImport(session.sessionId, `Session ${session.sessionId.slice(0, 8)} - ${shortProject(session.projectPath)}`); setMenuOpen(false); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            Add to Database
          </button>
        </div>
      )}
    </>
  );
}
