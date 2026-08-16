// # The editor, note loading, autosaving, and pasting.
// CodeMirror 6 does the editing, the undo history, and the Markdown styling. It lives
// in the vendored codemirror.js bundle, this is the only module importing from it.
// Other modules go through here to access CodeMirror features.

import {
  Compartment,
  EditorState,
  EditorView,
  HighlightStyle,
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  insertTab,
  keymap,
  lineNumbers,
  markdown,
  markdownLanguage,
  placeholder,
  redo,
  selectAll,
  styleTags,
  syntaxHighlighting,
  tags,
  undo,
} from "./codemirror.js";
import { showToast } from "./dialogs.js";
import { editor, sidebarNotes } from "./dom.js";
import { ensureCurrentNote } from "./sidebar-notes.js";
import { getSetting, updateSetting } from "./settings.js";
import { state } from "./state.js";
import { scheduleAutoSync } from "./sync.js";
import { invoke } from "./tauri.js";

let noteSaveTimer = null;

// ## Markdown styling.
// The colors are the theme's own CSS variables, so the notes follow every theme. The
// marks (#, *, -, >, `) share the accent the line numbers use, which reads as
// structure without pulling attention away from the text itself.
const markdownStyle = HighlightStyle.define([
  // Only the closest rule for a tag applies, the styles of a wider one are not added
  // to it, so the sized headings have to repeat the weight.
  { tag: tags.heading, fontWeight: "700" },
  { tag: tags.heading1, fontWeight: "700", fontSize: "1.6em" },
  { tag: tags.heading2, fontWeight: "700", fontSize: "1.4em" },
  { tag: tags.heading3, fontWeight: "700", fontSize: "1.2em" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.quote, color: "var(--color-text-placeholder)", fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: "var(--color-accent)", textDecoration: "underline" },
  { tag: tags.monospace, backgroundColor: "var(--color-bg-hover)" },
  { tag: tags.comment, color: "var(--color-text-muted)" },
  { tag: tags.string, color: "var(--color-text-placeholder)" },
  {
    tag: [tags.processingInstruction, tags.labelName, tags.escape, tags.character, tags.atom],
    color: "var(--color-accent)",
  },

  // A horizontal rule gets a class of its own, so the stylesheet can draw a line for
  // it. Only a real rule is tagged this way, dashes under a line of text are that
  // line's heading underline and stay untouched.
  { tag: tags.contentSeparator, class: "cm-horizontal-rule" },
]);

// ## Give the task list marker a style of its own.
// GFM (GitHub Flavored Markdown) parses the [ ] and [x] of a task list, but leaves
// them unstyled, so they get the same accent as the other marks.
const taskMarkerStyle = { props: [styleTags({ TaskMarker: tags.atom })] };

// ## Line numbers, toggled from the settings.
// The compartment swaps the extension in and out of the running editor, the flag
// carries the choice into the state a newly opened note gets.
const lineNumberConfig = new Compartment();
let showLineNumbers = false;

function lineNumberExtension() {
  return showLineNumbers ? lineNumbers({ formatNumber: (line) => `${line}.` }) : [];
}

export function setEditorLineNumbers(show) {
  showLineNumbers = show;

  editorView.dispatch({ effects: lineNumberConfig.reconfigure(lineNumberExtension()) });
}

// ## Re-measure the editor after the font settings changed.
// CodeMirror caches the text's size to lay the note out, and the font, line height and
// word spacing settings land on the #editor container behind its back.
export function remeasureEditor() {
  editorView.requestMeasure();
}

// ## Build a fresh editor state around a note's text.
// Every note gets its own state, so the undo history never reaches back into the
// note that was open before.
function createEditorState(text) {
  return EditorState.create({
    doc: text,
    extensions: [
      history(),
      keymap.of([
        // Tab types a tab, instead of walking the focus out of the editor and onto the
        // sidebar, where the next Delete would hit a note. Shift+Tab takes an indent
        // level back off.
        { key: "Tab", run: insertTab, shift: indentLess },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      markdown({ base: markdownLanguage, extensions: taskMarkerStyle }),
      syntaxHighlighting(markdownStyle),
      lineNumberConfig.of(lineNumberExtension()),
      placeholder("Start typing."),

      // Long lines wrap instead of scrolling sideways, like a note app should.
      EditorView.lineWrapping,

      // Autosave while typing.
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleNoteSave();

        // Undo and redo need the caret painted again, see redrawCaret below. The wait
        // is CodeMirror's own rule, a listener may not dispatch while the update that
        // called it is still running.
        if (
          update.transactions.some((tr) => tr.isUserEvent("undo") || tr.isUserEvent("redo"))
        ) {
          requestAnimationFrame(redrawCaret);
        }
      }),
    ],
  });
}

// ## The editor itself, mounted in the #editor container.
export const editorView = new EditorView({
  state: createEditorState(""),
  parent: editor,
});

// ## Read the note text out of the editor.
export function getEditorContent() {
  return editorView.state.doc.toString();
}

// ## Replace the editor's text with a note's.
// Swapping the whole state also clears the undo history and the selection, which is
// what both opening a note and taking one over from a sync should do.
export function setEditorContent(text) {
  // Let go of the old caret before the text under it disappears. WebKit keeps painting
  // a selection that points at removed nodes and hands it back on the next focus, and
  // CodeMirror only rewrites the caret while the editor has the focus, comparing
  // against its own cache of that same stale position. Between them the old caret stays
  // on screen while the real one sits at the end of the new note, so typing lands there.
  const selection = window.getSelection();
  if (selection.rangeCount && editorView.contentDOM.contains(selection.anchorNode)) {
    selection.removeAllRanges();
  }

  // The caret goes in with the state, not in a transaction after it. A second step
  // leaves a moment where the new note is on screen with the caret still at the top,
  // which the DOM observer can read back over it before the caret gets moved.
  const loaded = createEditorState(text);

  editorView.setState(
    loaded.update({ selection: { anchor: openNoteCaret(loaded.doc) } }).state,
  );

  // The scroller would otherwise stay where the previous note left it, leaving the
  // caret out of sight. This happens whether the editor takes the focus or not.
  scrollEditorToCaret();
}

// ## Paint the caret again after an undo or a redo to fix CodeMirror bug.
// Both put text back by swapping the nodes the caret stands in, and WebKit goes on
// painting the caret that stood in the old ones, so a dead second caret is left behind.
// It is the same stale selection setEditorContent works around above, and it takes the
// same two steps. Letting go of the selection erases the painting, and forceSelection
// has CodeMirror write the caret back on the empty transaction right after, from the
// position its own state holds. Neither step is enough on its own, the one leaves no
// caret at all, the other leaves the old painting where it is.
//
// forceSelection is a field of CodeMirror's, not part of its API, so give undo a try
// after ./update-codemirror.sh built a new bundle.
function redrawCaret() {
  // Without the focus nothing paints a caret, and CodeMirror would not write one back
  // either, since it leaves the selection alone while another element holds the focus.
  if (!editorView.hasFocus) return;

  const selection = window.getSelection();
  if (selection.rangeCount && editorView.contentDOM.contains(selection.anchorNode)) {
    selection.removeAllRanges();
  }

  editorView.docView.forceSelection = true;
  editorView.dispatch({});
}

// ## Scroll the editor to its caret, once the note has actually been laid out.
// Measuring right after the text is put in scrolls to the wrong place, since the font
// is not rendered yet and the lines have not wrapped, which a narrow editor shows off
// worst. The wait lets that settle. The first line then scrolls all the way to the top
// and the last all the way to the bottom, any line between sits in the middle.
//
// Landing at the end of a note waits longer, since every wrapped line above it still
// moves where that end is. A wider editor wraps less and settles sooner, which is why
// this edge-case bug only showed up on a narrow one.
const caretScrollDelay = 50;
const endOfNoteScrollDelay = 250;
let caretScrollTimer = null;

function scrollEditorToCaret() {
  clearTimeout(caretScrollTimer);

  const start = editorView.state;
  const landsAtEnd =
    start.doc.lines > 1 &&
    start.doc.lineAt(start.selection.main.head).number === start.doc.lines;

  caretScrollTimer = setTimeout(
    () => {
      caretScrollTimer = null;

      const { doc, selection } = editorView.state;
      const head = selection.main.head;
      const lineNumber = doc.lineAt(head).number;

      const target =
        lineNumber === 1
          ? EditorView.scrollIntoView(0, { y: "start" })
          : lineNumber === doc.lines
            ? EditorView.scrollIntoView(doc.length, { y: "end" })
            : EditorView.scrollIntoView(head, { y: "center" });

      editorView.dispatch({ effects: target });
    },
    landsAtEnd ? endOfNoteScrollDelay : caretScrollDelay,
  );
}

// ## Where the caret waits when a note opens, from the "On Opening a Note" setting.
// The beginning is the end of the note's first line, where its title ends, so typing
// carries the note on rather than pushing that title down. Measured against the note's
// own document, so a file with Windows line endings cannot put the caret past its end.
function openNoteCaret(doc) {
  return getSetting("open-note-focus") === "end" ? doc.length : doc.line(1).to;
}

// ## Schedule an autosave shortly after the user stops typing.
export function scheduleNoteSave() {
  if (!state.currentNotePath) {
    ensureCurrentNote();

    return;
  }

  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(async () => {
    noteSaveTimer = null;

    await invoke("save_note", {
      path: state.currentNotePath,
      content: getEditorContent(),
    });

    scheduleAutoSync();
  }, 500);
}

// ## Save the current note now, if a save is still pending.
export async function flushNoteSave() {
  if (!noteSaveTimer) return;

  clearTimeout(noteSaveTimer);
  noteSaveTimer = null;

  if (state.currentNotePath) {
    await invoke("save_note", {
      path: state.currentNotePath,
      content: getEditorContent(),
    });
  }
}

// ## Drop a pending autosave without writing, for when the note is going away.
export function discardPendingSave() {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = null;
}

// ## Give focus back to the editor.
// The caret goes back where it was on its own, the editor keeps its selection while
// an overlay holds the focus.
export function focusEditor() {
  editorView.focus();

  // Taking the focus is what makes the caret visible, so bring it into view as well.
  scrollEditorToCaret();
}

// ## The editor's own undo, redo, and select all, for the context menu.
export function undoEditor() {
  undo(editorView);
}

export function redoEditor() {
  redo(editorView);
}

export function selectAllEditor() {
  selectAll(editorView);
}

// ## Insert plain text at the caret, for the context menu's paste.
// Ctrl/Cmd+V goes through the editor's own plain-text paste and never lands here.
export function insertEditorText(text) {
  editorView.dispatch(editorView.state.replaceSelection(text.replace(/\r\n?/g, "\n")), {
    scrollIntoView: true,
    userEvent: "input.paste",
  });

  editorView.focus();
}

// ## Select and scroll to the first hit of a query on a line, for the search overlay.
export function highlightEditorMatch(line, query) {
  const doc = editorView.state.doc;
  if (line < 1 || line > doc.lines) return;

  const { from, text } = doc.line(line);
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return;

  editorView.dispatch({
    selection: { anchor: from + index, head: from + index + query.length },
    effects: EditorView.scrollIntoView(from + index, { y: "center" }),
  });

  editorView.focus();
}

// ## Open a note in the editor and remember it as the last open note.
export async function openNote(path) {
  // Opening the note that is already open would only throw away its undo history,
  // caret and scroll position, and hand the same text back. The sidebar highlight
  // does not need this either, the click that got here sets it, and a sidebar rebuild
  // restores it from the open note's path.
  if (path === state.currentNotePath) return;

  await flushNoteSave();

  let content;
  try {
    content = await invoke("load_note", { path });
  } catch (error) {
    showToast(error);

    return;
  }

  state.currentNotePath = path;
  setEditorContent(content);

  // Highlight it in the sidebar and unfold the folders above it. The note becomes
  // both the sidebar selection (.active) and the note open in the editor (.current).
  // Clicking a folder later only takes the selection with it, the .current highlight
  // stays on the note until another one opens.
  sidebarNotes
    .querySelectorAll(".active, .current")
    .forEach((el) => el.classList.remove("active", "current"));

  const item = sidebarNotes.querySelector(`.item[data-path="${CSS.escape(path)}"]`);
  if (item) {
    item.classList.add("active", "current");

    let folder = item.closest(".folder");
    while (folder) {
      folder.classList.add("open");
      folder = folder.parentElement.closest(".folder");
    }
  }

  updateSetting("last-note", path);

  // Taking the focus is what makes CodeMirror paint the caret at all, since it leaves
  // the caret alone while the editor does not have it. It also takes the Delete and F2
  // keys away from the sidebar selection, so the setting decides. Only the two modes
  // that ask for it get it, which keeps a settings.toml missing the key on the default.
  const focusMode = getSetting("open-note-focus");

  if (focusMode === "start" || focusMode === "end") focusEditor();
}

// ## Check whether the open note lives at or below a path.
export function pathContainsCurrentNote(path) {
  return (
    !!state.currentNotePath &&
    (state.currentNotePath === path || state.currentNotePath.startsWith(`${path}/`))
  );
}

// ## Close the open note and open the first note outside the trash, if any.
export function openNextNote() {
  state.currentNotePath = null;
  setEditorContent("");

  // Nothing is open anymore, so nothing is .current until openNote sets it again.
  sidebarNotes.querySelectorAll(".current").forEach((el) => el.classList.remove("current"));

  const nextItem = [...sidebarNotes.querySelectorAll(".item")].find(
    (item) => !item.dataset.path.startsWith(".trash"),
  );

  if (nextItem) {
    openNote(nextItem.dataset.path);
  } else {
    updateSetting("last-note", "");
  }
}

// ## Setup the editor.
export function setupEditor() {
  // Makes sure a pending autosave isn't lost when the window loses focus, or when the
  // app moves to the background (how iOS "closes" apps).
  window.addEventListener("blur", flushNoteSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNoteSave();
  });

  // Fixes an edge case bug in -webkit-scrollbar when wheel scrolling while the mouse
  // is held down on the scroll thumb at the top or bottom.
  let preventScroll = false;

  document.addEventListener("mousedown", (event) => {
    preventScroll = !event.target.closest(".cm-content");
  });

  document.addEventListener("mouseup", () => {
    preventScroll = false;
  });

  document.addEventListener(
    "wheel",
    (event) => {
      if (preventScroll) event.preventDefault();
    },
    // Passive listeners can't preventDefault, so this one opts out.
    { passive: false },
  );
}
