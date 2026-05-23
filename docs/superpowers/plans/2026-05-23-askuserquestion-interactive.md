# Interactive AskUserQuestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude inside Tierkit Chat calls Anthropic's built-in `AskUserQuestion` tool, render an interactive form in the assistant bubble. Submit sends the user's answer as a new chat message that resumes the same session — pseudo-interactive but invisible to the user.

**Architecture:** Pure GUI change in `packages/core/src/runtime/ui/gui.ts`. Intercept `tool_use` events with `name === "AskUserQuestion"` inside `chatAssistantBubble().addToolUse(d)`; render a `<form>` with radio/checkbox inputs + an "Other (specify)" textarea per question. On submit, format the answer as Markdown and pipe it through the existing `streamChat(text)` function so Claude continues via `--resume`.

**Tech Stack:** Vanilla DOM JS + CSS in the existing single-file webview. Vitest for the structural guiHtml test (no new test files — the file is too large to unit-test inline JS).

Spec: [`docs/superpowers/specs/2026-05-23-askuserquestion-interactive-design.md`](../specs/2026-05-23-askuserquestion-interactive-design.md)

---

## File Structure

**Only modified file:** `packages/core/src/runtime/ui/gui.ts`

Two tasks:
- Task 1: Add the `renderAskUserQuestion(d, body)` helper + branch in `addToolUse` + CSS
- Task 2: Build vsix + deploy + smoke test

---

## Task 1: Interactive AskUserQuestion form

**Files:** Modify `packages/core/src/runtime/ui/gui.ts` only.

### Step 1: Add CSS for the interactive form

Find the existing CSS rules for `.agent-thread` or `.msg` styles (the chat bubble styling). A good landing spot is near the end of the agent-thread CSS block. Add the new rules:

```css
  /* v0.22: interactive AskUserQuestion form rendered in place of the default
     tool_use card when Claude's built-in AskUserQuestion tool fires inside
     a Tierkit Chat turn. Submit pipes the answer through streamChat() so
     Claude continues via --resume. */
  .tk-aqq-card {
    margin: 6px 0;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: rgba(122, 162, 247, 0.06);
    font-size: 12px;
  }
  .tk-aqq-card .tk-aqq-title { font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .tk-aqq-card .tk-aqq-q { margin: 8px 0; }
  .tk-aqq-card .tk-aqq-q-text { font-weight: 600; margin-bottom: 4px; }
  .tk-aqq-card .tk-aqq-q-header { font-size: 10px; text-transform: uppercase; color: var(--fg-dim); letter-spacing: 0.05em; margin-right: 4px; }
  .tk-aqq-card label.tk-aqq-option {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 6px;
    margin: 2px 0;
    border-radius: 4px;
    cursor: pointer;
  }
  .tk-aqq-card label.tk-aqq-option:hover { background: rgba(122, 162, 247, 0.08); }
  .tk-aqq-card label.tk-aqq-option input { margin-top: 3px; flex-shrink: 0; }
  .tk-aqq-card label.tk-aqq-option .tk-aqq-option-text { flex: 1; min-width: 0; }
  .tk-aqq-card label.tk-aqq-option .tk-aqq-option-desc { display: block; font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
  .tk-aqq-card .tk-aqq-other {
    margin: 4px 0 0 24px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .tk-aqq-card .tk-aqq-other input[type="text"] {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    padding: 3px 6px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 4px;
    box-sizing: border-box;
  }
  .tk-aqq-card .tk-aqq-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    align-items: center;
  }
  .tk-aqq-card .tk-aqq-submitted {
    color: var(--ok);
    font-size: 11px;
    font-weight: 600;
  }
```

### Step 2: Add the `renderAskUserQuestion` helper function

Find `function chatAssistantBubble()` in `gui.ts` (around line 5171). Just BEFORE that function declaration, add the new helper:

```js
  /**
   * v0.22: render Anthropic's built-in AskUserQuestion tool_use as an
   * interactive form (radio for single-select, checkbox for multi-select,
   * plus a free-form "Other" input per question). On submit, format the
   * answer as Markdown and pipe through streamChat() so Claude continues
   * via --resume.
   *
   * Why this exists: claude -p closes stdin after the initial prompt, so
   * AskUserQuestion's tool_use cannot receive a tool_result inline. The
   * agent's turn ends with the tool failing. Re-sending the answer as a
   * NEW message via --resume is the only honest path to bidirectional
   * comms without rewriting chatWithClaude to interactive mode.
   *
   * @param {{ id?: string, input?: { questions?: Array<{ question: string, header?: string, multiSelect?: boolean, options?: Array<{ label: string, description?: string }> }> } }} d
   * @param {HTMLElement} bodyEl — the agent-thread node to append into
   */
  function renderAskUserQuestion(d, bodyEl) {
    const questions = (d && d.input && Array.isArray(d.input.questions)) ? d.input.questions : [];
    if (questions.length === 0) return false; // caller falls back to generic card
    const card = document.createElement('div');
    card.className = 'tk-aqq-card';
    card.dataset.toolId = d.id || '';
    const toolId = d.id || 'aqq-' + Math.random().toString(36).slice(2, 10);
    const titleLabel = lang === 'ko' ? '🤔 Claude가 묻습니다' : '🤔 Claude is asking';
    const otherLabel = lang === 'ko' ? '기타:' : 'Other:';
    const submitLabel = lang === 'ko' ? '답변 제출' : 'Submit answer';
    const emptyAnswerLabel = lang === 'ko' ? '최소 하나는 선택하거나 기타에 입력해주세요.' : 'Pick at least one option or type in Other.';
    const sentLabel = lang === 'ko' ? '✓ 전송됨' : '✓ Sent';

    let html = '<div class="tk-aqq-title"><span>' + escapeHtmlMd(titleLabel) + '</span></div>';
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const qText = q && typeof q.question === 'string' ? q.question : '';
      const header = q && typeof q.header === 'string' ? q.header : '';
      const multi = !!(q && q.multiSelect);
      const options = (q && Array.isArray(q.options)) ? q.options : [];
      const inputType = multi ? 'checkbox' : 'radio';
      const groupName = 'tk-aqq-' + toolId + '-' + qi;

      html += '<div class="tk-aqq-q" data-q-index="' + qi + '">';
      if (header) html += '<span class="tk-aqq-q-header">' + escapeHtmlMd(header) + '</span>';
      html += '<div class="tk-aqq-q-text">' + escapeHtmlMd(qText) + (multi ? ' <span class="dim" style="font-weight:normal;font-size:10px">[복수 선택]</span>' : '') + '</div>';
      for (let oi = 0; oi < options.length; oi++) {
        const opt = options[oi] || {};
        const optLabel = typeof opt.label === 'string' ? opt.label : '';
        const optDesc = typeof opt.description === 'string' ? opt.description : '';
        html += '<label class="tk-aqq-option">';
        html += '<input type="' + inputType + '" name="' + escapeHtmlMd(groupName) + '" value="' + escapeHtmlMd(String(oi)) + '">';
        html += '<span class="tk-aqq-option-text">' + escapeHtmlMd(optLabel);
        if (optDesc) html += '<span class="tk-aqq-option-desc">' + escapeHtmlMd(optDesc) + '</span>';
        html += '</span>';
        html += '</label>';
      }
      // Always-present "Other" free-form input.
      html += '<div class="tk-aqq-other"><span class="dim" style="font-size:11px">' + escapeHtmlMd(otherLabel) + '</span>';
      html += '<input type="text" data-q-other="' + qi + '" placeholder="…">';
      html += '</div>';
      html += '</div>';
    }
    html += '<div class="tk-aqq-actions">';
    html += '<button class="tiny primary" data-aqq-submit>' + escapeHtmlMd(submitLabel) + '</button>';
    html += '</div>';

    card.innerHTML = html;
    bodyEl.appendChild(card);

    const submitBtn = card.querySelector('[data-aqq-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // Collect answers per question.
        const parts = [];
        let totalSelected = 0;
        for (let qi = 0; qi < questions.length; qi++) {
          const q = questions[qi];
          const qText = q && typeof q.question === 'string' ? q.question : '';
          const multi = !!(q && q.multiSelect);
          const options = (q && Array.isArray(q.options)) ? q.options : [];
          const groupName = 'tk-aqq-' + toolId + '-' + qi;
          const checked = card.querySelectorAll('input[name="' + groupName.replace(/"/g, '') + '"]:checked');
          const selectedLabels = [];
          checked.forEach((node) => {
            const idx = parseInt(node.value, 10);
            const opt = options[idx];
            if (opt && typeof opt.label === 'string') selectedLabels.push(opt.label);
          });
          const otherInput = card.querySelector('input[data-q-other="' + qi + '"]');
          const otherText = otherInput && typeof otherInput.value === 'string' ? otherInput.value.trim() : '';
          if (otherText.length > 0) selectedLabels.push(otherText);
          if (selectedLabels.length > 0) totalSelected += 1;
          parts.push({ qText, selected: selectedLabels, multi });
        }
        if (totalSelected === 0) {
          toast(emptyAnswerLabel, 'err');
          return;
        }
        // Format as Markdown user message.
        const lines = [];
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          lines.push('**Q' + (i + 1) + ': ' + p.qText + '**');
          if (p.selected.length === 0) {
            lines.push('- (no answer)');
          } else {
            for (const s of p.selected) lines.push('- ' + s);
          }
          lines.push('');
        }
        const formatted = lines.join('\\n').trim();

        // Disable the form and show "sent" state.
        card.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
        const actions = card.querySelector('.tk-aqq-actions');
        if (actions) {
          actions.innerHTML = '<span class="tk-aqq-submitted">' + escapeHtmlMd(sentLabel) + '</span>';
        }

        // Send via existing streamChat → /v1/claude-code/chat with current sessionId.
        void streamChat(formatted);
      });
    }
    scrollAgentBottom();
    return true;
  }
```

### Step 3: Branch inside `addToolUse` for AskUserQuestion

Find `addToolUse(d)` inside `chatAssistantBubble()` (around line 5216). The first three lines are:

```js
      addToolUse(d) {
        // Force a new text node next time so tool cards appear AFTER current text.
        textNode = null;
        textBuffer = '';
```

Add the branch immediately after `textBuffer = '';`:

```js
      addToolUse(d) {
        // Force a new text node next time so tool cards appear AFTER current text.
        textNode = null;
        textBuffer = '';

        // v0.22: Anthropic's built-in AskUserQuestion → interactive form.
        // Falls through to the generic tool_use card if the input is malformed.
        if (d && d.name === 'AskUserQuestion' && d.input && Array.isArray(d.input.questions)) {
          if (renderAskUserQuestion(d, body)) return;
        }
```

The existing generic tool-card code stays unchanged below — it's the fall-through when AskUserQuestion's input is malformed.

### Step 4: Run the GUI tests

Run: `pnpm --filter @tierkit/core test guiHtml`
Expected: PASS, 3 tests.

### Step 5: Commit

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "feat(ui): interactive AskUserQuestion form in chat

Detects Anthropic's built-in AskUserQuestion tool_use events and renders
an interactive form (radio for single, checkbox for multi, plus Other
free-form) instead of the default tool card. Submit formats answers as
Markdown and pipes through streamChat() so claude continues via --resume.

Pseudo-interactive: the in-flight turn fails the tool_result (claude -p
closed stdin), but the next user message resumes the session with the
answer. Cleanest path until chatWithClaude is rewritten for interactive
stdin.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Build vsix + deploy + smoke test

**Files:** none — packaging + verification only.

- [ ] **Step 1: Build core + extension**

Run from `/Users/siwal/code/Tierkit`:

```
pnpm --filter @tierkit/core build && cd packages/vscode-tierkit && pnpm run build
```

Expected: clean build, no TS errors.

- [ ] **Step 2: Package vsix**

Run from `packages/vscode-tierkit`:

```
pnpm run package:sideload
```

Expected: `tierkit-vscode-0.21.12.vsix` produced (~1.23 MB).

- [ ] **Step 3: Hot-deploy to live code-server daemon**

```bash
EXT_DIR=/Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12
VSIX=/Users/siwal/code/Tierkit/packages/vscode-tierkit/tierkit-vscode-0.21.12.vsix
TMP=$(mktemp -d) && unzip -q "$VSIX" -d "$TMP"
cp "$TMP/extension/dist/extension.js" "$EXT_DIR/dist/extension.js"
cp "$TMP/extension/dist/extension.js.map" "$EXT_DIR/dist/extension.js.map" 2>/dev/null
rm -rf "$TMP"
echo "deployed at $(stat -f '%Sm' -t '%H:%M:%S' $EXT_DIR/dist/extension.js)"
```

- [ ] **Step 4: Verify markers are in the deployed file**

```
grep -c "tk-aqq-card\|renderAskUserQuestion\|AskUserQuestion" /Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12/dist/extension.js
```

Expected: ≥ 5 matches.

- [ ] **Step 5: Tell the user to reload + manual smoke test**

After the user reloads the code-server window, verify:
- Trigger a chat that produces an `AskUserQuestion` tool call (e.g., the `/audit` or `/review` slash command that the user originally reported broken).
- The card renders with the question header, radio/checkbox per `multiSelect`, "Other" input, Submit button.
- Picking options + clicking Submit fires a new user bubble with the formatted Markdown answer, and Claude streams a response.
- The form goes disabled with "✓ Sent" / "✓ 전송됨" displayed in place of the Submit button.
- Picking no options and no Other text → toast "Pick at least one…" + form stays editable.

No commit for this task — build outputs are gitignored.

---

## Self-Review

**Spec coverage:**

- Detect `tool_use` with `name === "AskUserQuestion"` and array input → Step 3 ✓
- Render radio for single-select, checkbox for multi-select → Step 2 (`inputType = multi ? 'checkbox' : 'radio'`) ✓
- "Other" free-form input on every question → Step 2 (always-present `tk-aqq-other` block) ✓
- Submit button → Step 2 ✓
- Format answer as Markdown user message → Step 2 (Q1/Q2 + bullet list) ✓
- Pipe through `streamChat(formatted)` → Step 2 ✓
- Disable form + show "✓ Sent" after submit → Step 2 ✓
- Toast on empty submit → Step 2 (`emptyAnswerLabel` + `toast(...,'err')`) ✓
- Fall through to generic card on malformed input → Step 3 (`if (renderAskUserQuestion(d, body)) return;` — returns true only on success) ✓
- Scoped radio `name` so multiple parallel cards don't collide → Step 2 (`groupName = 'tk-aqq-' + toolId + '-' + qi`) ✓
- Korean + English labels → Step 2 (`lang === 'ko' ? ... : ...`) ✓

**Placeholder scan:** No TBDs / "implement later" / "similar to Task N". All code blocks are complete.

**Type consistency:** `renderAskUserQuestion` defined in Step 2 with signature `(d, bodyEl)`; called in Step 3 as `renderAskUserQuestion(d, body)` where `body` is the in-scope `chatAssistantBubble` body element. Function returns `boolean` (`true` on success, `false` on malformed input) and the caller branches on it. Consistent.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-askuserquestion-interactive.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
