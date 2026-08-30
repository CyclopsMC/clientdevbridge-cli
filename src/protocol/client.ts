import WebSocket from 'ws';
import { ProtocolError, SessionError } from '../errors.js';
import { LOOPBACK_HOSTS, urlHost } from '../loopback.js';
import { type Hello, helloSchema, rpcNotificationSchema, rpcResponseSchema, SUPPORTED_PROTOCOL } from './types.js';

export type NotificationListener = (method: string, params: Record<string, unknown>) => void;

export interface ConnectOptions {
  readonly port: number;
  readonly timeoutMs?: number;
  readonly onNotification?: NotificationListener;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * A JSON-RPC 2.0 client over the mod's localhost WebSocket.
 *
 * One instance per CLI invocation: connect, do one thing, close.
 */
export class BridgeClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: NotificationListener[] = [];
  private nextId = 1;
  private closedReason: string | null = null;

  public readonly hello: Hello;

  private constructor(socket: WebSocket, hello: Hello) {
    this.socket = socket;
    this.hello = hello;
    socket.on('message', (raw) => this.onMessage(String(raw)));
    socket.on('close', () => this.failAll('The client closed the connection.'));
    socket.on('error', (error) => this.failAll(`Connection error: ${error.message}`));
  }

  /**
   * Connects to the client on this port, over whichever loopback address it is listening on.
   *
   * The first address that answers wins. When none does, the failure reported is the one from
   * 127.0.0.1: that is where a client is supposed to be, so it is the message that helps.
   */
  public static async connect(options: ConnectOptions): Promise<BridgeClient> {
    let first: unknown;
    for (const host of LOOPBACK_HOSTS) {
      try {
        return await BridgeClient.connectTo(host, options);
      } catch (error) {
        first ??= error;
      }
    }
    throw first;
  }

  private static async connectTo(host: string, options: ConnectOptions): Promise<BridgeClient> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const url = `ws://${urlHost(host)}:${options.port}`;

    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const early: { method: string; params: Record<string, unknown> }[] = [];

    const hello = await new Promise<Hello>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(
          new SessionError(
            `Timed out after ${timeoutMs} ms waiting for the ClientDevBridge handshake on ${url}.`,
          ),
        );
      }, timeoutMs);

      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const reason =
          error.code === 'ECONNREFUSED'
            ? `Nothing is listening on ${url}.`
            : `Could not connect to ${url}: ${error.message}`;
        reject(new SessionError(reason));
      });

      socket.on('message', function onMessage(raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        const notification = rpcNotificationSchema.safeParse(parsed);
        if (!notification.success) {
          return;
        }
        if (notification.data.method !== 'hello') {
          early.push({ method: notification.data.method, params: notification.data.params });
          return;
        }
        socket.off('message', onMessage);
        clearTimeout(timer);
        const helloResult = helloSchema.safeParse(notification.data.params);
        if (!helloResult.success) {
          reject(new SessionError(`The client sent a handshake this CLI cannot read: ${helloResult.error.message}`));
          return;
        }
        resolve(helloResult.data);
      });
    });

    if (hello.protocol !== SUPPORTED_PROTOCOL) {
      socket.close();
      const direction = hello.protocol > SUPPORTED_PROTOCOL ? 'update the CLI' : 'update the mod';
      throw new SessionError(
        `Protocol mismatch: this CLI speaks protocol ${SUPPORTED_PROTOCOL}, the ClientDevBridge mod speaks ${hello.protocol}. Please ${direction}.`,
        hello.protocol > SUPPORTED_PROTOCOL
          ? 'npm install -g cyclops-clientdevbridge-cli@latest'
          : 'Rebuild the ClientDevBridge mod, or pass --clientdevbridge-version to pick a matching build.',
      );
    }

    const client = new BridgeClient(socket, hello);
    if (options.onNotification !== undefined) {
      client.onNotification(options.onNotification);
      for (const notification of early) {
        options.onNotification(notification.method, notification.params);
      }
    }
    return client;
  }

  public onNotification(listener: NotificationListener): void {
    this.listeners.push(listener);
  }

  public async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    if (this.closedReason !== null) {
      throw new SessionError(this.closedReason);
    }
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SessionError(`'${method}' did not answer within ${timeoutMs} ms.`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(message);
    });
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const response = rpcResponseSchema.safeParse(parsed);
    if (response.success && response.data.id !== null) {
      const pending = this.pending.get(Number(response.data.id));
      if (pending === undefined) {
        return;
      }
      this.pending.delete(Number(response.data.id));
      if (response.data.error !== undefined) {
        pending.reject(
          new ProtocolError(response.data.error.code, response.data.error.message, response.data.error.data),
        );
      } else {
        pending.resolve(response.data.result ?? {});
      }
      return;
    }

    const notification = rpcNotificationSchema.safeParse(parsed);
    if (notification.success) {
      for (const listener of this.listeners) {
        listener(notification.data.method, notification.data.params);
      }
    }
  }

  private failAll(reason: string): void {
    this.closedReason = reason;
    for (const pending of this.pending.values()) {
      pending.reject(new SessionError(reason));
    }
    this.pending.clear();
  }

  public close(): void {
    this.closedReason = this.closedReason ?? 'Connection closed by the CLI.';
    this.socket.close();
  }
}
