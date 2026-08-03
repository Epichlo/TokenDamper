export interface TokenizerAdapter {
  readonly name: string;
  readonly isExact: boolean;
  countTokens(text: string): number;
  encode?(text: string): Uint32Array | number[];
}

export class EnhancedHeuristicTokenizer implements TokenizerAdapter {
  readonly name = 'enhanced_heuristic';
  readonly isExact = false;

  countTokens(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }

    let asciiWord = 0;
    let whitespace = 0;
    let punctuation = 0;
    let nonAscii = 0;

    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      
      // Whitespace: space (32), tab (9), newline (10), carriage return (13)
      if (charCode === 32 || charCode === 9 || charCode === 10 || charCode === 13) {
        whitespace++;
      } 
      // Punctuation and symbols (ASCII 33-47, 58-64, 91-96, 123-126)
      else if (
        (charCode >= 33 && charCode <= 47) ||
        (charCode >= 58 && charCode <= 64) ||
        (charCode >= 91 && charCode <= 96) ||
        (charCode >= 123 && charCode <= 126)
      ) {
        punctuation++;
      } else if (charCode < 128) {
        asciiWord++;
      } else {
        nonAscii++;
        if (charCode >= 0xd800 && charCode <= 0xdbff) {
          const nextCharCode = text.charCodeAt(i + 1);
          if (nextCharCode >= 0xdc00 && nextCharCode <= 0xdfff) {
            i++;
          }
        }
      }
    }

    const t = Math.ceil(0.22 * asciiWord + 0.55 * punctuation + 0.35 * whitespace + 1.1 * nonAscii);
    return Math.max(1, t);
  }
}

export default EnhancedHeuristicTokenizer;

/**
 * The single tokenizer instance every measurement site defaults to.
 *
 * Stateless and side-effect free, so sharing one instance is safe and keeps
 * `estimateTokens` allocation-free on the hot path.
 */
export const DEFAULT_TOKENIZER: TokenizerAdapter = new EnhancedHeuristicTokenizer();

/**
 * The **only** function in the codebase that answers "how many tokens is this text".
 *
 * Route every measurement through here. Two independent estimators previously coexisted —
 * this adapter on the input side of a bundle and an inline `ceil(len / 4)` on the output
 * side — and a reduction ratio computed across that seam reported an 11-22% saving on
 * byte-identical output. Any second implementation reintroduces that class of bug, because
 * the ratio's correctness depends on both sides counting the same way, not on either side
 * being accurate.
 *
 * Accuracy is deliberately *not* the contract here. Measured against `cl100k_base`,
 * `EnhancedHeuristicTokenizer` has a mean absolute error of 24% and `ceil(len / 4)` 17% —
 * the "enhanced" heuristic is the *less* accurate of the two on the project's own corpus.
 * The adapter is the default because it is the seam: `TokenizerAdapter` carries `isExact`
 * and `createTiktokenAdapter` already implements it, so a real BPE tokenizer replaces one
 * default rather than nine inline expressions. Fixing the numbers is a separate change to
 * the default, made once, here.
 */
export function estimateTokens(text: string, tokenizer: TokenizerAdapter = DEFAULT_TOKENIZER): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.max(1, tokenizer.countTokens(text));
}

/**
 * Estimates the tokens of a bundle's items under the canonical render — newline-joined,
 * in order, the same text the fallback resolver emits on the success path.
 *
 * The join convention is part of the measurement: counting `sum(item.content.length)`
 * instead (as the Gateway did) omits the N-1 separators and yields a different answer for
 * the same bundle. Bundle constructors must use this so that byte-identical bundles are
 * structurally guaranteed to produce identical estimates.
 */
export function estimateBundleTokens(
  items: ReadonlyArray<{ readonly content: string }>,
  tokenizer: TokenizerAdapter = DEFAULT_TOKENIZER,
): number {
  return estimateTokens(items.map((item) => item.content).join('\n'), tokenizer);
}

/**
 * Factory function for creating a TokenizerAdapter from a cl100k_base (or equivalent) BPE encoder instance.
 * Exact 1,024-token prompt-cache boundary injection (in v1.3.0) requires isExact === true;
 * otherwise, boundary placement operates in Best-Effort Approximate Mode.
 */
export function createTiktokenAdapter(encoderInstance: { encode: (text: string) => Uint32Array | number[] }): TokenizerAdapter {
  return {
    name: 'tiktoken_bpe',
    isExact: true,
    countTokens(text: string): number {
      const encoded = encoderInstance.encode(text);
      return encoded.length;
    },
    encode(text: string): Uint32Array | number[] {
      return encoderInstance.encode(text);
    }
  };
}
