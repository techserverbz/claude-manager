import React, { useState, useEffect, useCallback, useMemo } from "react";
import "./MemoryModule.css";
import AddBrainModal from "./AddBrainModal.jsx";

const TYPE_COLORS = { project: "#7c6aef", feedback: "#eab308", user: "#22c55e", reference: "#58a6ff", page: "#94a3b8" };
const TYPE_ICONS = { project: "\u{1F4CB}", feedback: "\u{1F4AC}", user: "\u{1F464}", reference: "\u{1F517}", page: "\u{1F4C4}" };
const CATEGORY_EMOJI = {
  codebases: "\u{1F4C1}", business: "\u{1F4BC}", people: "\u{1F464}", decisions: "\u{2696}\u{FE0F}",
  ideas: "\u{1F4A1}", patterns: "\u{1F517}", systems: "\u{2699}\u{FE0F}", tools: "\u{1F6E0}\u{FE0F}",
  research: "\u{1F50D}", meetings: "\u{1F4C5}", clients: "\u{1F91D}", finance: "\u{1F4B0}", credentials: "\u{1F511}"
};

const PLANNER_FILES = ["tasks.md", "short-term.md", "reminders.md", "calendar.md"];

export default function MemoryModule({ onClose }) {
  const [brains, setBrains] = useState([]);
  const [activeBrain, setActiveBrain] = useState(null);
  const [view, setView] = useState("pages"); // "hot" | "pages" | "planner" | "raw" | "skills"
  const [hotContent, setHotContent] = useState("");
  const [pages, setPages] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [plannerFile, setPlannerFile] = useState("tasks.md");
  const [plannerContent, setPlannerContent] = useState("");
  const [plannerDirty, setPlannerDirty] = useState(false);
  const [skills, setSkills] = useState([]);
  const [selectedPage, setSelectedPage] = useState(null);
  const [selectedContent, setSelectedContent] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAddBrain, setShowAddBrain] = useState(false);
  const [syncState, setSyncState] = useState("");

  // --- fetchers ---

  const fetchBrains = useCallback(async () => {
    try {
      const res = await fetch("/api/brains");
      const list = await res.json();
      setBrains(list);
      const active = list.find(b => b.is_active) || list[0];
      setActiveBrain(active || null);
    } catch {}
  }, []);

  const fetchPages = useCallback(async (brainId) => {
    if (!brainId) return;
    try {
      const res = await fetch(`/api/brains/${brainId}/pages`);
      const data = await res.json();
      setPages(data?.pages || []);
      setCategories(data?.categories || []);
    } catch {}
  }, []);

  const fetchHot = useCallback(async (brainId) => {
    if (!brainId) { setHotContent(""); return; }
    try {
      const res = await fetch(`/api/brains/${brainId}/hot`);
      const data = await res.json();
      setHotContent(data?.content || "");
    } catch {}
  }, []);

  const fetchPlanner = useCallback(async (brainId, file) => {
    if (!brainId) return;
    try {
      const res = await fetch(`/api/brains/${brainId}/planner/${file}`);
      const data = await res.json();
      setPlannerContent(data?.content || "");
      setPlannerDirty(false);
    } catch { setPlannerContent(""); }
  }, []);

  const fetchSkills = useCallback(async (brainId) => {
    if (!brainId) return;
    try {
      const res = await fetch(`/api/brains/${brainId}/skills`);
      const data = await res.json();
      setSkills(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  // --- effects ---

  useEffect(() => { fetchBrains().finally(() => setLoading(false)); }, [fetchBrains]);

  useEffect(() => {
    if (!activeBrain) return;
    fetchPages(activeBrain.id);
    fetchHot(activeBrain.id);
    fetchSkills(activeBrain.id);
    setSelectedPage(null);
    setSelectedContent("");
  }, [activeBrain, fetchPages, fetchHot, fetchSkills]);

  useEffect(() => {
    if (view === "planner" && activeBrain) fetchPlanner(activeBrain.id, plannerFile);
  }, [view, activeBrain, plannerFile, fetchPlanner]);

  // --- actions ---

  const activateBrain = async (id) => {
    try {
      await fetch(`/api/brains/${id}/activate`, { method: "POST" });
      await fetchBrains();
    } catch {}
  };

  const openPage = async (p) => {
    if (!activeBrain) return;
    setSelectedPage(p);
    setSelectedContent("Loading...");
    try {
      const res = await fetch(`/api/brains/${activeBrain.id}/pages/${p.category}/${p.slug}`);
      const data = await res.json();
      setSelectedContent(data?.content || "No content");
    } catch { setSelectedContent("Failed to load."); }
  };

  const syncWiki = async () => {
    if (!activeBrain) return;
    setSyncState("syncing...");
    try {
      const res = await fetch(`/api/brains/${activeBrain.id}/sync`, { method: "POST" });
      const data = await res.json();
      setSyncState(`synced ${data?.synced || 0} pages`);
      await fetchPages(activeBrain.id);
      setTimeout(() => setSyncState(""), 2500);
    } catch { setSyncState("sync failed"); }
  };

  const savePlanner = async () => {
    if (!activeBrain) return;
    try {
      await fetch(`/api/brains/${activeBrain.id}/planner/${plannerFile}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: plannerContent })
      });
      setPlannerDirty(false);
    } catch {}
  };

  const removeBrain = async (id) => {
    if (!window.confirm("Remove this service brain? (Wiki files on disk are untouched.)")) return;
    try {
      const res = await fetch(`/api/brains/${id}`, { method: "DELETE" });
      if (res.ok) await fetchBrains();
    } catch {}
  };

  // --- derived ---

  const filteredPages = useMemo(() => {
    return pages.filter(p => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (p.name || "").toLowerCase().includes(q) ||
          (p.excerpt || "").toLowerCase().includes(q) ||
          (p.slug || "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [pages, categoryFilter, search]);

  const pagesByCategory = useMemo(() => {
    const out = {};
    for (const p of filteredPages) {
      if (!out[p.category]) out[p.category] = [];
      out[p.category].push(p);
    }
    return out;
  }, [filteredPages]);

  const categoryStats = useMemo(() => {
    const counts = {};
    for (const p of pages) counts[p.category] = (counts[p.category] || 0) + 1;
    return counts;
  }, [pages]);

  // --- render ---

  return (
    <div className="memory-module">
      <div className="memory-header">
        <div className="memory-header-left">
          <h2>Second Brain</h2>
          <div className="memory-stats">
            <select
              className="memory-brain-select"
              value={activeBrain?.id || ""}
              onChange={e => activateBrain(e.target.value)}
              style={{ padding: "4px 8px", borderRadius: 6, background: "#1e1e2e", color: "#fff", border: "1px solid #333", fontSize: 13 }}
            >
              {brains.map(b => (
                <option key={b.id} value={b.id}>
                  {b.is_builtin ? "\u{1F3E0} " : "\u{1F517} "}{b.name}
                </option>
              ))}
            </select>
            <button
              className="stat"
              onClick={() => setShowAddBrain(true)}
              style={{ cursor: "pointer", background: "transparent", border: "1px dashed #555", color: "#7c6aef" }}
            >
              + Add Service Brain
            </button>
            {activeBrain && !activeBrain.is_builtin && (
              <button
                className="stat"
                onClick={() => removeBrain(activeBrain.id)}
                style={{ cursor: "pointer", background: "transparent", border: "1px solid #ef4444", color: "#ef4444" }}
                title="Remove this service brain"
              >
                Remove
              </button>
            )}
            <span className="stat">{pages.length} pages</span>
            {syncState && <span className="stat" style={{ color: "#22c55e" }}>{syncState}</span>}
            <button className="stat" onClick={syncWiki} style={{ cursor: "pointer", background: "transparent", border: "1px solid #333" }}>Sync</button>
          </div>
        </div>
        <div className="memory-header-right">
          <div className="memory-views">
            {[
              ["hot", "Hot"],
              ["pages", "Pages"],
              ["planner", "Planner"],
              ["skills", "Skills"]
            ].map(([v, label]) => (
              <button key={v} className={`view-btn ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
                {label}
              </button>
            ))}
          </div>
          <button className="memory-close-btn" onClick={onClose}>&times;</button>
        </div>
      </div>

      {activeBrain && (
        <div style={{ padding: "6px 16px", borderBottom: "1px solid #22222e", fontSize: 11, color: "#94a3b8", background: "#15151f" }}>
          {activeBrain.claude_path}
        </div>
      )}

      <div className="memory-body">
        <div className="memory-sidebar">
          {view === "pages" && (
            <>
              <input className="memory-search" placeholder="Search pages..." value={search} onChange={e => setSearch(e.target.value)} />
              <div className="memory-filter-row" style={{ flexWrap: "wrap", gap: 6 }}>
                <button
                  className={`memory-type-btn ${categoryFilter === "all" ? "active" : ""}`}
                  onClick={() => setCategoryFilter("all")}
                >
                  All ({pages.length})
                </button>
                {categories.map(c => (
                  <button
                    key={c}
                    className={`memory-type-btn ${categoryFilter === c ? "active" : ""}`}
                    onClick={() => setCategoryFilter(c)}
                    title={c}
                  >
                    <span style={{ marginRight: 4 }}>{CATEGORY_EMOJI[c] || "\u{1F4C4}"}</span>
                    {c} ({categoryStats[c] || 0})
                  </button>
                ))}
              </div>

              <div className="memory-list">
                {loading && <div className="memory-empty">Loading...</div>}
                {!loading && filteredPages.length === 0 && <div className="memory-empty">No pages</div>}
                {Object.keys(pagesByCategory).sort().map(cat => (
                  <div key={cat} className="memory-date-group">
                    <div className="memory-date-header">
                      {CATEGORY_EMOJI[cat] || "\u{1F4C1}"} {cat}
                    </div>
                    {pagesByCategory[cat].map(p => (
                      <div
                        key={`${p.category}/${p.slug}`}
                        className={`memory-item ${selectedPage?.slug === p.slug && selectedPage?.category === p.category ? "selected" : ""}`}
                        onClick={() => openPage(p)}
                      >
                        <span className="memory-item-icon">{TYPE_ICONS[p.type] || "\u{1F4C4}"}</span>
                        <div className="memory-item-info">
                          <div className="memory-item-name">{p.name || p.slug}</div>
                          <div className="memory-item-type" style={{ color: "#94a3b8" }}>
                            {(p.last_modified || "").slice(0, 10)}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {view === "hot" && (
            <div className="memory-list">
              <div className="memory-empty" style={{ fontSize: 12, padding: 8 }}>
                Hot cache — recent context loaded at session start.
              </div>
            </div>
          )}

          {view === "planner" && (
            <div className="memory-list">
              {PLANNER_FILES.map(f => (
                <div
                  key={f}
                  className={`memory-item ${plannerFile === f ? "selected" : ""}`}
                  onClick={() => setPlannerFile(f)}
                >
                  <span className="memory-item-icon">📝</span>
                  <div className="memory-item-info">
                    <div className="memory-item-name">{f}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {view === "skills" && (
            <div className="memory-list">
              {skills.length === 0 && <div className="memory-empty">No skills in {activeBrain?.claude_path}/skills/</div>}
              {skills.map((s, i) => (
                <div key={i} className="memory-item">
                  <span className="memory-item-icon">{s.type === "folder" ? "\u{1F4C1}" : "\u{1F4C4}"}</span>
                  <div className="memory-item-info">
                    <div className="memory-item-name">{s.name}</div>
                    <div className="memory-item-type" style={{ color: "#94a3b8" }}>{s.description?.slice(0, 60) || s.type}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="memory-detail">
          {view === "hot" ? (
            <div className="memory-detail-content">
              <div className="memory-detail-header">
                <h3>Hot Cache</h3>
                <div className="memory-detail-meta">
                  <span className="memory-detail-path">{activeBrain?.claude_path}/wiki/wiki/hot.md</span>
                </div>
              </div>
              <pre className="memory-content-text">{hotContent || "(empty — run scsb to compile, or wait for the hook)"}</pre>
            </div>
          ) : view === "planner" ? (
            <div className="memory-detail-content">
              <div className="memory-detail-header">
                <h3>{plannerFile}</h3>
                <div className="memory-detail-meta">
                  <span className="memory-detail-path">{activeBrain?.claude_path}/wiki/{plannerFile}</span>
                  {plannerDirty && <span className="stat" style={{ color: "#eab308" }}>unsaved</span>}
                  <button
                    className="stat"
                    onClick={savePlanner}
                    disabled={!plannerDirty}
                    style={{ cursor: plannerDirty ? "pointer" : "default", background: plannerDirty ? "#22c55e" : "#333", color: "#fff", border: 0 }}
                  >Save</button>
                </div>
              </div>
              <textarea
                className="memory-content-text"
                value={plannerContent}
                onChange={e => { setPlannerContent(e.target.value); setPlannerDirty(true); }}
                style={{ width: "100%", height: "100%", background: "#0f0f17", color: "#e2e8f0", border: "1px solid #22222e", borderRadius: 6, padding: 12, fontFamily: "Consolas, monospace", fontSize: 13, resize: "none" }}
              />
            </div>
          ) : view === "pages" && selectedPage ? (
            <div className="memory-detail-content">
              <div className="memory-detail-header">
                <h3>{selectedPage.name || selectedPage.slug}</h3>
                <div className="memory-detail-meta">
                  <span className="memory-detail-type" style={{ color: "#7c6aef", borderColor: "#7c6aef" }}>{selectedPage.category}</span>
                  <span className="memory-detail-path">wiki/{selectedPage.category}/{selectedPage.slug}.md</span>
                </div>
              </div>
              <pre className="memory-content-text">{selectedContent}</pre>
            </div>
          ) : view === "skills" ? (
            <div className="memory-detail-content">
              <div className="memory-detail-header">
                <h3>Skills — {activeBrain?.name}</h3>
                <div className="memory-detail-meta">
                  <span className="memory-detail-path">{activeBrain?.claude_path}/skills/</span>
                </div>
              </div>
              <pre className="memory-content-text">{skills.length === 0 ? "(no skills found in this brain's skills/ folder)" : skills.map(s => `${s.type === "folder" ? "📁" : "📄"} ${s.name}${s.description ? ` — ${s.description.trim().slice(0, 120)}` : ""}`).join("\n\n")}</pre>
            </div>
          ) : (
            <div className="memory-empty-detail">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>
              <p>Select a page to view</p>
            </div>
          )}
        </div>
      </div>

      {showAddBrain && (
        <AddBrainModal
          onClose={() => setShowAddBrain(false)}
          onAdded={async () => {
            setShowAddBrain(false);
            await fetchBrains();
          }}
        />
      )}
    </div>
  );
}
