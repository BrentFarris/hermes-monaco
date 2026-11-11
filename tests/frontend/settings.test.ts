import { describe, expect, it } from 'vitest';
import { parseRulers, preferences, remapPath, underPath } from '../../src/editorSettings';

describe('editor preferences and references', () => {
  it('defaults to 80 and 90, accepts multiple sorted guides, rejects invalid columns', () => {
    expect(preferences(null).rulers).toEqual([80, 90]);
    expect(parseRulers('120, 80, 90, 80')).toEqual([80, 90, 120]);
    for (const value of ['0', '-1', '80,', '80.5', '10001', 'NaN']) expect(parseRulers(value)).toBeNull();
    expect(preferences({ fontSize: 90, tabSize: 3 }).fontSize).toBe(32);
  });
  it('moves file references and descendants without changing similarly named siblings', () => {
    expect(remapPath('src/a.ts', 'src', 'lib')).toBe('lib/a.ts');
    expect(remapPath('src-old/a.ts', 'src', 'lib')).toBe('src-old/a.ts');
    expect(underPath('src-old/a.ts', 'src')).toBe(false);
    expect(remapPath('a.ts', 'a.ts', 'λ.ts')).toBe('λ.ts');
  });
});
