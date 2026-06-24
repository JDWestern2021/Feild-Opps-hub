/**
 * J&D FieldHub — Safety Module Shared Library
 * Include this on every safety form page.
 */
(function (W) {
  'use strict';
  const S = W.Safety = {};

  // ─────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────
  S.esc     = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  S.todayISO = () => new Date().toISOString().slice(0, 10);
  S.nowISO   = () => new Date().toISOString();
  S.fmtDate  = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-CA') : '—';
  S.fmtDT    = iso => iso ? new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  S.uid      = () => Math.random().toString(36).slice(2, 9);

  // ─────────────────────────────────────────────────────────────
  // FORM TYPE REGISTRY
  // ─────────────────────────────────────────────────────────────
  S.FORM_TYPES = {
    hazard_assessment:   { label: 'Hazard Assessment (FLHA)',       short: 'FLHA', icon: '⚠️',  group: 'Pre-Work',    phase: 1, url: 'safety-form-hazard.html' },
    fall_protection:     { label: 'Fall Protection Inspection',     short: 'FP',   icon: '🪝',  group: 'Inspections', phase: 1, url: 'safety-form-fall.html' },
    aerial_lift:         { label: 'Aerial / EWP Pre-Use',           short: 'AWP',  icon: '🏗',  group: 'Inspections', phase: 2, url: 'safety-form-aerial-lift.html' },
    vehicle_inspection:  { label: 'Vehicle Pre-Use Inspection',     short: 'VEH',  icon: '🚛',  group: 'Inspections', phase: 2, url: null },
    safety_meeting:      { label: 'Safety Meeting Record',          short: 'MTG',  icon: '👥',  group: 'Pre-Work',    phase: 3, url: 'safety-form-safety-meeting.html' },
    near_miss:           { label: 'Near Miss Report',               short: 'NM',   icon: '🔍',  group: 'Reporting',   phase: 3, url: 'safety-form-near-miss.html' },
    corrective_action:   { label: 'Corrective Action Notice',       short: 'CAN',  icon: '📋',  group: 'Admin',       phase: 3, url: null },
    erp:                 { label: 'Emergency Response Plan',        short: 'ERP',  icon: '🚨',  group: 'Pre-Work',    phase: 3, url: 'safety-form-erp.html' },
    incident_report:     { label: 'Incident Report',                short: 'IR',   icon: '🩺',  group: 'Reporting',   phase: 4, url: 'safety-form-incident-report.html' },
    forklift_inspection: { label: 'Forklift Pre-Use Checklist',     short: 'FL',   icon: '🚜',  group: 'Inspections', phase: 5, url: null },
    skid_steer:          { label: 'Skid Steer / Small Engine',      short: 'SSE',  icon: '🔧',  group: 'Inspections', phase: 5, url: null },
    ojt_record:          { label: 'OJT / Competency Record',        short: 'OJT',  icon: '📚',  group: 'Admin',       phase: 6, url: null },
    emergency_review:    { label: 'Emergency Review Record',        short: 'ERR',  icon: '🔎',  group: 'Admin',       phase: 6, url: null },
    maint_equipment:     { label: 'Scheduled Maint. — Equipment',   short: 'ME',   icon: '⚙️',  group: 'Maintenance', phase: 7, url: null },
    maint_vehicle:       { label: 'Scheduled Truck Inspection',     short: 'STI',  icon: '🔩',  group: 'Maintenance', phase: 7, url: 'safety-form-truck-inspection.html' },
  };

  S.formLabel = type => S.FORM_TYPES[type]?.label  || type;
  S.formShort = type => S.FORM_TYPES[type]?.short   || type.slice(0, 4).toUpperCase();
  S.formIcon  = type => S.FORM_TYPES[type]?.icon    || '📄';
  S.formUrl   = type => S.FORM_TYPES[type]?.url     || null;

  // ─────────────────────────────────────────────────────────────
  // SIGNATURE PAD CLASS
  // ─────────────────────────────────────────────────────────────
  class SignaturePad {
    constructor(canvas) {
      this.canvas  = canvas;
      this.ctx     = canvas.getContext('2d');
      this._pts    = [];
      this._active = false;
      this._setup();
    }
    _setup() {
      const c = this.canvas;
      this.ctx.strokeStyle = '#111827';
      this.ctx.lineWidth   = 2.5;
      this.ctx.lineCap     = 'round';
      this.ctx.lineJoin    = 'round';
      c.addEventListener('pointerdown', e => {
        e.preventDefault();
        this._active = true;
        c.setPointerCapture(e.pointerId);
        const p = this._pt(e);
        this._pts = [p];
        this.ctx.beginPath();
        this.ctx.moveTo(p.x, p.y);
      }, { passive: false });
      c.addEventListener('pointermove', e => {
        if (!this._active) return;
        e.preventDefault();
        const p = this._pt(e);
        this._pts.push(p);
        if (this._pts.length >= 3) {
          const [a, b, c2] = this._pts.slice(-3);
          const mid = { x: (b.x + c2.x) / 2, y: (b.y + c2.y) / 2 };
          this.ctx.quadraticCurveTo(b.x, b.y, mid.x, mid.y);
          this.ctx.stroke();
          this.ctx.beginPath();
          this.ctx.moveTo(mid.x, mid.y);
        }
      }, { passive: false });
      ['pointerup', 'pointercancel'].forEach(ev =>
        c.addEventListener(ev, () => { this._active = false; })
      );
    }
    _pt(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    clear() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._pts = [];
    }
    isEmpty() {
      const d = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) return false;
      return true;
    }
    toDataURL() { return this.canvas.toDataURL('image/png'); }
  }

  // ── Signature Modal (injected once, reused) ──────────────────
  let _sigResolve = null;
  let _sigPad     = null;

  let _sigKnownName = null; // set when name is pre-known and field should be hidden

  function _ensureSigModal() {
    if (document.getElementById('sf-sig-overlay')) return;
    const el = document.createElement('div');
    el.id = 'sf-sig-overlay';
    el.className = 'sf-sig-overlay';
    el.innerHTML = `
      <div class="sf-sig-modal">
        <div class="sf-sig-header">
          <h3 id="sf-sig-title">Sign Here</h3>
          <button class="sf-sig-close" id="sf-sig-close">✕</button>
        </div>
        <input id="sf-sig-name" class="sf-sig-name" type="text" placeholder="Full name (required)"/>
        <div class="sf-sig-canvas-wrap">
          <canvas id="sf-sig-canvas" class="sf-sig-canvas" width="800" height="240"></canvas>
          <div class="sf-sig-line"></div>
          <p class="sf-sig-hint">Sign with your finger or mouse</p>
        </div>
        <div class="sf-sig-actions">
          <button class="btn btn-secondary" id="sf-sig-clear">Clear</button>
          <button class="btn btn-primary" id="sf-sig-confirm">Confirm Signature</button>
        </div>
      </div>`;
    document.body.appendChild(el);

    document.getElementById('sf-sig-clear').addEventListener('click', () => _sigPad && _sigPad.clear());
    document.getElementById('sf-sig-close').addEventListener('click', () => _sigDone(null));
    el.addEventListener('click', e => { if (e.target === el) _sigDone(null); });
    document.getElementById('sf-sig-confirm').addEventListener('click', () => {
      const nameField = document.getElementById('sf-sig-name');
      const name = _sigKnownName || nameField.value.trim();
      if (!name) { nameField.focus(); return; }
      if (!_sigPad || _sigPad.isEmpty()) { alert('Please sign before confirming.'); return; }
      _sigDone({ signer_name: name, signed_at: new Date().toISOString(), data_url: _sigPad.toDataURL() });
    });
  }

  function _sigDone(result) {
    const ov = document.getElementById('sf-sig-overlay');
    if (ov) ov.style.display = 'none';
    if (_sigResolve) { _sigResolve(result); _sigResolve = null; }
  }

  function _initSigCanvas() {
    const canvas = document.getElementById('sf-sig-canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.round(canvas.offsetWidth  * dpr) || 800;
    canvas.height = Math.round(canvas.offsetHeight * dpr) || 240;
    canvas.getContext('2d').scale(dpr, dpr);
    _sigPad = new SignaturePad(canvas);
  }

  S.openSignatureModal = function ({ prefillName = '', skipName = false } = {}) {
    _ensureSigModal();
    _sigKnownName = skipName ? prefillName : null;
    const nameField = document.getElementById('sf-sig-name');
    const title = document.getElementById('sf-sig-title');
    if (skipName) {
      nameField.style.display = 'none';
      if (title) title.textContent = prefillName ? `${prefillName} — Sign Here` : 'Sign Here';
    } else {
      nameField.style.display = '';
      nameField.value = prefillName;
      if (title) title.textContent = 'Sign Here';
    }
    const ov = document.getElementById('sf-sig-overlay');
    ov.style.display = 'flex';
    setTimeout(_initSigCanvas, 120);
    return new Promise(res => { _sigResolve = res; });
  };

  // ── Signature field rendered inside a form ───────────────────
  S.renderSignatureField = function ({ container, label = 'Signature', required = false, value = null, onChange }) {
    const id = 'sf-sig-' + S.uid();
    let _val = value;

    function render() {
      container.innerHTML = `
        <div class="sf-sig-field" id="${id}">
          <div class="sf-field-label">${S.esc(label)}${required ? ' <span class="sf-req">*</span>' : ''}</div>
          <div class="sf-sig-display">
            <div class="sf-sig-preview" id="${id}-preview">
              ${_val?.data_url ? `<img src="${S.esc(_val.data_url)}" alt="Signature"/>` : '<span class="sf-sig-empty">Not yet signed</span>'}
            </div>
            ${_val?.signer_name ? `<div class="sf-sig-meta">${S.esc(_val.signer_name)} — ${S.fmtDT(_val.signed_at)}</div>` : ''}
            <div style="display:flex;gap:8px;margin-top:6px;">
              <button class="btn btn-secondary btn-sm" id="${id}-btn">${_val?.data_url ? '✏️ Re-sign' : '✍️ Sign'}</button>
              ${_val?.data_url ? `<button class="btn btn-ghost btn-sm" id="${id}-clr">Clear</button>` : ''}
            </div>
          </div>
        </div>`;
      document.getElementById(`${id}-btn`).addEventListener('click', async () => {
        const result = await S.openSignatureModal({ prefillName: _val?.signer_name || '' });
        if (result) { _val = result; render(); if (onChange) onChange(_val); }
      });
      const clr = document.getElementById(`${id}-clr`);
      if (clr) clr.addEventListener('click', () => { _val = null; render(); if (onChange) onChange(null); });
    }

    render();
    return { getValue: () => _val };
  };

  // ─────────────────────────────────────────────────────────────
  // PASS / FAIL / N/A
  // ─────────────────────────────────────────────────────────────
  // items: [{id, label}]
  // values: { [id]: {state:'pass'|'fail'|'na', detail:'', photo_url:'', person:'', target_date:''} }
  S.renderPassFailSection = function ({ container, sectionId, items, values = {}, onChange, showPhoto = true }) {
    const cid = 'pfna-' + S.uid();
    container.innerHTML = `<div class="pfna-section" id="${cid}">` +
      items.map(item => {
        const v = values[item.id] || {};
        return `<div class="pfna-row" data-id="${S.esc(item.id)}">
          <div class="pfna-label-text">${S.esc(item.label)}</div>
          <div class="pfna-buttons">
            <button class="pfna-btn pfna-pass${v.state === 'pass' ? ' active' : ''}" data-val="pass">✓ Pass</button>
            <button class="pfna-btn pfna-fail${v.state === 'fail' ? ' active' : ''}" data-val="fail">✗ Fail</button>
            <button class="pfna-btn pfna-na${v.state === 'na' ? ' active' : ''}" data-val="na">N/A</button>
          </div>
          <div class="pfna-detail${v.state === 'fail' ? '' : ' hidden'}">
            <textarea class="pfna-detail-text form-control" placeholder="Describe the defect…" rows="2">${S.esc(v.detail || '')}</textarea>
            ${showPhoto ? '<button type="button" class="pfna-photo-btn btn btn-secondary btn-sm">📷 Add Photo</button>' : ''}
            <div class="pfna-sub-row">
              <input class="pfna-person form-control" type="text" placeholder="Person responsible" value="${S.esc(v.person || '')}"/>
              <input class="pfna-date form-control" type="date" value="${S.esc(v.target_date || '')}"/>
            </div>
            <div class="pfna-photo-thumb">${v.photo_url ? `<img src="${S.esc(v.photo_url)}" alt="Defect photo"/><button type="button" class="pfna-photo-remove">✕</button>` : ''}</div>
          </div>
        </div>`;
      }).join('') + '</div>';

    const sec = document.getElementById(cid);

    function getValues() {
      const out = {};
      sec.querySelectorAll('.pfna-row').forEach(row => {
        const active = row.querySelector('.pfna-btn.active');
        out[row.dataset.id] = {
          state:       active ? active.dataset.val : null,
          detail:      row.querySelector('.pfna-detail-text')?.value.trim() || '',
          person:      row.querySelector('.pfna-person')?.value.trim() || '',
          target_date: row.querySelector('.pfna-date')?.value || '',
          photo_url:   row.querySelector('.pfna-photo-thumb img')?.src || ''
        };
      });
      return out;
    }

    sec.addEventListener('click', async e => {
      const btn = e.target.closest('.pfna-btn');
      if (btn) {
        const row = btn.closest('.pfna-row');
        row.querySelectorAll('.pfna-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        row.querySelector('.pfna-detail').classList.toggle('hidden', btn.dataset.val !== 'fail');
        if (onChange) onChange(getValues());
        return;
      }
      const photoBtn = e.target.closest('.pfna-photo-btn');
      if (photoBtn) {
        const url = await S.capturePhoto();
        if (url) {
          const thumb = photoBtn.closest('.pfna-row').querySelector('.pfna-photo-thumb');
          thumb.innerHTML = `<img src="${S.esc(url)}" alt="Defect photo"/><button type="button" class="pfna-photo-remove">✕</button>`;
          if (onChange) onChange(getValues());
        }
        return;
      }
      if (e.target.closest('.pfna-photo-remove')) {
        e.target.closest('.pfna-photo-thumb').innerHTML = '';
        if (onChange) onChange(getValues());
      }
    });
    sec.addEventListener('input', () => { if (onChange) onChange(getValues()); });

    return { getValues, container: sec };
  };

  // ─────────────────────────────────────────────────────────────
  // GOOD / REQUIRES REPAIR / N/A
  // ─────────────────────────────────────────────────────────────
  S.renderGoodRepairSection = function ({ container, sectionId, items, values = {}, onChange }) {
    const cid = 'grna-' + S.uid();
    container.innerHTML = `<div class="pfna-section" id="${cid}">` +
      items.map(item => {
        const v = values[item.id] || {};
        return `<div class="grna-row" data-id="${S.esc(item.id)}">
          <div class="pfna-label-text">${S.esc(item.label)}</div>
          <div class="pfna-buttons">
            <button class="pfna-btn grna-good${v.state === 'good' ? ' active' : ''}" data-val="good">✓ Good</button>
            <button class="pfna-btn grna-repair${v.state === 'repair' ? ' active' : ''}" data-val="repair">⚠ Requires Repair</button>
            <button class="pfna-btn pfna-na${v.state === 'na' ? ' active' : ''}" data-val="na">N/A</button>
          </div>
          <div class="pfna-detail${v.state === 'repair' ? '' : ' hidden'}">
            <textarea class="pfna-detail-text form-control" placeholder="Describe defect / repair needed…" rows="2">${S.esc(v.detail || '')}</textarea>
            <button type="button" class="pfna-photo-btn btn btn-secondary btn-sm">📷 Add Photo</button>
            <div class="pfna-sub-row">
              <input class="pfna-person form-control" type="text" placeholder="Person responsible" value="${S.esc(v.person || '')}"/>
              <input class="pfna-date form-control" type="date" value="${S.esc(v.target_date || '')}"/>
            </div>
            <div class="pfna-photo-thumb">${v.photo_url ? `<img src="${S.esc(v.photo_url)}" alt="Photo"/><button type="button" class="pfna-photo-remove">✕</button>` : ''}</div>
          </div>
        </div>`;
      }).join('') + '</div>';

    const sec = document.getElementById(cid);

    function getValues() {
      const out = {};
      sec.querySelectorAll('.grna-row').forEach(row => {
        const active = row.querySelector('.pfna-btn.active');
        out[row.dataset.id] = {
          state:       active ? active.dataset.val : null,
          detail:      row.querySelector('.pfna-detail-text')?.value.trim() || '',
          person:      row.querySelector('.pfna-person')?.value.trim() || '',
          target_date: row.querySelector('.pfna-date')?.value || '',
          photo_url:   row.querySelector('.pfna-photo-thumb img')?.src || ''
        };
      });
      return out;
    }

    sec.addEventListener('click', async e => {
      const btn = e.target.closest('.pfna-btn');
      if (btn) {
        const row = btn.closest('.grna-row');
        row.querySelectorAll('.pfna-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        row.querySelector('.pfna-detail').classList.toggle('hidden', btn.dataset.val !== 'repair');
        if (onChange) onChange(getValues());
        return;
      }
      const photoBtn = e.target.closest('.pfna-photo-btn');
      if (photoBtn) {
        const url = await S.capturePhoto();
        if (url) {
          const thumb = photoBtn.closest('.grna-row').querySelector('.pfna-photo-thumb');
          thumb.innerHTML = `<img src="${S.esc(url)}" alt="Photo"/><button type="button" class="pfna-photo-remove">✕</button>`;
          if (onChange) onChange(getValues());
        }
        return;
      }
      if (e.target.closest('.pfna-photo-remove')) {
        e.target.closest('.pfna-photo-thumb').innerHTML = '';
        if (onChange) onChange(getValues());
      }
    });
    sec.addEventListener('input', () => { if (onChange) onChange(getValues()); });

    return { getValues, container: sec };
  };

  // ─────────────────────────────────────────────────────────────
  // RESULT BANNER
  // ─────────────────────────────────────────────────────────────
  const _BANNER_PRESETS = {
    inspection:        ['No Defects Found', 'Defects — Safe to Operate', 'Defects — Do Not Operate'],
    lift:              ['Safe to Operate', 'Out of Service'],
    fall_protection:   ['No Defects', 'Defects Corrected', 'Fall Protection Replaced', 'Out of Service'],
    equipment:         ['No Defects Found', 'Defects — Safe to Operate', 'Defects — Out of Service / Do Not Use'],
  };

  function _bannerClass(val) {
    if (!val) return 'gray';
    const v = val.toLowerCase();
    if (v.includes('no defect') || v.includes('safe to operate') || v === 'safe to operate') return 'green';
    if (v.includes('out of service') || v.includes('do not')) return 'red';
    return 'yellow';
  }

  S.renderResultBanner = function ({ container, preset = 'inspection', options = null, value = null, onChange }) {
    const opts = options || _BANNER_PRESETS[preset] || _BANNER_PRESETS.inspection;
    const id = 'banner-' + S.uid();
    let _val = value;
    container.innerHTML = `
      <div class="sf-result-banner" id="${id}">
        <div class="sf-field-label">Overall Result <span class="sf-req">*</span></div>
        <div class="sf-banner-options">
          ${opts.map(o => {
            const cls = o === _val ? ` sf-banner-active sf-banner-${_bannerClass(o)}` : '';
            return `<button type="button" class="sf-banner-opt${cls}" data-val="${S.esc(o)}">${S.esc(o)}</button>`;
          }).join('')}
        </div>
      </div>`;
    document.getElementById(id).addEventListener('click', e => {
      const btn = e.target.closest('.sf-banner-opt');
      if (!btn) return;
      document.getElementById(id).querySelectorAll('.sf-banner-opt').forEach(b => b.className = 'sf-banner-opt');
      btn.classList.add('sf-banner-active', 'sf-banner-' + _bannerClass(btn.dataset.val));
      _val = btn.dataset.val;
      if (onChange) onChange(_val);
    });
    return { getValue: () => _val };
  };

  // ─────────────────────────────────────────────────────────────
  // REPEATER
  // cols: [{key, label, type:'text'|'textarea'|'date'|'select', options:[]}]
  // ─────────────────────────────────────────────────────────────
  S.renderRepeater = function ({ container, id, cols, addLabel = 'Add Row', value = [], onChange, minRows = 0 }) {
    const cid = 'rep-' + id + '-' + S.uid();
    container.innerHTML = `
      <div class="sf-repeater" id="${cid}">
        <div class="sf-rep-rows"></div>
        <button type="button" class="btn btn-secondary btn-sm sf-rep-add">＋ ${S.esc(addLabel)}</button>
      </div>`;
    const wrap    = document.getElementById(cid);
    const rowsEl  = wrap.querySelector('.sf-rep-rows');
    let rows = value.length ? value.map(r => ({ ...r })) : [];
    while (rows.length < minRows) rows.push({});

    function buildInput(col, val) {
      const v = S.esc(val || '');
      if (col.type === 'select')
        return `<select class="form-control" data-key="${S.esc(col.key)}"><option value="">—</option>${(col.options || []).map(o => `<option${o === val ? ' selected' : ''}>${S.esc(o)}</option>`).join('')}</select>`;
      if (col.type === 'date')
        return `<input type="date" class="form-control" data-key="${S.esc(col.key)}" value="${v}"/>`;
      if (col.type === 'textarea')
        return `<textarea class="form-control" data-key="${S.esc(col.key)}" rows="2">${v}</textarea>`;
      return `<input type="text" class="form-control" data-key="${S.esc(col.key)}" value="${v}" placeholder="${S.esc(col.label)}"/>`;
    }

    function renderRows() {
      rowsEl.innerHTML = '';
      rows.forEach((row, i) => {
        const div = document.createElement('div');
        div.className = 'sf-rep-row';
        div.innerHTML = cols.map(col =>
          `<div class="sf-rep-cell"><label class="sf-rep-cell-label">${S.esc(col.label)}</label>${buildInput(col, row[col.key])}</div>`
        ).join('') + (rows.length > minRows ? `<button type="button" class="sf-rep-remove" title="Remove">✕</button>` : '');

        div.addEventListener('input',  e => { const k = e.target.dataset.key; if (k) { rows[i][k] = e.target.value; if (onChange) onChange([...rows]); } });
        div.addEventListener('change', e => { const k = e.target.dataset.key; if (k) { rows[i][k] = e.target.value; if (onChange) onChange([...rows]); } });
        const rm = div.querySelector('.sf-rep-remove');
        if (rm) rm.addEventListener('click', () => { rows.splice(i, 1); renderRows(); if (onChange) onChange([...rows]); });
        rowsEl.appendChild(div);
      });
    }

    wrap.querySelector('.sf-rep-add').addEventListener('click', () => { rows.push({}); renderRows(); if (onChange) onChange([...rows]); });
    renderRows();
    return { getValues: () => rows.map(r => ({ ...r })), setValue: v => { rows = v.map(r => ({ ...r })); renderRows(); } };
  };

  // ── Preset: Corrective Actions ──────────────────────────────
  S.CORRECTIVE_ACTION_COLS = [
    { key: 'action',          label: 'Action / Item',   type: 'text' },
    { key: 'assigned_to',     label: 'Assigned To',     type: 'text' },
    { key: 'due_date',        label: 'Due Date',        type: 'date' },
    { key: 'completion_date', label: 'Completed',       type: 'date' },
  ];
  S.renderCorrectiveActions = function ({ container, value = [], onChange }) {
    return S.renderRepeater({ container, id: 'ca', cols: S.CORRECTIVE_ACTION_COLS, addLabel: 'Add Corrective Action', value, onChange });
  };

  // ── Preset: Worker Sign-on ───────────────────────────────────
  // ── Team cache (fetched once per page load) ──────────────────
  S._teamCache = undefined;
  S._fetchTeam = async function () {
    if (S._teamCache !== undefined) return S._teamCache;
    try {
      const r = await fetch('/api/team-members');
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.includes('json')) S._teamCache = await r.json();
      else { S._teamCache = undefined; return []; }   // don't cache failures — allow retry
    } catch { S._teamCache = undefined; return []; }
    return S._teamCache || [];
  };

  // ── Worker sign-on with team picker ──────────────────────────
  // Each worker row: { user_id, name, role, signed_at, signature_data_url }
  // user_id = null for non-team (guest) workers
  S.renderWorkerSignOn = function ({ container, value = [], onChange }) {
    const uid = S.uid();
    const listId = 'wsign-list-' + uid;

    container.innerHTML = `
      <style>
        .wsign-list { display:flex; flex-direction:column; gap:10px; margin-bottom:12px; }
        .wsign-row { border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; }
        .wsign-row-info { display:flex; align-items:center; gap:10px; padding:10px 12px; background:#f9fafb; }
        .wsign-avatar { width:34px; height:34px; border-radius:50%; background:#374151; color:#fff; display:flex; align-items:center; justify-content:center; font-size:.85rem; font-weight:700; flex-shrink:0; }
        .wsign-name-wrap { flex:1; min-width:0; }
        .wsign-name { font-weight:700; font-size:.9rem; color:#111827; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .wsign-role { font-size:.75rem; color:#6b7280; }
        .wsign-team-badge { font-size:.68rem; background:#dbeafe; color:#1d4ed8; border-radius:4px; padding:2px 6px; flex-shrink:0; }
        .wsign-guest-badge { font-size:.68rem; background:#f3f4f6; color:#6b7280; border-radius:4px; padding:2px 6px; flex-shrink:0; }
        .wsign-sig-area { padding:10px 12px; border-top:1px solid #e5e7eb; background:#fff; }
        .wsign-sig-done { display:flex; align-items:center; gap:10px; }
        .wsign-sig-img { max-height:40px; border-bottom:1px solid #d1d5db; }
        .wsign-sig-meta { font-size:.72rem; color:#6b7280; }
        .wsign-btn-row { display:flex; gap:8px; flex-wrap:wrap; }
        .wsign-sign-btn { flex:1; padding:10px; background:#111827; color:#fff; border:none; border-radius:6px; font-weight:700; font-size:.88rem; cursor:pointer; min-height:44px; }
        .wsign-sign-btn:hover { background:#374151; }
        .wsign-notify-btn { padding:10px 14px; background:#fff; border:1px solid #d1d5db; border-radius:6px; font-size:.85rem; cursor:pointer; min-height:44px; }
        .wsign-remove-btn { width:34px; height:34px; border-radius:50%; background:transparent; border:1px solid #e5e7eb; color:#9ca3af; cursor:pointer; font-size:.9rem; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
        .wsign-remove-btn:hover { background:#fee2e2; border-color:#fca5a5; color:#dc2626; }
        .wsign-add-row { display:flex; gap:8px; flex-wrap:wrap; }
        .wsign-add-btn { flex:1; padding:12px; border:2px dashed #d1d5db; border-radius:8px; background:#fff; color:#374151; font-weight:600; font-size:.88rem; cursor:pointer; min-height:48px; }
        .wsign-add-btn:hover { border-color:#9ca3af; background:#f9fafb; }

        /* Team picker modal */
        .wsign-picker { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:9000; display:flex; align-items:flex-end; justify-content:center; }
        .wsign-picker-sheet { background:#fff; border-radius:16px 16px 0 0; width:100%; max-width:560px; max-height:80vh; display:flex; flex-direction:column; }
        .wsign-picker-head { padding:14px 16px; display:flex; align-items:center; gap:10px; border-bottom:1px solid #e5e7eb; }
        .wsign-picker-head h3 { flex:1; margin:0; font-size:1rem; }
        .wsign-picker-close { padding:4px 10px; border:1px solid #e5e7eb; border-radius:6px; background:#fff; cursor:pointer; font-size:.85rem; }
        .wsign-picker-search { padding:10px 16px; border-bottom:1px solid #e5e7eb; }
        .wsign-picker-search input { width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:.9rem; box-sizing:border-box; }
        .wsign-picker-list { overflow-y:auto; flex:1; }
        .wsign-picker-item { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid #f3f4f6; cursor:pointer; }
        .wsign-picker-item:hover { background:#f9fafb; }
        .wsign-picker-item:active { background:#f3f4f6; }
        .wsign-picker-av { width:36px; height:36px; border-radius:50%; background:#374151; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.9rem; flex-shrink:0; }
        .wsign-picker-name { font-weight:600; font-size:.9rem; color:#111827; }
        .wsign-picker-sub  { font-size:.75rem; color:#6b7280; }
        .wsign-picker-already { color:#9ca3af; font-size:.75rem; margin-left:auto; }

        /* Guest add modal */
        .wsign-guest-sheet { background:#fff; border-radius:16px 16px 0 0; width:100%; max-width:560px; padding:20px 16px 32px; }
        .wsign-guest-sheet h3 { margin:0 0 16px; font-size:1rem; }
        .wsign-guest-field { margin-bottom:12px; }
        .wsign-guest-label { display:block; font-size:.8rem; font-weight:600; color:#374151; margin-bottom:5px; }
        .wsign-guest-save { width:100%; padding:14px; background:#111827; color:#fff; border:none; border-radius:8px; font-weight:700; font-size:.95rem; cursor:pointer; margin-top:6px; }
      </style>
      <div class="wsign-list" id="${listId}"></div>
      <div class="wsign-add-row">
        <button type="button" class="wsign-add-btn" id="wsign-pick-${uid}">👤 Add Team Member</button>
        <button type="button" class="wsign-add-btn" id="wsign-guest-${uid}">＋ Add Non-Team Worker</button>
      </div>`;

    let workers = value.length ? value.map(w => ({...w})) : [];
    const listEl = document.getElementById(listId);

    function initials(name) { return (name||'?').split(' ').map(p=>p[0]).join('').toUpperCase().slice(0,2); }

    function renderWorkers() {
      listEl.innerHTML = '';
      workers.forEach((w, i) => {
        const row = document.createElement('div');
        row.className = 'wsign-row';
        const badge = w.user_id
          ? `<span class="wsign-team-badge">Team</span>`
          : `<span class="wsign-guest-badge">Guest</span>`;
        let sigHtml = '';
        if (w.signed_at && w.signature_data_url) {
          sigHtml = `<div class="wsign-sig-area"><div class="wsign-sig-done">
            <img src="${S.esc(w.signature_data_url)}" class="wsign-sig-img" alt="sig"/>
            <div class="wsign-sig-meta">Signed ${S.fmtDT(w.signed_at)}</div>
          </div></div>`;
        } else {
          const notifyBtn = w.user_id
            ? `<button type="button" class="wsign-notify-btn" data-idx="${i}" data-action="notify">🔔 Notify</button>`
            : '';
          sigHtml = `<div class="wsign-sig-area"><div class="wsign-btn-row">
            <button type="button" class="wsign-sign-btn" data-idx="${i}" data-action="sign">✍️ Sign Now</button>
            ${notifyBtn}
          </div></div>`;
        }
        row.innerHTML = `
          <div class="wsign-row-info">
            <div class="wsign-avatar">${initials(w.name)}</div>
            <div class="wsign-name-wrap">
              <div class="wsign-name">${S.esc(w.name)}</div>
              <div class="wsign-role">${S.esc(w.role || '')}</div>
            </div>
            ${badge}
            <button type="button" class="wsign-remove-btn" data-idx="${i}" data-action="remove" title="Remove">✕</button>
          </div>
          ${sigHtml}`;
        listEl.appendChild(row);
      });
    }

    listEl.addEventListener('click', async e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const i = parseInt(btn.dataset.idx);
      const action = btn.dataset.action;
      if (action === 'remove') {
        workers.splice(i, 1); renderWorkers(); if (onChange) onChange([...workers]); return;
      }
      if (action === 'sign') {
        const result = await S.openSignatureModal({ prefillName: workers[i].name, skipName: true });
        if (result) {
          workers[i].signed_at = result.signed_at;
          workers[i].signature_data_url = result.data_url;
          renderWorkers(); if (onChange) onChange([...workers]);
        }
        return;
      }
      if (action === 'notify') {
        // Mark as notification pending — the server pending-signatures panel picks it up
        btn.textContent = '✓ Will be notified';
        btn.disabled = true;
        return;
      }
    });

    // ── Team picker (multi-select with Select All) ────────────
    document.getElementById('wsign-pick-' + uid).addEventListener('click', async () => {
      const team = await S._fetchTeam();
      const alreadyIds = new Set(workers.filter(w=>w.user_id).map(w=>String(w.user_id)));
      const selected  = new Set(); // uid strings checked in this session

      const modal = document.createElement('div');
      modal.className = 'wsign-picker';
      modal.innerHTML = `
        <div class="wsign-picker-sheet" style="display:flex;flex-direction:column;max-height:85vh;">
          <div class="wsign-picker-head">
            <h3>Add Team Members</h3>
            <button type="button" class="wsign-picker-close">Close</button>
          </div>
          <div style="padding:10px 16px;border-bottom:1px solid #e5e7eb;display:flex;gap:8px;align-items:center;">
            <input type="text" placeholder="Search by name…" style="flex:1;padding:9px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:.9rem;box-sizing:border-box;" autofocus/>
            <button type="button" id="wsign-select-all" style="padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;font-size:.82rem;font-weight:700;cursor:pointer;white-space:nowrap;color:#374151;">Select All</button>
          </div>
          <div class="wsign-picker-list" style="flex:1;overflow-y:auto;">
            ${team.map(u => {
              const already = alreadyIds.has(String(u.id));
              return `<div class="wsign-picker-item" data-uid="${S.esc(u.id)}" data-name="${S.esc(u.name)}" style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #f3f4f6;cursor:${already?'default':'pointer'};opacity:${already?'.45':'1'};">
                <div style="width:22px;height:22px;border:2px solid ${already?'#d1d5db':'#d1d5db'};border-radius:6px;background:#fff;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px;" class="wsign-chk">${already?'✓':''}</div>
                <div class="wsign-picker-av">${initials(u.name)}</div>
                <div style="flex:1;min-width:0;">
                  <div class="wsign-picker-name">${S.esc(u.name)}</div>
                  <div class="wsign-picker-sub">${S.esc(u.email||'')}</div>
                </div>
                ${already ? '<span class="wsign-picker-already">Added</span>' : ''}
              </div>`;
            }).join('')}
          </div>
          <div style="padding:12px 16px;border-top:1px solid #e5e7eb;display:flex;gap:10px;">
            <button type="button" id="wsign-confirm" style="flex:1;padding:14px;background:#F47920;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:.95rem;cursor:pointer;">Add Selected (0)</button>
            <button type="button" class="wsign-picker-close" style="padding:14px 18px;background:#f3f4f6;border:none;border-radius:10px;font-weight:600;font-size:.9rem;cursor:pointer;color:#374151;">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(modal);

      const confirmBtn = modal.querySelector('#wsign-confirm');
      const selectAllBtn = modal.querySelector('#wsign-select-all');
      const searchInput = modal.querySelector('input[type="text"]');

      function updateConfirmBtn() {
        confirmBtn.textContent = `Add Selected (${selected.size})`;
        confirmBtn.style.opacity = selected.size ? '1' : '.5';
      }

      function toggleItem(item) {
        if (alreadyIds.has(item.dataset.uid)) return;
        const uid2 = item.dataset.uid;
        const chk  = item.querySelector('.wsign-chk');
        if (selected.has(uid2)) {
          selected.delete(uid2);
          chk.textContent = '';
          chk.style.background = '#fff';
          chk.style.borderColor = '#d1d5db';
          item.style.background = '';
        } else {
          selected.add(uid2);
          chk.textContent = '✓';
          chk.style.background = '#F47920';
          chk.style.borderColor = '#F47920';
          chk.style.color = '#fff';
          item.style.background = '#fff7ed';
        }
        updateConfirmBtn();
      }

      modal.querySelector('.wsign-picker-list').addEventListener('click', e => {
        const item = e.target.closest('.wsign-picker-item');
        if (item) toggleItem(item);
      });

      selectAllBtn.addEventListener('click', () => {
        const visible = [...modal.querySelectorAll('.wsign-picker-item')].filter(el => el.style.display !== 'none' && !alreadyIds.has(el.dataset.uid));
        const allChecked = visible.every(el => selected.has(el.dataset.uid));
        visible.forEach(el => {
          if (allChecked) {
            selected.delete(el.dataset.uid);
            const chk = el.querySelector('.wsign-chk');
            chk.textContent = ''; chk.style.background = '#fff'; chk.style.borderColor = '#d1d5db'; chk.style.color = '';
            el.style.background = '';
          } else if (!selected.has(el.dataset.uid)) {
            toggleItem(el);
          }
        });
        selectAllBtn.textContent = allChecked ? 'Select All' : 'Deselect All';
        updateConfirmBtn();
      });

      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        modal.querySelectorAll('.wsign-picker-item').forEach(el => {
          el.style.display = el.dataset.name.toLowerCase().includes(q) ? '' : 'none';
        });
        const visible = [...modal.querySelectorAll('.wsign-picker-item')].filter(el => el.style.display !== 'none' && !alreadyIds.has(el.dataset.uid));
        selectAllBtn.textContent = visible.length && visible.every(el => selected.has(el.dataset.uid)) ? 'Deselect All' : 'Select All';
      });

      modal.querySelectorAll('.wsign-picker-close').forEach(b => b.addEventListener('click', () => modal.remove()));

      confirmBtn.addEventListener('click', () => {
        if (!selected.size) return;
        const teamMap = Object.fromEntries(team.map(u => [String(u.id), u]));
        selected.forEach(uid2 => {
          if (!workers.some(w => String(w.user_id) === uid2)) {
            const u = teamMap[uid2];
            if (u) workers.push({ user_id: uid2, name: u.name, role: '' });
          }
        });
        renderWorkers(); if (onChange) onChange([...workers]);
        modal.remove();
      });
    });

    // ── Guest / non-team picker ───────────────────────────────
    document.getElementById('wsign-guest-' + uid).addEventListener('click', () => {
      const modal = document.createElement('div');
      modal.className = 'wsign-picker';
      modal.innerHTML = `
        <div class="wsign-picker-sheet wsign-guest-sheet">
          <h3>Add Non-Team Worker</h3>
          <div class="wsign-guest-field">
            <label class="wsign-guest-label">Name <span style="color:#ef4444">*</span></label>
            <input type="text" id="guest-name-inp" class="form-control" placeholder="Full name"/>
          </div>
          <div class="wsign-guest-field">
            <label class="wsign-guest-label">Role / Company</label>
            <input type="text" id="guest-role-inp" class="form-control" placeholder="e.g. Electrician, Sub-contractor…"/>
          </div>
          <button type="button" class="wsign-guest-save" id="guest-save-btn">Add Worker</button>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
      document.getElementById('guest-name-inp').focus();
      document.getElementById('guest-save-btn').addEventListener('click', () => {
        const name = document.getElementById('guest-name-inp').value.trim();
        if (!name) { S.toast('Name is required','error'); return; }
        const role = document.getElementById('guest-role-inp').value.trim();
        workers.push({ user_id: null, name, role });
        renderWorkers(); if (onChange) onChange([...workers]);
        modal.remove();
      });
    });

    renderWorkers();
    return {
      getValues: () => workers.map(w => ({...w})),
      setValue:  v  => { workers = v.map(w=>({...w})); renderWorkers(); }
    };
  };

  // ── Preset: Hazards ─────────────────────────────────────────
  S.HAZARD_COLS = [
    { key: 'hazard',  label: 'Hazard',          type: 'text' },
    { key: 'risk',    label: 'Risk Level',       type: 'select', options: ['Low', 'Medium', 'High', 'Critical'] },
    { key: 'control', label: 'Control Measure',  type: 'text' },
  ];
  S.renderHazardRepeater = function ({ container, value = [], onChange }) {
    return S.renderRepeater({ container, id: 'hazards', cols: S.HAZARD_COLS, addLabel: 'Add Hazard', value, onChange, minRows: 1 });
  };

  // ─────────────────────────────────────────────────────────────
  // GEO FIELD
  // ─────────────────────────────────────────────────────────────
  S.renderGeoField = function ({ container, label = 'Site Location', value = null, onChange }) {
    const id = 'geo-' + S.uid();
    let _val = value;
    container.innerHTML = `
      <div class="sf-geo" id="${id}">
        <div class="sf-field-label">${S.esc(label)}</div>
        <div class="sf-geo-row">
          <button type="button" class="btn btn-secondary btn-sm" id="${id}-btn">📍 Capture Location</button>
          <span class="sf-geo-status" id="${id}-status">${_val?.address ? '' : 'Not captured'}</span>
        </div>
        <input class="form-control sf-geo-addr" id="${id}-addr" type="text" placeholder="Address (editable)"
               value="${S.esc(_val?.address || '')}" style="${_val?.address ? '' : 'display:none;'}"/>
        <input type="hidden" id="${id}-lat" value="${_val?.lat || ''}"/>
        <input type="hidden" id="${id}-lng" value="${_val?.lng || ''}"/>
      </div>`;

    document.getElementById(`${id}-btn`).addEventListener('click', async () => {
      const btn = document.getElementById(`${id}-btn`);
      btn.textContent = '⏳ Getting location…'; btn.disabled = true;
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 12000, enableHighAccuracy: true })
        );
        const { latitude: lat, longitude: lng } = pos.coords;
        let addr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, { headers: { 'User-Agent': 'JDFieldHub/1.0' } });
          const d = await r.json();
          if (d.display_name) addr = d.display_name;
        } catch {}
        _val = { lat, lng, address: addr };
        document.getElementById(`${id}-lat`).value = lat;
        document.getElementById(`${id}-lng`).value = lng;
        const addrEl = document.getElementById(`${id}-addr`);
        addrEl.value = addr; addrEl.style.display = '';
        document.getElementById(`${id}-status`).textContent = '';
        if (onChange) onChange(_val);
      } catch {
        document.getElementById(`${id}-status`).textContent = '⚠ Could not get location — type address manually';
        const addrEl = document.getElementById(`${id}-addr`);
        addrEl.style.display = '';
      }
      btn.textContent = '📍 Capture Location'; btn.disabled = false;
    });

    document.getElementById(`${id}-addr`).addEventListener('input', e => {
      if (!_val) _val = {};
      _val.address = e.target.value;
      if (onChange) onChange(_val);
    });

    return { getValue: () => _val };
  };

  // ─────────────────────────────────────────────────────────────
  // PHOTO FIELD
  // ─────────────────────────────────────────────────────────────
  S.renderPhotoField = function ({ container, label = 'Photos', value = [], onChange, max = 5 }) {
    const id = 'pf-' + S.uid();
    let _urls = [...(value || [])];
    container.innerHTML = `
      <div class="sf-photo-field" id="${id}">
        <div class="sf-field-label">${S.esc(label)}</div>
        <div class="sf-photo-grid" id="${id}-grid"></div>
        <label class="btn btn-secondary btn-sm sf-photo-add-btn" id="${id}-lbl" style="cursor:pointer;">
          📷 Add Photo
          <input type="file" accept="image/*" capture="environment" multiple style="display:none;" id="${id}-input"/>
        </label>
        <div class="sf-photo-progress" id="${id}-prog" style="display:none;">Uploading…</div>
      </div>`;

    function renderGrid() {
      const grid = document.getElementById(`${id}-grid`);
      grid.innerHTML = _urls.map((url, i) => `
        <div class="sf-photo-thumb">
          <img src="${S.esc(url)}" alt="Photo ${i + 1}"/>
          <button type="button" class="sf-photo-remove" data-idx="${i}">✕</button>
        </div>`).join('');
      grid.querySelectorAll('.sf-photo-remove').forEach(btn => {
        btn.addEventListener('click', () => { _urls.splice(parseInt(btn.dataset.idx), 1); renderGrid(); if (onChange) onChange([..._urls]); });
      });
      const lbl = document.getElementById(`${id}-lbl`);
      if (lbl) lbl.style.display = _urls.length >= max ? 'none' : '';
    }

    document.getElementById(`${id}-input`).addEventListener('change', async e => {
      const files = Array.from(e.target.files).slice(0, max - _urls.length);
      document.getElementById(`${id}-prog`).style.display = '';
      for (const file of files) {
        try {
          _urls.push(await S._uploadPhoto(file));
        } catch {
          _urls.push(await S._fileToDataURL(file));
        }
      }
      document.getElementById(`${id}-prog`).style.display = 'none';
      renderGrid();
      if (onChange) onChange([..._urls]);
      e.target.value = '';
    });

    renderGrid();
    return { getValue: () => [..._urls], setValue: v => { _urls = [...v]; renderGrid(); } };
  };

  S._uploadPhoto = async function (file) {
    const fd = new FormData();
    fd.append('photo', file);
    const r = await fetch('/api/uploads/safety-photo', { method: 'POST', body: fd });
    if (!r.ok) throw new Error('Upload failed');
    return (await r.json()).url;
  };

  S._fileToDataURL = file => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload  = () => res(fr.result);
    fr.onerror = () => rej(new Error('FileReader failed'));
    fr.readAsDataURL(file);
  });

  // Single photo capture (used by pass_fail_na photo button)
  S.capturePhoto = function () {
    return new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
      inp.onchange = async () => {
        if (!inp.files[0]) { resolve(null); return; }
        try   { resolve(await S._uploadPhoto(inp.files[0])); }
        catch { resolve(await S._fileToDataURL(inp.files[0])); }
      };
      inp.click();
    });
  };

  // ─────────────────────────────────────────────────────────────
  // PEOPLE PICKER
  // ─────────────────────────────────────────────────────────────
  // Returns a <select> element populated from the users list
  S.buildPeoplePicker = function (users, { value = '', placeholder = 'Select person', required = false } = {}) {
    const sel = document.createElement('select');
    sel.className = 'form-control';
    if (required) sel.required = true;
    sel.innerHTML = `<option value="">${S.esc(placeholder)}</option>` +
      users.map(u => `<option value="${u.id}"${String(u.id) === String(value) ? ' selected' : ''}>${S.esc(u.name)}</option>`).join('');
    return sel;
  };

  // Convenience: fetch all active users and return list
  S.loadUsers = async function () {
    const r = await fetch('/api/users');
    if (!r.ok) return [];
    return await r.json();
  };

  // ─────────────────────────────────────────────────────────────
  // DRAFT MANAGER
  // ─────────────────────────────────────────────────────────────
  S.DraftManager = {
    _key: (type, id) => `sf_draft_${type}_${id || 'new'}`,
    save(type, id, data) {
      try {
        localStorage.setItem(this._key(type, id), JSON.stringify({ ...data, _saved_at: new Date().toISOString() }));
      } catch (e) { console.warn('DraftManager.save:', e); }
    },
    load(type, id) {
      try { return JSON.parse(localStorage.getItem(this._key(type, id))); } catch { return null; }
    },
    remove(type, id) { localStorage.removeItem(this._key(type, id)); },
    list() {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('sf_draft_')) continue;
        try {
          const d = JSON.parse(localStorage.getItem(k));
          const parts = k.split('_');        // ['sf','draft','formtype','id']
          out.push({ key: k, form_type: parts[2], form_id: parts[3], ...d });
        } catch {}
      }
      return out.sort((a, b) => (b._saved_at > a._saved_at ? 1 : -1));
    }
  };

  // ─────────────────────────────────────────────────────────────
  // OFFLINE QUEUE
  // ─────────────────────────────────────────────────────────────
  S.OfflineQueue = {
    _KEY: 'sf_offline_queue',
    enqueue(payload) {
      const q = this._read();
      q.push({ ...payload, _queued_at: new Date().toISOString(), _qid: Date.now() });
      this._write(q);
      this._syncBanner();
    },
    _read()   { try { return JSON.parse(localStorage.getItem(this._KEY)) || []; } catch { return []; } },
    _write(q) { try { localStorage.setItem(this._KEY, JSON.stringify(q)); } catch {} },
    count()   { return this._read().length; },
    async flush() {
      if (!navigator.onLine) return;
      const q = this._read();
      if (!q.length) return;
      const remaining = [];
      for (const item of q) {
        try {
          const r = await fetch('/api/safety', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
          if (!r.ok) remaining.push(item);
        } catch { remaining.push(item); }
      }
      this._write(remaining);
      this._syncBanner();
    },
    _syncBanner() {
      const n  = this.count();
      const el = document.getElementById('sf-offline-banner');
      if (!el) return;
      el.style.display = n > 0 ? 'flex' : 'none';
      const ct = el.querySelector('.sf-offline-count');
      if (ct) ct.textContent = `${n} form${n === 1 ? '' : 's'} queued — will submit when back online`;
    }
  };
  window.addEventListener('online', () => S.OfflineQueue.flush());

  // ─────────────────────────────────────────────────────────────
  // FORM SUBMISSION
  // ─────────────────────────────────────────────────────────────
  S.submitForm = async function ({ form_type, form_data, project_id, project_name, job_number, status = 'Submitted', existing_id = null }) {
    const payload = { form_type, form_data, project_id, project_name, job_number, status, date: form_data?.date || null };
    if (!navigator.onLine) {
      S.OfflineQueue.enqueue(payload);
      return { queued: true };
    }
    const url    = existing_id ? `/api/safety/${existing_id}` : '/api/safety';
    const method = existing_id ? 'PATCH' : 'POST';
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      let msg = 'Submission failed';
      try { msg = JSON.parse(text).error || msg; } catch {}
      if (r.status === 413) msg = 'Form is too large to submit (too many photos/signatures). Try reducing photo count.';
      if (r.status === 401) msg = 'You are not logged in. Please refresh the page and log in again.';
      if (r.status === 403) msg = 'You do not have permission to submit this form.';
      if (r.status === 400) msg = msg || 'Missing required field — check date and form type.';
      throw new Error(`${msg} (HTTP ${r.status})`);
    }
    return await r.json();
  };

  S.saveDraftToServer = async function ({ form_type, form_data, project_id, project_name, job_number, existing_id }) {
    if (!navigator.onLine) return null;
    if (existing_id) {
      await fetch(`/api/safety/${existing_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ form_data, project_id, project_name, job_number, status: 'Draft' })
      });
      return { id: existing_id };
    }
    const r = await fetch('/api/safety', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_type, form_data, project_id, project_name, job_number, status: 'Draft' })
    });
    if (!r.ok) return null;
    return await r.json();
  };

  // ─────────────────────────────────────────────────────────────
  // BRANDED PRINT
  // ─────────────────────────────────────────────────────────────
  S.printForm = function ({ title, subtitle = '', sections = [], meta = {} }) {
    const printed = new Date().toLocaleDateString('en-CA');
    const sectionHTML = sections.map(sec => `
      <div class="sfp-section">
        <div class="sfp-section-title">${S.esc(sec.title)}</div>
        <div class="sfp-fields">
          ${(sec.fields || []).map(f => `
            <div class="sfp-field${f.wide ? ' sfp-wide' : ''}">
              <div class="sfp-label">${S.esc(f.label)}</div>
              <div class="sfp-value">${f.html || S.esc(f.value || '—')}</div>
            </div>`).join('')}
          ${sec.html || ''}
        </div>
      </div>`).join('');

    let pa = document.getElementById('print-area');
    if (!pa) { pa = document.createElement('div'); pa.id = 'print-area'; document.body.appendChild(pa); }
    pa.innerHTML = `
      <div class="sfp-page">
        <div class="sfp-header">
          <div class="sfp-header-left">
            <img class="sfp-logo" src="/jd-logo.png" alt="J&D Logo"/>
            <div>
              <div class="sfp-company">J&amp;D WESTERN ELECTRIC LTD</div>
              <div class="sfp-tagline">Power &bull; Performance &bull; Peace of Mind</div>
              <div class="sfp-phone">587-343-4349 &nbsp;·&nbsp; jdwesternelectric.ca</div>
            </div>
          </div>
          <div class="sfp-header-right">
            <div class="sfp-form-title">${S.esc(title)}</div>
            ${subtitle ? `<div class="sfp-form-subtitle">${S.esc(subtitle)}</div>` : ''}
            ${meta.form_number ? `<div class="sfp-form-num">Form # ${S.esc(meta.form_number)}</div>` : ''}
          </div>
        </div>
        <div class="sfp-accent"></div>
        ${meta.project_name ? `<div class="sfp-project-bar">Project: ${S.esc(meta.project_name)}${meta.date ? ' &nbsp;·&nbsp; ' + S.esc(meta.date) : ''}</div>` : ''}
        ${sectionHTML}
        <div class="sfp-footer">
          <span>J&amp;D Western Electric Ltd &nbsp;·&nbsp; jdwesternelectric.ca</span>
          <span>Printed: ${printed}</span>
        </div>
      </div>`;
    setTimeout(() => {
      window.print();
      window.addEventListener('afterprint', () => { pa.innerHTML = ''; }, { once: true });
    }, 80);
  };

  // ─────────────────────────────────────────────────────────────
  // TOAST
  // ─────────────────────────────────────────────────────────────
  S.toast = function (msg, type = 'info', duration = 3500) {
    let wrap = document.getElementById('sf-toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'sf-toast-wrap';
      Object.assign(wrap.style, {
        position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
        zIndex: '9999', display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center'
      });
      document.body.appendChild(wrap);
    }
    const t = document.createElement('div');
    const bg = { info: '#1e40af', success: '#166534', error: '#991b1b', warning: '#92400e' }[type] || '#1e40af';
    Object.assign(t.style, {
      background: bg, color: '#fff', padding: '10px 20px', borderRadius: '8px',
      fontSize: '0.9rem', fontWeight: '600', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      maxWidth: '320px', textAlign: 'center', opacity: '1', transition: 'opacity .4s'
    });
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 400);
    }, duration);
  };

})(window);
