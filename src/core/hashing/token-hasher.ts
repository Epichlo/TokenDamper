import { hashContent } from '../model/constructors';
import { ELISION_HASH_PREFIX_LENGTH, ELISION_MARKER_PATTERN, unwrapElisionContent } from '../elision';

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

  /**
   * Maps a marker's truncated hash back to the full digest.
   *
   * Markers carry `ELISION_HASH_PREFIX_LENGTH` hex characters, not the whole digest, so the
   * reverse path needs this. A `null` value records that two distinct blocks share a prefix:
   * the entry then resolves to nothing and `rehydrateText` leaves the marker in place, which
   * is what it already does for any hash it cannot resolve. Refusing an ambiguous lookup is
   * the only answer that cannot silently substitute the wrong content.
   */
  private readonly prefixIndex = new Map<string, string | null>();

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

    const prefix = hash.slice(0, ELISION_HASH_PREFIX_LENGTH);
    const existing = this.prefixIndex.get(prefix);
    if (existing === undefined) {
      this.prefixIndex.set(prefix, hash);
    } else if (existing !== hash) {
      this.prefixIndex.set(prefix, null);
    }

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
    return this.resolve(this.extractHash(hashOrPlaceholder))?.content;
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
      const entry = this.resolve(this.extractHash(wrappedMarker));
      if (entry) {
        return entry.content;
      }
      return text;
    }

    // Two forms are read and one is written. `[TokenDamper: … sha256:…]` is what
    // `renderElisionMarker` produces; `<BLOCK_HASH:…>` is the previous format, still accepted
    // so that text captured before this change round-trips. Both resolve through `resolve`,
    // so the truncated and full digests behave identically.
    const combined = new RegExp(
      `${ELISION_MARKER_PATTERN.source}|<BLOCK_HASH:([a-f0-9]{12,64}|[^>]+)>`,
      'g',
    );
    return text.replace(combined, (match: string, markerHash?: string, blockHash?: string) => {
      const entry = this.resolve(markerHash ?? blockHash ?? '');
      return entry ? entry.content : match;
    });
  }

  /**
   * Returns whether a block hash or placeholder exists in the store.
   */
  public hasHash(hashOrPlaceholder: string): boolean {
    return this.resolve(this.extractHash(hashOrPlaceholder)) !== undefined;
  }

  /**
   * Returns metadata entry for a stored block.
   */
  public getBlock(hashOrPlaceholder: string): StoredBlock | undefined {
    return this.resolve(this.extractHash(hashOrPlaceholder));
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
    this.prefixIndex.clear();
  }

  /**
   * Looks up a full digest, or the truncated one a marker carries. An ambiguous prefix
   * resolves to nothing rather than to a guess.
   */
  private resolve(key: string): StoredBlock | undefined {
    const direct = this.store.get(key);
    if (direct) {
      return direct;
    }
    if (key.length !== ELISION_HASH_PREFIX_LENGTH) {
      return undefined;
    }
    const full = this.prefixIndex.get(key);
    return full ? this.store.get(full) : undefined;
  }

  private extractHash(hashOrPlaceholder: string): string {
    const trimmed = hashOrPlaceholder.trim();

    const marker = new RegExp(`^${ELISION_MARKER_PATTERN.source}$`).exec(trimmed);
    if (marker && marker[1]) {
      return marker[1];
    }

    const legacy = /^<BLOCK_HASH:([^>]+)>$/.exec(trimmed);
    return legacy && legacy[1] ? legacy[1] : trimmed;
  }
}
