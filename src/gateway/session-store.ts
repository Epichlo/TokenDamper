import type { GatewaySession, SessionContentEntry, SessionTurn } from './types';

/**
 * Stateful in-memory session manager for cross-turn context deduplication.
 */
export class GatewaySessionStore {
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxContentEntriesPerSession: number;

  constructor(
    options: {
      sessionTtlMs?: number | undefined;
      maxSessions?: number | undefined;
      maxContentEntriesPerSession?: number | undefined;
    } = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 60 * 60 * 1000; // 1 hour default
    this.maxSessions = options.maxSessions ?? 100;
    this.maxContentEntriesPerSession = options.maxContentEntriesPerSession ?? 100;
  }

  /**
   * Retrieves an existing session without creating one, and without touching `lastActiveAt`.
   *
   * The read-only counterpart to `getOrCreateSession`. The MCP `get_session_metrics` tool and
   * the `tokendamper://session/<id>` resource both used the creating variant, so *asking about*
   * a session brought it into existence — an inspection call could evict a real session under
   * `maxSessions`, and a typo'd id reported a plausible all-zero session rather than saying it
   * did not exist (audit M5, minor).
   *
   * Expiry is still honoured: an expired session is not a session.
   */
  public getSession(sessionId: string): GatewaySession | undefined {
    this.pruneExpired();
    return this.sessions.get(sessionId);
  }

  /**
   * Retrieves an existing session or creates a new session if it does not exist.
   */
  public getOrCreateSession(sessionId: string): GatewaySession {
    this.pruneExpired();

    let session = this.sessions.get(sessionId);
    const now = Date.now();

    if (!session) {
      if (this.sessions.size >= this.maxSessions) {
        this.evictOldestSession();
      }

      session = {
        sessionId,
        createdAt: now,
        lastActiveAt: now,
        turnCount: 0,
        seenBlockHashes: new Set<string>(),
        contentByHash: new Map<string, string>(),
        turns: [],
      };
      this.sessions.set(sessionId, session);
    } else {
      session.lastActiveAt = now;
    }

    return session;
  }

  /**
   * Records a turn result into the active session state.
   */
  public recordTurn(
    sessionId: string,
    turn: Omit<SessionTurn, 'turnIndex' | 'timestamp'>,
    newBlocks: ReadonlyArray<string | SessionContentEntry>,
  ): GatewaySession {
    const session = this.getOrCreateSession(sessionId);
    const now = Date.now();

    session.turnCount += 1;
    session.lastActiveAt = now;

    const fullTurn: SessionTurn = {
      ...turn,
      turnIndex: session.turnCount,
      timestamp: now,
    };

    session.turns.push(fullTurn);

    for (const block of newBlocks) {
      const hash = typeof block === 'string' ? block : block.hash;
      
      session.seenBlockHashes.delete(hash);
      session.seenBlockHashes.add(hash);
      
      if (typeof block !== 'string') {
        this.storeContent(sessionId, hash, block.content);
      }
    }
    this.capSeenBlockHashes(session);

    return session;
  }

  /**
   * Stores original raw content by hash for later rehydration.
   */
  public storeContent(sessionId: string, hash: string, content: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.seenBlockHashes.delete(hash);
    session.seenBlockHashes.add(hash);
    this.capSeenBlockHashes(session);

    if (session.contentByHash.has(hash)) {
      session.contentByHash.delete(hash);
    }
    session.contentByHash.set(hash, content);

    while (session.contentByHash.size > this.maxContentEntriesPerSession) {
      const oldestKey = session.contentByHash.keys().next().value;
      if (oldestKey !== undefined) {
        session.contentByHash.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  /**
   * Retrieves original raw content by full content hash, short ref, or elision marker.
   */
  public getContent(sessionId: string, hashOrRef: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const normalizedRef = normalizeHashOrRef(hashOrRef);
    const exactMatch = session.contentByHash.get(normalizedRef);
    if (exactMatch !== undefined) {
      session.contentByHash.delete(normalizedRef);
      session.contentByHash.set(normalizedRef, exactMatch);
      return exactMatch;
    }

    const prefixMatches: Array<{ hash: string; content: string }> = [];
    for (const [hash, content] of session.contentByHash.entries()) {
      if (hash.startsWith(normalizedRef)) {
        prefixMatches.push({ hash, content });
      }
    }

    if (prefixMatches.length === 1 && prefixMatches[0]) {
      const match = prefixMatches[0];
      session.contentByHash.delete(match.hash);
      session.contentByHash.set(match.hash, match.content);
      return match.content;
    }

    return undefined;
  }

  /**
   * Returns whether a block hash has been observed in previous turns of this session.
   */
  public hasBlockHash(sessionId: string, hash: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.seenBlockHashes.has(hash);
  }

  /**
   * Clears expired sessions based on TTL.
   */
  public pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastActiveAt > this.sessionTtlMs) {
        this.sessions.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Returns total active session count.
   */
  public get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Evicts the least recently active session.
   */
  private evictOldestSession(): void {
    let oldestId: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [id, session] of this.sessions.entries()) {
      if (session.lastActiveAt < oldestTimestamp) {
        oldestTimestamp = session.lastActiveAt;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.sessions.delete(oldestId);
    }
  }

  /**
   * Clears all stored sessions.
   */
  public clear(): void {
    this.sessions.clear();
  }

  private capSeenBlockHashes(session: GatewaySession): void {
    const MAX_SEEN_BLOCK_HASHES = 1000;
    while (session.seenBlockHashes.size > MAX_SEEN_BLOCK_HASHES) {
      const oldestHash = session.seenBlockHashes.values().next().value;
      if (oldestHash !== undefined) {
        session.seenBlockHashes.delete(oldestHash);
      } else {
        break;
      }
    }
  }
}

function normalizeHashOrRef(hashOrRef: string): string {
  const elisionRef = /\bref=([A-Za-z0-9_-]+)/.exec(hashOrRef);
  if (elisionRef?.[1]) {
    return elisionRef[1];
  }

  return hashOrRef.trim();
}
