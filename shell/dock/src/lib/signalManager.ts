/**
 * Manages GObject signal connections to prevent leaks.
 * Every connect() must be paired with a disconnectAll() in disable().
 *
 * Actors that come and go while the extension runs (icons, thumbnails, the apps button, stacks) use connectActor() instead: it
 * also listens for the actor's own "destroy" and forgets its connections then, so a later disconnectAll() never touches a
 * disposed object (GJS throws "already disposed" on disconnect, and the handler id is gone with the instance anyway), and
 * disconnectSource() lets an owner let one actor go before it is destroyed.
 */

type SignalSource = {
  connect(signal: string, callback: (...args: unknown[]) => void): number;
  disconnect(id: number): void;
};

export class SignalManager {
  private _connections: { source: SignalSource; signalId: number }[] = [];
  /** The "destroy" watch of each actor that is tracked by connectActor(). */
  private _destroyWatch = new Map<SignalSource, number>();

  connect(source: SignalSource, signal: string, callback: (...args: unknown[]) => void): number {
    const id = source.connect(signal, callback);
    this._connections.push({ source, signalId: id });
    return id;
  }

  /** Like connect() for an actor that can be destroyed before disconnectAll(): its connections are forgotten when it is destroyed. */
  connectActor(
    source: SignalSource,
    signal: string,
    callback: (...args: unknown[]) => void,
  ): number {
    if (!this._destroyWatch.has(source)) {
      // At "destroy" the instance is still alive; its handlers end with it, so they are only dropped from the books.
      const watch = source.connect("destroy", () => this._forget(source));
      this._destroyWatch.set(source, watch);
      this._connections.push({ source, signalId: watch });
    }
    return this.connect(source, signal, callback);
  }

  disconnect(id: number): void {
    const index = this._connections.findIndex((c) => c.signalId === id);
    if (index !== -1) {
      const [conn] = this._connections.splice(index, 1);
      conn.source.disconnect(conn.signalId);
    }
  }

  /** Disconnects everything this manager holds on `source`, ahead of its destruction. */
  disconnectSource(source: SignalSource): void {
    const mine = this._connections.filter((c) => c.source === source);
    this._connections = this._connections.filter((c) => c.source !== source);
    this._destroyWatch.delete(source);
    for (const conn of mine) conn.source.disconnect(conn.signalId);
  }

  disconnectAll(): void {
    for (const conn of this._connections) {
      conn.source.disconnect(conn.signalId);
    }
    this._connections = [];
    this._destroyWatch.clear();
  }

  /** The number of live connections (the destroy watches included): what a leak check reads. */
  get size(): number {
    return this._connections.length;
  }

  private _forget(source: SignalSource): void {
    this._connections = this._connections.filter((c) => c.source !== source);
    this._destroyWatch.delete(source);
  }
}
