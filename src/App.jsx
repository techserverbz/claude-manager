import React, { useState, useEffect, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import CliPanel from "./components/CliPanel.jsx";
import Sidebar from "./components/Sidebar.jsx";
import VoiceOrb from "./components/VoiceOrb.jsx";
import TaskModule from "./components/TaskModule/TaskModule.jsx";
import ScreenViewer from "./components/ScreenViewer.jsx";
import SessionBrowser from "./components/SessionBrowser.jsx";
import SettingsPanel from "./components/SettingsPanel.jsx";
import SkillsPage from "./components/SkillsPage.jsx";
import ConnectorsPage from "./components/ConnectorsPage.jsx";
import MemoryModule from "./components/MemoryModule/MemoryModule.jsx";
import AgentsPage from "./components/AgentsPage.jsx";
import SyncPage from "./components/SyncPage.jsx";
import "./App.css";

// Always connect to the same origin (works for both dev and prod since Express serves the frontend)
const SOCKET_URL = window.location.origin;

export default function App() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  // Conversation-keyed state
  const [conversationCache, setConversationCache] = useState({}); // convoId -> messages[] (for DB persistence)
  const [cliEventsByConvo, setCliEventsByConvo] = useState({}); // convoId -> raw CLI events[]
  const [streamingByConvo, setStreamingByConvo] = useState({}); // convoId -> streamingText
  const [thinkingByConvo, setThinkingByConvo] = useState({}); // convoId -> boolean
  const [keepAliveByConvo, setKeepAliveByConvo] = useState({}); // convoId -> boolean
  const [modeByConvo, setModeByConvo] = useState({}); // convoId -> "terminal-oneshot" | "terminal-persistent" | "process-oneshot" | "process-persistent"
  const [configByConvo, setConfigByConvo] = useState({}); // convoId -> { model, workingDirectory, maxTurns, ... }
  const [newConvoIds, setNewConvoIds] = useState(new Set()); // track just-created conversations for auto-connect
  const [hasMoreByConvo, setHasMoreByConvo] = useState({}); // convoId -> boolean (more messages to load)
  const [totalMsgsByConvo, setTotalMsgsByConvo] = useState({}); // convoId -> total message count
  const [cwdByConvo, setCwdByConvo] = useState({}); // convoId -> working directory path
  const [showTerminalFor, setShowTerminalFor] = useState(null); // { convoId, ts } to auto-show terminal
  const [masterChatMode, setMasterChatMode] = useState("process-persistent"); // default mode for master chat
  const [localSessions, setLocalSessions] = useState([]); // sessions from ~/.claude/projects/

  const [currentConvoId, setCurrentConvoId] = useState(() => {
    const saved = sessionStorage.getItem("christopher_convoId");
    return saved && !saved.startsWith("local-") ? saved : null;
  });
  const [conversations, setConversations] = useState([]);
  const [activeSessions, setActiveSessions] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showTasks, setShowTasks] = useState(false);
  const [showScreen, setShowScreen] = useState(false);
  const [settingsOverlay, setSettingsOverlay] = useState(null); // null | "tasks" | "skills" | "connectors" | "sessions"
  const [multiView, setMultiView] = useState(false);
  const [multiViewConvos, setMultiViewConvos] = useState([]); // conversation IDs in grid
  const [maxPanes, setMaxPanes] = useState(4); // 4-8
  const [viewMessagesId, setViewMessagesId] = useState(null); // convo ID to force message view
  const [playwrightMode, setPlaywrightMode] = useState("extension");
  const [currentModel, setCurrentModel] = useState("claude-opus-4-6");
  const [agentMode, setAgentMode] = useState("");
  const [appName, setAppName] = useState("AI Assistant");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [volume, setVolume] = useState(1);
  const [showVolume, setShowVolume] = useState(false);
  const volumeRef = useRef(null);

  const recognitionRef = useRef(null);
  const socketRef = useRef(null);
  const currentConvoIdRef = useRef(currentConvoId);

  const isListeningRef = useRef(false);
  const isPausedRef = useRef(false);

  // Derived state from current conversation
  const cliEvents = cliEventsByConvo[currentConvoId] || [];
  const streamingText = streamingByConvo[currentConvoId] || "";
  const isThinking = thinkingByConvo[currentConvoId] || false;
  const keepAlive = keepAliveByConvo[currentConvoId] || false;
  const currentConvo = conversations.find(c => c.id === currentConvoId);
  const currentIsMaster = currentConvo?.metadata?.master === true;
  const currentMode = modeByConvo[currentConvoId] || (keepAlive || currentIsMaster ? "process-persistent" : "process-oneshot");
  const currentConfig = configByConvo[currentConvoId] || {};
  const isNewConversation = newConvoIds.has(currentConvoId);
  const currentSessionId = conversations.find(c => c.id === currentConvoId)?.claude_session_id || null;

  // Keep refs in sync — don't persist virtual (local-*) IDs to sessionStorage
  useEffect(() => {
    currentConvoIdRef.current = currentConvoId;
    if (currentConvoId) {
      if (!currentConvoId.startsWith("local-")) {
        sessionStorage.setItem("christopher_convoId", currentConvoId);
      }
      socketRef.current?.emit("view:conversation", { conversationId: currentConvoId });
    } else {
      sessionStorage.removeItem("christopher_convoId");
    }
  }, [currentConvoId]);

  // --- Core voice functions ---

  const spawnRecognition = () => {
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }

    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      alert("Speech recognition not supported. Use Chrome.");
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let finalTranscript = "";
    let silenceTimer = null;

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + " ";

          if (transcript.toLowerCase().trim() === "stop") {
            socketRef.current?.emit("chat:stop", { conversationId: currentConvoIdRef.current });
            finalTranscript = "";
            return;
          }
        }
      }

      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (finalTranscript.trim()) {
          const msg = finalTranscript.trim();
          finalTranscript = "";
          if (socketRef.current) {
            const convoId = currentConvoIdRef.current;
            setConversationCache((prev) => ({
              ...prev,
              [convoId || "__pending"]: [...(prev[convoId || "__pending"] || []),
                { role: "user", content: msg, timestamp: Date.now() }],
            }));
            socketRef.current.emit("chat:message", {
              text: msg,
              conversationId: convoId,
            });
          }
        }
      }, 1500);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      isListeningRef.current = false;
      setIsListening(false);
    };

    recognition.onend = () => {
      if (isListeningRef.current && !isPausedRef.current) {
        setTimeout(() => {
          if (isListeningRef.current && !isPausedRef.current) {
            spawnRecognition();
          }
        }, 150);
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
    } catch (err) {
      setTimeout(() => {
        if (isListeningRef.current && !isPausedRef.current) {
          try {
            recognition.start();
            recognitionRef.current = recognition;
          } catch {}
        }
      }, 500);
    }
  };

  const spawnRecognitionRef = useRef(spawnRecognition);
  spawnRecognitionRef.current = spawnRecognition;

  const pauseRef = useRef(() => {
    isPausedRef.current = true;
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }
  });

  const resumeRef = useRef(() => {
    isPausedRef.current = false;
    if (!isListeningRef.current) return;
    setTimeout(() => {
      if (isListeningRef.current && !isPausedRef.current) {
        spawnRecognitionRef.current();
      }
    }, 400);
  });

  // --- Socket initialization ---

  useEffect(() => {
    const s = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = s;
    let wasDisconnected = false;

    s.on("connect", () => {
      setConnected(true);
      if (wasDisconnected) {
        window.location.reload();
        return;
      }
    });

    s.on("disconnect", () => {
      setConnected(false);
      wasDisconnected = true;
    });

    s.on("chat:status", ({ status, conversationId }) => {
      if (status === "thinking") {
        setThinkingByConvo((prev) => ({ ...prev, [conversationId]: true }));
      }
    });

    s.on("chat:chunk", ({ text, conversationId }) => {
      setStreamingByConvo((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] || "") + text,
      }));
      setThinkingByConvo((prev) => ({ ...prev, [conversationId]: false }));
    });

    s.on("chat:conversation", ({ conversationId }) => {
      setCurrentConvoId((prev) => {
        if (!prev) {
          // Migrate pending messages and CLI events
          setConversationCache((cache) => {
            const pending = cache["__pending"] || [];
            const existing = cache[conversationId] || [];
            const newCache = { ...cache, [conversationId]: [...existing, ...pending] };
            delete newCache["__pending"];
            return newCache;
          });
          setCliEventsByConvo((prev) => {
            const pending = prev["__pending"] || [];
            const existing = prev[conversationId] || [];
            const newEvents = { ...prev, [conversationId]: [...existing, ...pending] };
            delete newEvents["__pending"];
            return newEvents;
          });
          return conversationId;
        }
        return prev;
      });
    });

    s.on("chat:complete", ({ text, conversationId }) => {
      setConversationCache((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] || []),
          { role: "assistant", content: text, timestamp: Date.now() }],
      }));
      setStreamingByConvo((prev) => ({ ...prev, [conversationId]: "" }));
      setThinkingByConvo((prev) => ({ ...prev, [conversationId]: false }));
      fetchConversations();
      fetchActiveSessions();
    });

    // Raw CLI events — the main data source for CliPanel
    s.on("cli:event", (event) => {
      const convoId = event.conversationId;
      if (convoId) {
        // Safety: clear thinking on result event (belt + suspenders)
        if (event.type === "result") {
          setThinkingByConvo((prev) => ({ ...prev, [convoId]: false }));
          setStreamingByConvo((prev) => ({ ...prev, [convoId]: "" }));
        }
        setCliEventsByConvo((prev) => ({
          ...prev,
          [convoId]: [...(prev[convoId] || []).slice(-500), event], // Keep last 500 events
        }));
      }
    });

    s.on("chat:error", ({ error, conversationId }) => {
      const convoId = conversationId || currentConvoIdRef.current;
      if (convoId) {
        setCliEventsByConvo((prev) => ({
          ...prev,
          [convoId]: [...(prev[convoId] || []),
            { type: "error", message: error, _ts: Date.now(), conversationId: convoId }],
        }));
        setConversationCache((prev) => ({
          ...prev,
          [convoId]: [...(prev[convoId] || []),
            { role: "system", content: `Error: ${error}`, timestamp: Date.now() }],
        }));
      }
      setThinkingByConvo((prev) => ({ ...prev, [convoId]: false }));
      setStreamingByConvo((prev) => ({ ...prev, [convoId]: "" }));
      resumeRef.current();
    });

    s.on("chat:stopped", ({ conversationId }) => {
      setThinkingByConvo((prev) => ({ ...prev, [conversationId]: false }));
      setStreamingByConvo((prev) => ({ ...prev, [conversationId]: "" }));
      resumeRef.current();
    });

    // Queue updates
    s.on("queue:update", ({ conversationId, status, summary }) => {
      setConversations((prev) => prev.map((c) =>
        c.id === conversationId ? { ...c, status, status_summary: summary } : c
      ));
    });

    s.on("conversation:updated", ({ conversationId, ...fields }) => {
      setConversations((prev) => prev.map((c) => {
        if (c.id !== conversationId) return c;
        // Only update fields that were actually sent (not undefined)
        const updates = {};
        if (fields.claude_session_id !== undefined) updates.claude_session_id = fields.claude_session_id;
        if (fields.mode !== undefined) {
          const meta = typeof c.metadata === "string" ? JSON.parse(c.metadata || "{}") : (c.metadata || {});
          updates.metadata = { ...meta, mode: fields.mode };
        }
        return { ...c, ...updates };
      }));
    });

    s.on("mode:changed", ({ mode }) => setAgentMode(mode));

    setSocket(s);
    return () => s.disconnect();
  }, []);

  // --- Load data ---

  useEffect(() => {
    fetch("/api/settings/playwright").then(r => r.json()).then(d => setPlaywrightMode(d.mode)).catch(() => {});
    fetch("/api/mode").then(r => r.json()).then(d => setAgentMode(d.mode || "")).catch(() => {});
    fetch("/api/settings/layout").then(r => r.json()).then(d => {
      if (d.maxPanes) setMaxPanes(d.maxPanes);
      if (d.multiView) { setMultiView(true); if (d.paneConvos?.length) setMultiViewConvos(d.paneConvos); }
      if (d.volume !== undefined) setVolume(d.volume);
      if (d.voiceEnabled !== undefined) setVoiceEnabled(d.voiceEnabled);
    }).catch(() => {});
    fetchConversations();
    fetchActiveSessions();
    fetchCurrentModel();
    fetch("/api/app-name").then(r => r.json()).then(d => { if (d.name) { setAppName(d.name); document.title = `${d.name} - AI Assistant`; } }).catch(() => {});
    fetchLocalSessions();
    const savedConvoId = sessionStorage.getItem("christopher_convoId");
    if (savedConvoId && !savedConvoId.startsWith("local-")) {
      loadConversationMessages(savedConvoId);
    }

    // Refresh active sessions periodically
    const interval = setInterval(() => {
      fetchActiveSessions();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const fetchConversations = async () => {
    try {
      const res = await fetch("/api/conversations");
      setConversations(await res.json());
    } catch {}
  };

  const fetchLocalSessions = async () => {
    try {
      const res = await fetch("/api/sessions/local?limit=30");
      const sessions = await res.json();
      // Only show sessions NOT already in the database
      setLocalSessions(sessions.filter(s => !s.inDatabase));
    } catch {}
  };

  const importSession = async (sessionId, title) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const result = await res.json();
      if (result.ok) {
        fetchConversations();
        fetchLocalSessions();
        setCurrentConvoId(result.conversationId);
        return result;
      }
    } catch {}
    return null;
  };

  const viewLocalSessionMessages = async (sessionId, title) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/replay`);
      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) return;

      const virtualId = `local-${sessionId}`;
      const { cliEvents, cwd } = convertSessionEvents(events, virtualId);
      setCliEventsByConvo((prev) => ({ ...prev, [virtualId]: cliEvents }));
      setModeByConvo((prev) => ({ ...prev, [virtualId]: "process-persistent" }));
      setKeepAliveByConvo((prev) => ({ ...prev, [virtualId]: true }));
      if (cwd) setCwdByConvo((prev) => ({ ...prev, [virtualId]: cwd }));
      setCurrentConvoId(virtualId);
    } catch (err) {
      console.error("Failed to view session:", err);
    }
  };

  const fetchActiveSessions = async () => {
    try {
      const res = await fetch("/api/admin/info");
      const info = await res.json();
      setActiveSessions(info.runningConversations || []);
    } catch {}
  };

  const fetchCurrentModel = async () => {
    try {
      const res = await fetch("/api/settings/model");
      const data = await res.json();
      setCurrentModel(data.model || "claude-opus-4-6");
    } catch {}
  };

  const changeModel = async (model) => {
    setCurrentModel(model);
    try {
      await fetch("/api/settings/model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
    } catch (err) {
      console.error("Failed to update model:", err);
    }
  };

  const MSG_PAGE_SIZE = 50;
  const MSG_MAX_CONTENT = 20000; // truncate messages > 20KB for fast rendering

  // Convert Claude CLI session events to structured CliPanel events
  const convertSessionEvents = (events, convoId) => {
    const cliEvents = [];
    let cwd = null;
    for (const evt of events) {
      if (!cwd && evt.cwd) cwd = evt.cwd;
      if (evt.type === "human" || evt.type === "user") {
        const text = Array.isArray(evt.message?.content)
          ? evt.message.content.map(b => b.type === "text" ? b.text : "").join("")
          : (typeof evt.message?.content === "string" ? evt.message.content : "");
        if (text) cliEvents.push({ type: "user_message", text, conversationId: convoId });
      } else if (evt.type === "assistant") {
        cliEvents.push({ type: "assistant", message: evt.message || { content: [{ type: "text", text: "" }] }, conversationId: convoId });
      } else if (evt.type === "result") {
        cliEvents.push({ type: "result", cost_usd: evt.cost_usd, conversationId: convoId });
      }
    }
    return { cliEvents, cwd };
  };

  const loadConversationMessages = async (convoId, loadMore = false, forceReload = false) => {
    if (!convoId || convoId.startsWith("local-")) return; // virtual IDs are loaded by viewLocalSessionMessages
    try {
      // First, load conversation metadata to check for session ID and mode
      let convoMeta = null;
      if (!loadMore) {
        const convoRes = await fetch(`/api/conversations/${convoId}`);
        convoMeta = await convoRes.json();
        const meta = typeof convoMeta.metadata === "string" ? JSON.parse(convoMeta.metadata || "{}") : (convoMeta.metadata || {});
        const convoMode = meta.mode || (meta.master ? "process-persistent" : null);
        setKeepAliveByConvo((prev) => ({
          ...prev,
          [convoId]: meta.keepAlive || convoMode === "process-persistent" || false,
        }));
        if (convoMode) {
          setModeByConvo((prev) => ({ ...prev, [convoId]: convoMode }));
        }
      }

      // For any conversation with a session ID, load from CLI session file (structured events)
      const sessionId = convoMeta?.claude_session_id;
      const meta = typeof convoMeta?.metadata === "string" ? JSON.parse(convoMeta.metadata || "{}") : (convoMeta?.metadata || {});
      const originalSessionId = meta.original_session_id;
      // Try current session ID first, then original (pre-rename) session ID
      const sessionIdsToTry = [sessionId, originalSessionId].filter(Boolean);
      if (!loadMore && sessionIdsToTry.length > 0) {
        for (const sid of sessionIdsToTry) {
          try {
            const replayRes = await fetch(`/api/sessions/${sid}/replay`);
            if (!replayRes.ok) continue;
            const events = await replayRes.json();
            if (Array.isArray(events) && events.length > 0) {
              const { cliEvents, cwd } = convertSessionEvents(events, convoId);
              setCliEventsByConvo((prev) => ({
                ...prev,
                [convoId]: forceReload ? cliEvents : (prev[convoId]?.length > 0 ? prev[convoId] : cliEvents),
              }));
              setHasMoreByConvo((prev) => ({ ...prev, [convoId]: false }));
              setTotalMsgsByConvo((prev) => ({ ...prev, [convoId]: cliEvents.length }));
              // Prefer conversation metadata cwd over JSONL cwd (metadata may have been updated)
              const metaCwd = meta.cwd || meta.workingDirectory;
              const displayCwd = metaCwd || cwd;
              if (displayCwd) setCwdByConvo((prev) => ({ ...prev, [convoId]: displayCwd }));
              return; // loaded from session file — skip flat message loading
            }
          } catch {} // try next or fall through
        }
      }

      // Standard paginated message loading (process mode or fallback)
      const currentOffset = loadMore ? (cliEventsByConvo[convoId]?.length || 0) : 0;
      const res = await fetch(`/api/conversations/${convoId}/messages?limit=${MSG_PAGE_SIZE}&offset=${currentOffset}&maxContentLen=${MSG_MAX_CONTENT}`);
      const data = await res.json();

      const msgs = data.messages || data;
      const hasMore = data.hasMore ?? false;
      const total = data.total ?? msgs.length;

      setHasMoreByConvo((prev) => ({ ...prev, [convoId]: hasMore }));
      setTotalMsgsByConvo((prev) => ({ ...prev, [convoId]: total }));

      if (Array.isArray(msgs) && msgs.length > 0) {
        const newCacheEntries = msgs.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: new Date(m.created_at).getTime(),
        }));
        setConversationCache((prev) => ({
          ...prev,
          [convoId]: loadMore ? [...newCacheEntries, ...(prev[convoId] || [])] : newCacheEntries,
        }));

        const historyEvents = msgs.map((m) => {
          if (m.role === "user") {
            return { type: "user_message", text: m.content, _ts: new Date(m.created_at).getTime(), conversationId: convoId };
          }
          if (m.role === "assistant") {
            return { type: "assistant", message: { content: [{ type: "text", text: m.content }] }, _ts: new Date(m.created_at).getTime(), conversationId: convoId };
          }
          return { type: "system", message: m.content, _ts: new Date(m.created_at).getTime(), conversationId: convoId };
        });
        setCliEventsByConvo((prev) => {
          const existing = prev[convoId] || [];
          if (loadMore) return { ...prev, [convoId]: [...historyEvents, ...existing] };
          return { ...prev, [convoId]: existing.length > 0 ? existing : historyEvents };
        });
      }
    } catch {}
  };

  // --- User controls ---

  const startListening = () => {
    isListeningRef.current = true;
    isPausedRef.current = false;
    setIsListening(true);
    spawnRecognition();
  };

  const stopListening = () => {
    isListeningRef.current = false;
    isPausedRef.current = false;
    setIsListening(false);
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }
  };

  const toggleListening = () => {
    if (isListeningRef.current) stopListening();
    else startListening();
  };

  const sendMessage = useCallback((text, images) => {
    if (!text.trim() && (!images || images.length === 0)) return;
    if (!socketRef.current) return;

    const convoId = currentConvoIdRef.current;
    setConversationCache((prev) => ({
      ...prev,
      [convoId || "__pending"]: [...(prev[convoId || "__pending"] || []),
        { role: "user", content: text, images: images || [], timestamp: Date.now() }],
    }));

    socketRef.current.emit("chat:message", {
      text,
      images: images || [],
      conversationId: convoId,
    });
  }, []);

  const sendRawMessage = useCallback((text) => {
    if (!text.trim() || !socketRef.current) return;
    const convoId = currentConvoIdRef.current;
    if (!convoId) return;
    socketRef.current.emit("chat:raw", { text, conversationId: convoId });
  }, []);

  const toggleKeepAlive = async (enabled) => {
    if (!currentConvoId) return;

    try {
      await fetch(`/api/conversations/${currentConvoId}/keep-alive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });

      setKeepAliveByConvo((prev) => ({ ...prev, [currentConvoId]: enabled }));
    } catch (err) {
      console.error("Failed to toggle keep-alive:", err);
    }
  };

  useEffect(() => {
  }, [volume]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (volumeRef.current && !volumeRef.current.contains(e.target)) {
        setShowVolume(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Persist layout panes whenever they change
  useEffect(() => {
    if (multiView && multiViewConvos.length > 0) {
      fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paneConvos: multiViewConvos }) }).catch(() => {});
    }
  }, [multiViewConvos, multiView]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger when typing in input/textarea
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;

      if (e.shiftKey && e.key === "L") {
        e.preventDefault();
        if (!multiView) {
          const others = conversations.filter(c => c.id !== currentConvoIdRef.current && !(c.metadata?.master)).slice(0, maxPanes - 1).map(c => c.id);
          setMultiViewConvos(currentConvoIdRef.current ? [currentConvoIdRef.current, ...others].slice(0, maxPanes) : others.slice(0, maxPanes));
          setMultiView(true);
          fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ multiView: true, maxPanes }) }).catch(() => {});
        } else {
          setMultiView(false);
          setMultiViewConvos([]);
          fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ multiView: false }) }).catch(() => {});
        }
      }

      if (e.shiftKey && e.key === "S") {
        e.preventDefault();
        setSidebarOpen(prev => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [multiView, conversations, maxPanes]);

  const newConversation = async () => newConversationWithMode("process-oneshot");

  const newConversationWithMode = async (mode, workingDirectory) => {
    socketRef.current?.emit("chat:new-conversation");
    const modeLabel = {
      "terminal-persistent": "Terminal",
      "terminal-oneshot": "Terminal (1x)",
      "process-persistent": "Process",
      "process-oneshot": "Chat",
    }[mode] || "Chat";
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `${modeLabel} - ${new Date().toLocaleString()}` }),
      });
      const convo = await res.json();
      setCurrentConvoId(convo.id);
      setModeByConvo((prev) => ({ ...prev, [convo.id]: mode }));
      setCliEventsByConvo((prev) => ({ ...prev, [convo.id]: [] }));
      setNewConvoIds((prev) => new Set(prev).add(convo.id));
      if (workingDirectory) {
        setConfigByConvo((prev) => ({ ...prev, [convo.id]: { ...(prev[convo.id] || {}), workingDirectory } }));
        setCwdByConvo((prev) => ({ ...prev, [convo.id]: workingDirectory }));
      }
      if (mode === "process-persistent" || mode === "terminal-persistent") {
        setKeepAliveByConvo((prev) => ({ ...prev, [convo.id]: true }));
      }
      fetchConversations();
    } catch {
      setCurrentConvoId(null);
    }
  };

  const openMasterChat = async () => {
    try {
      const convo = await (await fetch("/api/master-chat", { method: "POST" })).json();
      // Switch immediately — no await on messages
      setCurrentConvoId(convo.id);
      setModeByConvo((prev) => ({ ...prev, [convo.id]: "process-persistent" }));
      setKeepAliveByConvo((prev) => ({ ...prev, [convo.id]: true }));
      setCliEventsByConvo((prev) => ({ ...prev, [convo.id]: prev[convo.id] || [] }));
      socketRef.current?.emit("view:conversation", { conversationId: convo.id });
      // Load messages in background (non-blocking)
      if (!conversationCache[convo.id]) loadConversationMessages(convo.id);
      fetchConversations();
    } catch (err) {
      console.error("Failed to open master chat:", err);
    }
  };

  const changeMasterChatMode = (mode) => {
    setMasterChatMode(mode);
    // Also update the current master chat conversation if it exists
    const masterConvo = conversations.find(c => c.metadata?.master === true);
    if (masterConvo) {
      changeConversationMode(masterConvo.id, mode);
    }
  };

  const renameConversation = async (convoId, title) => {
    try {
      await fetch(`/api/conversations/${convoId}/title`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      fetchConversations();
    } catch (err) {
      console.error("Failed to rename:", err);
    }
  };

  const changeConversationStatus = async (convoId, status) => {
    try {
      // If completing a terminal conversation, kill the PTY
      if (status === "completed") {
        socketRef.current?.emit("pty:destroy", { conversationId: convoId });
        socketRef.current?.emit("chat:stop", { conversationId: convoId });
      }
      await fetch(`/api/conversations/${convoId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, summary: "" }),
      });
      fetchConversations();
    } catch (err) {
      console.error("Failed to change status:", err);
    }
  };

  const deleteConversation = async (convoId) => {
    try {
      await fetch(`/api/conversations/${convoId}`, { method: "DELETE" });
      // If we're viewing the deleted conversation, clear it
      if (currentConvoId === convoId) {
        setCurrentConvoId(null);
        sessionStorage.removeItem("christopher_convoId");
      }
      // Clean up local state
      setConversationCache((prev) => { const n = { ...prev }; delete n[convoId]; return n; });
      setCliEventsByConvo((prev) => { const n = { ...prev }; delete n[convoId]; return n; });
      setKeepAliveByConvo((prev) => { const n = { ...prev }; delete n[convoId]; return n; });
      fetchConversations();
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  };

  const toggleStar = async (convoId, starred) => {
    try {
      await fetch(`/api/conversations/${convoId}/star`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred }),
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convoId ? { ...c, metadata: { ...(c.metadata || {}), starred } } : c
        )
      );
    } catch (err) {
      console.error("Failed to toggle star:", err);
    }
  };

  const changeConversationAgent = async (convoId, agent) => {
    try {
      await fetch(`/api/conversations/${convoId}/agent`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      setConversations((prev) => prev.map((c) => c.id === convoId ? { ...c, agent } : c));
    } catch (err) {
      console.error("Failed to change agent:", err);
    }
  };

  const changeConversationMode = async (convoId, mode) => {
    setModeByConvo((prev) => ({ ...prev, [convoId]: mode }));
    // Persist to DB metadata
    try {
      await fetch(`/api/conversations/${convoId}/mode`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
    } catch {}
    // Update keep-alive state based on mode
    const isPersistent = mode === "terminal-persistent" || mode === "process-persistent";
    setKeepAliveByConvo((prev) => ({ ...prev, [convoId]: isPersistent }));
  };

  // Single click — select conversation, show terminal if active session
  const selectConversation = async (convo) => {
    setCurrentConvoId(convo.id);
    const meta = typeof convo.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo.metadata || {});
    const isTerminal = meta.mode?.startsWith("terminal");
    const hasSession = !!convo.claude_session_id;
    // Show terminal if it's a terminal conversation with a session
    if (isTerminal && hasSession) {
      setShowTerminalFor({ convoId: convo.id, ts: Date.now() });
    } else {
      setShowTerminalFor(null);
    }
    if (!conversationCache[convo.id]) {
      await loadConversationMessages(convo.id);
    }
    socketRef.current?.emit("view:conversation", { conversationId: convo.id });
  };

  // Double click — view messages (force message view)
  const viewConversationMessages = async (convo) => {
    setCurrentConvoId(convo.id);
    setShowTerminalFor(null);
    // Always force-reload to get structured session events (not flat PTY text)
    await loadConversationMessages(convo.id, false, true);
    socketRef.current?.emit("view:conversation", { conversationId: convo.id });
  };

  // Count conversations needing attention
  const queueCount = conversations.filter((c) => c.status === "waiting_for_user").length;
  const runningCount = conversations.filter((c) => c.status === "in_progress").length;

  return (
    <div className="app">

      {sidebarOpen && (
        <Sidebar
          appName={appName}
          conversations={conversations}
          currentConvoId={currentConvoId}
          queueCount={queueCount}
          runningCount={runningCount}
          activeSessions={activeSessions}
          onSelectConversation={selectConversation}
          onViewConversationMessages={viewConversationMessages}
          onNewConversation={newConversation}
          onNewConversationWithMode={newConversationWithMode}
          onOpenMasterChat={openMasterChat}
          onDeleteConversation={deleteConversation}
          onRenameConversation={renameConversation}
          onChangeStatus={changeConversationStatus}
          onChangeModel={changeModel}
          currentModel={currentModel}
          onChangeMode={changeConversationMode}
          modeByConvo={modeByConvo}
          masterChatMode={masterChatMode}
          onChangeMasterChatMode={changeMasterChatMode}
          localSessions={localSessions}
          onImportSession={importSession}
          onViewLocalSession={viewLocalSessionMessages}
          onOpenTasks={() => setSettingsOverlay("tasks")}
          onOpenOverlay={setSettingsOverlay}
          onViewMessages={(convoId) => { setCurrentConvoId(convoId); setViewMessagesId(convoId); loadConversationMessages(convoId); }}
          agentMode={agentMode}
          onModeChange={setAgentMode}
          onToggleStar={toggleStar}
          onChangeAgent={changeConversationAgent}
          onReorderStarred={(orderedIds) => {
            setConversations((prev) => prev.map((c) => {
              const idx = orderedIds.indexOf(c.id);
              if (idx === -1) return c;
              return { ...c, metadata: { ...(c.metadata || {}), sort_order: idx } };
            }));
          }}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      <main className="main-content">
        <header className="top-bar">
          {!sidebarOpen && (
            <button className="btn-icon" onClick={() => setSidebarOpen(true)} title="Open sidebar">
              <MenuIcon />
            </button>
          )}
          <div className="agent-indicator">
            <span className={`status-dot ${connected ? "online" : "offline"}`} />
            <span className="agent-name">{appName}</span>
            <span className={`mode-badge-top ${agentMode}`}>{agentMode}</span>
            {isThinking && <span className="thinking-badge">thinking...</span>}
            {runningCount > 0 && !isThinking && (
              <span className="running-badge">{runningCount} running</span>
            )}
          </div>
          <div className="top-actions">
            {queueCount > 0 && (
              <div className="queue-indicator">
                <span className="queue-badge-top">{queueCount}</span>
                <span className="queue-label">needs you</span>
              </div>
            )}
            <button
              className={`btn-icon ${showScreen ? "active" : ""}`}
              onClick={() => setShowScreen(!showScreen)}
              title="Screen Viewer"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </button>
            <div className="volume-control" ref={volumeRef}>
              <button
                className={`btn-icon ${voiceEnabled ? "active" : ""}`}
                onClick={() => { const next = !voiceEnabled; setVoiceEnabled(next); fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceEnabled: next }) }).catch(() => {}); }}
                onContextMenu={(e) => { e.preventDefault(); setShowVolume(!showVolume); }}
                onMouseEnter={() => setShowVolume(true)}
                title={voiceEnabled ? "Voice ON" : "Voice OFF"}
              >
                {voiceEnabled ? (volume === 0 ? <VolumeMuteIcon /> : <VolumeIcon />) : <VolumeMuteIcon />}
              </button>
              {showVolume && (
                <div className="volume-slider-popup" onMouseLeave={() => setShowVolume(false)}>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volume}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setVolume(v);
                      const ve = v > 0;
                      if (v === 0 && voiceEnabled) setVoiceEnabled(false);
                      if (v > 0 && !voiceEnabled) setVoiceEnabled(true);
                      fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ volume: v, voiceEnabled: ve }) }).catch(() => {});
                    }}
                    className="volume-slider"
                    orient="vertical"
                  />
                  <span className="volume-label">{Math.round(volume * 100)}%</span>
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button
                className={`btn-icon ${multiView ? "active" : ""}`}
                onClick={() => {
                  if (!multiView) {
                    const others = conversations.filter(c => c.id !== currentConvoId && !(c.metadata?.master)).slice(0, maxPanes - 1).map(c => c.id);
                    setMultiViewConvos(currentConvoId ? [currentConvoId, ...others].slice(0, maxPanes) : others.slice(0, maxPanes));
                    setMultiView(true);
                    fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ multiView: true, maxPanes }) }).catch(() => {});
                  } else {
                    setMultiView(false);
                    setMultiViewConvos([]);
                    fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ multiView: false }) }).catch(() => {});
                  }
                }}
                title={multiView ? "Single view" : `Multi-window (${maxPanes} panes)`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="9" height="9" rx="1" />
                  <rect x="13" y="2" width="9" height="9" rx="1" />
                  <rect x="2" y="13" width="9" height="9" rx="1" />
                  <rect x="13" y="13" width="9" height="9" rx="1" />
                </svg>
              </button>
              {multiView && (
                <select
                  value={maxPanes}
                  onChange={(e) => { const n = parseInt(e.target.value); setMaxPanes(n); setMultiViewConvos(prev => prev.slice(0, n)); fetch("/api/settings/layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxPanes: n }) }).catch(() => {}); }}
                  style={{ background: "var(--bg-tertiary)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-secondary)", fontSize: 11, padding: "4px 4px", cursor: "pointer", fontFamily: "var(--font-sans)", outline: "none", width: 38 }}
                  title="Max panes"
                >
                  {[2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n} style={{background:"var(--bg-tertiary)",color:"var(--text-primary)"}}>{n}</option>)}
                </select>
              )}
            </div>
          </div>
        </header>

        {showScreen ? (
          <ScreenViewer socket={socket} onClose={() => setShowScreen(false)} />
        ) : settingsOverlay === "tasks" ? (
          <TaskModule socket={socket} onClose={() => setSettingsOverlay(null)} />
        ) : settingsOverlay === "sessions" ? (
          <SessionBrowser socket={socket} onResumeSession={(cid, sid) => { setSettingsOverlay(null); setCurrentConvoId(cid); loadConversationMessages(cid); }} onClose={() => setSettingsOverlay(null)} />
        ) : settingsOverlay === "skills" ? (
          <SkillsPage onClose={() => setSettingsOverlay(null)} />
        ) : settingsOverlay === "connectors" ? (
          <ConnectorsPage onClose={() => setSettingsOverlay(null)} />
        ) : settingsOverlay === "memories" ? (
          <MemoryModule onClose={() => setSettingsOverlay(null)} />
        ) : settingsOverlay === "agents" ? (
          <AgentsPage onClose={() => setSettingsOverlay(null)} />
        ) : settingsOverlay === "sync" ? (
          <SyncPage onClose={() => setSettingsOverlay(null)} />
        ) : settingsOverlay === "cronJobs" ? (
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",fontFamily:"var(--font-sans)"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 20px",borderBottom:"1px solid var(--border)",background:"var(--bg-secondary)",flexShrink:0}}>
              <h2 style={{fontSize:15,fontWeight:600,color:"var(--text-primary)",margin:0}}>Cron Jobs</h2>
              <button className="btn-icon" onClick={() => setSettingsOverlay(null)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg></button>
            </div>
            <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,color:"var(--text-muted)",fontSize:14,padding:40}}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <p>Cron jobs are managed via the <code style={{background:"var(--bg-tertiary)",padding:"2px 6px",borderRadius:4,fontFamily:"var(--font-mono)",fontSize:12}}>/loop</code> skill in chat.</p>
              <p style={{fontSize:12,color:"var(--text-ghost)"}}>Example: /loop 5m /your-command</p>
            </div>
          </div>
        ) : multiView ? (
          <div className="multi-view-grid" style={{
            flex: 1, display: "grid", overflow: "hidden",
            gridTemplateColumns: `repeat(${maxPanes <= 2 ? 2 : maxPanes <= 4 ? 2 : 4}, 1fr)`,
            gridTemplateRows: `repeat(${maxPanes <= 2 ? 1 : maxPanes <= 4 ? 2 : 2}, 1fr)`,
            gap: "2px", background: "var(--bg-tertiary)",
          }}>
            {multiViewConvos.map((cid, paneIdx) => {
              const convo = conversations.find(c => c.id === cid);
              const meta = typeof convo?.metadata === "string" ? JSON.parse(convo.metadata || "{}") : (convo?.metadata || {});
              const paneMode = modeByConvo[cid] || meta.mode || "process-oneshot";
              const paneKeepAlive = keepAliveByConvo[cid] || false;
              const paneSessionId = convo?.claude_session_id || null;
              return (
                <div key={cid} className="multi-view-pane" onMouseDown={() => setCurrentConvoId(cid)} style={{
                  display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-primary)",
                  border: cid === currentConvoId ? "1px solid var(--accent)" : "none",
                }}>
                  <PaneHeader
                    cid={cid}
                    title={convo?.title?.slice(0, 30) || cid.slice(0, 8)}
                    isActive={cid === currentConvoId}
                    conversations={conversations}
                    onSelect={() => setCurrentConvoId(cid)}
                    onSwitch={(newCid) => {
                      setMultiViewConvos(prev => prev.map((id, i) => i === paneIdx ? newCid : id));
                      if (!conversationCache[newCid]) loadConversationMessages(newCid);
                      setCurrentConvoId(newCid);
                    }}
                    onRemove={() => setMultiViewConvos(prev => prev.filter(id => id !== cid))}
                  />
                  <CliPanel
                    events={cliEventsByConvo[cid] || []}
                    streamingText={streamingByConvo[cid] || ""}
                    isThinking={thinkingByConvo[cid] || false}
                    onSendMessage={(text, images) => {
                      if (!socketRef.current) return;
                      setConversationCache(prev => ({ ...prev, [cid]: [...(prev[cid] || []), { role: "user", content: text, images: images || [], timestamp: Date.now() }] }));
                      socketRef.current.emit("chat:message", { text, images: images || [], conversationId: cid });
                    }}
                    onStop={() => socketRef.current?.emit("chat:stop", { conversationId: cid })}
                    socket={socket}
                    conversationId={cid}
                    keepAlive={paneKeepAlive}
                    onToggleKeepAlive={(enabled) => {
                      fetch(`/api/conversations/${cid}/keep-alive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }).catch(() => {});
                      setKeepAliveByConvo(prev => ({ ...prev, [cid]: enabled }));
                    }}
                    mode={paneMode}
                    conversationConfig={configByConvo[cid] || {}}
                    isNewConversation={newConvoIds.has(cid)}
                    sessionId={paneSessionId}
                    hasMore={hasMoreByConvo[cid] || false}
                    totalMessages={totalMsgsByConvo[cid] || 0}
                    onLoadMore={() => loadConversationMessages(cid, true)}
                    sessionCwd={cwdByConvo[cid] || null}
                    autoShowTerminal={showTerminalFor?.convoId === cid ? showTerminalFor.ts : null}
                    onSwitchMode={(newMode) => changeConversationMode(cid, newMode)}
                  />
                </div>
              );
            })}
            {multiViewConvos.length < maxPanes && (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "var(--bg-primary)", cursor: "pointer", flexDirection: "column", gap: 6,
                color: "var(--text-muted)", fontSize: 12, fontFamily: "'Inter','Helvetica Neue',sans-serif",
              }} onClick={() => {
                const unused = conversations.filter(c => !multiViewConvos.includes(c.id) && !(c.metadata?.master)).slice(0, 1);
                if (unused.length > 0) {
                  setMultiViewConvos(prev => [...prev, unused[0].id]);
                  if (!conversationCache[unused[0].id]) loadConversationMessages(unused[0].id);
                }
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                add
              </div>
            )}
          </div>
        ) : (
          <CliPanel
            events={cliEvents}
            streamingText={streamingText}
            isThinking={isThinking}
            onSendMessage={sendMessage}
            onStop={() => socketRef.current?.emit("chat:stop", { conversationId: currentConvoId })}
            socket={socket}
            conversationId={currentConvoId}
            keepAlive={keepAlive}
            onToggleKeepAlive={toggleKeepAlive}
            mode={currentMode}
            conversationConfig={currentConfig}
            isNewConversation={isNewConversation}
            sessionId={currentSessionId}
            viewMessages={viewMessagesId === currentConvoId}
            onCloseViewMessages={() => setViewMessagesId(null)}
            hasMore={hasMoreByConvo[currentConvoId] || false}
            totalMessages={totalMsgsByConvo[currentConvoId] || 0}
            onLoadMore={() => loadConversationMessages(currentConvoId, true)}
            sessionCwd={cwdByConvo[currentConvoId] || null}
            autoShowTerminal={showTerminalFor?.convoId === currentConvoId ? showTerminalFor.ts : null}
            onSwitchMode={(newMode) => changeConversationMode(currentConvoId, newMode)}
          />
        )}

        {currentMode === "terminal-persistent" && (
          <VoiceOrb
            isListening={isListening}
            isSpeaking={false}
            isThinking={isThinking}
            onToggle={toggleListening}
            onStop={() => socketRef.current?.emit("chat:stop", { conversationId: currentConvoId })}
          />
        )}
      </main>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function VolumeMuteIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  );
}

function PaneHeader({ cid, title, isActive, conversations, onSelect, onSwitch, onRemove }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropRef = React.useRef(null);

  React.useEffect(() => {
    if (!dropdownOpen) return;
    const close = (e) => { if (dropRef.current && !dropRef.current.contains(e.target)) setDropdownOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [dropdownOpen]);

  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex", alignItems: "center",
        padding: "4px 8px", background: isActive ? "var(--bg-elevated)" : "var(--bg-secondary)",
        borderBottom: isActive ? "2px solid var(--accent)" : "1px solid var(--border)",
        fontSize: 11, fontFamily: "var(--font-sans)", flexShrink: 0, gap: 4,
        transition: "background 0.15s ease-out, border-color 0.15s ease-out", cursor: "pointer",
        position: "relative",
      }}>
      {/* Title — double-click opens dropdown */}
      <span
        onDoubleClick={(e) => { e.stopPropagation(); setDropdownOpen(true); }}
        style={{
          flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: isActive ? "var(--accent-light)" : "var(--text-secondary)",
          fontWeight: 500, userSelect: "none",
        }}
      >{title}</span>

      {/* Small chevron button to open dropdown */}
      <button
        onClick={(e) => { e.stopPropagation(); setDropdownOpen(!dropdownOpen); }}
        style={{
          background: "none", border: "none", color: "var(--text-ghost)", padding: "2px 3px",
          cursor: "pointer", flexShrink: 0, borderRadius: 3, transition: "color 0.12s",
        }}
        onMouseEnter={e => e.currentTarget.style.color = "var(--text-secondary)"}
        onMouseLeave={e => e.currentTarget.style.color = "var(--text-ghost)"}
        title="Switch conversation"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="6 9 12 15 18 9" /></svg>
      </button>

      {/* Custom dropdown */}
      {dropdownOpen && (
        <div ref={dropRef} style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50,
          background: "var(--bg-tertiary)", border: "1px solid var(--border-secondary)",
          borderRadius: "0 0 var(--radius-md) var(--radius-md)",
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)", maxHeight: 200, overflowY: "auto",
        }}>
          {conversations.map(c => (
            <div
              key={c.id}
              onClick={(e) => { e.stopPropagation(); onSwitch(c.id); setDropdownOpen(false); }}
              style={{
                padding: "7px 12px", fontSize: 11, cursor: "pointer",
                color: c.id === cid ? "var(--accent-light)" : "var(--text-secondary)",
                background: c.id === cid ? "var(--accent-muted)" : "transparent",
                transition: "background 0.1s",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}
              onMouseEnter={e => { if (c.id !== cid) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={e => { if (c.id !== cid) e.currentTarget.style.background = "transparent"; }}
            >
              {c.title?.slice(0, 45) || c.id.slice(0, 8)}
            </div>
          ))}
        </div>
      )}

      {/* X remove */}
      <button style={{
        background: "none", border: "none", color: "var(--text-muted)", padding: 3, flexShrink: 0,
        borderRadius: 4, transition: "color 0.15s, background 0.15s",
      }}
        onMouseEnter={e => { e.currentTarget.style.color = "var(--danger)"; e.currentTarget.style.background = "var(--danger-bg)"; }}
        onMouseLeave={e => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="Remove pane"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
      </button>
    </div>
  );
}
