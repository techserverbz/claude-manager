import React, { useRef, useEffect, useState, useCallback } from "react";
import Markdown from "react-markdown";
import XtermPanel from "./XtermPanel.jsx";
import "./CliPanel.css";

export default function CliPanel({ events, streamingText, isThinking, onSendMessage, onStop, socket, conversationId, keepAlive, onToggleKeepAlive, mode, conversationConfig, isNewConversation, sessionId, viewMessages, onCloseViewMessages, hasMore, totalMessages, onLoadMore, sessionCwd, autoShowTerminal, onSwitchMode }) {
  const isTerminalConvo = mode === "terminal-oneshot" || mode === "terminal-persistent";

  // ALL hooks must be declared before any conditional returns (React rules of hooks)
  const [showTerminal, setShowTerminal] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const findInputRef = useRef(null);
  const [inputText, setInputText] = useState("");
  const [pendingImages, setPendingImages] = useState([]);
  const [collapsedTools, setCollapsedTools] = useState({});
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatches, setFindMatches] = useState(0);
  const [findCurrent, setFindCurrent] = useState(0);
  const [cwdMenu, setCwdMenu] = useState(null); // { x, y } or null
  const cwdMenuRef = useRef(null);
  const stickToBottom = useRef(true);

  // Close cwd context menu on outside click
  useEffect(() => {
    if (!cwdMenu) return;
    const close = (e) => { if (cwdMenuRef.current && !cwdMenuRef.current.contains(e.target)) setCwdMenu(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [cwdMenu]);

  // Reset to message view when conversation changes, or show terminal if requested
  useEffect(() => {
    setShowTerminal(!!autoShowTerminal);
    stickToBottom.current = true;
    prevEventsLen.current = 0; // Reset so next events load triggers scroll
  }, [conversationId, autoShowTerminal]);

  // Find in chat — highlight and navigate matches
  useEffect(() => {
    if (!scrollRef.current) return;
    const container = scrollRef.current;
    container.querySelectorAll("mark.cli-find-hl").forEach((m) => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
    if (!findQuery.trim()) { setFindMatches(0); setFindCurrent(0); return; }

    const query = findQuery.toLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let count = 0;
    for (const node of textNodes) {
      const text = node.textContent;
      const idx = text.toLowerCase().indexOf(query);
      if (idx === -1) continue;
      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + query.length);
      const after = text.slice(idx + query.length);
      const mark = document.createElement("mark");
      mark.className = "cli-find-hl";
      mark.setAttribute("data-find-idx", count);
      mark.textContent = match;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode.replaceChild(frag, node);
      count++;
    }
    setFindMatches(count);
    setFindCurrent(count > 0 ? 1 : 0);
    const first = container.querySelector('mark.cli-find-hl[data-find-idx="0"]');
    if (first) { first.classList.add("active"); first.scrollIntoView({ block: "center" }); }
  }, [findQuery, events.length]);

  useEffect(() => {
    if (showFind && findInputRef.current) findInputRef.current.focus();
  }, [showFind]);

  const prevEventsLen = useRef(0);
  useEffect(() => {
    const wasEmpty = prevEventsLen.current === 0;
    prevEventsLen.current = events.length;
    // Always scroll on initial load (0 → N), otherwise respect stickToBottom
    if ((wasEmpty && events.length > 0) || stickToBottom.current) {
      if (scrollRef.current) {
        // Multiple attempts — large conversations take longer to render
        for (const delay of [50, 200, 500]) {
          setTimeout(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }, delay);
        }
      }
    }
  }, [events.length, streamingText]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = gap < 30;
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", onWheel, { passive: true });
    return () => { el.removeEventListener("wheel", onWheel); el.removeEventListener("touchmove", onWheel); };
  }, []);

  const navigateFind = (dir) => {
    if (findMatches === 0 || !scrollRef.current) return;
    const next = dir === "next"
      ? (findCurrent % findMatches) + 1
      : ((findCurrent - 2 + findMatches) % findMatches) + 1;
    setFindCurrent(next);
    scrollRef.current.querySelectorAll("mark.cli-find-hl").forEach((m) => m.classList.remove("active"));
    const el = scrollRef.current.querySelector(`mark.cli-find-hl[data-find-idx="${next - 1}"]`);
    if (el) { el.classList.add("active"); el.scrollIntoView({ block: "center" }); }
  };

  // Show xterm only when explicitly toggled (or new conversation auto-connect)
  if (isTerminalConvo && (showTerminal || isNewConversation)) {
    return (
      <div className="cli-panel">
        <div className="cli-mode-bar">
          <span className="cli-mode-indicator terminal">{mode === "terminal-persistent" ? "Terminal (Persistent)" : "Terminal (One-shot)"}</span>
          {sessionId && <span className="cli-session-tag" title="Click to copy" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(sessionId); const el = e.currentTarget; el.classList.add("copied"); setTimeout(() => el.classList.remove("copied"), 1200); }}>{sessionId}</span>}
          {sessionCwd && <span className="cli-cwd-tag" title={sessionCwd} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCwdMenu({ x: e.clientX, y: e.clientY }); }}>{sessionCwd}</span>}
          {onSwitchMode && (
            <button onClick={() => onSwitchMode("process-persistent")} className="cli-mode-bar-btn switch-mode" title="Switch to Process mode">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
              Process
            </button>
          )}
          <button onClick={() => setShowTerminal(false)} className="cli-mode-bar-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
            Messages
          </button>
        </div>
        <XtermPanel
          key={conversationId}
          socket={socket}
          conversationId={conversationId}
          mode={mode}
          config={conversationConfig}
          autoConnect={isNewConversation}
          sessionId={sessionId}
        />
        {mode === "terminal-oneshot" && (
          <form className="cli-input-bar" onSubmit={(e) => {
            e.preventDefault();
            const input = e.target.elements.msg;
            if (!input.value.trim()) return;
            onSendMessage(input.value.trim(), []);
            input.value = "";
          }}>
            <span className="cli-input-prompt">&gt;</span>
            <textarea name="msg" className="cli-input" placeholder="Type a message (one-shot)..." rows={1}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } }} />
            <button type="submit" className="cli-send-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
            </button>
          </form>
        )}
      </div>
    );
  }

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!inputText.trim() && pendingImages.length === 0) return;
    onSendMessage(inputText.trim(), pendingImages.map((img) => img.dataUrl));
    setInputText("");
    setPendingImages([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e); }
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) { e.preventDefault(); addImageFile(item.getAsFile()); }
    }
  };

  const handleFileSelect = (e) => {
    for (const file of Array.from(e.target.files || [])) {
      if (file.type.startsWith("image/")) addImageFile(file);
    }
    e.target.value = "";
  };

  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    for (const file of Array.from(e.dataTransfer.files || [])) {
      if (file.type.startsWith("image/")) addImageFile(file);
    }
  };

  const addImageFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPendingImages((prev) => [...prev, { dataUrl: ev.target.result, name: file.name }]);
    reader.readAsDataURL(file);
  };

  return (
    <div className="cli-panel" onDrop={handleDrop} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="cli-mode-bar">
        <span className={`cli-mode-indicator ${isTerminalConvo ? "terminal" : "process"}`}>
          {isTerminalConvo
            ? (mode === "terminal-persistent" ? "Terminal (Persistent)" : "Terminal (One-shot)")
            : (keepAlive ? "Process (Persistent)" : "Process (One-shot)")}
        </span>
        {sessionId && <span className="cli-session-tag" title="Click to copy" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(sessionId); const el = e.currentTarget; el.classList.add("copied"); setTimeout(() => el.classList.remove("copied"), 1200); }}>{sessionId}</span>}
        {sessionCwd && <span className="cli-cwd-tag" title={sessionCwd} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCwdMenu({ x: e.clientX, y: e.clientY }); }}>{sessionCwd}</span>}
        {onSwitchMode && (
          <button onClick={() => onSwitchMode(isTerminalConvo ? "process-persistent" : "terminal-persistent")} className="cli-mode-bar-btn switch-mode" title={isTerminalConvo ? "Switch to Process" : "Switch to Terminal"}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" /></svg>
            {isTerminalConvo ? "Process" : "Terminal"}
          </button>
        )}
        {isTerminalConvo && sessionId && (
          <button onClick={() => setShowTerminal(true)} className="cli-mode-bar-btn resume">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            Resume Session
          </button>
        )}
        {isTerminalConvo && !sessionId && (
          <button onClick={() => setShowTerminal(true)} className="cli-mode-bar-btn">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></svg>
            Open Terminal
          </button>
        )}
        <button onClick={() => { setShowFind(!showFind); if (showFind) { setFindQuery(""); } }} className="cli-mode-bar-btn" style={{ marginLeft: isTerminalConvo ? 0 : "auto" }} title="Find in chat (Ctrl+F)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          Find
        </button>
      </div>
      {showFind && (
        <div className="cli-find-bar">
          <input ref={findInputRef} className="cli-find-input" type="text" placeholder="Find in chat..." value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") navigateFind(e.shiftKey ? "prev" : "next"); if (e.key === "Escape") { setShowFind(false); setFindQuery(""); } }}
          />
          <span className="cli-find-count">{findMatches > 0 ? `${findCurrent}/${findMatches}` : findQuery ? "0" : ""}</span>
          <button className="cli-find-nav" onClick={() => navigateFind("prev")} disabled={findMatches === 0}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15" /></svg>
          </button>
          <button className="cli-find-nav" onClick={() => navigateFind("next")} disabled={findMatches === 0}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <button className="cli-find-nav" onClick={() => { setShowFind(false); setFindQuery(""); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}
      <div className="cli-split-container">
        <div className="cli-chat-side">
          <div className="cli-terminal" ref={scrollRef}>
            {hasMore && onLoadMore && (
              <div className="cli-load-more">
                <button className="cli-load-more-btn" onClick={onLoadMore}>
                  Load earlier messages {totalMessages > 0 ? `(${events.length} of ${totalMessages})` : ""}
                </button>
              </div>
            )}
            {events.length === 0 && !streamingText && !isThinking && (
              <div className="cli-welcome">
                <span className="cli-prompt-char">&gt;</span>
                <span className="cli-welcome-text">CLI - Ready for input</span>
              </div>
            )}
            {events.map((evt, i) => (
              <CliEvent key={i} event={evt} index={i} collapsed={collapsedTools[i]} onToggle={() => setCollapsedTools((p) => ({ ...p, [i]: !p[i] }))} />
            ))}
            {isThinking && !streamingText && events.length > 0 && (
              <div className="cli-thinking"><span className="cli-spinner" /><span>Thinking...</span></div>
            )}
            {streamingText && (
              <div className="cli-streaming"><CliText text={streamingText} /><span className="cli-cursor" /></div>
            )}
          </div>

          {pendingImages.length > 0 && (
            <div className="cli-image-preview">
              {pendingImages.map((img, i) => (
                <div key={i} className="cli-image-item">
                  <img src={img.dataUrl} alt={img.name || "Preview"} />
                  <button className="cli-image-remove" onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))}>x</button>
                </div>
              ))}
            </div>
          )}

          <form className="cli-input-bar" onSubmit={handleSubmit}>
            <span className="cli-input-prompt">&gt;</span>
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleFileSelect} />
            <button type="button" className="cli-attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach image">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            <textarea ref={inputRef} className="cli-input" value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste} placeholder="Type a message..." rows={1} />
            <button type="button" className="cli-stop-btn" onClick={onStop} title="Stop CLI instance">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
            <button type="submit" className="cli-send-btn" disabled={!inputText.trim() && pendingImages.length === 0}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
        </div>

      </div>

      {cwdMenu && sessionCwd && (
        <div className="cli-cwd-menu" ref={cwdMenuRef} style={{ top: cwdMenu.y, left: cwdMenu.x }}>
          <button className="cli-cwd-menu-item" onClick={() => {
            fetch("/api/open-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: sessionCwd }) }).catch(() => {
              window.open(`file:///${sessionCwd.replace(/\\/g, "/")}`, "_blank");
            });
            setCwdMenu(null);
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
            Open in Explorer
          </button>
          <button className="cli-cwd-menu-item" onClick={() => {
            const projectHash = sessionCwd.replace(/[:\\/]/g, "-").replace(/^-/, "");
            const claudePath = `${sessionCwd}/.claude`;
            fetch("/api/open-path", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: claudePath }) }).catch(() => {
              window.open(`file:///${claudePath.replace(/\\/g, "/")}`, "_blank");
            });
            setCwdMenu(null);
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06" /></svg>
            Open .claude folder
          </button>
          <button className="cli-cwd-menu-item" onClick={() => {
            navigator.clipboard.writeText(sessionCwd);
            setCwdMenu(null);
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            Copy full path
          </button>
        </div>
      )}
    </div>
  );
}

// (RawTerminal removed — replaced by XtermPanel for terminal modes)

// --- Chat view components (unchanged) ---

function CliEvent({ event, index, collapsed, onToggle }) {
  if (!event) return null;

  if (event.type === "user_message") {
    return (
      <div className="cli-event cli-user-msg">
        <span className="cli-prompt-char">&gt;</span>
        <span className="cli-user-text">{event.text}</span>
        {event.imagePaths?.length > 0 && <span className="cli-image-badge">[{event.imagePaths.length} image(s)]</span>}
      </div>
    );
  }

  if (event.type === "system" && event.subtype === "init") {
    return (
      <div className="cli-event cli-system">
        <span className="cli-icon cli-icon-system">~</span>
        <span className="cli-dim">Session initialized</span>
        {event.session_id && <span className="cli-session-id">{event.session_id.slice(0, 8)}...</span>}
      </div>
    );
  }

  if (event.type === "assistant" && event.message?.content) {
    return (
      <div className="cli-event-group">
        {event.message.content.map((block, bi) => {
          if (block.type === "tool_use") return <CliToolCall key={bi} block={block} id={`${index}-${bi}`} collapsed={collapsed} onToggle={onToggle} />;
          if (block.type === "text" && block.text) return <div key={bi} className="cli-event cli-assistant-text"><CliText text={block.text} /></div>;
          return null;
        })}
      </div>
    );
  }

  if (event.type === "result") {
    return (
      <div className="cli-event cli-result">
        <span className="cli-icon cli-icon-done">&#10003;</span>
        <span className="cli-done-text">Done</span>
        {event.cost_usd !== undefined && <span className="cli-cost">${Number(event.cost_usd).toFixed(4)}</span>}
      </div>
    );
  }

  return null;
}

function CliToolCall({ block, id, collapsed, onToggle }) {
  const toolName = block.name || "unknown";
  const input = block.input || {};
  let detail = "", detailContent = "";

  switch (toolName) {
    case "Read": detail = input.file_path ? shortPath(input.file_path) : ""; break;
    case "Write": detail = input.file_path ? shortPath(input.file_path) : ""; detailContent = input.content ? truncate(input.content, 500) : ""; break;
    case "Edit": detail = input.file_path ? shortPath(input.file_path) : ""; if (input.old_string && input.new_string) detailContent = `- ${truncate(input.old_string, 200)}\n+ ${truncate(input.new_string, 200)}`; break;
    case "Bash": detail = input.command ? truncate(input.command, 100) : ""; detailContent = input.command || ""; break;
    case "Grep": detail = input.pattern ? `"${input.pattern}"` : ""; if (input.path) detail += ` in ${shortPath(input.path)}`; break;
    case "Glob": detail = input.pattern || ""; if (input.path) detail += ` in ${shortPath(input.path)}`; break;
    case "WebSearch": detail = input.query ? `"${input.query}"` : ""; break;
    case "WebFetch": detail = input.url ? truncate(input.url, 80) : ""; break;
    case "Agent": detail = input.description || input.prompt?.slice(0, 60) || ""; break;
    default: if (input.file_path) detail = shortPath(input.file_path); else if (input.command) detail = truncate(input.command, 80); break;
  }

  const hasDetail = detailContent && detailContent.length > 0;

  return (
    <div className="cli-event cli-tool-call">
      <div className="cli-tool-header" onClick={hasDetail ? onToggle : undefined} style={hasDetail ? { cursor: "pointer" } : {}}>
        <span className="cli-icon cli-icon-tool">{getToolIcon(toolName)}</span>
        <span className="cli-tool-name">{toolName}</span>
        {detail && <span className="cli-tool-detail">{detail}</span>}
        {hasDetail && <span className="cli-tool-expand">{collapsed ? "+" : "-"}</span>}
      </div>
      {hasDetail && !collapsed && <div className="cli-tool-content"><pre>{detailContent}</pre></div>}
    </div>
  );
}

function CliText({ text }) {
  if (!text) return null;
  // Strip ANSI escape codes and terminal control chars
  const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/[\x00-\x08\x0e-\x1f]/g, "");
  return (
    <div className="cli-markdown">
      <Markdown
        components={{
          code({ inline, className, children, ...props }) {
            const lang = className?.replace("language-", "") || "";
            if (!inline) {
              return (
                <pre className="cli-code-block">
                  {lang && <div className="cli-code-lang">{lang}</div>}
                  <code {...props}>{children}</code>
                </pre>
              );
            }
            return <code className="cli-inline-code" {...props}>{children}</code>;
          },
          p({ children }) { return <p style={{ margin: "4px 0" }}>{children}</p>; },
          ul({ children }) { return <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>{children}</ul>; },
          ol({ children }) { return <ol style={{ margin: "4px 0", paddingLeft: "20px" }}>{children}</ol>; },
          li({ children }) { return <li style={{ margin: "2px 0" }}>{children}</li>; },
          h1({ children }) { return <h1 style={{ fontSize: "1.3em", margin: "8px 0 4px", color: "var(--text-primary)" }}>{children}</h1>; },
          h2({ children }) { return <h2 style={{ fontSize: "1.15em", margin: "8px 0 4px", color: "var(--text-primary)" }}>{children}</h2>; },
          h3({ children }) { return <h3 style={{ fontSize: "1.05em", margin: "6px 0 3px", color: "var(--text-primary)" }}>{children}</h3>; },
          a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{children}</a>; },
          blockquote({ children }) { return <blockquote style={{ borderLeft: "3px solid var(--border)", paddingLeft: "10px", margin: "4px 0", color: "var(--text-muted)" }}>{children}</blockquote>; },
          table({ children }) { return <table style={{ borderCollapse: "collapse", margin: "6px 0", width: "100%" }}>{children}</table>; },
          th({ children }) { return <th style={{ border: "1px solid var(--border)", padding: "4px 8px", textAlign: "left", background: "var(--bg-tertiary)", fontSize: "12px" }}>{children}</th>; },
          td({ children }) { return <td style={{ border: "1px solid var(--border)", padding: "4px 8px", fontSize: "12px" }}>{children}</td>; },
          hr() { return <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "8px 0" }} />; },
          strong({ children }) { return <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>{children}</strong>; },
          em({ children }) { return <em>{children}</em>; },
        }}
      >
        {clean}
      </Markdown>
    </div>
  );
}

function getToolIcon(name) {
  const m = { Read: "\u{1F4C4}", Write: "\u{270F}", Edit: "\u{1F4DD}", Bash: "$", Grep: "\u{1F50D}", Glob: "\u{1F4C1}", Agent: "\u{1F916}", WebSearch: "\u{1F310}", WebFetch: "\u{1F310}", Skill: "\u{26A1}" };
  return m[name] || "\u{2699}";
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length <= 3 ? parts.join("/") : ".../" + parts.slice(-3).join("/");
}

function truncate(s, max) {
  return !s ? "" : s.length <= max ? s : s.slice(0, max) + "...";
}
