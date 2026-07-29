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

    const c = text.length;
    let w = 0;
    let p = 0;

    for (let i = 0; i < c; i++) {
      const char = text.charAt(i);
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
        w++;
      } else if ('{}[]():;,.<>=+-*/!&|^%~$#"\'\\'.includes(char)) {
        p++;
      }
    }

    const t = Math.ceil(0.22 * (c - p - w) + 0.55 * p + 0.35 * w);
    return Math.max(1, t);
  }
}

export default EnhancedHeuristicTokenizer;

/**
 * Factory function for creating a TokenizerAdapter from a cl100k_base (or equivalent) BPE encoder instance.
 * Exact 1,024-token prompt-cache boundary injection (in v1.3.0) requires isExact === true;
 * otherwise, boundary placement operates in Best-Effort Approximate Mode.
 */
export function createTiktokenAdapter(encoderInstance: any): TokenizerAdapter {
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
