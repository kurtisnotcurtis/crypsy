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
          <h3 class="note-card-title">${escapeHtml(n.title || 'Untitled')}</