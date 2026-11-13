/* ==========================================================================
   cork_board — sticky notes, client side only.
   No build step, no framework, no server: notes live in localStorage and can
   be written to / read from a plain JSON file on the computer.
   ========================================================================== */

(function () {
  "use strict";

  var STORAGE_KEY = "cork_board.notes.v1";
  var THEME_KEY = "cork_board.theme";
  var FILE_NAME = "cork_board.json";
  var FILE_FORMAT = "cork_board/v1";

  /* ------------------------------------------------------------- state --- */

  var notes = [];                 // [{ id, text, createdAt, updatedAt }]
  var selected = new Set();       // ids checked in selection mode
  var selecting = false;          // selection mode on/off
  var editingId = null;           // note currently open in its editor
  var editingIsNew = false;       // discard it on Esc if it was never written
  var suppressBlurCommit = false; // Esc / re-render must not auto-save
  var fileHandle = null;          // File System Access handle, when granted

  /* ---------------------------------------------------------- elements --- */

  var el = {
    board: document.querySelector(".board"),
    list: document.getElementById("notes"),
    empty: document.getElementById("empty"),
    template: document.getElementById("noteTemplate"),
    status: document.getElementById("status"),
    toast: document.getElementById("toast"),
    fileInput: document.getElementById("fileInput"),

    btnNew: document.getElementById("btnNew"),
    btnEmptyNew: document.getElementById("btnEmptyNew"),
    btnSelect: document.getElementById("btnSelect"),
    btnDeleteAll: document.getElementById("btnDeleteAll"),
    btnTheme: document.getElementById("btnTheme"),
    btnSave: document.getElementById("btnSave"),
    btnOpen: document.getElementById("btnOpen"),

    selectionBar: document.getElementById("selectionBar"),
    selectionCount: document.getElementById("selectionCount"),
    btnSelectAll: document.getElementById("btnSelectAll"),
    btnClearSelection: document.getElementById("btnClearSelection"),
    btnDeleteSelected: document.getElementById("btnDeleteSelected"),
    btnExitSelect: document.getElementById("btnExitSelect"),

    dialog: document.getElementById("confirmDialog"),
    dialogTitle: document.getElementById("confirmTitle"),
    dialogText: document.getElementById("confirmText"),
    dialogOk: document.getElementById("confirmOk"),
    dialogExtra: document.getElementById("confirmExtra")
  };

  /* ----------------------------------------------------------- helpers --- */

  function uid() {
    return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function byId(id) {
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].id === id) return notes[i];
    }
    return null;
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  var dateFormat = new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  });

  function formatStamp(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : dateFormat.format(d);
  }

  var toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add("toast--visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove("toast--visible");
    }, 2200);
  }

  /** Promise-based confirm built on <dialog>. Resolves "confirm" | "extra" | "cancel". */
  function ask(options) {
    el.dialogTitle.textContent = options.title;
    el.dialogText.textContent = options.text || "";
    el.dialogOk.textContent = options.okLabel || "Delete";
    el.dialogOk.classList.toggle("confirm__btn--danger", options.danger !== false);

    if (options.extraLabel) {
      el.dialogExtra.textContent = options.extraLabel;
      el.dialogExtra.hidden = false;
    } else {
      el.dialogExtra.hidden = true;
    }

    return new Promise(function (resolve) {
      function done() {
        el.dialog.removeEventListener("close", done);
        resolve(el.dialog.returnValue || "cancel");
      }
      el.dialog.addEventListener("close", done);
      el.dialog.returnValue = "";
      el.dialog.showModal();
    });
  }

  /* --------------------------------------------------------- storage --- */

  function load() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      toast("Local storage is blocked in this browser.");
      return [];
    }
    if (!raw) return [];
    try {
      return normalise(JSON.parse(raw));
    } catch (err) {
      toast("Saved notes could not be read.");
      return [];
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch (err) {
      toast("Could not save — local storage is full or blocked.");
    }
  }

  /** Accepts either a bare array of notes or an exported { notes: [...] } file. */
  function normalise(data) {
    var list = Array.isArray(data) ? data : (data && Array.isArray(data.notes) ? data.notes : null);
    if (!list) throw new Error("unrecognised shape");

    return list.map(function (item) {
      var now = new Date().toISOString();
      if (typeof item === "string") {
        return { id: uid(), text: item, createdAt: now, updatedAt: now };
      }
      return {
        id: typeof item.id === "string" && item.id ? item.id : uid(),
        text: typeof item.text === "string" ? item.text : "",
        createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now
      };
    });
  }

  /* ------------------------------------------------------------ theme --- */

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var dark = theme === "dark";
    el.btnTheme.setAttribute("aria-pressed", String(dark));
    el.btnTheme.title = dark ? "Switch to light mode" : "Switch to dark mode";
    var icon = el.btnTheme.querySelector("iconify-icon");
    if (icon) {
      icon.setAttribute("icon", dark ? "material-symbols:light-mode-outline"
                                     : "material-symbols:dark-mode-outline");
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* ignore */ }
  }

  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (err) { /* ignore */ }
    if (stored !== "dark" && stored !== "light") {
      stored = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark" : "light";
    }
    applyTheme(stored);
  }

  /* ----------------------------------------------------------- render --- */

  /** Bento sizing: longer notes claim more of the grid. */
  function spanFor(text) {
    var length = text.length;
    var lines = text ? text.split("\n").length : 0;
    if (length > 460 || lines > 14) return "big";
    if (length > 170) return "wide";
    if (lines > 8) return "tall";
    return "";
  }

  function render() {
    var fragment = document.createDocumentFragment();

    notes.forEach(function (note) {
      var li = el.template.content.firstElementChild.cloneNode(true);
      var span = spanFor(note.text);

      li.dataset.id = note.id;
      if (span) li.dataset.span = span;
      li.classList.toggle("note--selected", selected.has(note.id));

      li.querySelector(".note__text").textContent = note.text;

      var time = li.querySelector(".note__meta");
      time.dateTime = note.updatedAt;
      time.textContent = formatStamp(note.updatedAt);

      var checkbox = li.querySelector(".note__checkbox");
      checkbox.checked = selected.has(note.id);

      fragment.appendChild(li);
    });

    el.list.replaceChildren(fragment);
    el.empty.hidden = notes.length > 0;
    el.list.hidden = notes.length === 0;

    el.btnDeleteAll.disabled = notes.length === 0;
    el.btnSelect.disabled = notes.length === 0;
    el.btnSave.disabled = notes.length === 0;

    renderStatus();
    renderSelection();

    if (editingId) openEditor(editingId);
  }

  function renderStatus() {
    var where = fileHandle ? " · linked to " + fileHandle.name : "";
    el.status.textContent = notes.length === 0
      ? "Nothing pinned yet" + where
      : plural(notes.length, "note") + " saved in this browser" + where;
  }

  function renderSelection() {
    el.board.classList.toggle("board--selecting", selecting);
    el.selectionBar.hidden = !selecting;
    el.btnSelect.setAttribute("aria-pressed", String(selecting));
    el.selectionCount.textContent = plural(selected.size, "note") + " selected";
    el.btnDeleteSelected.disabled = selected.size === 0;
    el.btnClearSelection.disabled = selected.size === 0;
  }

  /* ------------------------------------------------------------- CRUD --- */

  function createNote() {
    if (selecting) exitSelectMode();
    var now = new Date().toISOString();
    var note = { id: uid(), text: "", createdAt: now, updatedAt: now };
    notes.unshift(note);
    save();
    editingId = note.id;
    editingIsNew = true;
    render();
  }

  function updateNote(id, text) {
    var note = byId(id);
    if (!note || note.text === text) return false;
    note.text = text;
    note.updatedAt = new Date().toISOString();
    save();
    return true;
  }

  function removeNotes(ids) {
    var doomed = new Set(ids);
    notes = notes.filter(function (note) { return !doomed.has(note.id); });
    doomed.forEach(function (id) { selected.delete(id); });
    if (editingId && doomed.has(editingId)) {
      editingId = null;
      editingIsNew = false;
    }
    save();
    render();
  }

  function deleteNote(id) {
    var note = byId(id);
    if (!note) return;

    var preview = note.text.trim().slice(0, 60);
    ask({
      title: "Delete this note?",
      text: preview ? "“" + preview + (note.text.trim().length > 60 ? "…" : "") + "” will be removed. This cannot be undone."
                    : "This empty note will be removed.",
      okLabel: "Delete note"
    }).then(function (answer) {
      if (answer === "confirm") {
        removeNotes([id]);
        toast("Note deleted");
      }
    });
  }

  function deleteAll() {
    if (notes.length === 0) return;
    ask({
      title: "Delete all notes?",
      text: "All " + plural(notes.length, "note") + " will be removed from this board. Save them to a file first if you want to keep them.",
      okLabel: "Delete all"
    }).then(function (answer) {
      if (answer !== "confirm") return;
      notes = [];
      selected.clear();
      editingId = null;
      save();
      exitSelectMode();
      render();
      toast("Board cleared");
    });
  }

  function deleteSelected() {
    if (selected.size === 0) return;
    var count = selected.size;
    ask({
      title: "Delete " + plural(count, "note") + "?",
      text: "The selected notes will be removed. This cannot be undone.",
      okLabel: "Delete " + plural(count, "note")
    }).then(function (answer) {
      if (answer !== "confirm") return;
      removeNotes(Array.from(selected));
      toast(plural(count, "note") + " deleted");
      if (notes.length === 0) exitSelectMode();
    });
  }

  function copyNote(id) {
    var note = byId(id);
    if (!note) return;

    function fallback() {
      var scratch = document.createElement("textarea");
      scratch.value = note.text;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      try { document.execCommand("copy"); toast("Copied to clipboard"); }
      catch (err) { toast("Copying is not available here"); }
      document.body.removeChild(scratch);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(note.text)
        .then(function () { toast("Copied to clipboard"); })
        .catch(fallback);
    } else {
      fallback();
    }
  }

  /* ----------------------------------------------------------- editor --- */

  function openEditor(id) {
    var li = el.list.querySelector('[data-id="' + id + '"]');
    var note = byId(id);
    if (!li || !note) { editingId = null; return; }

    var text = li.querySelector(".note__text");
    var editor = li.querySelector(".note__editor");

    li.classList.add("note--editing");
    text.hidden = true;
    editor.hidden = false;
    editor.value = note.text;

    editor.focus({ preventScroll: true });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    li.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /**
   * Put a note back into reading state in place. Closing the editor must not
   * rebuild the list: a click that lands on another note starts with a blur,
   * and swapping the DOM out from under that click would swallow it.
   */
  function closeEditorDom(id) {
    var li = el.list.querySelector('[data-id="' + id + '"]');
    if (!li) return;

    var note = byId(id);
    var text = li.querySelector(".note__text");
    var editor = li.querySelector(".note__editor");

    li.classList.remove("note--editing");
    editor.hidden = true;
    text.hidden = false;

    if (!note) return;
    text.textContent = note.text;

    var time = li.querySelector(".note__meta");
    time.dateTime = note.updatedAt;
    time.textContent = formatStamp(note.updatedAt);

    var span = spanFor(note.text);
    if (span) li.dataset.span = span; else delete li.dataset.span;
  }

  function commitEditor() {
    if (!editingId) return;
    var id = editingId;
    var li = el.list.querySelector('[data-id="' + id + '"]');
    var editor = li && li.querySelector(".note__editor");
    var value = editor ? editor.value : null;

    editingId = null;
    editingIsNew = false;
    if (value !== null) updateNote(id, value);
    closeEditorDom(id);
    renderStatus();
  }

  function cancelEditor() {
    if (!editingId) return;
    var id = editingId;
    var wasNew = editingIsNew;

    suppressBlurCommit = true;
    editingId = null;
    editingIsNew = false;

    var note = byId(id);
    if (wasNew && note && note.text.trim() === "") {
      removeNotes([id]);
    } else {
      closeEditorDom(id);
    }
    suppressBlurCommit = false;
  }

  function startEditing(id) {
    if (selecting) return;
    if (editingId === id) return;
    if (editingId) {
      commitEditor();   // commit whatever was open, then open the new one
    }
    editingId = id;
    editingIsNew = false;
    openEditor(id);
  }

  /* -------------------------------------------------------- selection --- */

  function enterSelectMode() {
    if (notes.length === 0) return;
    if (editingId) commitEditor();
    selecting = true;
    renderSelection();
  }

  function exitSelectMode() {
    selecting = false;
    selected.clear();
    el.list.querySelectorAll(".note--selected").forEach(function (li) {
      li.classList.remove("note--selected");
    });
    el.list.querySelectorAll(".note__checkbox").forEach(function (box) {
      box.checked = false;
    });
    renderSelection();
  }

  function toggleSelected(id, force) {
    var on = typeof force === "boolean" ? force : !selected.has(id);
    if (on) selected.add(id); else selected.delete(id);

    var li = el.list.querySelector('[data-id="' + id + '"]');
    if (li) {
      li.classList.toggle("note--selected", on);
      li.querySelector(".note__checkbox").checked = on;
    }
    renderSelection();
  }

  function selectAll() {
    if (!selecting) enterSelectMode();
    notes.forEach(function (note) { selected.add(note.id); });
    el.list.querySelectorAll(".note").forEach(function (li) {
      li.classList.add("note--selected");
      li.querySelector(".note__checkbox").checked = true;
    });
    renderSelection();
  }

  /* --------------------------------------------------------- file I/O --- */

  function exportPayload() {
    return JSON.stringify({
      format: FILE_FORMAT,
      savedAt: new Date().toISOString(),
      notes: notes
    }, null, 2);
  }

  function downloadFile(text) {
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = FILE_NAME;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("Saved to " + FILE_NAME);
  }

  function saveToFile() {
    if (editingId) commitEditor();
    var text = exportPayload();

    // Chromium browsers can write straight back to a file the user picked.
    if (!window.showSaveFilePicker) { downloadFile(text); return; }

    var chain = fileHandle
      ? Promise.resolve(fileHandle)
      : window.showSaveFilePicker({
          suggestedName: FILE_NAME,
          types: [{ description: "cork_board notes", accept: { "application/json": [".json"] } }]
        });

    chain.then(function (handle) {
      fileHandle = handle;
      return handle.createWritable();
    }).then(function (writable) {
      return writable.write(text).then(function () { return writable.close(); });
    }).then(function () {
      renderStatus();
      toast("Saved to " + fileHandle.name);
    }).catch(function (err) {
      if (err && err.name === "AbortError") return;     // user closed the picker
      fileHandle = null;
      downloadFile(text);
    });
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsText(file);
    });
  }

  function ingest(text) {
    var incoming;
    try {
      incoming = normalise(JSON.parse(text));
    } catch (err) {
      toast("That file is not a cork_board notes file.");
      return;
    }
    if (incoming.length === 0) {
      toast("That file has no notes in it.");
      return;
    }

    function apply(list, message) {
      notes = list;
      selected.clear();
      editingId = null;
      save();
      exitSelectMode();
      render();
      toast(message);
    }

    if (notes.length === 0) {
      apply(incoming, "Loaded " + plural(incoming.length, "note"));
      return;
    }

    ask({
      title: "Load " + plural(incoming.length, "note") + "?",
      text: "This board already holds " + plural(notes.length, "note") +
            ". Merge keeps both; replace throws the current board away.",
      okLabel: "Replace board",
      extraLabel: "Merge"
    }).then(function (answer) {
      if (answer === "confirm") {
        apply(incoming, "Board replaced with " + plural(incoming.length, "note"));
      } else if (answer === "extra") {
        var seen = new Set(notes.map(function (n) { return n.id; }));
        var merged = notes.concat(incoming.map(function (n) {
          if (seen.has(n.id)) n.id = uid();
          seen.add(n.id);
          return n;
        }));
        apply(merged, "Merged " + plural(incoming.length, "note"));
      }
    });
  }

  function openFromFile() {
    if (editingId) commitEditor();

    if (window.showOpenFilePicker) {
      window.showOpenFilePicker({
        types: [{ description: "cork_board notes", accept: { "application/json": [".json"] } }],
        multiple: false
      }).then(function (handles) {
        fileHandle = handles[0];
        return handles[0].getFile();
      }).then(readFileText)
        .then(ingest)
        .then(renderStatus)
        .catch(function (err) {
          if (!err || err.name !== "AbortError") el.fileInput.click();
        });
      return;
    }

    el.fileInput.click();
  }

  /* ------------------------------------------------------------ events --- */

  function noteIdFrom(target) {
    var li = target.closest(".note");
    return li ? li.dataset.id : null;
  }

  el.list.addEventListener("click", function (event) {
    var id = noteIdFrom(event.target);
    if (!id) return;

    if (selecting) {
      // Inside the checkbox the native label handles it; the change event follows.
      if (!event.target.closest(".note__select")) toggleSelected(id);
      return;
    }

    var button = event.target.closest(".note__btn");
    if (!button) return;

    switch (button.dataset.action) {
      case "copy":   copyNote(id); break;
      case "edit":   startEditing(id); break;
      case "delete": deleteNote(id); break;
    }
  });

  el.list.addEventListener("change", function (event) {
    if (!event.target.classList.contains("note__checkbox")) return;
    var id = noteIdFrom(event.target);
    if (id) toggleSelected(id, event.target.checked);
  });

  el.list.addEventListener("dblclick", function (event) {
    if (selecting || event.target.closest(".note__btn")) return;
    var id = noteIdFrom(event.target);
    if (id) startEditing(id);
  });

  el.list.addEventListener("focusout", function (event) {
    if (suppressBlurCommit) return;
    if (!event.target.classList.contains("note__editor")) return;
    if (editingId !== noteIdFrom(event.target)) return;
    // Leaving the editor saves the note, the way a real sticky note just stays written.
    commitEditor();
  });

  el.list.addEventListener("keydown", function (event) {
    if (!event.target.classList.contains("note__editor")) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEditor();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitEditor();
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented) return;

    var tag = document.activeElement ? document.activeElement.tagName : "";
    var typing = tag === "TEXTAREA" || tag === "INPUT" ||
                 (document.activeElement && document.activeElement.isContentEditable);

    if (event.key === "Escape" && selecting && !el.dialog.open) {
      exitSelectMode();
      return;
    }
    if (typing || el.dialog.open || event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      createNote();
    }
  });

  el.btnNew.addEventListener("click", createNote);
  el.btnEmptyNew.addEventListener("click", createNote);
  el.btnDeleteAll.addEventListener("click", deleteAll);
  el.btnSave.addEventListener("click", saveToFile);
  el.btnOpen.addEventListener("click", openFromFile);

  el.btnTheme.addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  el.btnSelect.addEventListener("click", function () {
    if (selecting) exitSelectMode(); else enterSelectMode();
  });

  el.btnSelectAll.addEventListener("click", selectAll);
  el.btnClearSelection.addEventListener("click", function () {
    selected.clear();
    el.list.querySelectorAll(".note").forEach(function (li) {
      li.classList.remove("note--selected");
      li.querySelector(".note__checkbox").checked = false;
    });
    renderSelection();
  });
  el.btnDeleteSelected.addEventListener("click", deleteSelected);
  el.btnExitSelect.addEventListener("click", exitSelectMode);

  el.fileInput.addEventListener("change", function () {
    var file = el.fileInput.files && el.fileInput.files[0];
    if (!file) return;
    readFileText(file).then(ingest).catch(function () {
      toast("That file could not be read.");
    });
    el.fileInput.value = "";
  });

  // Another tab of the same board edited the notes — follow along.
  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY) return;
    notes = load();
    selected.clear();
    editingId = null;
    render();
  });

  /* -------------------------------------------------------------- boot --- */

  initTheme();
  notes = load();
  render();
})();
