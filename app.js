/**
 * Crypsy — Initial Note Card Prototype (2019)
 */
(() => {
  const STORAGE_KEY = 'crypsy_notes_v0';
  let notes = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');

  const titleEl = document.getElementById('composerTitle');
  const descEl = document.getElementById('composerDescription');
  const saveBtn = document.getElementById('composerSaveBtn');
  const gridEl = document.getElementById('othersGrid');

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function saveNotes() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  }

  function render() {
    gridEl.innerHTML = notes
      .map(
        (n) => `
      <article class="note-card" data-note-id="${n.id}">
        <div class="note-card-header">
          <h3 class="note-card-title">${escapeHtml(n.title || 'Untitled')}</h3>
        </div>
        <div class="note-card-desc">${escapeHtml(n.description)}</div>
        <div class="note-card-footer">
          <button type="button" class="icon-btn danger-btn" data-delete="${n.id}">&times;</button>
        </div>
      </article>`
      )
      .join('');
  }

  saveBtn.addEventListener('click', () => {
    const title = titleEl.value.trim();
    const description = descEl.value.trim();
    if (!title && !description) return;
    notes.unshift({
      id: 'note-' + Date.now(),
      title,
      description,
      updatedAt: Date.now(),
    });
    titleEl.value = '';
    descEl.value = '';
    saveNotes();
    render();
  });

  gridEl.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete]');
    if (del) {
      const id = del.getAttribute('data-delete');
      notes = notes.filter((n) => n.id !== id);
      saveNotes();
      render();
    }
  });

  render();
})();
