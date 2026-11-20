/**
 * WebSocket transport for StateBus.
 *
 * Enables state synchronization between browser windows on
 * different machines via a server-side relay.
 *
 * Usage:
 *   import { bus } from '../stateBus.js';
 *   import { WebSocketTransport } from './websocket.js';
 *
 *   const transport = new WebSocketTransport(bus, 'ws://localhost:5001/ws/sync');
 *   bus.addTransport(transport);
 */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class WebSocketTransport {
  /**
   * @param {import('../stateBus.js').StateBus} bus
   * @param {string} url - WebSocket endpoint URL
   * @param {object} [options]
   * @param {string} [options.apiKey] - API key for authentication
   * @param {boolean} [options.autoReconnect=true]
   */
  constructor(bus, url, options = {}) {
    this._bus = bus;
    this._url = url;
    this._apiKey = options.apiKey || null;
    this._autoReconnect = options.autoReconnect !== false;
    this._ws = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._destroyed = false;
    this._queue = []; // messages queued while disconnected

    this._connect();
  }

  send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    } else {
      // Queue for when connection is established
      this._queue.push(msg);
      if (this._queue.length > 100) this._queue.shift(); // cap queue
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.onclose = null; // prevent reconnect
      this._ws.close();
    }
  }

  _connect() {
    if (this._destroyed) return;

    const url = this._apiKey
      ? `${this._url}?api_key=${encodeURIComponent(this._apiKey)}`
      : this._url;

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      console.warn('[WebSocketTransport] connect error:', e);
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      console.log('[WebSocketTransport] connected to', this._url);
      this._reconnectDelay = RECONNECT_BASE_MS;
      // Flush queued messages
      while (this._queue.length > 0) {
        this.send(this._queue.shift());
      }
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && typeof msg === 'object' && msg.channel) {
          this._bus.receive(msg);
        }
      } catch (e) {
        console.warn('[WebSocketTransport] parse error:', e);
      }
    };

    this._ws.onclose = () => {
      if (!this._destroyed && this._autoReconnect) {
        this._scheduleReconnect();
      }
    };

    this._ws.onerror = (e) => {
      console.warn('[WebSocketTransport] error:', e);
    };
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    console.log(`[WebSocketTransport] reconnecting in ${this._reconnectDelay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);
      this._connect();
    }, this._reconnectDelay);
  }
}
