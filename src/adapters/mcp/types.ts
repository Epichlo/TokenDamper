/**
 * JSON-RPC 2.0 request interface.
 */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * JSON-RPC 2.0 response interface.
 */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error interface.
 */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * JSON-RPC 2.0 notification interface.
 */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Standard JSON-RPC 2.0 error codes.
 */
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// --- MCP Protocol Interfaces ---

export interface McpServerCapabilities {
  readonly tools?: { readonly listChanged?: boolean };
  readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
  readonly prompts?: { readonly listChanged?: boolean };
}

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpServerCapabilities;
  readonly serverInfo: McpServerInfo;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };
}

export interface McpToolResultContent {
  readonly type: 'text';
  readonly text: string;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<McpToolResultContent>;
  readonly isError?: boolean;
}

export interface McpResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
}

export interface McpPromptDefinition {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }>;
}

export interface McpPromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: {
    readonly type: 'text';
    readonly text: string;
  };
}
