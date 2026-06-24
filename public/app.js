(() => {
  const $ = id => document.getElementById(id);

  const uploadSection  = $('upload-section');
  const loadingSection = $('loading-section');
  const resultSection  = $('result-section');
  const dropZone       = $('drop-zone');
  const fileInput      = $('file-input');
  const asciiOutput    = $('ascii-output');
  const statsBar       = $('stats-bar');
  const shareBtn       = $('share-btn');
  const copyArtBtn     = $('copy-art-btn');
  const resetBtn       = $('reset-btn');
  const shareFeedback  = $('share-feedback');
  const uploadError    = $('upload-error');

  let currentShareId = null;

  // ── State helpers ──────────────────────────────────────────────

  function showSection(name) {
    uploadSection.hidden  = name !== 'upload';
    loadingSection.hidden = name !== 'loading';
    resultSection.hidden  = name !== 'result';
  }

  function showError(msg) {
    uploadError.textContent = `✖ ${msg}`;
    uploadError.hidden = false;
  }

  function clearError() {
    uploadError.hidden = true;
    uploadError.textContent = '';
  }

  // ── Stats rendering ────────────────────────────────────────────

  function renderStats(s) {
    const parts = [];
    parts.push(`<span><strong>${s.distanceFmt}</strong> distance</span>`);
    if (s.elevGainFmt) parts.push(`<span><strong>${s.elevGainFmt}</strong> gain</span>`);
    if (s.elevLossFmt) parts.push(`<span><strong>${s.elevLossFmt}</strong> loss</span>`);
    if (s.durationFmt) parts.push(`<span><strong>${s.durationFmt}</strong> moving time</span>`);
    parts.push(`<span><strong>${s.pointCount.toLocaleString()}</strong> track points</span>`);
    statsBar.innerHTML = parts.join('');
  }

  // ── Result display ─────────────────────────────────────────────

  function displayResult(data) {
    currentShareId = data.id;
    renderStats({ ...data.stats, pointCount: data.pointCount });
    if (data.format === 'html') {
      asciiOutput.innerHTML = data.ascii;
    } else {
      asciiOutput.textContent = data.ascii;
    }
    showSection('result');
    history.replaceState({}, '', `?s=${data.id}`);
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── Upload ─────────────────────────────────────────────────────

  async function uploadFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.gpx')) {
      showError('Please upload a .gpx file.');
      return;
    }

    clearError();
    showSection('loading');

    const formData = new FormData();
    formData.append('gpx', file);

    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await resp.json();

      if (!resp.ok) {
        showSection('upload');
        showError(data.error || 'Upload failed.');
        return;
      }

      displayResult(data);
    } catch {
      showSection('upload');
      showError('Network error — is the server running?');
    }
  }

  // ── Drag & drop ────────────────────────────────────────────────

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  // ── Share button ───────────────────────────────────────────────

  shareBtn.addEventListener('click', async () => {
    if (!currentShareId) return;
    const url = `${location.origin}${location.pathname}?s=${currentShareId}`;
    try {
      await navigator.clipboard.writeText(url);
      showFeedback('link copied!');
    } catch {
      prompt('Copy this link:', url);
    }
  });

  copyArtBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(asciiOutput.textContent);
      showFeedback('ascii art copied!');
    } catch {
      showFeedback('select the map above and copy manually');
    }
  });

  resetBtn.addEventListener('click', () => {
    currentShareId = null;
    fileInput.value = '';
    asciiOutput.textContent = '';
    statsBar.innerHTML = '';
    clearError();
    history.replaceState({}, '', location.pathname);
    showSection('upload');
  });

  function showFeedback(msg) {
    shareFeedback.textContent = `✔ ${msg}`;
    shareFeedback.hidden = false;
    shareFeedback.style.animation = 'none';
    void shareFeedback.offsetWidth; // reflow to restart animation
    shareFeedback.style.animation = '';
    setTimeout(() => { shareFeedback.hidden = true; }, 2600);
  }

  // ── Load shared route on page load ─────────────────────────────

  async function loadSharedRoute(id) {
    showSection('loading');
    try {
      const resp = await fetch(`/api/share/${id}`);
      const data = await resp.json();
      if (!resp.ok) {
        showSection('upload');
        showError(data.error || 'Route not found.');
        return;
      }
      displayResult(data);
    } catch {
      showSection('upload');
      showError('Could not load shared route.');
    }
  }

  const params = new URLSearchParams(location.search);
  const shareId = params.get('s');
  if (shareId && /^[a-f0-9]+$/i.test(shareId)) {
    loadSharedRoute(shareId);
  } else {
    showSection('upload');
  }
})();
