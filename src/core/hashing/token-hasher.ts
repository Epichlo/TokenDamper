import { hashContent } from '../model/constructors';
import { unwrapElisionContent } from '../elision';

export interface BlockPlaceholderOptions {
  readonly blockType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface StoredBlock {
  readonly hash: string;
  readonly content: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly blockType?: string;
}

/**
 * Reversible token hasher for TokenDamper.
 * Supports bidirectional hashing: mapping content to `<BLOCK_HASH:sha256>` placeholders
 * and rehydrating text containing placeholders back to raw original content.
 */
export class TokenHasher {
  private readonly store = new Map<string, StoredBlock>();

  constructor(initialBlocks?: ReadonlyArray<StoredBlock | { hash: string; content: string }>) {
    if (initialBlocks) {
      for (const block of initialBlocks) {
        const metadata: { bytes?: number; createdAt?: number; blockType?: string } = {
          bytes: block.content.length,
          createdAt: 'createdAt' in block && typeof block.createdAt === 'number' ? block.createdAt : Date.now(),
        };
        if ('blockType' in block && typeof block.blockType === 'string') {
          metadata.blockType = block.blockType;
        }
        this.registerBlock(block.hash, block.content, metadata);
      }
    }
  }

  /**
   * Registers a content block directly into the internal store.
   */
  public registerBlock(
    hash: string,
    content: string,
    metadata?: { bytes?: number; createdAt?: number; blockType?: string },
  ): string {
    const entry: StoredBlock = {
      hash,
      content,
      bytes: metadata?.bytes ?? content.length,
      createdAt: metadata?.createdAt ?? Date.now(),
      ...(metadata?.blockType ? { blockType: metadata.blockType } : {}),
    };
    this.store.set(hash, entry);
    return hash;
  }

  /**
   * Creates a reversible block placeholder for text content.
   * Returns placeholder string in format: `<BLOCK_HASH:${hash}>`
   */
  public createBlockPlaceholder(content: string, options?: BlockPlaceholderOptions): string {
    const hash = hashContent(content);
    const metadata: { bytes?: number; createdAt?: number; blockType?: string } = {
      bytes: content.length,
      createdAt: Date.now(),
    };
    if (options?.blockType) {
      metadata.blockType = options.blockType;
    }
    this.registerBlock(hash, content, metadata);
    return `<BLOCK_HASH:${hash}>`;
  }

  /**
   * Expands a block hash or placeholder string back into its original content.
   * Accepts either raw SHA-256 hash or `<BLOCK_HASH:hash>` placeholder string.
   */
  public expandBlockHash(hashOrPlaceholder: string): string | undefined {
    const hash = this.extractHash(hashOrPlaceholder);
    const entry = this.store.get(hash);
    return entry?.content;
  }

  /**
   * Rehydrates all `<BLOCK_HASH:hash>` placeholders present in text.
   * Placeholders whose hash exists in the store are replaced with original content.
   * Unknown placeholders are left as-is.
   */
  public rehydrateText(text: string): string {
    // JSON-shaped items carry the placeholder wrapped as `{"__td_block__":"<BLOCK_HASH:...>"}`
    // so the elided item stays parseable. Unwrap first and return the stored content
    // directly: substituting in place would yield the original content nested inside the
    // wrapper (or, for the quoted form, a string wrapping an object), which round-trips to
    // something that is not byte-identical to the input. Format and reverse transform are
    // one contract — changing either alone breaks the round trip.
    const wrappedMarker = unwrapElisionContent(text);
    if (wrappedMarker !== undefined) {
      const entry = this.store.get(this.extractHash(wrappedMarker));
      if (entry) {
        return entry.content;
      }
      return text;
    }

    const placeholderRegex = /<BLOCK_HASH:([a-f0-9]{64}|[a-f0-9]{12,64}|[^>]+)>/g;
    return text.replace(placeholderRegex, (match, hash) => {
      const entry = this.store.get(hash);
      if (entry) {
        return entry.content;
      }
      return match;
    });
  }

  /**
   * Returns whether a block hash or placeholder exists in the store.
   */
  public hasHash(hashOrPlaceholder: string): boolean {
    const hash = this.extractHash(hashOrPlaceholder);
    return this.store.has(hash);
  }

  /**
   * Returns metadata entry for a stored block.
   */
  public getBlock(hashOrPlaceholder: string): StoredBlock | undefined {
    const hash = this.extractHash(hashOrPlaceholder);
    return this.store.get(hash);
  }

  /**
   * Returns the count of stored block hashes.
   */
  public get size(): number {
    return this.store.size;
  }

  /**
   * Clears all stored block mappings.
   */
  public clear(): void {
    this.store.clear();
  }

  private extractHash(hashOrPlaceholder: string): string {
    const match = /^<BLOCK_HASH:([^>]+)>$/.exec(hashOrPlaceholder.trim());
    return match && match[1] ? match[1] : hashOrPlaceholder.trim();
  }
}
