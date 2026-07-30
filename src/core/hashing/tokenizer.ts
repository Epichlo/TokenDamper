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
