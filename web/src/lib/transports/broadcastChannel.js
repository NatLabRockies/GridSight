/**
 * BroadcastChannel transport for StateBus.
 *
 * Enables state synchronization between browser tabs/windows
 * on the same origin. Zero server overhead.
 *
 * Usage:
 *   import { bus } from '../stateBus.js';
 *   import { BroadcastChannelTransport } from './broadcastChannel.js';
 *
 *   const transport = new BroadcastChannelTransport(bus, 'meridian-sync');
 *   bus.addTransport(transport);
 */

export class BroadcastChannelTransport {
  /**
   * @param {import('../stateBus.js').StateBus} bus - the bus to deliver received messages to
   * @param {string} [channelName='meridian-sync'] - BroadcastChannel name
   */
  constructor(bus, channelName = 'meridian-sync') {
    this._bus = bus;
    this._channel = new BroadcastChannel(channelName);
    this._channel.onmessage = (event) => {
      try {
        const msg = event.data;
        if (msg && typeof msg === 'object' && msg.channel) {
          this._bus.receive(msg);
        }
      } catch (e) {
        console.warn('[BroadcastChannelTransport] receive error:', e);
      }
    };
  }

  /**
   * Send a message to all other tabs/windows.
   * @param {object} msg - BusMessage (must be structured-clone compatible)
   */
  send(msg) {
    this._channel.postMessage(msg);
  }

  /** Close the BroadcastChannel. */
  destroy() {
    this._channel.close();
  }
}
