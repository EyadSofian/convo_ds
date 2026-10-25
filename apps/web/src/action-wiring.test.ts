import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTIONS } from './actions';
import { LIVE_ACTIONS } from './live/dispatch';

/**
 * Every control the interface draws names an action somebody handles.
 *
 * A screen test renders a control and a dialog test opens a dialog directly, so
 * both pass while the button between them names an action no dispatcher knows:
 * the click is silently dropped. That is how Inbox's "Save current view" and
 * "Update" shipped as `open-dialog` while the registry only knows `dialog`.
 *
 * The names are read from source, so a new control is checked the moment it is
 * written, without a test for it existing yet.
 */

const SOURCE = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** Action names a control can carry: literals, including both arms of a ternary. */
function namedActions(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/(?:\bact|'data-act'|'data-submit')\s*:\s*([^,}\n]+)/g)) {
    // A comparison picks which name to use; the compared value is state, not an action.
    const expression = match[1]!.replace(/[=!]==\s*'[^']*'/g, '').replace(/'[^']*'\s*[=!]==/g, '');
    for (const literal of expression.matchAll(/'([a-z][a-z0-9-]*)'/g)) names.push(literal[1]!);
  }
  return names;
}

function handledNames(): Set<string> {
  const handled = new Set([...Object.keys(ACTIONS), ...Object.keys(LIVE_ACTIONS)]);
  // These two dispatchers branch on the name instead of keeping a table.
  for (const file of ['live/notification-actions.ts', 'app.ts']) {
    const text = readFileSync(join(SOURCE, file), 'utf8');
    for (const match of text.matchAll(/(?:name|act) === '([a-z][a-z0-9-]*)'/g)) handled.add(match[1]!);
  }
  // The disabled "Coming soon" card button. It is never clickable.
  handled.add('noop');
  return handled;
}

describe('action wiring', () => {
  it('finds the controls it is checking', () => {
    const names = sourceFiles(SOURCE).flatMap((file) => namedActions(readFileSync(file, 'utf8')));
    // A broken scan would pass the next test by checking nothing.
    expect(new Set(names).size).toBeGreaterThan(150);
    expect(names).toContain('live-inbox-saved-view-update');
  });

  it('gives every button, link and form in the interface a handler', () => {
    const handled = handledNames();
    const unhandled = sourceFiles(SOURCE).flatMap((file) =>
      namedActions(readFileSync(file, 'utf8'))
        .filter((name) => !handled.has(name))
        .map((name) => `${file.slice(SOURCE.length)}: ${name}`));
    expect(unhandled).toEqual([]);
  });
});
