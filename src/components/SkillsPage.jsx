import React, { useState, useEffect, useCallback } from "react";

export default function SkillsPage({ onClose }) {
  const [skills, setSkills] = useState([]);
  const [viewing, setViewing] = useState(null); // { name, content, files }
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null); // skill name being deleted
  const [confirmDelete, setConfirmDelete] = useState(null); // skill name pending confirm
  const [brains, setBrains] = useState([]);
  const [selectedBrainId, setSelectedBrainId] = useState(""); // "" = use /api/skills (built-in Personal)
  const [selectedBrain, setSelectedBrain] = useState(null);

  const fetchSkills = useCallback(async () => {
    try {
      // If a non-personal service brain is selected, read from brain endpoint
      if (selectedBrainId && selectedBrain && !selectedBrain.is_builtin) {
        const r = await fetch(`/api/brains/${selectedBrainId}/skills`);
        if (r.ok) {
          const items = await r.json();
          // Normalize brain skill shape to skills-page shape
          setSkills(items.map(s => ({
            name: s.name,
            description: s.description || "",
            fileCount: s.type === "folder" ? "—" : 1,
            readonly: true,   // can't create/delete under a service brain from here
            path: s.path
          })));
          return;
        }
      }
      // Default: use existing /api/skills (Personal brain or built-in skills)
      const r = await fetch("/api/skills");
      if (r.ok) setSkills(await r.json());
    } catch {}
  }, [selectedBrainId, selectedBrain]);

  const fetchBrains = useCallback(async () => {
    try {
      const r = await fetch("/api/brains");
      if (r.ok) {
        const list = await r.json();
        setBrains(list);
      }
    } catch {}
  }, []);

  useEffect(() => { fetchBrains(); }, [fetchBrains]);
  useEffect(() => {
    const b = brains.find(x => x.id === selectedBrainId);
    setSelectedBrain(b || null);
  }, [selectedBrainId, brains]);
  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await fetch("/api/skills/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
      setName(""); setShowForm(false); await fetchSkills();
    } catch {} finally { setCreating(false); }
  };

  const handleDelete = async (skillName) => {
    setDeleting(skillName);
    try {
      await fetch(`/api/skills/${encodeURIComponent(skillName)}`, { method: "DELETE" });
      setConfirmDelete(null);
      if (viewing?.name === skillName) setViewing(null);
      await fetchSkills();
    } catch {} finally { setDeleting(null); }
  };

  const handleView = async (skillName) => {
    try {
      const r = await fetch(`/api/skills/${encodeURIComponent(skillName)}`);
      if (r.ok) setViewing(await r.json());
    } catch {}
  };

  // Viewing a skill detail
  if (viewing) {
    return (
      <div className="sp-root">
        <div className="sp-header">
          <div className="sp-header-left">
            <button className="sp-back" onClick={() => setViewing(null)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <h2 className="sp-title">{viewing.name}</h2>
          </div>
          <button className="sp-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="sp-scroll">
          {viewing.files && viewing.files.length > 0 && (
            <div className="sp-files-section">
              <div className="sp-label">Files ({viewing.files.length})</div>
              <div className="sp-file-list">
                {viewing.files.map((f, i) => (
                  <div key={i} className="sp-file-item">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></svg>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {viewing.content && (
            <div className="sp-content-section">
              <div className="sp-label">SKILL.md</div>
              <pre className="sp-markdown">{viewing.content}</pre>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Skills list
  const isServiceBrain = selectedBrain && !selectedBrain.is_builtin;
  return (
    <div className="sp-root">
      <div className="sp-header">
        <h2 className="sp-title">Skills</h2>
        <div className="sp-header-actions">
          {brains.length > 0 && (
            <select
              value={selectedBrainId}
              onChange={e => setSelectedBrainId(e.target.value)}
              className="sp-brain-select"
              title="View skills from a specific brain"
            >
              <option value="">🏠 Personal (built-in)</option>
              {brains.filter(b => !b.is_builtin).map(b => (
                <option key={b.id} value={b.id}>🔗 {b.name}</option>
              ))}
            </select>
          )}
          {!isServiceBrain && (
            <button className="sp-add-btn" onClick={() => setShowForm(!showForm)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              Add Skill
            </button>
          )}
          <button className="sp-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>
      {isServiceBrain && (
        <div style={{ padding: "8px 20px", background: "#15151f", borderBottom: "1px solid #22222e", fontSize: 11, color: "#94a3b8" }}>
          Viewing skills from <code>{selectedBrain?.claude_path}/skills/</code> (read-only — manage service brain skills in the Services wiki)
        </div>
      )}

      <div className="sp-scroll">
        {showForm && (
          <form className="sp-form" onSubmit={handleCreate}>
            <input className="sp-input" value={name} onChange={e => setName(e.target.value)} placeholder="Skill name..." autoFocus />
            <button type="submit" className="sp-form-submit" disabled={creating || !name.trim()}>
              {creating ? "Creating..." : "Create"}
            </button>
            <button type="button" className="sp-form-cancel" onClick={() => { setShowForm(false); setName(""); }}>Cancel</button>
          </form>
        )}

        {skills.length === 0 && !showForm && (
          <div className="sp-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <p>No skills installed</p>
            <span>Click "Add Skill" to create one</span>
          </div>
        )}

        <div className="sp-list">
          {skills.map(skill => (
            <div key={skill.name} className="sp-card">
              <div className="sp-card-main" onClick={() => handleView(skill.name)}>
                <div className="sp-card-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                </div>
                <div className="sp-card-info">
                  <span className="sp-card-name">{skill.name}</span>
                  {skill.description && <span className="sp-card-desc">{skill.description}</span>}
                  <span className="sp-card-meta">{skill.fileCount} files</span>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="sp-card-arrow"><polyline points="9 18 15 12 9 6" /></svg>
              </div>
              {!isServiceBrain && (
                <div className="sp-card-actions">
                  {confirmDelete === skill.name ? (
                    <>
                      <span className="sp-confirm-text">Delete?</span>
                      <button className="sp-confirm-yes" onClick={() => handleDelete(skill.name)} disabled={deleting === skill.name}>
                        {deleting === skill.name ? "..." : "Yes"}
                      </button>
                      <button className="sp-confirm-no" onClick={() => setConfirmDelete(null)}>No</button>
                    </>
                  ) : (
                    <button className="sp-delete-btn" onClick={(e) => { e.stopPropagation(); setConfirmDelete(skill.name); }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <style>{`
        .sp-root { flex:1; display:flex; flex-direction:column; overflow:hidden; font-family:var(--font-sans); }
        .sp-header { display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid var(--border); background:var(--bg-secondary); flex-shrink:0; }
        .sp-header-left { display:flex; align-items:center; gap:8px; }
        .sp-title { font-size:15px; font-weight:600; color:var(--text-primary); margin:0; }
        .sp-header-actions { display:flex; gap:8px; align-items:center; }
        .sp-back { background:none; border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-muted); width:32px; height:32px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .15s; }
        .sp-back:hover { color:var(--text-primary); border-color:var(--border-secondary); }
        .sp-close { background:none; border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-muted); width:32px; height:32px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:all .15s; }
        .sp-close:hover { color:var(--text-primary); border-color:var(--border-secondary); }
        .sp-brain-select { padding:6px 10px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-primary); font-size:12px; font-family:var(--font-sans); cursor:pointer; outline:none; }
        .sp-brain-select:hover { border-color:var(--border-secondary); }
        .sp-add-btn { display:flex; align-items:center; gap:6px; padding:6px 14px; background:var(--accent-muted); border:1px solid var(--accent); border-radius:var(--radius-md); color:var(--accent-light); font-size:12px; font-weight:500; font-family:var(--font-sans); cursor:pointer; transition:all .15s; }
        .sp-add-btn:hover { background:var(--accent-glow); }
        .sp-scroll { flex:1; overflow-y:auto; padding:20px; }

        .sp-form { display:flex; gap:8px; margin-bottom:20px; padding:16px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); align-items:center; }
        .sp-input { flex:1; padding:9px 14px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-primary); font-size:13px; font-family:var(--font-sans); outline:none; transition:border-color .15s; }
        .sp-input:focus { border-color:var(--accent); }
        .sp-form-submit { padding:9px 18px; background:var(--accent); border:none; border-radius:var(--radius-md); color:#fff; font-size:12px; font-weight:500; font-family:var(--font-sans); cursor:pointer; transition:opacity .15s; }
        .sp-form-submit:disabled { opacity:.4; cursor:default; }
        .sp-form-cancel { padding:9px 14px; background:none; border:1px solid var(--border); border-radius:var(--radius-md); color:var(--text-muted); font-size:12px; font-family:var(--font-sans); cursor:pointer; }

        .sp-empty { display:flex; flex-direction:column; align-items:center; gap:10px; padding:80px 40px; color:var(--text-muted); text-align:center; }
        .sp-empty p { font-size:15px; font-weight:500; margin:0; }
        .sp-empty span { font-size:12px; color:var(--text-ghost); }

        .sp-list { display:flex; flex-direction:column; gap:8px; }

        .sp-card { display:flex; align-items:center; background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-lg); overflow:hidden; transition:border-color .15s; }
        .sp-card:hover { border-color:var(--border-secondary); }
        .sp-card-main { flex:1; display:flex; align-items:center; gap:14px; padding:16px 18px; cursor:pointer; min-width:0; }
        .sp-card-icon { width:38px; height:38px; border-radius:var(--radius-md); background:var(--accent-muted); display:flex; align-items:center; justify-content:center; color:var(--accent-light); flex-shrink:0; }
        .sp-card-info { flex:1; display:flex; flex-direction:column; gap:3px; min-width:0; }
        .sp-card-name { font-size:14px; font-weight:600; color:var(--text-primary); }
        .sp-card-desc { font-size:11px; color:var(--text-muted); line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .sp-card-meta { font-size:10px; color:var(--text-ghost); font-family:var(--font-mono); }
        .sp-card-arrow { color:var(--text-ghost); flex-shrink:0; margin-right:4px; }

        .sp-card-actions { display:flex; align-items:center; gap:6px; padding:0 14px; border-left:1px solid var(--border); height:100%; }
        .sp-delete-btn { background:none; border:none; color:var(--text-muted); cursor:pointer; padding:8px; border-radius:var(--radius-md); transition:all .15s; }
        .sp-delete-btn:hover { color:var(--danger); background:var(--danger-bg); }
        .sp-confirm-text { font-size:11px; color:var(--danger); font-weight:500; }
        .sp-confirm-yes { padding:4px 10px; background:var(--danger); border:none; border-radius:var(--radius-sm); color:#fff; font-size:11px; cursor:pointer; font-family:var(--font-sans); }
        .sp-confirm-yes:disabled { opacity:.5; }
        .sp-confirm-no { padding:4px 10px; background:none; border:1px solid var(--border); border-radius:var(--radius-sm); color:var(--text-muted); font-size:11px; cursor:pointer; font-family:var(--font-sans); }

        .sp-files-section, .sp-content-section { margin-bottom:24px; }
        .sp-label { font-size:11px; font-weight:500; color:var(--text-muted); margin-bottom:10px; letter-spacing:.3px; }
        .sp-file-list { display:flex; flex-direction:column; gap:2px; }
        .sp-file-item { display:flex; align-items:center; gap:8px; padding:6px 12px; font-size:12px; color:var(--text-secondary); font-family:var(--font-mono); background:var(--bg-secondary); border-radius:var(--radius-sm); }
        .sp-file-item svg { color:var(--text-ghost); flex-shrink:0; }
        .sp-markdown { font-size:12px; line-height:1.6; color:var(--text-secondary); font-family:var(--font-mono); background:var(--bg-secondary); border:1px solid var(--border); border-radius:var(--radius-md); padding:16px; white-space:pre-wrap; word-break:break-word; overflow-x:auto; margin:0; }
      `}</style>
    </div>
  );
}
