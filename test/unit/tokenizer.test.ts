import { describe, expect, it } from 'vitest';
import EnhancedHeuristicTokenizer, { createTiktokenAdapter } from '../../src/core/hashing/tokenizer';

describe('EnhancedHeuristicTokenizer', () => {
  it('instantiates properly with zero dependencies', () => {
    const tokenizer = new EnhancedHeuristicTokenizer();
    expect(tokenizer.name).toBe('enhanced_heuristic');
    expect(tokenizer.isExact).toBe(false);
  });

  it('calculates tokens for plain text correctly', () => {
    const tokenizer = new EnhancedHeuristicTokenizer();
    const plainText = "This is a simple plain text string with no symbols.";
    expect(tokenizer.countTokens(plainText)).toBeGreaterThan(0);
  });

  it('calculates tokens for heavily symbol-dense code correctly', () => {
    const tokenizer = new EnhancedHeuristicTokenizer();
    const code = "function test() { return [1, 2, 3].map(x => x * 2); }";
    const count = tokenizer.countTokens(code);
    expect(count).toBeGreaterThan(5);
  });

  it('handles empty text', () => {
    const tokenizer = new EnhancedHeuristicTokenizer();
    expect(tokenizer.countTokens('')).toBe(0);
  });

  it('uses conservative counts for non-ASCII text', () => {
    const tokenizer = new EnhancedHeuristicTokenizer();
    const cjkText = '这是一个用于测试的中文句子';
    const emojiText = 'TokenDamper 🚀🔥✨';

    expect(tokenizer.countTokens(cjkText)).toBeGreaterThanOrEqual(cjkText.length);
    expect(tokenizer.countTokens(emojiText)).toBeGreaterThan(tokenizer.countTokens('TokenDamper'));
  });
});

describe('createTiktokenAdapter', () => {
  it('creates an exact adapter', () => {
    const mockEncoder = {
      encode: (_text: string) => [1, 2, 3]
    };
    const adapter = createTiktokenAdapter(mockEncoder);
    expect(adapter.name).toBe('tiktoken_bpe');
    expect(adapter.isExact).toBe(true);
    expect(adapter.countTokens('test')).toBe(3);
    if (adapter.encode) {
      expect(adapter.encode('test')).toEqual([1, 2, 3]);
    }
  });
});
