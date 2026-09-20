import assert from 'node:assert/strict'
import * as nativeDiagnostics from 'node:diagnostics_channel'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const source = readFileSync(new URL('../runtime/node/diagnostics_channel.ts', import.meta.url), 'utf8')
const shimDiagnostics = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
const shimSpecifier = new URL('../runtime/node/diagnostics_channel.ts', import.meta.url).href

function runDeferredErrorScenario(specifier, body) {
  const program = `
    import * as diagnostics from ${JSON.stringify(specifier)}
    const events = []
    process.on('uncaughtException', (error) => events.push('uncaught:' + error.message))
    setImmediate(() => {
      ${body}
      process.nextTick(() => events.push('nextTick-after'))
      queueMicrotask(() => events.push('microtask'))
      setImmediate(() => process.stdout.write(JSON.stringify(events)))
    })
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout)
}

class Store {
  current

  run(value, callback, ...args) {
    const previous = this.current
    this.current = value
    try {
      return callback(...args)
    } finally {
      this.current = previous
    }
  }

  getStore() {
    return this.current
  }
}

for (const [label, diagnostics] of [
  ['node', nativeDiagnostics],
  ['shim', shimDiagnostics]
]) {
  test(`${label} channels preserve identity, synchronous observation, mutation snapshots, and stores`, () => {
    const absentName = Symbol(`gea-diagnostics-absent-${label}`)
    const hasSubscribersDescriptor = Object.getOwnPropertyDescriptor(diagnostics.Channel.prototype, 'hasSubscribers')
    let getterReads = 0
    Object.defineProperty(diagnostics.Channel.prototype, 'hasSubscribers', {
      ...hasSubscribersDescriptor,
      get() {
        getterReads += 1
        return hasSubscribersDescriptor.get.call(this)
      }
    })
    try {
      assert.equal(diagnostics.hasSubscribers(absentName), false)
      assert.equal(getterReads, 0, 'checking an unknown name must not construct or inspect a channel')
    } finally {
      Object.defineProperty(diagnostics.Channel.prototype, 'hasSubscribers', hasSubscribersDescriptor)
    }

    const constructedName = Symbol(`gea-diagnostics-constructed-${label}`)
    const constructed = new diagnostics.Channel(constructedName)
    assert.equal(diagnostics.channel(constructedName), constructed)
    const replacement = new diagnostics.Channel(constructedName)
    assert.notEqual(replacement, constructed)
    assert.equal(diagnostics.channel(constructedName), replacement)

    const name = Symbol(`gea-diagnostics-${label}`)
    const observed = []
    const current = diagnostics.channel(name)
    assert.equal(current, diagnostics.channel(name))
    assert.equal(current.hasSubscribers, false)
    assert.equal(diagnostics.hasSubscribers(name), false)

    const late = (message, channelName) => observed.push(['late', message, channelName])
    const second = (message, channelName) => observed.push(['second', message, channelName])
    const first = (message, channelName) => {
      observed.push(['first', message, channelName])
      current.unsubscribe(second)
      current.subscribe(late)
    }
    current.subscribe(first)
    diagnostics.subscribe(name, second)
    assert.equal(diagnostics.hasSubscribers(name), true)
    current.publish('one')
    current.publish('two')
    assert.deepEqual(observed, [
      ['first', 'one', name],
      ['second', 'one', name],
      ['first', 'two', name],
      ['late', 'two', name]
    ])
    assert.equal(diagnostics.unsubscribe(name, first), true)
    assert.equal(diagnostics.unsubscribe(name, first), false)

    const storeChannel = diagnostics.channel(Symbol(`gea-diagnostics-store-${label}`))
    const store = new Store()
    const storesSeen = []
    const listener = (message) => storesSeen.push([message, store.getStore()])
    storeChannel.bindStore(store, (context) => ({ value: context.value }))
    assert.equal(storeChannel.hasSubscribers, true)
    storeChannel.subscribe(listener)
    const receiver = { base: 4 }
    const result = storeChannel.runStores(
      { value: 3 },
      function (increment) {
        assert.equal(this, receiver)
        assert.deepEqual(store.getStore(), { value: 3 })
        return this.base + increment
      },
      receiver,
      2
    )
    assert.equal(result, 6)
    assert.deepEqual(storesSeen, [[{ value: 3 }, { value: 3 }]])
    assert.equal(store.getStore(), undefined)

    storeChannel.bindStore(store, (context) => ({ value: context.value * 2 }))
    storeChannel.runStores({ value: 5 }, () => assert.deepEqual(store.getStore(), { value: 10 }))
    assert.equal(storeChannel.unbindStore(store), true)
    assert.equal(storeChannel.unbindStore(store), false)
    assert.equal(storeChannel.unsubscribe(listener), true)
    assert.equal(storeChannel.hasSubscribers, false)

    const nestedChannel = diagnostics.channel(Symbol(`gea-diagnostics-nested-stores-${label}`))
    const nesting = []
    class RecordingStore extends Store {
      constructor(name) {
        super()
        this.name = name
      }

      run(value, callback, ...args) {
        nesting.push(`enter:${this.name}`)
        try {
          return super.run(value, callback, ...args)
        } finally {
          nesting.push(`leave:${this.name}`)
        }
      }
    }
    const firstStore = new RecordingStore('first')
    const secondStore = new RecordingStore('second')
    nestedChannel.bindStore(firstStore, () => {
      nesting.push('transform:first')
      return 'first-context'
    })
    nestedChannel.bindStore(secondStore, () => {
      nesting.push('transform:second')
      return 'second-context'
    })
    nestedChannel.subscribe(() => nesting.push('publish'))
    nestedChannel.runStores({}, () => nesting.push('callback'))
    assert.deepEqual(nesting, [
      'transform:second',
      'enter:second',
      'transform:first',
      'enter:first',
      'publish',
      'callback',
      'leave:first',
      'leave:second'
    ])
  })

  test(`${label} subscriber and transform failures use nextTick without suppressing observers`, () => {
    const specifier = label === 'node' ? 'node:diagnostics_channel' : shimSpecifier
    assert.deepEqual(runDeferredErrorScenario(specifier, `
      const current = diagnostics.channel(Symbol('subscriber-errors'))
      current.subscribe(() => {
        events.push('first')
        throw new Error('subscriber')
      })
      current.subscribe(() => events.push('second'))
      current.publish('message')
    `), [
      'first',
      'second',
      'uncaught:subscriber',
      'nextTick-after',
      'microtask'
    ])

    assert.deepEqual(runDeferredErrorScenario(specifier, `
      class RecordingStore {
        constructor(name) {
          this.name = name
          this.current = undefined
        }
        run(value, callback) {
          const previous = this.current
          this.current = value
          events.push('enter:' + this.name)
          try {
            return callback()
          } finally {
            events.push('leave:' + this.name)
            this.current = previous
          }
        }
      }
      const first = new RecordingStore('first')
      const second = new RecordingStore('second')
      const current = diagnostics.channel(Symbol('transform-errors'))
      current.bindStore(first, () => {
        events.push('transform:first')
        throw new Error('transform')
      })
      current.bindStore(second, () => {
        events.push('transform:second')
        return 'second-context'
      })
      current.subscribe(() => events.push('publish:' + first.current + ':' + second.current))
      const result = current.runStores({}, () => {
        events.push('callback:' + first.current + ':' + second.current)
        return 17
      })
      events.push('result:' + result)
    `), [
      'transform:second',
      'enter:second',
      'transform:first',
      'publish:undefined:second-context',
      'callback:undefined:second-context',
      'leave:second',
      'result:17',
      'uncaught:transform',
      'nextTick-after',
      'microtask'
    ])
  })

  test(`${label} tracing channels publish Fastify's sync, async, and error lifecycle`, async () => {
    const name = `gea-fastify-tracing-${label}`
    const tracing = diagnostics.tracingChannel(name)
    for (const event of ['start', 'end', 'asyncStart', 'asyncEnd', 'error']) {
      assert.equal(tracing[event], diagnostics.channel(`tracing:${name}:${event}`))
    }

    const untouched = { marker: true }
    assert.equal(tracing.hasSubscribers, false)
    assert.equal(tracing.traceSync((value) => value + 1, untouched, undefined, 2), 3)
    assert.deepEqual(untouched, { marker: true })

    const observed = []
    const subscribers = Object.fromEntries(
      ['start', 'end', 'asyncStart', 'asyncEnd', 'error'].map((event) => [
        event,
        (message) => observed.push([event, { ...message }])
      ])
    )
    tracing.subscribe(subscribers)
    assert.equal(tracing.hasSubscribers, true)

    const syncContext = { operation: 'sync' }
    assert.equal(tracing.traceSync((value) => value * 2, syncContext, undefined, 3), 6)
    assert.deepEqual(observed.splice(0), [
      ['start', { operation: 'sync' }],
      ['end', { operation: 'sync', result: 6 }]
    ])

    const failure = { problem: true }
    const errorContext = { operation: 'throw' }
    assert.throws(() => tracing.traceSync(() => { throw failure }, errorContext), (error) => error === failure)
    assert.deepEqual(observed.splice(0), [
      ['start', { operation: 'throw' }],
      ['error', { operation: 'throw', error: failure }],
      ['end', { operation: 'throw', error: failure }]
    ])

    const promiseContext = { operation: 'promise' }
    const promise = tracing.tracePromise(() => Promise.resolve('done'), promiseContext)
    assert.deepEqual(observed.splice(0), [
      ['start', { operation: 'promise' }],
      ['end', { operation: 'promise' }]
    ])
    assert.equal(await promise, 'done')
    assert.deepEqual(observed.splice(0), [
      ['asyncStart', { operation: 'promise', result: 'done' }],
      ['asyncEnd', { operation: 'promise', result: 'done' }]
    ])

    const rejection = { rejected: true }
    const rejectionContext = { operation: 'rejection' }
    const rejected = tracing.tracePromise(() => Promise.reject(rejection), rejectionContext)
    assert.deepEqual(observed.splice(0), [
      ['start', { operation: 'rejection' }],
      ['end', { operation: 'rejection' }]
    ])
    await assert.rejects(rejected, (error) => error === rejection)
    assert.deepEqual(observed.splice(0), [
      ['error', { operation: 'rejection', error: rejection }],
      ['asyncStart', { operation: 'rejection', error: rejection }],
      ['asyncEnd', { operation: 'rejection', error: rejection }]
    ])

    const normalized = diagnostics.tracingChannel(`gea-fastify-normalized-${label}`)
    const asyncStore = new Store()
    const asyncStoreValues = []
    const asyncListener = () => asyncStoreValues.push(asyncStore.getStore())
    normalized.asyncStart.bindStore(asyncStore, () => ({ active: true }))
    normalized.asyncStart.subscribe(asyncListener)
    const scalar = normalized.tracePromise(() => 23, { operation: 'scalar' })
    assert.equal(scalar instanceof Promise, true)
    assert.equal(await scalar, 23)
    const thenable = normalized.tracePromise(
      () => ({ then: (resolve) => resolve('thenable') }),
      { operation: 'thenable' }
    )
    assert.equal(thenable instanceof Promise, true)
    assert.equal(await thenable, 'thenable')
    assert.deepEqual(asyncStoreValues, [undefined, undefined], 'tracePromise must publish asyncStart without running its stores')
    assert.equal(normalized.asyncStart.unsubscribe(asyncListener), true)
    assert.equal(normalized.asyncStart.unbindStore(asyncStore), true)

    const callbackContext = { operation: 'callback' }
    const callbackResult = []
    let wrappedCallbackResult = 'not-called'
    const returned = tracing.traceCallback(
      (value, callback) => {
        wrappedCallbackResult = callback(null, value + 1)
        return 'returned'
      },
      1,
      callbackContext,
      undefined,
      8,
      (error, value) => callbackResult.push(error, value)
    )
    assert.equal(returned, 'returned')
    assert.equal(wrappedCallbackResult, undefined)
    assert.deepEqual(callbackResult, [null, 9])
    assert.deepEqual(observed.splice(0), [
      ['start', { operation: 'callback' }],
      ['asyncStart', { operation: 'callback', result: 9 }],
      ['asyncEnd', { operation: 'callback', result: 9 }],
      ['end', { operation: 'callback', result: 9 }]
    ])

    for (const [falsyError, suffix] of [[false, 'false'], [0, 'zero'], ['', 'empty']]) {
      const falsyContext = { operation: `callback-${suffix}` }
      const values = []
      tracing.traceCallback(
        (callback) => callback(falsyError, suffix),
        0,
        falsyContext,
        undefined,
        (error, value) => values.push(error, value)
      )
      assert.deepEqual(values, [falsyError, suffix])
      assert.deepEqual(observed.splice(0), [
        ['start', { operation: `callback-${suffix}` }],
        ['asyncStart', { operation: `callback-${suffix}`, result: suffix }],
        ['asyncEnd', { operation: `callback-${suffix}`, result: suffix }],
        ['end', { operation: `callback-${suffix}`, result: suffix }]
      ])
    }

    for (const { position, callbackIndex, values } of [
      { position: -1, callbackIndex: 1, values: ['left', null] },
      { position: -2, callbackIndex: 1, values: ['left', null, 'right'] },
      { position: -3, callbackIndex: 0, values: [null, 'middle', 'right'] }
    ]) {
      const operation = `callback-position-${position}`
      const callbackCalls = []
      const originalCallback = (error, value) => {
        callbackCalls.push(error, value)
        return `callback-return-${position}`
      }
      const args = values.map((value) => value === null ? originalCallback : value)
      let wrapperResult = 'not-called'
      const result = tracing.traceCallback(
        (...received) => {
          assert.equal(received.length, args.length)
          for (let index = 0; index < args.length; index += 1) {
            if (index !== callbackIndex) assert.equal(received[index], args[index])
          }
          wrapperResult = received[callbackIndex](null, position)
          return `outer-return-${position}`
        },
        position,
        { operation },
        undefined,
        ...args
      )
      assert.equal(result, `outer-return-${position}`)
      assert.equal(wrapperResult, undefined)
      assert.deepEqual(callbackCalls, [null, position])
      assert.deepEqual(observed.splice(0), [
        ['start', { operation }],
        ['asyncStart', { operation, result: position }],
        ['asyncEnd', { operation, result: position }],
        ['end', { operation, result: position }]
      ])
    }

    let invalidPositionInvoked = false
    assert.throws(
      () => tracing.traceCallback(
        () => {
          invalidPositionInvoked = true
        },
        -4,
        { operation: 'invalid-position' },
        undefined,
        'one',
        'two',
        'three'
      ),
      TypeError
    )
    assert.equal(invalidPositionInvoked, false)
    assert.deepEqual(observed.splice(0), [])

    assert.equal(tracing.unsubscribe(subscribers), true)
    assert.equal(tracing.hasSubscribers, false)
  })
}
