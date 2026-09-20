// The DOM abort machinery -- `Event`, `AbortSignal`, `AbortController` --
// split out of `globals.ts` and loaded UNCONDITIONALLY, for the same reason
// `whatwg-streams.ts` is: this target's OWN builtins name these classes with
// no import. `events.ts`'s `addAbortListener` and `stream.ts`'s
// `signal?: AbortSignal` are node-compat source, not application source, so
// they must typecheck in every program -- not only in a `--globals` one that
// asked for the WHATWG fetch classes. Leaving them in `globals.ts` made
// `apps/raw-http-hello` fail with 13 `Cannot find name 'AbortSignal'` /
// `'Event'` errors while `apps/hono-hello` compiled, purely because the
// latter pulls `globals.ts` in and the former does not.
//
// Like `globals.ts` and `whatwg-streams.ts` this file is a SCRIPT, never a
// module: it must have NO top-level `import`/`export`, because that is the
// whole mechanism putting these declarations in real global scope. Unreached
// declarations are pruned like any other root, so a program that never aborts
// anything pays for none of it.

// DOM Standard §2.2's base dictionary every `*EventInit` extends
// (`MessageEventInit`/`CloseEventInit`/`ErrorEventInit` below, and
// `@hono/node-server`'s own `websocket.ts`-local `CloseEventInit`/
// `ErrorEventInit`, which spell `extends EventInit` with no import). Fields
// are accepted and stored nowhere: nothing in this file or in any app this
// target builds reads a dispatched event's `bubbles`/`cancelable`/
// `composed` back, so keeping state for them would be dead weight on every
// `new Event(...)` call the hot WebSocket path makes.

// `AbortSignal`'s default abort reason is a `DOMException`, so it travels
// with the abort machinery rather than with the fetch classes.
class DOMException extends Error {
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }

  get code(): number {
    const names = [
      "",
      "IndexSizeError",
      "DOMStringSizeError",
      "HierarchyRequestError",
      "WrongDocumentError",
      "InvalidCharacterError",
      "NoDataAllowedError",
      "NoModificationAllowedError",
      "NotFoundError",
      "NotSupportedError",
      "InUseAttributeError",
      "InvalidStateError",
      "SyntaxError",
      "InvalidModificationError",
      "NamespaceError",
      "InvalidAccessError",
      "ValidationError",
      "TypeMismatchError",
      "SecurityError",
      "NetworkError",
      "AbortError",
      "URLMismatchError",
      "QuotaExceededError",
      "TimeoutError",
      "InvalidNodeTypeError",
      "DataCloneError",
    ];
    const index = names.indexOf(this.name);
    return index < 0 ? 0 : index;
  }
}

interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

// DOM Standard (2026-08-25), §3: abort reasons retain their identity and an
// abort notification is synchronous and fires only once. The reason is a real
// dynamic boundary: JavaScript permits throwing any value here.
class Event {
  readonly type: string;
  target: AbortSignal | null = null;
  currentTarget: AbortSignal | null = null;
  private immediateStopped = false;

  constructor(type: string, _init?: EventInit) {
    this.type = type;
  }

  stopImmediatePropagation(): void {
    this.immediateStopped = true;
  }

  isImmediatePropagationStopped(): boolean {
    return this.immediateStopped;
  }
}


type AbortEventListener = (this: AbortSignal, event: Event) => void;
interface AbortListenerRegistration {
  type: string;
  callback: AbortEventListener;
  capture: boolean;
  once: boolean;
  removed: boolean;
}

const abortSignalConstructionToken = Symbol("AbortSignal construction");

class AbortSignal {
  private abortedValue = false;
  // `unknown`, not `any`, and the difference is load-bearing rather than
  // stylistic. An abort reason genuinely IS arbitrary -- whatever the caller
  // passed to `abort()`, rethrown unchanged -- so no narrower type would be
  // honest. But it is only ever STORED and handed back: nothing in this
  // runtime calls a method on it. That is exactly the case `unknown` is for,
  // and it keeps the value out of the opaque-receiver set that stamps a
  // host-surface wildcard.
  private reasonValue: unknown = undefined;
  private listeners: AbortListenerRegistration[] = [];
  private onabortValue: AbortEventListener | null = null;
  private onabortListener = (event: Event): void => {
    if (this.onabortValue !== null) this.onabortValue.call(this, event);
  };

  constructor(token: symbol) {
    if (token !== abortSignalConstructionToken)
      throw new TypeError("Illegal constructor");
  }

  get aborted(): boolean {
    return this.abortedValue;
  }

  get reason(): unknown {
    return this.reasonValue;
  }

  get onabort(): AbortEventListener | null {
    return this.onabortValue;
  }

  set onabort(callback: AbortEventListener | null) {
    if (callback !== null && this.onabortValue === null)
      this.addEventListener("abort", this.onabortListener);
    if (callback === null)
      this.removeEventListener("abort", this.onabortListener);
    this.onabortValue = callback;
  }

  throwIfAborted(): void {
    if (this.abortedValue) throw this.reasonValue;
  }

  addEventListener(
    type: string,
    callback: AbortEventListener | null,
    options: boolean | { capture?: boolean; once?: boolean } = false,
  ): void {
    if (callback === null) return;
    const capture =
      typeof options === "boolean" ? options : (options.capture ?? false);
    for (const entry of this.listeners) {
      if (
        !entry.removed &&
        entry.type === type &&
        entry.callback === callback &&
        entry.capture === capture
      )
        return;
    }
    this.listeners.push({
      type,
      callback,
      capture,
      once: typeof options === "boolean" ? false : (options.once ?? false),
      removed: false,
    });
  }

  removeEventListener(
    type: string,
    callback: AbortEventListener | null,
    options: boolean | { capture?: boolean } = false,
  ): void {
    const capture =
      typeof options === "boolean" ? options : (options.capture ?? false);
    for (const entry of this.listeners) {
      if (
        entry.type === type &&
        entry.callback === callback &&
        entry.capture === capture
      )
        entry.removed = true;
    }
    this.listeners = this.listeners.filter((entry) => !entry.removed);
  }

  dispatchEvent(event: Event): boolean {
    event.target = this;
    event.currentTarget = this;
    // Snapshot membership, but share each registration's removal state so a
    // callback can remove a later callback from the dispatch already in flight.
    const entries = this.listeners.slice();
    for (const entry of entries) {
      if (event.isImmediatePropagationStopped()) break;
      if (entry.removed || entry.type !== event.type) continue;
      if (entry.once)
        this.removeEventListener(entry.type, entry.callback, entry.capture);
      try {
        entry.callback.call(this, event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    event.currentTarget = null;
    return true;
  }

  signalAbort(reason: unknown): void {
    if (this.abortedValue) return;
    if (reason === undefined)
      reason = new DOMException("This operation was aborted", "AbortError");
    this.reasonValue = reason;
    this.abortedValue = true;
    this.dispatchEvent(new Event("abort"));
  }

  static abort(reason: unknown = undefined): AbortSignal {
    const signal = new AbortSignal(abortSignalConstructionToken);
    signal.signalAbort(reason);
    return signal;
  }
}

class AbortController {
  readonly signal = new AbortSignal(abortSignalConstructionToken);

  abort(reason: unknown = undefined): void {
    this.signal.signalAbort(reason);
  }
}
