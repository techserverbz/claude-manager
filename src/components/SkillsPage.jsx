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
        /* ═══ SkillsPage — Operator ═══ */
        .sp-root {
          flex:1; display:flex; flex-direction:column; overflow:hidden;
          font-family:var(--ff-ui); background:var(--ink-0); position:relative;
        }
        .sp-root::before {
          content:""; position:absolute; inset:0;
          background-image:var(--noise); opacity:0.45;
          pointer-events:none; z-index:0;
        }
        .sp-root > * { position:relative; z-index:1; }

        .sp-header {
          display:flex; align-items:center; justify-content:space-between;
          padding:20px 28px 18px;
          box-shadow: inset 0 -1px 0 var(--rule-1);
          background: transparent; flex-shrink:0;
        }
        .sp-header-left { display:flex; align-items:center; gap:12px; }
        .sp-title {
          font-family: var(--ff-serif); font-style: italic; font-weight: 400;
          font-size: 32px; letter-spacing: var(--track-editorial);
          color: var(--paper-0); margin: 0; line-height: 1;
          position: relative; padding-top: 18px;
        }
        .sp-title::before {
          content: "INSTALLED";
          position: absolute; top: 0; left: 0;
          font-family: var(--ff-mono); font-style: normal;
          font-size: 9px; font-weight: 500;
          letter-spacing: var(--track-wider);
          color: var(--paper-3);
        }
        .sp-header-actions { display:flex; gap:8px; align-items:center; }

        .sp-back, .sp-close {
          background:transparent; border:none;
          color:var(--paper-3);
          width:30px; height:30px;
          display:flex; align-items:center; justify-content:center;
          cursor:pointer; border-radius:var(--r-1);
          box-shadow: var(--shadow-inset-hairline);
          transition: color var(--dur-quick) var(--ease-snap),
                      background var(--dur-quick) var(--ease-snap);
        }
        .sp-back:hover { color:var(--paper-0); background:var(--ink-2); }
        .sp-close:hover { color:var(--flame); background:color-mix(in srgb, var(--flame) 8%, transparent); }

        .sp-brain-select {
          appearance: none; -webkit-appearance: none;
          padding: 6px 28px 6px 14px;
          background: var(--ink-1)
            url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23a8a294' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")
            no-repeat right 9px center;
          border: none; border-radius: var(--r-pill);
          box-shadow: var(--shadow-inset-hairline);
          color: var(--paper-0);
          font-family: var(--ff-ui); font-size: 12px; font-weight: var(--w-mid);
          cursor: pointer; outline: none;
          transition: box-shadow var(--dur-quick) var(--ease-snap);
        }
        .sp-brain-select:hover { box-shadow: var(--shadow-inset-hairline-strong); }
        .sp-brain-select:focus { box-shadow: inset 0 0 0 1px var(--rule-acid); }

        .sp-add-btn {
          display:flex; align-items:center; gap:6px;
          padding:6px 14px;
          background: var(--acid); color: #0b0a08;
          border:none; border-radius:var(--r-pill);
          font-size:11px; font-weight:var(--w-strong);
          letter-spacing:var(--track-wide);
          font-family:var(--ff-ui); cursor:pointer;
          box-shadow: var(--glow-acid);
          transition: filter var(--dur-quick) var(--ease-snap);
        }
        .sp-add-btn:hover { filter: brightness(1.1); }

        .sp-scroll { flex:1; overflow-y:auto; padding:24px 28px 32px; }
        .sp-scroll::-webkit-scrollbar { width:8px; }
        .sp-scroll::-webkit-scrollbar-track { background:transparent; }
        .sp-scroll::-webkit-scrollbar-thumb { background:var(--ink-4); border-radius:var(--r-pill); }

        .sp-form {
          display:flex; gap:10px; margin-bottom:24px;
          padding:18px 20px;
          background: var(--ink-1);
          border: none; border-radius: var(--r-2);
          box-shadow: var(--shadow-inset-hairline);
          align-items:center;
        }
        .sp-input {
          flex:1; padding:10px 14px;
          background: var(--ink-0); color: var(--paper-0);
          border: none; border-radius: var(--r-1);
          box-shadow: var(--shadow-inset-hairline);
          font-size:13px; font-family: var(--ff-ui);
          outline:none;
          transition: box-shadow var(--dur-quick) var(--ease-snap);
        }
        .sp-input:focus { box-shadow: inset 0 0 0 1px var(--rule-acid); }

        .sp-form-submit {
          padding: 10px 18px;
          background: var(--acid); color: #0b0a08;
          border: none; border-radius: var(--r-1);
          font-size: 12px; font-weight: var(--w-strong);
          letter-spacing: var(--track-wide);
          font-family: var(--ff-ui);
          cursor: pointer;
          box-shadow: var(--glow-acid);
          transition: filter var(--dur-quick) var(--ease-snap);
        }
        .sp-form-submit:hover:not(:disabled) { filter: brightness(1.1); }
        .sp-form-submit:disabled { opacity: 0.4; cursor: default; box-shadow: var(--shadow-inset-hairline); background: var(--ink-3); color: var(--paper-3); }

        .sp-form-cancel {
          padding: 10px 14px;
          background: transparent; color: var(--paper-2);
          border: none; border-radius: var(--r-1);
          box-shadow: var(--shadow-inset-hairline);
          font-size: 12px; font-family: var(--ff-ui);
          cursor: pointer;
          transition: background var(--dur-quick) var(--ease-snap);
        }
        .sp-form-cancel:hover { background: var(--ink-2); color: var(--paper-0); }

        .sp-empty {
          display:flex; flex-direction:column; align-items:center; gap:16px;
          padding:90px 40px; color:var(--paper-3); text-align:center;
        }
        .sp-empty svg { opacity: 0.35; }
        .sp-empty p {
          font-family: var(--ff-serif); font-style: italic;
          font-size: 20px; font-weight: 400;
          letter-spacing: var(--track-editorial);
          color: var(--paper-2); margin: 0;
        }
        .sp-empty span {
          font-family: var(--ff-mono); font-size: 10.5px;
          color: var(--paper-3); letter-spacing: var(--track-wide);
        }

        .sp-list {
          display:flex; flex-direction:column; gap:0;
          background: var(--ink-1);
          border-radius: var(--r-2);
          box-shadow: var(--shadow-inset-hairline);
          overflow: hidden;
        }

        .sp-card {
          display:flex; align-items:center;
          background: transparent; border: none;
          border-radius: 0;
          box-shadow: inset 0 -1px 0 var(--rule-0);
          transition: background var(--dur-instant) var(--ease-snap);
        }
        .sp-card:last-child { box-shadow: none; }
        .sp-card:hover { background: var(--ink-2); }

        .sp-card-main {
          flex:1; display:flex; align-items:center; gap:16px;
          padding:16px 20px; cursor:pointer; min-width:0;
        }
        .sp-card-icon {
          width:34px; height:34px;
          border-radius: var(--r-pill);
          background: color-mix(in srgb, var(--acid) 10%, transparent);
          box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--acid) 40%, transparent);
          display:flex; align-items:center; justify-content:center;
          color: var(--acid); flex-shrink:0;
        }
        .sp-card-info { flex:1; display:flex; flex-direction:column; gap:4px; min-width:0; }
        .sp-card-name {
          font-family: var(--ff-ui);
          font-size: 14px; font-weight: var(--w-mid);
          color: var(--paper-0); letter-spacing: var(--track-tight);
        }
        .sp-card-desc {
          font-size: 11.5px; color: var(--paper-2); line-height: 1.4;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .sp-card-meta {
          font-size:10px; color:var(--paper-3);
          font-family:var(--ff-mono);
          font-variant-numeric: tabular-nums;
          letter-spacing: var(--track-wide);
        }
        .sp-card-arrow { color:var(--paper-3); flex-shrink:0; margin-right:6px; }

        .sp-card-actions {
          display:flex; align-items:center; gap:6px;
          padding:0 18px;
          box-shadow: inset 1px 0 0 var(--rule-0);
          height:100%;
        }
        .sp-delete-btn {
          background:transparent; border:none;
          color:var(--paper-3); cursor:pointer;
          padding:8px; border-radius:var(--r-1);
          transition: color var(--dur-quick) var(--ease-snap),
                      background var(--dur-quick) var(--ease-snap);
        }
        .sp-delete-btn:hover {
          color: var(--flame);
          background: color-mix(in srgb, var(--flame) 8%, transparent);
        }
        .sp-confirm-text {
          font-family: var(--ff-ui); font-size: 10px;
          letter-spacing: var(--track-wider); text-transform: uppercase;
          color: var(--flame); font-weight: var(--w-mid);
        }
        .sp-confirm-yes {
          padding: 4px 12px;
          background: var(--flame); color: #0b0a08;
          border: none; border-radius: var(--r-pill);
          font-size: 10px; font-weight: var(--w-strong);
          letter-spacing: var(--track-wide); text-transform: uppercase;
          font-family: var(--ff-ui); cursor: pointer;
        }
        .sp-confirm-yes:disabled { opacity: 0.5; }
        .sp-confirm-no {
          padding: 4px 12px;
          background: transparent; color: var(--paper-2);
          border: none; border-radius: var(--r-pill);
          box-shadow: var(--shadow-inset-hairline);
          font-size: 10px; letter-spacing: var(--track-wide); text-transform: uppercase;
          font-family: var(--ff-ui); cursor: pointer;
        }

        .sp-files-section, .sp-content-section { margin-bottom:28px; }
        .sp-label {
          font-family: var(--ff-ui); font-size: 10px; font-weight: var(--w-mid);
          letter-spacing: var(--track-wider); text-transform: uppercase;
          color: var(--paper-3); margin-bottom: 12px;
        }
        .sp-file-list { display:flex; flex-direction:column; gap:2px; }
        .sp-file-item {
          display:flex; align-items:center; gap:10px;
          padding:8px 14px; font-size:12px;
          color: var(--paper-2);
          font-family: var(--ff-mono);
          background: var(--ink-1);
          border-radius: var(--r-1);
          box-shadow: var(--shadow-inset-hairline);
        }
        .sp-file-item svg { color: var(--paper-3); flex-shrink: 0; }
        .sp-markdown {
          font-size: 12.5px; line-height: 1.7;
          color: var(--paper-1);
          font-family: var(--ff-mono);
          background: var(--ink-1);
          border: none;
          border-radius: var(--r-2);
          box-shadow: var(--shadow-inset-hairline);
          padding: 20px;
          white-space: pre-wrap; word-break: break-word; overflow-x: auto;
          margin: 0;
        }
      `}</style>
    </div>
  );
}
