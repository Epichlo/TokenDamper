import { describe, expect, it } from 'vitest';
import { scanContentSpans } from '../../src/gateway/proxy';

/**
 * The span scanner that replaced value-searching on egress — audit OX-H4.
 *
 * This is the riskiest kind of code in the project: it decides which bytes of a caller's request
 * get overwritten. A wrong span does not lose a saving, it corrupts a field being sent to a
 * provider, which is the one direction invariant 3 forbids. So the cases below are mostly about
 * what it must *refuse*, and every span it does return is checked by slicing the input with it and
 * parsing the result.
 */
describe('scanContentSpans', () => {
  const spansOf = (body: string, includeSystem = false) => scanContentSpans(body, { includeSystem });

  /** Every returned span must delimit exactly one parseable JSON value. */
  const valuesAt = (body: string, includeSystem = false): unknown[] => {
    const spans = spansOf(body, includeSystem);
    expect(spans).toBeDefined();
    return (spans as ReadonlyArray<{ start: number; end: number }>).map((s) =>
      JSON.parse(body.slice(s.start, s.end)),
    );
  };

  describe('the shapes that broke the value search', () => {
    it('finds a null content value', () => {
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'assistant', content: null }] });
      expect(valuesAt(body)).toEqual([null]);
    });

    it('finds array content', () => {
      const body = JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      });
      expect(valuesAt(body)).toEqual([[{ type: 'text', text: 'hi' }]]);
    });

    it('finds every content in a mixed payload, in payload order', () => {
      const body = JSON.stringify({
        model: 'm',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1' }] },
          { role: 'user', content: [{ type: 'text', text: 'third' }] },
          { role: 'assistant', content: 'fourth' },
        ],
      });
      expect(valuesAt(body)).toEqual(['first', null, [{ type: 'text', text: 'third' }], 'fourth']);
    });
  });

  describe('things that must not fool it', () => {
    it('ignores the word content inside a string value', () => {
      const body = JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'the key "content" appears here', extra: 'x' }],
      });
      expect(valuesAt(body)).toEqual(['the key "content" appears here']);
    });

    it('steps over escaped quotes and backslashes', () => {
      const tricky = 'he said \\"hi\\" and \\\\ then left';
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: tricky }] });
      expect(valuesAt(body)).toEqual([tricky]);
    });

    it('ignores braces and brackets inside strings', () => {
      const body = JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: '{"not":"json"} and ] [ }' }],
      });
      expect(valuesAt(body)).toEqual(['{"not":"json"} and ] [ }']);
    });

    it('handles deeply nested structured content', () => {
      const nested = { a: [{ b: { c: [1, 2, { d: 'e' }] } }] };
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: nested }] });
      expect(valuesAt(body)).toEqual([nested]);
    });

    it('handles a pretty-printed body, where canonical encoding differs from the bytes', () => {
      // The formatting case: `JSON.stringify` of the parsed value is compact, so a value search
      // could never have matched these bytes even when the content is a plain string.
      const body = JSON.stringify(
        { model: 'm', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: null }] },
        null,
        2,
      );
      expect(valuesAt(body)).toEqual(['hello', null]);
    });

    it('is not confused by a content key nested inside another message field', () => {
      const body = JSON.stringify({
        model: 'm',
        messages: [{ role: 'tool', meta: { content: 'decoy' }, content: 'real' }],
      });
      // `meta` precedes `content`, and its own inner `content` must not be taken for the message's.
      expect(valuesAt(body)).toEqual(['real']);
    });
  });

  describe('what it refuses', () => {
    it('declines a message with no content key, rather than misaligning', () => {
      // The entry list still holds a slot for such a message, so returning fewer spans than
      // entries would splice a replacement over the wrong value.
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', text: 'no content key' }] });
      expect(spansOf(body)).toBeUndefined();
    });

    it('declines when messages is absent', () => {
      expect(spansOf(JSON.stringify({ model: 'm' }))).toBeUndefined();
    });

    it('declines when messages is not an array', () => {
      expect(spansOf(JSON.stringify({ model: 'm', messages: 'nope' }))).toBeUndefined();
    });

    it('declines a truncated body', () => {
      expect(spansOf('{"model":"m","messages":[{"role":"user","content":"unclo')).toBeUndefined();
    });

    it('declines a non-object root', () => {
      expect(spansOf('[1,2,3]')).toBeUndefined();
    });

    it('declines when system was expected but is absent', () => {
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
      expect(spansOf(body, true)).toBeUndefined();
    });

    it('returns an empty list for an empty messages array', () => {
      expect(spansOf(JSON.stringify({ model: 'm', messages: [] }))).toEqual([]);
    });
  });

  describe('the Anthropic system slot', () => {
    it('puts system first, matching the order entries are built in', () => {
      const body = JSON.stringify({
        model: 'm',
        system: 'be terse',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(valuesAt(body, true)).toEqual(['be terse', 'hi']);
    });

    it('finds system even when it is written after messages', () => {
      // Entries always list system first, so the scan returns it first too, regardless of where
      // the caller put it — which makes the span list non-ascending for this payload.
      //
      // `spliceBySpans` only enforces ascent across entries it actually replaces, so this is not
      // simply a decline: if only messages are being replaced, the out-of-order `system` span is
      // never spliced and the saving still lands. It declines exactly when `system` itself has a
      // replacement and a later span would then splice backwards, which is the case that would
      // corrupt.
      const body = '{"messages":[{"role":"user","content":"hi"}],"system":"be terse"}';
      expect(valuesAt(body, true)).toEqual(['be terse', 'hi']);
    });
  });
});
